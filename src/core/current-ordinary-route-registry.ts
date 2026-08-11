/**
 * Owner-scoped Current route registry for ordinary ingress.
 *
 * Provider-message admission happens before a Session identity is resolved.
 * The injected creator owns every daemon/Lark opening decision; this Module
 * only proves exact-one-or-create, installs the returned Current binding, and
 * forwards the unchanged command through the downstream Session address/lane.
 */

import { computeInputHash } from '../utils/canonical-input-hash.js';
import * as sessionStore from '../services/session-store.js';
import type { Session } from '../types.js';
import {
  normalizeOrdinaryImTurn,
  type NormalizedOrdinaryImTurn,
} from './ordinary-im-turn.js';
import type {
  CommandOutcomeFor,
  OrdinaryIngressCommand,
  OrdinaryIngressCommandOutcome,
  SessionCommand,
  SessionCommandRequest,
  SessionCommandRoute,
  SessionProjection,
  SessionRuntime,
} from './session-runtime.js';
import {
  activeSessionAnchorId,
  activeSessionKey,
  storedActiveSessionAnchorId,
  type DaemonSession,
} from './types.js';
import {
  currentRouteAdmissionKey,
  reserveCurrentRouteAdmission,
} from './current-route-admission.js';

declare const currentOrdinaryRouteOpeningPostCommitTokenBrand: unique symbol;
declare const currentOrdinaryRouteOpeningRollbackTokenBrand: unique symbol;

/** Opaque one-shot capability minted by a production opening creator. */
export type CurrentOrdinaryRouteOpeningPostCommitToken = Readonly<{
  readonly [currentOrdinaryRouteOpeningPostCommitTokenBrand]: true;
}>;

/** Exact provisional publication lease; only its creator can roll it back. */
export type CurrentOrdinaryRouteOpeningRollbackToken = Readonly<{
  readonly [currentOrdinaryRouteOpeningRollbackTokenBrand]: true;
}>;

export type CurrentOrdinaryRouteOpeningRollbackResult =
  | { readonly kind: 'rolledBack' }
  | { readonly kind: 'unknown'; readonly message: string };

export type CurrentOrdinaryRouteOpeningCreationResult =
  | {
      readonly kind: 'created';
      readonly current: DaemonSession;
      readonly rollbackToken: CurrentOrdinaryRouteOpeningRollbackToken;
      readonly postCommitToken?: CurrentOrdinaryRouteOpeningPostCommitToken;
    }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

export type CurrentOrdinaryRouteOpeningEffectSettlement =
  | { readonly kind: 'returned'; readonly value: unknown }
  | { readonly kind: 'threw'; readonly error: unknown }
  | { readonly kind: 'superseded' };

export type CurrentOrdinaryRouteOpeningBeginResult =
  | Extract<CurrentOrdinaryRouteOpeningCreationResult, { readonly kind: 'refused' | 'unknown' }>
  | {
      readonly kind: 'effect';
      readonly intent: unknown;
      readonly continuation: unknown;
    };

/** Production owns this capability; the route registry never invents opening state. */
export interface CurrentOrdinaryRouteOpeningCreator {
  begin(
    turn: NormalizedOrdinaryImTurn,
  ): CurrentOrdinaryRouteOpeningBeginResult;
  execute(intent: unknown): Promise<unknown>;
  resume(
    continuation: unknown,
    settlement: CurrentOrdinaryRouteOpeningEffectSettlement,
  ): CurrentOrdinaryRouteOpeningCreationResult;
  /** Synchronously removes one exact provisional opening after proven no-commit. */
  rollback(
    token: CurrentOrdinaryRouteOpeningRollbackToken,
  ): CurrentOrdinaryRouteOpeningRollbackResult;
  /** Runs after the downstream ordinary Session lane has settled committed. */
  dispatchPostCommit?(token: CurrentOrdinaryRouteOpeningPostCommitToken): void;
}

interface DownstreamCurrentSessionHost {
  readonly runtime: SessionRuntime;
  readonly projection: SessionProjection;
}

export interface CurrentOrdinaryRouteRegistryOptions {
  readonly ownerLarkAppId: string;
  readonly activeSessions: Map<string, DaemonSession>;
  readonly openingCreator: CurrentOrdinaryRouteOpeningCreator;
  readonly downstream: DownstreamCurrentSessionHost;
}

type RouteResolution =
  | {
      readonly kind: 'resolved';
      readonly sessionId: string;
      readonly binding: RouteBinding;
      readonly rollbackToken?: CurrentOrdinaryRouteOpeningRollbackToken;
      readonly postCommitToken?: CurrentOrdinaryRouteOpeningPostCommitToken;
    }
  | { readonly kind: 'none' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string }
  | { readonly kind: 'quarantined'; readonly message: string };

interface RouteBinding {
  readonly key: string;
  readonly current: DaemonSession;
  readonly session: Session;
  readonly route: NormalizedOrdinaryImTurn['route'];
}

interface ProviderAttempt {
  readonly terminal: Promise<OrdinaryIngressCommandOutcome>;
  settle(outcome: OrdinaryIngressCommandOutcome): void;
}

type ProviderRecord =
  | {
      readonly requestHash: string;
      readonly state: 'received';
      readonly attempt: ProviderAttempt;
    }
  | {
      readonly requestHash: string;
      readonly state: 'inputCommitted';
      readonly sessionId: string;
    }
  | {
      readonly requestHash: string;
      readonly state: 'terminal';
      readonly outcome: Extract<
        OrdinaryIngressCommandOutcome,
        { readonly kind: 'ambiguous' | 'quarantined' }
      >;
    };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function isThenable(value: unknown): boolean {
  if (!isObject(value)) return false;
  try {
    return typeof value.then === 'function';
  } catch {
    return true;
  }
}

function detachThenable(value: unknown): void {
  if (!isObject(value)) return;
  try {
    void Promise.resolve(value).catch(() => undefined);
  } catch {
    // An unreadable thenable is already quarantined by the caller.
  }
}

function routeMatchesTurn(
  route: SessionCommandRoute,
  turn: NormalizedOrdinaryImTurn,
): boolean {
  return route.kind !== 'idempotency'
    && route.kind !== 'schedule'
    && route.kind === turn.route.scope
    && (route.kind === 'thread'
      ? route.anchorId === turn.route.canonicalAnchor
      : route.chatId === turn.route.chatId);
}

function liveMatchesTurn(
  current: DaemonSession,
  ownerLarkAppId: string,
  turn: NormalizedOrdinaryImTurn,
): boolean {
  return current.larkAppId === ownerLarkAppId
    && (current.session.larkAppId === undefined
      || current.session.larkAppId === ownerLarkAppId)
    && current.session.status === 'active'
    && current.scope === turn.route.scope
    && current.session.scope === turn.route.scope
    && activeSessionAnchorId(current) === turn.route.canonicalAnchor
    && current.chatId === turn.route.chatId
    && current.session.chatId === turn.route.chatId
    && current.chatType === turn.route.chatType
    && current.session.chatType === turn.route.chatType;
}

function bindingFor(
  current: DaemonSession,
  turn: NormalizedOrdinaryImTurn,
): RouteBinding {
  return {
    key: activeSessionKey(current),
    current,
    session: current.session,
    route: Object.freeze({ ...turn.route }),
  };
}

function sameRoute(
  left: NormalizedOrdinaryImTurn['route'],
  right: NormalizedOrdinaryImTurn['route'],
): boolean {
  return left.scope === right.scope
    && left.canonicalAnchor === right.canonicalAnchor
    && left.chatId === right.chatId
    && left.chatType === right.chatType;
}

function bindingIsCurrent(
  options: Pick<CurrentOrdinaryRouteRegistryOptions, 'ownerLarkAppId' | 'activeSessions'>,
  binding: RouteBinding,
  turn: NormalizedOrdinaryImTurn,
): boolean {
  const current = options.activeSessions.get(binding.key);
  return current === binding.current
    && current.session === binding.session
    && activeSessionKey(current) === binding.key
    && current.session.sessionId === binding.session.sessionId
    && sameRoute(binding.route, turn.route)
    && liveMatchesTurn(current, options.ownerLarkAppId, turn);
}

function storedMatchesTurn(
  session: Session,
  turn: NormalizedOrdinaryImTurn,
): boolean {
  const scope = session.scope === 'chat' ? 'chat' : 'thread';
  return session.status === 'active'
    && scope === turn.route.scope
    && storedActiveSessionAnchorId(session) === turn.route.canonicalAnchor
    && session.chatId === turn.route.chatId
    && (session.chatType ?? 'group') === turn.route.chatType;
}

function duplicate(sessionId: string): OrdinaryIngressCommandOutcome {
  return {
    kind: 'duplicate',
    state: 'inputCommitted',
    policy: 'ordinary-replayable',
    durability: 'processLocal',
    sessionId,
    message: 'ordinary provider message joined the Current route winner',
  };
}

function createAttempt(): ProviderAttempt {
  let resolveTerminal!: (outcome: OrdinaryIngressCommandOutcome) => void;
  let settled = false;
  const terminal = new Promise<OrdinaryIngressCommandOutcome>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    terminal,
    settle(outcome) {
      if (settled) return;
      settled = true;
      resolveTerminal(outcome);
    },
  };
}

type OpeningTransitionSnapshot =
  | { readonly kind: 'effect'; readonly intent: object; readonly continuation: object }
  | {
      readonly kind: 'created';
      readonly current: DaemonSession;
      readonly rollbackToken: CurrentOrdinaryRouteOpeningRollbackToken;
      readonly postCommitToken?: CurrentOrdinaryRouteOpeningPostCommitToken;
    }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

type OpeningBeginSnapshot = Extract<
  OpeningTransitionSnapshot,
  { readonly kind: 'effect' | 'refused' | 'unknown' }
>;

type OpeningResumeSnapshot = Extract<
  OpeningTransitionSnapshot,
  { readonly kind: 'created' | 'refused' | 'unknown' }
>;

function inspectOpeningTransition(
  value: unknown,
  phase: 'begin',
): OpeningBeginSnapshot;
function inspectOpeningTransition(
  value: unknown,
  phase: 'resume',
): OpeningResumeSnapshot;

function inspectOpeningTransition(
  value: unknown,
  phase: 'begin' | 'resume',
): OpeningTransitionSnapshot {
  if (isThenable(value)) {
    detachThenable(value);
    return {
      kind: 'unknown',
      message: `Current ordinary opening ${phase} must return synchronously`,
    };
  }
  try {
    if (!isObject(value)) {
      return {
        kind: 'unknown',
        message: `Current ordinary opening ${phase} returned no result`,
      };
    }
    const kind = value.kind;
    if (kind === 'refused' || kind === 'unknown') {
      const transitionMessage = value.message;
      return typeof transitionMessage === 'string'
        ? { kind, message: transitionMessage }
        : {
            kind: 'unknown',
            message: `Current ordinary opening ${phase} returned ${kind} without a message`,
          };
    }
    if (phase === 'begin' && kind === 'effect') {
      const intent = value.intent;
      const continuation = value.continuation;
      if (!isObject(intent) || !isObject(continuation) || intent === continuation) {
        return {
          kind: 'unknown',
          message: 'Current ordinary opening begin returned invalid effect capabilities',
        };
      }
      return { kind: 'effect', intent, continuation };
    }
    if (phase === 'resume' && kind === 'created') {
      const current = value.current;
      const rollbackToken = value.rollbackToken;
      const postCommitToken = value.postCommitToken;
      if (!isObject(current)
          || !isObject(rollbackToken)
          || (postCommitToken !== undefined && !isObject(postCommitToken))) {
        return {
          kind: 'unknown',
          message: 'Current ordinary opening resume returned an invalid creation result',
        };
      }
      return {
        kind: 'created',
        current: current as unknown as DaemonSession,
        rollbackToken: rollbackToken as CurrentOrdinaryRouteOpeningRollbackToken,
        ...(postCommitToken === undefined
          ? {}
          : {
              postCommitToken: postCommitToken as CurrentOrdinaryRouteOpeningPostCommitToken,
            }),
      };
    }
    return {
      kind: 'unknown',
      message: `Current ordinary opening ${phase} returned an invalid transition`,
    };
  } catch (error) {
    return {
      kind: 'unknown',
      message: `Current ordinary opening ${phase} result is unreadable: ${message(error)}`,
    };
  }
}

class CurrentOrdinaryRouteRegistry {
  constructor(private readonly options: Pick<
    CurrentOrdinaryRouteRegistryOptions,
    'ownerLarkAppId' | 'activeSessions' | 'openingCreator'
  >) {}

  private inspectExisting(turn: NormalizedOrdinaryImTurn): RouteResolution {
    let persisted: Session[];
    try {
      persisted = sessionStore.listSessionsForOwnerStrict(this.options.ownerLarkAppId);
    } catch (error) {
      return {
        kind: 'quarantined',
        message: `Current ordinary route source is unreadable: ${message(error)}`,
      };
    }

    const persistedById = new Map(persisted.map(session => [session.sessionId, session]));
    const liveById = new Map<string, DaemonSession>();
    for (const [key, current] of this.options.activeSessions) {
      if (!liveMatchesTurn(current, this.options.ownerLarkAppId, turn)) continue;
      if (key !== activeSessionKey(current)) {
        return {
          kind: 'quarantined',
          message: 'Current ordinary route has a live owner under a stale registry key',
        };
      }
      const prior = liveById.get(current.session.sessionId);
      if (prior && prior !== current) {
        return {
          kind: 'quarantined',
          message: 'Current ordinary route has multiple active owner bindings for one Session',
        };
      }
      const durable = persistedById.get(current.session.sessionId);
      if (durable && !storedMatchesTurn(durable, turn)) {
        return {
          kind: 'quarantined',
          message: 'Current ordinary route live and durable bindings disagree',
        };
      }
      liveById.set(current.session.sessionId, current);
    }

    const candidates = new Set(liveById.keys());
    for (const session of persisted) {
      if (storedMatchesTurn(session, turn)) candidates.add(session.sessionId);
    }
    if (candidates.size > 1) {
      return {
        kind: 'quarantined',
        message: 'Current ordinary route has multiple active owner bindings',
      };
    }
    const [sessionId] = candidates;
    if (sessionId !== undefined) {
      if (!liveById.has(sessionId)) {
        return {
          kind: 'quarantined',
          message: 'Current ordinary route has a durable owner without an active runtime binding',
        };
      }
      const current = liveById.get(sessionId)!;
      return {
        kind: 'resolved',
        sessionId,
        binding: bindingFor(current, turn),
      };
    }
    return { kind: 'none' };
  }

  private begin(turn: NormalizedOrdinaryImTurn): OpeningBeginSnapshot {
    let result: unknown;
    try {
      result = this.options.openingCreator.begin(turn);
    } catch (error) {
      return {
        kind: 'unknown',
        message: `Current ordinary opening begin failed: ${message(error)}`,
      };
    }
    return inspectOpeningTransition(result, 'begin');
  }

  private resume(
    continuation: object,
    settlement: CurrentOrdinaryRouteOpeningEffectSettlement,
  ): OpeningResumeSnapshot {
    let result: unknown;
    try {
      result = this.options.openingCreator.resume(continuation, settlement);
    } catch (error) {
      return {
        kind: 'unknown',
        message: `Current ordinary opening resume failed: ${message(error)}`,
      };
    }
    return inspectOpeningTransition(result, 'resume');
  }

  private cancel(
    continuation: object,
  ): Extract<RouteResolution, { readonly kind: 'unknown' }> | undefined {
    const cancelled = this.resume(continuation, { kind: 'superseded' });
    if (cancelled.kind === 'refused') return undefined;
    return {
      kind: 'unknown',
      message: cancelled.kind === 'unknown'
        ? cancelled.message
        : 'Current ordinary opening supersession did not cancel without publication',
    };
  }

  private publish(
    turn: NormalizedOrdinaryImTurn,
    created: Extract<OpeningTransitionSnapshot, { readonly kind: 'created' }>,
  ): RouteResolution {
    try {
      const { current, rollbackToken, postCommitToken } = created;
      if (!liveMatchesTurn(current, this.options.ownerLarkAppId, turn)) {
        return {
          kind: 'unknown',
          message: 'Current ordinary opening creator returned a mismatched Session binding',
        };
      }
      if (current.session.initialUserTurnPending !== true) {
        return {
          kind: 'unknown',
          message: 'Current ordinary opening creator returned no opening reservation',
        };
      }
      const durable = sessionStore.getSessionForOwnerStrict(
        this.options.ownerLarkAppId,
        current.session.sessionId,
      );
      if (!durable || !storedMatchesTurn(durable, turn)
          || durable.initialUserTurnPending !== true) {
        return {
          kind: 'unknown',
          message: 'Current ordinary opening creator did not publish its exact opening Session',
        };
      }
      const collisions = sessionStore.listSessionsForOwnerStrict(this.options.ownerLarkAppId)
        .filter(session => storedMatchesTurn(session, turn));
      if (new Set(collisions.map(session => session.sessionId)).size !== 1) {
        return {
          kind: 'unknown',
          message: 'Current ordinary opening creation produced multiple active owner bindings',
        };
      }
      const key = activeSessionKey(current);
      const incumbent = this.options.activeSessions.get(key);
      if (incumbent && incumbent !== current) {
        return {
          kind: 'unknown',
          message: 'Current ordinary opening creation lost its exact registry slot',
        };
      }
      this.options.activeSessions.set(key, current);
      return {
        kind: 'resolved',
        sessionId: current.session.sessionId,
        binding: bindingFor(current, turn),
        rollbackToken,
        ...(postCommitToken === undefined
          ? {}
          : {
              postCommitToken,
            }),
      };
    } catch (error) {
      return {
        kind: 'unknown',
        message: `Current ordinary opening result is unreadable: ${message(error)}`,
      };
    }
  }

  private async create(turn: NormalizedOrdinaryImTurn): Promise<RouteResolution> {
    const begun = this.begin(turn);
    if (begun.kind !== 'effect') return begun;

    let settlement: CurrentOrdinaryRouteOpeningEffectSettlement;
    try {
      settlement = {
        kind: 'returned',
        value: await this.options.openingCreator.execute(begun.intent),
      };
    } catch (error) {
      settlement = { kind: 'threw', error };
    }

    const current = this.inspectExisting(turn);
    if (current.kind !== 'none') {
      const cancellation = this.cancel(begun.continuation);
      return cancellation ?? current;
    }

    const resumed = this.resume(begun.continuation, settlement);
    if (resumed.kind === 'created') return this.publish(turn, resumed);
    return resumed;
  }

  async resolveOrCreate(turn: NormalizedOrdinaryImTurn): Promise<RouteResolution> {
    const existing = this.inspectExisting(turn);
    return existing.kind === 'none' ? await this.create(turn) : existing;
  }
}

/**
 * Wrap one Current Host runtime with owner/provider route admission. All
 * Session-targeted commands and every non-ordinary route remain untouched.
 */
export function createCurrentOrdinaryRouteRegistryRuntime(
  options: CurrentOrdinaryRouteRegistryOptions,
): SessionRuntime {
  const registry = new CurrentOrdinaryRouteRegistry(options);
  const providerRecords = new Map<string, ProviderRecord>();
  const pendingPostCommits = new Map<string, CurrentOrdinaryRouteOpeningPostCommitToken>();
  const postCommitKey = (sessionId: string, providerKey: string): string => (
    `${sessionId}\u0000${providerKey}`
  );
  const routeUnknowns = new Map<string, string>();
  const routeAdmissionKey = (turn: NormalizedOrdinaryImTurn): string => (
    currentRouteAdmissionKey({
      ownerLarkAppId: options.ownerLarkAppId,
      scope: turn.route.scope,
      canonicalAnchor: turn.route.canonicalAnchor,
      chatId: turn.route.chatId,
      chatType: turn.route.chatType,
    })
  );

  const rollbackOpening = (
    token: CurrentOrdinaryRouteOpeningRollbackToken,
  ): CurrentOrdinaryRouteOpeningRollbackResult => {
    let result: unknown;
    try {
      result = options.openingCreator.rollback(token);
    } catch (error) {
      return {
        kind: 'unknown',
        message: `Current ordinary opening rollback failed: ${message(error)}`,
      };
    }
    if (isThenable(result)) {
      detachThenable(result);
      return {
        kind: 'unknown',
        message: 'Current ordinary opening rollback must return synchronously',
      };
    }
    try {
      if (isObject(result) && result.kind === 'rolledBack') return { kind: 'rolledBack' };
      if (isObject(result)
          && result.kind === 'unknown'
          && typeof result.message === 'string') {
        return { kind: 'unknown', message: result.message };
      }
      return {
        kind: 'unknown',
        message: 'Current ordinary opening rollback returned an invalid result',
      };
    } catch (error) {
      return {
        kind: 'unknown',
        message: `Current ordinary opening rollback result is unreadable: ${message(error)}`,
      };
    }
  };

  const provesNoOrdinaryCommit = (outcome: OrdinaryIngressCommandOutcome): boolean => (
    outcome.kind === 'retryable'
      || outcome.kind === 'rejected'
      || outcome.kind === 'staleAddress'
      || outcome.kind === 'notWired'
  );

  const repeatTerminal = (
    outcome: Extract<
      OrdinaryIngressCommandOutcome,
      { readonly kind: 'ambiguous' | 'quarantined' }
    >,
  ): OrdinaryIngressCommandOutcome => (
    outcome.kind === 'ambiguous' ? { ...outcome, idempotent: true } : outcome
  );

  // Terminal provider records mirror the runtime's bounded idempotency ledger:
  // they serve duplicate replay inside the transport redelivery window, while
  // the durable seen-message claim dedups beyond it. Cap retention so the map
  // does not grow by one entry per delivered message for the daemon's lifetime.
  const TERMINAL_PROVIDER_RECORD_CAP = 1024;
  const terminalProviderKeys: string[] = [];
  const retainTerminalProviderRecord = (providerKey: string): void => {
    terminalProviderKeys.push(providerKey);
    if (terminalProviderKeys.length <= TERMINAL_PROVIDER_RECORD_CAP) return;
    const evicted = terminalProviderKeys.splice(
      0,
      terminalProviderKeys.length - TERMINAL_PROVIDER_RECORD_CAP,
    );
    for (const old of evicted) {
      const record = providerRecords.get(old);
      if (record && record.state !== 'received') providerRecords.delete(old);
    }
  };

  const finish = (
    providerKey: string,
    requestHash: string,
    attempt: ProviderAttempt,
    outcome: OrdinaryIngressCommandOutcome,
  ): OrdinaryIngressCommandOutcome => {
    const current = providerRecords.get(providerKey);
    if (current?.state === 'received' && current.attempt === attempt) {
      if (outcome.kind === 'applied' || outcome.kind === 'duplicate') {
        providerRecords.set(providerKey, {
          requestHash,
          state: 'inputCommitted',
          sessionId: outcome.sessionId,
        });
        retainTerminalProviderRecord(providerKey);
      } else if (outcome.kind === 'ambiguous' || outcome.kind === 'quarantined') {
        providerRecords.set(providerKey, { requestHash, state: 'terminal', outcome });
        retainTerminalProviderRecord(providerKey);
      } else {
        providerRecords.delete(providerKey);
      }
    }
    attempt.settle(outcome);
    return outcome;
  };

  const submitRoute = async (
    request: SessionCommandRequest<OrdinaryIngressCommand>,
  ): Promise<OrdinaryIngressCommandOutcome> => {
    const normalized = normalizeOrdinaryImTurn(request.command.input.turn);
    if (normalized.kind === 'rejected') {
      return {
        kind: 'rejected',
        reason: 'invalidCommand',
        message: `ordinary ingress transport turn is invalid: ${normalized.message}`,
      };
    }
    const turn = normalized.turn;
    if (!request.idempotencyKey.trim()
        || request.idempotencyKey !== turn.messageKey) {
      return {
        kind: 'rejected',
        reason: 'invalidCommand',
        message: 'ordinary ingress idempotency key must equal the transport message key',
      };
    }
    if (request.target.kind !== 'route'
        || !routeMatchesTurn(request.target.route, turn)) {
      return {
        kind: 'rejected',
        reason: 'invalidCommand',
        message: 'ordinary ingress route target does not match the transport turn',
      };
    }
    let requestHash: string;
    try {
      requestHash = computeInputHash(turn);
    } catch (error) {
      return {
        kind: 'rejected',
        reason: 'invalidCommand',
        message: `ordinary ingress transport turn is not canonicalizable: ${message(error)}`,
      };
    }

    const providerKey = request.idempotencyKey;
    const prior = providerRecords.get(providerKey);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        return {
          kind: 'rejected',
          reason: 'idempotencyConflict',
          message: 'owner/provider message key already belongs to a different ordinary ingress',
        };
      }
      if (prior.state === 'inputCommitted') return duplicate(prior.sessionId);
      if (prior.state === 'terminal') return repeatTerminal(prior.outcome);
      const joined = await prior.attempt.terminal;
      if (joined.kind === 'applied') return duplicate(joined.sessionId);
      if (joined.kind === 'ambiguous') return { ...joined, idempotent: true };
      return joined;
    }

    const attempt = createAttempt();
    providerRecords.set(providerKey, { requestHash, state: 'received', attempt });
    const routeAdmission = reserveCurrentRouteAdmission(routeAdmissionKey(turn));
    await routeAdmission.ready;
    const admissionKey = routeAdmissionKey(turn);
    let pendingPostCommitKey: string | undefined;
    let openingRollbackToken: CurrentOrdinaryRouteOpeningRollbackToken | undefined;
    let forwardedPromise: Promise<OrdinaryIngressCommandOutcome> | undefined;
    let holdAdmissionUntilProvisionalSettles = false;
    const finishBeforeDelivery = (
      outcome: OrdinaryIngressCommandOutcome,
    ): OrdinaryIngressCommandOutcome => {
      if (pendingPostCommitKey) pendingPostCommits.delete(pendingPostCommitKey);
      if (!openingRollbackToken) {
        return finish(providerKey, requestHash, attempt, outcome);
      }
      const rollback = rollbackOpening(openingRollbackToken);
      if (rollback.kind === 'unknown') {
        routeUnknowns.set(admissionKey, rollback.message);
        return finish(providerKey, requestHash, attempt, {
          kind: 'quarantined',
          message: rollback.message,
        });
      }
      return finish(providerKey, requestHash, attempt, outcome);
    };
    try {
      const priorUnknown = routeUnknowns.get(admissionKey);
      if (priorUnknown) {
        return finish(providerKey, requestHash, attempt, {
          kind: 'quarantined',
          message: priorUnknown,
        });
      }
      let resolved: RouteResolution;
      try {
        resolved = await registry.resolveOrCreate(turn);
      } catch (error) {
        const unknownMessage = `Current ordinary opening orchestration failed: ${message(error)}`;
        routeUnknowns.set(admissionKey, unknownMessage);
        return finish(providerKey, requestHash, attempt, {
          kind: 'quarantined',
          message: unknownMessage,
        });
      }
      if (resolved.kind === 'unknown' || resolved.kind === 'none') {
        const unknownMessage = resolved.kind === 'unknown'
          ? resolved.message
          : 'Current ordinary opening orchestration returned no resolution';
        routeUnknowns.set(admissionKey, unknownMessage);
        return finish(providerKey, requestHash, attempt, {
          kind: 'quarantined',
          message: unknownMessage,
        });
      }
      if (resolved.kind === 'refused') {
        return finish(providerKey, requestHash, attempt, {
          kind: 'retryable',
          message: resolved.message,
        });
      }
      if (resolved.kind === 'quarantined') {
        return finish(providerKey, requestHash, attempt, resolved);
      }
      openingRollbackToken = resolved.rollbackToken;
      pendingPostCommitKey = postCommitKey(resolved.sessionId, providerKey);
      if (resolved.postCommitToken) {
        if (!options.openingCreator.dispatchPostCommit) {
          return finishBeforeDelivery({
            kind: 'quarantined',
            message: 'Current ordinary opening creator returned an unhandled post-commit token',
          });
        }
        pendingPostCommits.set(pendingPostCommitKey, resolved.postCommitToken);
      }

      let projected: Awaited<ReturnType<SessionProjection['read']>>;
      try {
        projected = await options.downstream.projection.read({
          kind: 'byExternalSession',
          sessionId: resolved.sessionId,
        });
      } catch (error) {
        return finishBeforeDelivery({
          kind: 'quarantined',
          message: `Current ordinary route projection failed: ${message(error)}`,
        });
      }
      if (projected.kind !== 'one'
          || projected.session.sessionId !== resolved.sessionId) {
        return finishBeforeDelivery({
          kind: 'quarantined',
          message: projected.kind === 'notReady'
            ? projected.message
            : 'Current ordinary route winner has no exact Session projection',
        });
      }
      if (!bindingIsCurrent(options, resolved.binding, turn)) {
        return finishBeforeDelivery({
          kind: 'quarantined',
          message: 'Current ordinary route identity changed across projection',
        });
      }

      try {
        // SessionRuntime.submit enters downstream begin synchronously. Release
        // an existing route immediately after that boundary so its own
        // per-Session FIFO can materialize later arrivals concurrently. A new
        // provisional route keeps admission until its terminal outcome has
        // either committed the opening or completed the exact rollback.
        holdAdmissionUntilProvisionalSettles = openingRollbackToken !== undefined;
        forwardedPromise = options.downstream.runtime.submit({
          target: { kind: 'session', address: projected.session.address },
          idempotencyKey: request.idempotencyKey,
          command: request.command,
        });
      } catch (error) {
        forwardedPromise = Promise.reject(error);
      }
    } finally {
      if (!holdAdmissionUntilProvisionalSettles) routeAdmission.release();
    }

    try {
      let forwarded: OrdinaryIngressCommandOutcome;
      try {
        forwarded = await forwardedPromise!;
      } catch (error) {
        forwarded = {
          kind: 'quarantined',
          message: `Current ordinary route delivery outcome is unknown: ${message(error)}`,
        };
      }
      if (openingRollbackToken && provesNoOrdinaryCommit(forwarded)) {
        pendingPostCommits.delete(pendingPostCommitKey!);
        const rollback = rollbackOpening(openingRollbackToken);
        if (rollback.kind === 'unknown') {
          routeUnknowns.set(admissionKey, rollback.message);
          return finish(providerKey, requestHash, attempt, {
            kind: 'quarantined',
            message: rollback.message,
          });
        }
      }
      const postCommitToken = pendingPostCommits.get(pendingPostCommitKey!);
      if (postCommitToken
          && (forwarded.kind === 'applied' || forwarded.kind === 'duplicate')) {
        // Consume before invocation. A throw or hidden asynchronous dispatch
        // cannot make a committed ordinary input replay this effect.
        pendingPostCommits.delete(pendingPostCommitKey!);
        try {
          options.openingCreator.dispatchPostCommit?.(postCommitToken);
        } catch {
          // The ordinary input is already committed. Post-commit dispatch is a
          // detached one-shot and cannot revise or replay that outcome.
        }
      } else if (forwarded.kind !== 'retryable') {
        pendingPostCommits.delete(pendingPostCommitKey!);
      }
      return finish(providerKey, requestHash, attempt, forwarded);
    } finally {
      if (holdAdmissionUntilProvisionalSettles) routeAdmission.release();
    }
  };

  return {
    submit<C extends SessionCommand>(
      request: SessionCommandRequest<C>,
    ): Promise<CommandOutcomeFor<C>> {
      if (request.command.kind !== 'ordinary.ingress'
          || request.target.kind !== 'route') {
        return options.downstream.runtime.submit(request);
      }
      return submitRoute(
        request as SessionCommandRequest<OrdinaryIngressCommand>,
      ) as Promise<CommandOutcomeFor<C>>;
    },
  };
}
