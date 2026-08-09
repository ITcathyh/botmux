/**
 * Current existing-route policy for ordinary IM turns.
 *
 * This Adapter owns only the synchronous classification around an asynchronous
 * boundary. It does not drive a real worker yet: production composition must
 * provide the boundary driver. Runtime sees only one-shot opaque effect and
 * continuation tokens, so neither mutable Session state nor a route decision
 * can escape the Session lane.
 */

import { types as nodeUtilTypes } from 'node:util';

import type { Session } from '../types.js';
import {
  createCurrentOrdinaryImTurnPreparationPort,
  CurrentOrdinaryImTurnPreparationPort,
  OrdinaryImTransportEnvelope,
  PreparedOrdinaryImTurn,
} from './current-ordinary-im-turn.js';
import type {
  OrdinaryIngressEffectSettlement,
  OrdinaryIngressPort,
  OrdinaryIngressTransitionResult,
} from './session-runtime.js';
import {
  claimInitialUserTurn,
  releaseInitialUserTurn,
} from './initial-user-turn.js';
import {
  activeSessionKey,
  sessionAnchorId,
  sessionKey,
  type DaemonSession,
} from './types.js';

export type CurrentOrdinaryIngressBoundaryResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string }
  | { readonly kind: 'stateChanged' };

/** Detached input for the not-yet-wired production boundary. */
export interface CurrentOrdinaryIngressBoundaryInput {
  readonly sessionId: string;
  readonly turn: PreparedOrdinaryImTurn;
  /**
   * Whether this delivery owns the current empty-start marker. Persistence
   * keeps the legacy best-effort semantics and is not a durable receipt.
   */
  readonly opening: boolean;
}

export interface CurrentOrdinaryIngressBoundaryDriver {
  sendLive(
    input: CurrentOrdinaryIngressBoundaryInput,
  ): Promise<CurrentOrdinaryIngressBoundaryResult>;
  parkOpeningFollower(
    input: CurrentOrdinaryIngressBoundaryInput,
  ): Promise<CurrentOrdinaryIngressBoundaryResult>;
  parkPendingRepoFollower(
    input: CurrentOrdinaryIngressBoundaryInput,
  ): Promise<CurrentOrdinaryIngressBoundaryResult>;
  startColdReplacement(
    input: CurrentOrdinaryIngressBoundaryInput,
  ): Promise<CurrentOrdinaryIngressBoundaryResult>;
  startQueuedActivation(
    input: CurrentOrdinaryIngressBoundaryInput,
  ): Promise<CurrentOrdinaryIngressBoundaryResult>;
  recoverParkedActivation(
    input: CurrentOrdinaryIngressBoundaryInput,
  ): Promise<CurrentOrdinaryIngressBoundaryResult>;
}

export interface CurrentOrdinaryIngressOptions {
  readonly ownerLarkAppId: string;
  readonly activeSessions: ReadonlyMap<string, DaemonSession>;
  readonly turnPreparation: CurrentOrdinaryImTurnPreparationPort;
  readonly boundaryDriver: CurrentOrdinaryIngressBoundaryDriver;
}

type BoundaryMethod = keyof CurrentOrdinaryIngressBoundaryDriver;

interface CurrentIdentity {
  readonly key: string;
  readonly sessionId: string;
  readonly daemonSession: DaemonSession;
  readonly session: Session;
}

interface EffectPlan {
  readonly method: BoundaryMethod;
  readonly input: CurrentOrdinaryIngressBoundaryInput;
}

interface ContinuationPlan {
  readonly identity: CurrentIdentity;
  readonly turn: PreparedOrdinaryImTurn;
  readonly openingClaimed: boolean;
  readonly reclassifications: number;
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
    && sessionAnchorId(ds) === turn.route.canonicalAnchor;
}

function preparedSemanticsMatch(
  input: OrdinaryImTransportEnvelope,
  prepared: PreparedOrdinaryImTurn,
): boolean {
  try {
    if (!Array.isArray(input.attachments)
      || !Array.isArray(input.mentions)
      || !Array.isArray(prepared.attachments)
      || !Array.isArray(prepared.mentions)) {
      return false;
    }
    const inputSemantics = {
      route: {
        scope: input.route.scope,
        canonicalAnchor: input.route.canonicalAnchor,
        chatId: input.route.chatId,
        chatType: input.route.chatType,
      },
      source: input.source,
      messageKey: input.messageKey,
      content: input.content,
      sender: {
        kind: input.sender.kind,
        openId: input.sender.openId,
        name: input.sender.name,
      },
      attachments: input.attachments.map(attachment => ({
        type: attachment.type,
        resourceKey: attachment.resourceKey,
        sourceMessageKey: attachment.sourceMessageKey ?? input.messageKey,
        name: attachment.name,
      })),
      mentions: input.mentions.map(mention => ({
        key: mention.key,
        name: mention.name,
        openId: mention.openId,
        kind: mention.kind,
      })),
    };
    const preparedSemantics = {
      route: {
        scope: prepared.route.scope,
        canonicalAnchor: prepared.route.canonicalAnchor,
        chatId: prepared.route.chatId,
        chatType: prepared.route.chatType,
      },
      source: prepared.source,
      messageKey: prepared.messageKey,
      content: prepared.content,
      sender: {
        kind: prepared.sender.kind,
        openId: prepared.sender.openId,
        name: prepared.sender.name,
      },
      attachments: prepared.attachments.map(attachment => ({
        type: attachment.type,
        resourceKey: attachment.resourceKey,
        sourceMessageKey: attachment.sourceMessageKey,
        name: attachment.name,
      })),
      mentions: prepared.mentions.map(mention => ({
        key: mention.key,
        name: mention.name,
        openId: mention.openId,
        kind: mention.kind,
      })),
    };
    return JSON.stringify(preparedSemantics) === JSON.stringify(inputSemantics);
  } catch {
    return false;
  }
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

function classify(ds: DaemonSession): BoundaryMethod {
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

function canOwnOpening(method: BoundaryMethod): boolean {
  return method === 'sendLive'
    || method === 'startColdReplacement';
}

/**
 * Build the Current staged port. `begin` and `resume` are synchronous lane
 * transitions; `execute` performs exactly one injected boundary call outside
 * the lane.
 */
export function createCurrentOrdinaryIngressPort(
  options: CurrentOrdinaryIngressOptions,
): OrdinaryIngressPort {
  const trustedTurnPreparation = createCurrentOrdinaryImTurnPreparationPort();
  const effects = new WeakMap<object, EffectPlan>();
  const continuations = new WeakMap<object, ContinuationPlan>();

  const resolveIdentity = (
    sessionId: string,
    turn: OrdinaryImTransportEnvelope | PreparedOrdinaryImTurn,
  ): CurrentIdentity | undefined => {
    const key = sessionKey(turn.route.canonicalAnchor, options.ownerLarkAppId);
    const ds = options.activeSessions.get(key);
    if (!ds
      || activeSessionKey(ds) !== key
      || ds.larkAppId !== options.ownerLarkAppId
      || ds.session.sessionId !== sessionId
      || !routeMatches(ds, turn)) {
      return undefined;
    }
    return {
      key,
      sessionId: ds.session.sessionId,
      daemonSession: ds,
      session: ds.session,
    };
  };

  const identityIsCurrent = (
    identity: CurrentIdentity,
    turn: OrdinaryImTransportEnvelope | PreparedOrdinaryImTurn,
  ): boolean => {
    const current = options.activeSessions.get(identity.key);
    return current === identity.daemonSession
      && current.session === identity.session
      && current.session.sessionId === identity.sessionId
      && current.larkAppId === options.ownerLarkAppId
      && activeSessionKey(current) === identity.key
      && routeMatches(current, turn);
  };

  const nextEffect = (
    plan: ContinuationPlan,
  ): OrdinaryIngressTransitionResult => {
    const method = classify(plan.identity.daemonSession);
    let openingClaimed = plan.openingClaimed;
    if (!openingClaimed
      && canOwnOpening(method)
      && claimInitialUserTurn(plan.identity.daemonSession)) {
      openingClaimed = true;
    }

    const input = Object.freeze({
      sessionId: plan.identity.session.sessionId,
      turn: plan.turn,
      opening: openingClaimed,
    });
    const intent = frozenToken();
    const continuation = frozenToken();
    effects.set(intent, { method, input });
    continuations.set(continuation, {
      identity: plan.identity,
      turn: plan.turn,
      openingClaimed,
      reclassifications: plan.reclassifications,
    });
    return { kind: 'effect', intent, continuation };
  };

  const begin: OrdinaryIngressPort['begin'] = ({ sessionId, turn }) => {
    const identity = resolveIdentity(sessionId, turn);
    if (!identity) {
      return {
        kind: 'notCommitted',
        message: 'Current ordinary ingress route is no longer owned by this Session',
      };
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
      return {
        kind: 'notCommitted',
        message: prepared.message,
      };
    }
    const trustedPrepared = trustedTurnPreparation.prepare(turn);
    if (trustedPrepared.kind !== 'prepared'
      || !exactPreparedOutputMatches(prepared.turn, trustedPrepared.turn)) {
      return {
        kind: 'unknown',
        message: 'ordinary IM turn preparation violated the exact compiler contract',
      };
    }
    if (!preparedSemanticsMatch(turn, prepared.turn)) {
      return {
        kind: 'unknown',
        message: 'ordinary IM turn preparation changed transport semantics',
      };
    }
    if (!identityIsCurrent(identity, prepared.turn)) {
      return {
        kind: 'notCommitted',
        message: 'Current Session identity changed during ordinary IM turn preparation',
      };
    }
    return nextEffect({
      identity,
      turn: prepared.turn,
      openingClaimed: false,
      reclassifications: 0,
    });
  };

  const execute: OrdinaryIngressPort['execute'] = async (intent) => {
    if ((typeof intent !== 'object' && typeof intent !== 'function') || intent === null) {
      throw new Error('invalid Current ordinary ingress effect token');
    }
    const plan = effects.get(intent);
    if (!plan) throw new Error('Current ordinary ingress effect token was already consumed');
    effects.delete(intent);
    return options.boundaryDriver[plan.method](plan.input);
  };

  const resume: OrdinaryIngressPort['resume'] = (
    continuation,
    settlement: OrdinaryIngressEffectSettlement,
  ) => {
    if ((typeof continuation !== 'object' && typeof continuation !== 'function')
      || continuation === null) {
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

    if (!identityIsCurrent(plan.identity, plan.turn)) {
      return {
        kind: 'unknown',
        message: 'Current Session identity changed while ordinary ingress outcome was in flight',
      };
    }
    if (settlement.kind === 'threw') {
      return {
        kind: 'unknown',
        message: `ordinary ingress boundary outcome is unknown: ${settlement.error instanceof Error
          ? settlement.error.message
          : String(settlement.error)}`,
      };
    }

    const boundaryResult = settlement.value as Partial<CurrentOrdinaryIngressBoundaryResult> | null;
    if (!boundaryResult || typeof boundaryResult !== 'object') {
      return { kind: 'unknown', message: 'ordinary ingress boundary returned an invalid result' };
    }
    if (boundaryResult.kind === 'accepted') return { kind: 'committed' };
    if (boundaryResult.kind === 'refused') {
      if (plan.openingClaimed && identityIsCurrent(plan.identity, plan.turn)) {
        releaseInitialUserTurn(plan.identity.daemonSession);
      }
      return {
        kind: 'notCommitted',
        message: typeof boundaryResult.message === 'string'
          ? boundaryResult.message
          : 'ordinary ingress boundary refused the turn',
      };
    }
    if (boundaryResult.kind === 'unknown') {
      return {
        kind: 'unknown',
        message: typeof boundaryResult.message === 'string'
          ? boundaryResult.message
          : 'ordinary ingress boundary outcome is unknown',
      };
    }
    if (boundaryResult.kind === 'stateChanged') {
      if (plan.reclassifications >= MAX_STATE_RECLASSIFICATIONS) {
        return {
          kind: 'unknown',
          message: 'ordinary ingress delivery state did not stabilize before the retry limit',
        };
      }
      return nextEffect({
        ...plan,
        reclassifications: plan.reclassifications + 1,
      });
    }
    return { kind: 'unknown', message: 'ordinary ingress boundary returned an invalid result' };
  };

  return { begin, execute, resume };
}
