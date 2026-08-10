/**
 * Current existing-route policy for ordinary IM turns.
 *
 * `begin` reserves the Session-local arrival slot and validates the transport
 * compiler. `execute` materializes detached input outside the Session lane.
 * `resume` re-resolves the exact Current binding, classifies it, and applies
 * one synchronous worker/current command. Later materializations may finish
 * first, but their command cannot cross an earlier arrival slot.
 */

import { types as nodeUtilTypes } from 'node:util';

import {
  createCurrentOrdinaryImTurnPreparationPort,
  CurrentOrdinaryImTurnPreparationPort,
  OrdinaryImTransportEnvelope,
  PreparedOrdinaryImTurn,
} from './current-ordinary-im-turn.js';
import type {
  OrdinaryIngressEffectSettlement,
  OrdinaryIngressPort,
} from './session-runtime.js';
import {
  claimInitialUserTurn,
  releaseInitialUserTurn,
} from './initial-user-turn.js';
import {
  activeSessionAnchorId,
  activeSessionKey,
  sessionKey,
  type DaemonSession,
} from './types.js';

export interface CurrentOrdinaryIngressMaterializeInput {
  readonly sessionId: string;
  readonly turn: PreparedOrdinaryImTurn;
}

export type CurrentOrdinaryIngressExternalEffect = {
  readonly kind: 'materialize';
  readonly input: CurrentOrdinaryIngressMaterializeInput;
};

export type CurrentOrdinaryIngressExternalEffectResult =
  | { readonly kind: 'materialized' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

/** The only asynchronous seam; it always runs outside the Session lane. */
export interface CurrentOrdinaryIngressExternalEffectExecutor {
  execute(
    effect: CurrentOrdinaryIngressExternalEffect,
  ): Promise<CurrentOrdinaryIngressExternalEffectResult>;
}

export type CurrentOrdinaryIngressCommandKind =
  | 'sendLive'
  | 'parkOpeningFollower'
  | 'parkPendingRepoFollower'
  | 'startColdReplacement'
  | 'startQueuedActivation'
  | 'recoverParkedActivation';

export interface CurrentOrdinaryIngressCommand {
  readonly kind: CurrentOrdinaryIngressCommandKind;
  readonly input: CurrentOrdinaryIngressMaterializeInput & {
    /** True only when this arrival synchronously consumed the empty-start marker. */
    readonly opening: boolean;
  };
  /** Detached guard for adapters that hand input to an already-live worker. */
  readonly guard: {
    readonly workerGeneration: number | undefined;
  };
}

export type CurrentOrdinaryIngressCommandResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string }
  | { readonly kind: 'stateChanged' };

/** Synchronous Adapter for all worker/current mutations selected by policy. */
export interface CurrentOrdinaryIngressCommandAdapter {
  apply(command: CurrentOrdinaryIngressCommand): CurrentOrdinaryIngressCommandResult;
}

export interface CurrentOrdinaryIngressPreMaterializationModule {
  /** Runs in the Session lane; it must not await or retain Current authority. */
  apply(
    current: DaemonSession,
    input: CurrentOrdinaryIngressMaterializeInput,
  ): { readonly kind: 'ready' } | { readonly kind: 'unknown'; readonly message: string };
}

export interface CurrentOrdinaryIngressOptions {
  readonly ownerLarkAppId: string;
  readonly activeSessions: ReadonlyMap<string, DaemonSession>;
  readonly turnPreparation: CurrentOrdinaryImTurnPreparationPort;
  readonly preMaterialization?: CurrentOrdinaryIngressPreMaterializationModule;
  readonly externalEffects: CurrentOrdinaryIngressExternalEffectExecutor;
  readonly commands: CurrentOrdinaryIngressCommandAdapter;
}

interface BindingStamp {
  readonly key: string;
  readonly sessionId: string;
  readonly token: object;
  readonly sessionToken: object;
}

interface ResolvedBinding {
  readonly stamp: BindingStamp;
  readonly current: DaemonSession;
}

interface ArrivalQueue {
  nextSlot: number;
  deliverableSlot: number;
  readonly waiters: Map<number, () => void>;
}

interface ArrivalReservation {
  readonly queue: ArrivalQueue;
  readonly slot: number;
  readonly ready: Promise<void>;
}

interface EffectPlan {
  readonly effect: CurrentOrdinaryIngressExternalEffect;
  readonly arrival: ArrivalReservation;
}

interface ContinuationPlan {
  readonly binding: BindingStamp;
  readonly input: CurrentOrdinaryIngressMaterializeInput;
  readonly arrival: ArrivalReservation;
}

const MAX_STATE_RECLASSIFICATIONS = 3;

function frozenToken(): object {
  return Object.freeze(Object.create(null)) as object;
}

function routeMatches(
  ds: DaemonSession,
  turn: OrdinaryImTransportEnvelope | PreparedOrdinaryImTurn,
): boolean {
  return ds.scope === turn.route.scope
    && ds.chatId === turn.route.chatId
    && ds.chatType === turn.route.chatType
    && activeSessionAnchorId(ds) === turn.route.canonicalAnchor;
}

/**
 * Compare an injected compiler value with the trusted compiler's exact output.
 * The nominal brand participates only as one expected descriptor among all
 * descriptors; it never grants authority without exact shape, immutability,
 * and semantic equality.
 */
function exactPreparedOutputMatches(
  candidate: PreparedOrdinaryImTurn,
  expected: PreparedOrdinaryImTurn,
): boolean {
  const seen = new WeakMap<object, object>();
  const compare = (actual: unknown, reference: unknown): boolean => {
    if (Object.is(actual, reference)) return true;
    if (actual === null || reference === null
      || (typeof actual !== 'object' && typeof actual !== 'function')
      || (typeof reference !== 'object' && typeof reference !== 'function')) {
      return false;
    }
    if (nodeUtilTypes.isProxy(actual)) return false;
    const prior = seen.get(actual);
    if (prior) return prior === reference;
    seen.set(actual, reference);

    if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(reference)
      || !Object.isFrozen(actual)) {
      return false;
    }
    const actualKeys = Reflect.ownKeys(actual);
    const referenceKeys = Reflect.ownKeys(reference);
    if (actualKeys.length !== referenceKeys.length
      || referenceKeys.some(key => !actualKeys.includes(key))) {
      return false;
    }
    for (const key of referenceKeys) {
      const actualDescriptor = Object.getOwnPropertyDescriptor(actual, key);
      const referenceDescriptor = Object.getOwnPropertyDescriptor(reference, key);
      if (!actualDescriptor || !referenceDescriptor
        || !('value' in actualDescriptor)
        || !('value' in referenceDescriptor)
        || actualDescriptor.enumerable !== referenceDescriptor.enumerable
        || actualDescriptor.configurable !== referenceDescriptor.configurable
        || actualDescriptor.writable !== referenceDescriptor.writable
        || !compare(actualDescriptor.value, referenceDescriptor.value)) {
        return false;
      }
    }
    return true;
  };

  try {
    return compare(candidate, expected);
  } catch {
    return false;
  }
}

function hasQueuedActivationAdmissionGate(ds: DaemonSession): boolean {
  return ds.session.queuedActivationPending === true
    || (ds.session.queuedActivationTail?.length ?? 0) > 0
    || (ds.queuedActivationTailAdmissionsOutstanding ?? 0) > 0
    || ds.queuedActivationTailReleasePending !== undefined
    || (ds.initialStartPending === true
      && ds.session.queuedActivationInput !== undefined);
}

function classify(ds: DaemonSession): CurrentOrdinaryIngressCommandKind {
  const workerIsLive = ds.worker !== null && !ds.worker.killed;
  const liveTakeoverReady = workerIsLive
    && !hasQueuedActivationAdmissionGate(ds)
    && ds.initialStartClaimToken === undefined;
  const openingFollower = ds.initialStartPending === true && !liveTakeoverReady;

  if (ds.pendingRepo) return 'parkPendingRepoFollower';
  if (workerIsLive && !liveTakeoverReady) return 'parkOpeningFollower';
  if (openingFollower) return 'parkOpeningFollower';
  if (workerIsLive) return 'sendLive';
  if (ds.session.queuedActivationPending) return 'recoverParkedActivation';
  if (ds.session.queued && ds.session.queuedPrompt !== undefined) {
    return 'startQueuedActivation';
  }
  return 'startColdReplacement';
}

function canOwnOpening(kind: CurrentOrdinaryIngressCommandKind): boolean {
  return kind === 'sendLive'
    || kind === 'startColdReplacement'
    || kind === 'parkPendingRepoFollower';
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/**
 * Build the Current staged port. No mutable Session or worker reference is
 * retained across the asynchronous seam; continuations carry an immutable
 * binding stamp and re-resolve Current state on resume.
 */
export function createCurrentOrdinaryIngressPort(
  options: CurrentOrdinaryIngressOptions,
): OrdinaryIngressPort {
  const trustedTurnPreparation = createCurrentOrdinaryImTurnPreparationPort();
  const effects = new WeakMap<object, EffectPlan>();
  const continuations = new WeakMap<object, ContinuationPlan>();
  const bindingTokens = new WeakMap<DaemonSession, object>();
  const sessionTokens = new WeakMap<object, object>();
  const arrivalQueues = new WeakMap<object, ArrivalQueue>();

  const tokenFor = (current: DaemonSession): object => {
    const existing = bindingTokens.get(current);
    if (existing) return existing;
    const token = frozenToken();
    bindingTokens.set(current, token);
    return token;
  };

  const sessionTokenFor = (session: object): object => {
    const existing = sessionTokens.get(session);
    if (existing) return existing;
    const token = frozenToken();
    sessionTokens.set(session, token);
    return token;
  };

  const resolveBinding = (
    sessionId: string,
    turn: OrdinaryImTransportEnvelope | PreparedOrdinaryImTurn,
  ): ResolvedBinding | undefined => {
    const key = sessionKey(turn.route.canonicalAnchor, options.ownerLarkAppId);
    const current = options.activeSessions.get(key);
    if (!current
      || activeSessionKey(current) !== key
      || current.larkAppId !== options.ownerLarkAppId
      || current.session.sessionId !== sessionId
      || !routeMatches(current, turn)) {
      return undefined;
    }
    return {
      stamp: Object.freeze({
        key,
        sessionId,
        token: tokenFor(current),
        sessionToken: sessionTokenFor(current.session),
      }),
      current,
    };
  };

  const resolveCurrent = (
    stamp: BindingStamp,
    turn: OrdinaryImTransportEnvelope | PreparedOrdinaryImTurn,
  ): DaemonSession | undefined => {
    const current = options.activeSessions.get(stamp.key);
    if (!current
      || tokenFor(current) !== stamp.token
      || sessionTokenFor(current.session) !== stamp.sessionToken
      || activeSessionKey(current) !== stamp.key
      || current.larkAppId !== options.ownerLarkAppId
      || current.session.sessionId !== stamp.sessionId
      || !routeMatches(current, turn)) {
      return undefined;
    }
    return current;
  };

  const reserveArrival = (binding: BindingStamp): ArrivalReservation => {
    let queue = arrivalQueues.get(binding.token);
    if (!queue) {
      queue = { nextSlot: 0, deliverableSlot: 0, waiters: new Map() };
      arrivalQueues.set(binding.token, queue);
    }
    const slot = queue.nextSlot;
    queue.nextSlot += 1;
    let ready: Promise<void>;
    if (slot === queue.deliverableSlot) {
      ready = Promise.resolve();
    } else {
      ready = new Promise<void>((resolve) => {
        queue!.waiters.set(slot, resolve);
      });
    }
    return { queue, slot, ready };
  };

  const releaseArrival = (arrival: ArrivalReservation): void => {
    if (arrival.slot !== arrival.queue.deliverableSlot) {
      throw new Error('Current ordinary ingress arrival slot lost linearization');
    }
    arrival.queue.deliverableSlot += 1;
    const releaseNext = arrival.queue.waiters.get(arrival.queue.deliverableSlot);
    if (releaseNext) {
      arrival.queue.waiters.delete(arrival.queue.deliverableSlot);
      releaseNext();
    }
  };

  const releaseOpening = (
    plan: ContinuationPlan,
    openingClaimed: boolean,
  ): void => {
    if (!openingClaimed) return;
    const current = resolveCurrent(plan.binding, plan.input.turn);
    if (current) releaseInitialUserTurn(current);
  };

  const begin: OrdinaryIngressPort['begin'] = ({ sessionId, turn }) => {
    const resolved = resolveBinding(sessionId, turn);
    if (!resolved) {
      return {
        kind: 'notCommitted',
        message: 'Current ordinary ingress route is no longer owned by this Session',
      };
    }

    const trustedPrepared = trustedTurnPreparation.prepare(turn);
    if (trustedPrepared.kind !== 'prepared') {
      return { kind: 'notCommitted', message: trustedPrepared.message };
    }

    let prepared;
    try {
      prepared = options.turnPreparation.prepare(turn);
    } catch (error) {
      return {
        kind: 'unknown',
        message: `ordinary IM turn preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (prepared.kind !== 'prepared') {
      return { kind: 'notCommitted', message: prepared.message };
    }
    if (!exactPreparedOutputMatches(prepared.turn, trustedPrepared.turn)) {
      return {
        kind: 'unknown',
        message: 'ordinary IM turn preparation violated the exact compiler contract',
      };
    }

    const current = resolveCurrent(resolved.stamp, prepared.turn);
    if (!current) {
      return {
        kind: 'notCommitted',
        message: 'Current Session identity changed during ordinary IM turn preparation',
      };
    }
    const input = Object.freeze({
      sessionId: resolved.stamp.sessionId,
      turn: prepared.turn,
    });
    if (options.preMaterialization) {
      let preparation: ReturnType<CurrentOrdinaryIngressPreMaterializationModule['apply']>;
      try {
        preparation = options.preMaterialization.apply(current, input);
      } catch (error) {
        return {
          kind: 'unknown',
          message: `ordinary ingress Current preparation failed: ${error instanceof Error
            ? error.message
            : String(error)}`,
        };
      }
      if (isObject(preparation)) {
        let then: unknown;
        try {
          then = (preparation as { readonly then?: unknown }).then;
        } catch {
          return {
            kind: 'unknown',
            message: 'ordinary ingress Current preparation returned an unreadable result',
          };
        }
        if (typeof then === 'function') {
          try { void Promise.resolve(preparation).catch(() => undefined); }
          catch { /* outcome remains unknown */ }
          return {
            kind: 'unknown',
            message: 'ordinary ingress Current preparation must return synchronously',
          };
        }
      }
      if (!preparation || preparation.kind !== 'ready') {
        return {
          kind: 'unknown',
          message: preparation && preparation.kind === 'unknown'
            ? preparation.message
            : 'ordinary ingress Current preparation returned an invalid result',
        };
      }
      if (!resolveCurrent(resolved.stamp, prepared.turn)) {
        return {
          kind: 'unknown',
          message: 'Current Session identity changed during ordinary ingress Current preparation',
        };
      }
    }
    const arrival = reserveArrival(resolved.stamp);
    const intent = frozenToken();
    const continuation = frozenToken();
    const effect = Object.freeze({ kind: 'materialize' as const, input });
    effects.set(intent, { effect, arrival });
    continuations.set(continuation, {
      binding: resolved.stamp,
      input,
      arrival,
    });
    return { kind: 'effect', intent, continuation };
  };

  const execute: OrdinaryIngressPort['execute'] = async (intent) => {
    if (!isObject(intent)) {
      throw new Error('invalid Current ordinary ingress effect token');
    }
    const plan = effects.get(intent);
    if (!plan) throw new Error('Current ordinary ingress effect token was already consumed');
    effects.delete(intent);

    let materialization: Promise<
      | { kind: 'returned'; value: CurrentOrdinaryIngressExternalEffectResult }
      | { kind: 'threw'; error: unknown }
    >;
    try {
      materialization = Promise.resolve(options.externalEffects.execute(plan.effect)).then(
        value => ({ kind: 'returned' as const, value }),
        error => ({ kind: 'threw' as const, error }),
      );
    } catch (error) {
      materialization = Promise.resolve({ kind: 'threw', error });
    }
    const settled = await materialization;
    await plan.arrival.ready;
    if (settled.kind === 'threw') throw settled.error;
    return settled.value;
  };

  const resume: OrdinaryIngressPort['resume'] = (
    continuation,
    settlement: OrdinaryIngressEffectSettlement,
  ) => {
    if (!isObject(continuation)) {
      return { kind: 'unknown', message: 'invalid Current ordinary ingress continuation token' };
    }
    const plan = continuations.get(continuation);
    if (!plan) {
      return {
        kind: 'unknown',
        message: 'Current ordinary ingress continuation token was already consumed',
      };
    }
    continuations.delete(continuation);

    try {
      if (!resolveCurrent(plan.binding, plan.input.turn)) {
        return {
          kind: 'unknown',
          message: 'Current Session identity changed while ordinary ingress outcome was in flight',
        };
      }
      if (settlement.kind === 'threw') {
        return {
          kind: 'unknown',
          message: `ordinary ingress materialization outcome is unknown: ${settlement.error instanceof Error
            ? settlement.error.message
            : String(settlement.error)}`,
        };
      }

      const materialization = settlement.value as Partial<CurrentOrdinaryIngressExternalEffectResult> | null;
      if (!materialization || typeof materialization !== 'object') {
        return { kind: 'unknown', message: 'ordinary ingress materializer returned an invalid result' };
      }
      if (materialization.kind === 'refused') {
        return {
          kind: 'notCommitted',
          message: typeof materialization.message === 'string'
            ? materialization.message
            : 'ordinary ingress materializer refused the turn',
        };
      }
      if (materialization.kind === 'unknown') {
        return {
          kind: 'unknown',
          message: typeof materialization.message === 'string'
            ? materialization.message
            : 'ordinary ingress materialization outcome is unknown',
        };
      }
      if (materialization.kind !== 'materialized') {
        return { kind: 'unknown', message: 'ordinary ingress materializer returned an invalid result' };
      }

      let openingClaimed = false;
      for (let reclassifications = 0; ; reclassifications += 1) {
        const current = resolveCurrent(plan.binding, plan.input.turn);
        if (!current) {
          return {
            kind: 'unknown',
            message: 'Current Session identity changed before ordinary ingress delivery',
          };
        }
        const commandKind = classify(current);
        if (!openingClaimed && canOwnOpening(commandKind)) {
          openingClaimed = claimInitialUserTurn(current);
        }
        const command = Object.freeze({
          kind: commandKind,
          input: Object.freeze({ ...plan.input, opening: openingClaimed }),
          guard: Object.freeze({ workerGeneration: current.workerGeneration }),
        });
        let commandResult: CurrentOrdinaryIngressCommandResult;
        try {
          commandResult = options.commands.apply(command);
        } catch (error) {
          return {
            kind: 'unknown',
            message: `ordinary ingress command outcome is unknown: ${error instanceof Error
              ? error.message
              : String(error)}`,
          };
        }
        let commandResultKind: unknown;
        let commandResultMessage: unknown;
        if (isObject(commandResult)) {
          let then: unknown;
          try {
            then = (commandResult as { readonly then?: unknown }).then;
          } catch {
            return {
              kind: 'unknown',
              message: 'Current ordinary ingress command Adapter must return synchronously',
            };
          }
          if (typeof then === 'function') {
            try {
              void Promise.resolve(commandResult).catch(() => undefined);
            } catch {
              // A hostile thenable can throw during assimilation; the outcome
              // remains unknown and must never be replayed.
            }
            return {
              kind: 'unknown',
              message: 'Current ordinary ingress command Adapter must return synchronously',
            };
          }
          try {
            commandResultKind = (commandResult as { readonly kind?: unknown }).kind;
            commandResultMessage = (commandResult as { readonly message?: unknown }).message;
          } catch {
            return {
              kind: 'unknown',
              message: 'Current ordinary ingress command returned an unreadable result',
            };
          }
        }
        if (!resolveCurrent(plan.binding, plan.input.turn)) {
          return {
            kind: 'unknown',
            message: 'Current Session identity changed during ordinary ingress delivery',
          };
        }
        if (!commandResult || typeof commandResult !== 'object') {
          return { kind: 'unknown', message: 'ordinary ingress command returned an invalid result' };
        }
        if (commandResultKind === 'accepted') return { kind: 'committed' };
        if (commandResultKind === 'refused') {
          releaseOpening(plan, openingClaimed);
          return {
            kind: 'notCommitted',
            message: typeof commandResultMessage === 'string'
              ? commandResultMessage
              : 'ordinary ingress command refused the turn',
          };
        }
        if (commandResultKind === 'unknown') {
          return {
            kind: 'unknown',
            message: typeof commandResultMessage === 'string'
              ? commandResultMessage
              : 'ordinary ingress command outcome is unknown',
          };
        }
        if (commandResultKind !== 'stateChanged') {
          return { kind: 'unknown', message: 'ordinary ingress command returned an invalid result' };
        }
        if (reclassifications >= MAX_STATE_RECLASSIFICATIONS) {
          return {
            kind: 'unknown',
            message: 'ordinary ingress delivery state did not stabilize before the retry limit',
          };
        }
      }
    } finally {
      releaseArrival(plan.arrival);
    }
  };

  return { begin, execute, resume };
}
