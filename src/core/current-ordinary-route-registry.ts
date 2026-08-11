/**
 * Owner-scoped Current route registry for ordinary ingress.
 *
 * Provider-message admission happens before a Session identity is resolved.
 * The injected creator owns every daemon/Lark opening decision; this Module
 * only proves exact-one-or-create, installs the returned Current binding, and
 * forwards the unchanged command through the downstream Session address/lane.
 */

import { isDeepStrictEqual } from 'node:util';

import { computeInputHash } from '../utils/canonical-input-hash.js';
import * as sessionStore from '../services/session-store.js';
import type { Session } from '../types.js';
import {
  normalizeOrdinaryImTurn,
  type NormalizedOrdinaryImTurn,
} from './ordinary-im-turn.js';
import type {
  CommandOutcomeFor,
  ControlMutationCommand,
  ControlMutationCommandOutcome,
  DashboardSpawnCommand,
  DashboardSpawnCommandOutcome,
  OrdinaryIngressCommand,
  OrdinaryIngressCommandOutcome,
  SessionCommand,
  SessionCommandRequest,
  SessionCommandRoute,
  SessionProjection,
  SessionRuntime,
  SessionRoute,
} from './session-runtime.js';
import type {
  CurrentDashboardRouteOpeningPort,
  CurrentDashboardRouteOpeningResult,
} from './current-dashboard-route-opening.js';
import {
  activeSessionAnchorId,
  activeSessionKey,
  sessionAnchorId,
  storedActiveSessionAnchorId,
  type DaemonSession,
} from './types.js';
import {
  currentRouteAdmissionKey,
  reserveCurrentRouteAdmission,
} from './current-route-admission.js';
import {
  isDisposableCurrentRouteScratch,
  isDisposableStoredRouteScratch,
} from './current-route-scratch.js';

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
  /** Staged Dashboard chat-route creator. Absent keeps dashboard.spawn fail-closed. */
  readonly dashboardRouteOpening?: CurrentDashboardRouteOpeningPort;
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

interface CurrentRelocationRouteReservation {
  readonly ownerLarkAppId: string;
  readonly activeSessions: Map<string, DaemonSession>;
  readonly route: SessionRoute;
}

const currentRelocationRouteReservations = new WeakMap<
  object,
  CurrentRelocationRouteReservation
>();

/** Validate one exact, still-held reservation minted by this Current route
 * registry. The token has no enumerable authority and becomes invalid before
 * the waiting ordinary route admission is released. */
export function isCurrentRelocationRouteReservation(input: {
  readonly token: unknown;
  readonly ownerLarkAppId: string;
  readonly activeSessions: Map<string, DaemonSession>;
  readonly route: SessionRoute;
}): boolean {
  if (!isObject(input.token)) return false;
  const held = currentRelocationRouteReservations.get(input.token);
  if (!held
      || held.ownerLarkAppId !== input.ownerLarkAppId
      || held.activeSessions !== input.activeSessions
      || held.route.kind !== input.route.kind) return false;
  return held.route.kind === 'thread' && input.route.kind === 'thread'
    ? held.route.anchorId === input.route.anchorId
    : held.route.kind === 'chat' && input.route.kind === 'chat'
      && held.route.chatId === input.route.chatId;
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

interface RelocationAttempt {
  readonly terminal: Promise<ControlMutationCommandOutcome>;
  settle(outcome: ControlMutationCommandOutcome): void;
}

type RelocationRecord =
  | {
      readonly requestHash: string;
      readonly state: 'received';
      readonly attempt: RelocationAttempt;
    }
  | {
      readonly requestHash: string;
      readonly state: 'terminal';
      readonly outcome: ControlMutationCommandOutcome;
    };

interface DashboardSpawnAttempt {
  readonly terminal: Promise<DashboardSpawnCommandOutcome>;
  settle(outcome: DashboardSpawnCommandOutcome): void;
}

type DashboardSpawnRecord =
  | {
      readonly requestHash: string;
      readonly state: 'received';
      readonly attempt: DashboardSpawnAttempt;
    }
  | {
      readonly requestHash: string;
      readonly state: 'terminal';
      readonly outcome: DashboardSpawnCommandOutcome;
    }
  | {
      readonly requestHash: string;
      readonly state: 'retryable';
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

function createRelocationAttempt(): RelocationAttempt {
  let resolveTerminal!: (outcome: ControlMutationCommandOutcome) => void;
  let settled = false;
  const terminal = new Promise<ControlMutationCommandOutcome>((resolve) => {
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

function createDashboardSpawnAttempt(): DashboardSpawnAttempt {
  let resolveTerminal!: (outcome: DashboardSpawnCommandOutcome) => void;
  let settled = false;
  const terminal = new Promise<DashboardSpawnCommandOutcome>((resolve) => {
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

function duplicateRelocation(
  outcome: ControlMutationCommandOutcome,
): ControlMutationCommandOutcome {
  if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') return outcome;
  return {
    kind: 'duplicate',
    state: 'controlApplied',
    policy: 'control-staged-transition',
    sessionId: outcome.sessionId,
    result: outcome.result,
    message: 'route relocation is already reflected by the Current registry',
  };
}

function duplicateDashboardSpawn(
  outcome: DashboardSpawnCommandOutcome,
  state: 'inFlight' | 'routeOpened',
): DashboardSpawnCommandOutcome {
  if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') return outcome;
  return {
    kind: 'duplicate',
    state,
    policy: 'route-staged-opening',
    sessionId: outcome.sessionId,
    message: 'Dashboard route opening joined the winning stable operation',
  };
}

type RelocationTargetInspection =
  | { readonly kind: 'clear' }
  | { readonly kind: 'scratches'; readonly sessionIds: readonly string[] }
  | { readonly kind: 'occupied'; readonly message: string }
  | { readonly kind: 'quarantined'; readonly message: string };

function samePersistedSession(left: Session, right: Session): boolean {
  const persisted = (session: Session): Session => (
    JSON.parse(JSON.stringify(session)) as Session
  );
  return isDeepStrictEqual(persisted(left), persisted(right));
}

/** Resolve only exact owner/canonical target occupants. The returned ids are
 * still authority-free; callers must project each one into an opaque
 * SessionAddress before submitting a staged close through SessionRuntime. */
function inspectRelocationTarget(options: Pick<
  CurrentOrdinaryRouteRegistryOptions,
  'ownerLarkAppId' | 'activeSessions'
>, input: {
  readonly sourceSessionId: string;
  readonly targetChatId: string;
}): RelocationTargetInspection {
  let persisted: Session[];
  try {
    persisted = sessionStore.listSessionsForOwnerStrict(options.ownerLarkAppId);
  } catch (error) {
    return {
      kind: 'quarantined',
      message: `Current relocate target Store is unreadable: ${message(error)}`,
    };
  }

  const persistedById = new Map<string, Session>();
  for (const session of persisted) {
    if (persistedById.has(session.sessionId)) {
      return {
        kind: 'quarantined',
        message: 'Current relocate target Store has duplicate Session identities',
      };
    }
    persistedById.set(session.sessionId, session);
  }

  const liveById = new Map<string, DaemonSession>();
  for (const [key, current] of options.activeSessions) {
    if (sessionAnchorId(current) !== input.targetChatId) continue;
    if (key !== activeSessionKey(current)) {
      return {
        kind: 'quarantined',
        message: 'Current relocate target has an owner under a noncanonical registry key',
      };
    }
    if (current.larkAppId !== options.ownerLarkAppId
        || current.session.larkAppId !== options.ownerLarkAppId) {
      return {
        kind: 'quarantined',
        message: 'Current relocate target registry owner does not match its Runtime Host',
      };
    }
    if (current.session.status !== 'active'
        || current.scope !== current.session.scope
        || current.chatId !== current.session.chatId) {
      return {
        kind: 'quarantined',
        message: 'Current relocate target live binding is internally inconsistent',
      };
    }
    if (current.session.sessionId === input.sourceSessionId) continue;
    const prior = liveById.get(current.session.sessionId);
    if (prior && prior !== current) {
      return {
        kind: 'quarantined',
        message: 'Current relocate target has multiple live bindings for one Session',
      };
    }
    liveById.set(current.session.sessionId, current);
  }

  const targetPersisted = persisted.filter(session => (
    session.sessionId !== input.sourceSessionId
    && session.status === 'active'
    && !session.vcMeetingReceiver
    && (session.scope === 'chat' ? session.chatId : session.rootMessageId) === input.targetChatId
  ));
  const candidateIds = new Set([
    ...liveById.keys(),
    ...targetPersisted.map(session => session.sessionId),
  ]);
  const scratches: string[] = [];
  for (const sessionId of candidateIds) {
    const live = liveById.get(sessionId);
    const durable = persistedById.get(sessionId);
    if (live && (!durable || !samePersistedSession(live.session, durable))) {
      return {
        kind: 'quarantined',
        message: 'Current relocate target live and durable Session bindings disagree',
      };
    }
    if (live
      ? !isDisposableCurrentRouteScratch(live)
      : !durable || !isDisposableStoredRouteScratch(durable)) {
      return {
        kind: 'occupied',
        message: 'target_chat_has_session',
      };
    }
    scratches.push(sessionId);
  }
  return scratches.length === 0
    ? { kind: 'clear' }
    : { kind: 'scratches', sessionIds: scratches.sort() };
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
  const relocationRecords = new Map<string, RelocationRecord>();
  const dashboardSpawnRecords = new Map<string, DashboardSpawnRecord>();
  const pendingPostCommits = new Map<string, CurrentOrdinaryRouteOpeningPostCommitToken>();
  const postCommitKey = (sessionId: string, providerKey: string): string => (
    `${sessionId}\u0000${providerKey}`
  );
  const routeUnknowns = new Map<string, string>();
  const routeAdmissionKey = (input: {
    readonly scope: 'thread' | 'chat';
    readonly canonicalAnchor: string;
    readonly chatId: string;
    readonly chatType: 'group' | 'p2p';
  }): string => currentRouteAdmissionKey({
    ownerLarkAppId: options.ownerLarkAppId,
    ...input,
  });

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
    const routeAdmission = reserveCurrentRouteAdmission(routeAdmissionKey(turn.route));
    await routeAdmission.ready;
    const admissionKey = routeAdmissionKey(turn.route);
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

  const submitDashboardSpawnRoute = async (
    request: SessionCommandRequest<DashboardSpawnCommand>,
  ): Promise<DashboardSpawnCommandOutcome> => {
    if (request.target.kind !== 'route'
        || request.target.route.kind !== 'chat') {
      return {
        kind: 'rejected',
        reason: 'invalidCommand',
        message: 'Dashboard spawn requires one concrete chat route',
      };
    }
    if (!request.idempotencyKey.trim()) {
      return {
        kind: 'rejected',
        reason: 'invalidCommand',
        message: 'Dashboard spawn idempotency key must not be blank',
      };
    }

    let requestHash: string;
    try {
      requestHash = computeInputHash({
        route: request.target.route,
        input: request.command.input,
      });
    } catch (error) {
      return {
        kind: 'rejected',
        reason: 'invalidCommand',
        message: `Dashboard spawn is not canonicalizable: ${message(error)}`,
      };
    }
    const operationKey = request.idempotencyKey;
    const prior = dashboardSpawnRecords.get(operationKey);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        return {
          kind: 'rejected',
          reason: 'idempotencyConflict',
          message: 'Dashboard spawn operation key belongs to different business input',
        };
      }
      if (prior.state === 'terminal') {
        return duplicateDashboardSpawn(prior.outcome, 'routeOpened');
      }
      if (prior.state === 'received') {
        return duplicateDashboardSpawn(await prior.attempt.terminal, 'inFlight');
      }
    }

    const attempt = createDashboardSpawnAttempt();
    dashboardSpawnRecords.set(operationKey, {
      requestHash,
      state: 'received',
      attempt,
    });
    const finishDashboardSpawn = (
      outcome: DashboardSpawnCommandOutcome,
    ): DashboardSpawnCommandOutcome => {
      const current = dashboardSpawnRecords.get(operationKey);
      if (current?.state === 'received' && current.attempt === attempt) {
        dashboardSpawnRecords.set(operationKey,
          outcome.kind === 'retryable' || outcome.kind === 'notWired'
            ? { requestHash, state: 'retryable' }
            : { requestHash, state: 'terminal', outcome });
      }
      attempt.settle(outcome);
      return outcome;
    };

    const opening = options.dashboardRouteOpening;
    if (!opening) {
      return finishDashboardSpawn({
        kind: 'notWired',
        command: 'dashboard.spawn',
        message: 'Dashboard route opening is not connected to this Current Host',
      });
    }
    const route = request.target.route;
    const admissionKey = routeAdmissionKey({
      scope: 'chat',
      canonicalAnchor: route.chatId,
      chatId: route.chatId,
      chatType: 'group',
    });
    const routeAdmission = reserveCurrentRouteAdmission(admissionKey);
    await routeAdmission.ready;
    try {
      const priorUnknown = routeUnknowns.get(admissionKey);
      if (priorUnknown) {
        return finishDashboardSpawn({ kind: 'quarantined', message: priorUnknown });
      }

      let inspection: unknown;
      try {
        inspection = opening.inspect(route);
      } catch (error) {
        const unknownMessage = `Current Dashboard route inspection failed: ${message(error)}`;
        return finishDashboardSpawn({ kind: 'retryable', message: unknownMessage });
      }
      if (isThenable(inspection)) {
        detachThenable(inspection);
        const unknownMessage = 'Current Dashboard route inspection must return synchronously';
        return finishDashboardSpawn({ kind: 'retryable', message: unknownMessage });
      }
      if (!isObject(inspection)) {
        const unknownMessage = 'Current Dashboard route inspection returned no result';
        return finishDashboardSpawn({ kind: 'retryable', message: unknownMessage });
      }
      try {
        if (inspection.kind === 'occupied') {
          if (typeof inspection.sessionId !== 'string' || !inspection.sessionId) {
            throw new Error('occupied inspection has no Session identity');
          }
          return finishDashboardSpawn({
            kind: 'rejected',
            reason: 'sessionExists',
            code: 'session_exists',
            message: 'session_exists',
          });
        }
        if (inspection.kind === 'unknown') {
          if (typeof inspection.message !== 'string') {
            throw new Error('unknown inspection has no message');
          }
          return finishDashboardSpawn({
            kind: 'retryable',
            message: inspection.message,
          });
        }
        if (inspection.kind !== 'vacant') {
          throw new Error('inspection kind is invalid');
        }
      } catch (error) {
        const unknownMessage = `Current Dashboard route inspection is unreadable: ${message(error)}`;
        return finishDashboardSpawn({ kind: 'retryable', message: unknownMessage });
      }

      let begun: unknown;
      try {
        begun = opening.begin({ route, command: request.command.input });
      } catch (error) {
        const unknownMessage = `Current Dashboard opening begin failed: ${message(error)}`;
        return finishDashboardSpawn({ kind: 'retryable', message: unknownMessage });
      }
      if (isThenable(begun)) {
        detachThenable(begun);
        const unknownMessage = 'Current Dashboard opening begin must return synchronously';
        return finishDashboardSpawn({ kind: 'retryable', message: unknownMessage });
      }
      if (!isObject(begun)) {
        const unknownMessage = 'Current Dashboard opening begin returned no result';
        return finishDashboardSpawn({ kind: 'retryable', message: unknownMessage });
      }
      let beginKind: unknown;
      try {
        beginKind = begun.kind;
      } catch (error) {
        const unknownMessage = `Current Dashboard opening begin is unreadable: ${message(error)}`;
        return finishDashboardSpawn({ kind: 'retryable', message: unknownMessage });
      }
      if (beginKind === 'refused') {
        return finishDashboardSpawn({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: typeof begun.message === 'string'
            ? begun.message
            : 'Current Dashboard opening refused invalid input',
        });
      }
      if (beginKind === 'unknown') {
        const unknownMessage = typeof begun.message === 'string'
          ? begun.message
          : 'Current Dashboard opening begin outcome is unknown';
        return finishDashboardSpawn({
          kind: 'retryable',
          message: unknownMessage,
        });
      }
      if (beginKind !== 'effect'
          || !isObject(begun.intent)
          || !isObject(begun.continuation)
          || begun.intent === begun.continuation) {
        const unknownMessage = 'Current Dashboard opening begin returned invalid effect capabilities';
        return finishDashboardSpawn({ kind: 'retryable', message: unknownMessage });
      }

      let settlement: { kind: 'returned'; value: unknown } | { kind: 'threw'; error: unknown };
      try {
        settlement = { kind: 'returned', value: await opening.execute(begun.intent) };
      } catch (error) {
        settlement = { kind: 'threw', error };
      }
      let resumed: unknown;
      try {
        resumed = opening.resume(begun.continuation, settlement);
      } catch (error) {
        const unknownMessage = `Current Dashboard opening resume failed: ${message(error)}`;
        routeUnknowns.set(admissionKey, unknownMessage);
        return finishDashboardSpawn({
          kind: 'ambiguous',
          policy: 'route-staged-opening',
          message: unknownMessage,
        });
      }
      if (isThenable(resumed)) {
        detachThenable(resumed);
        const unknownMessage = 'Current Dashboard opening resume must return synchronously';
        routeUnknowns.set(admissionKey, unknownMessage);
        return finishDashboardSpawn({
          kind: 'ambiguous',
          policy: 'route-staged-opening',
          message: unknownMessage,
        });
      }
      if (!isObject(resumed)) {
        const unknownMessage = 'Current Dashboard opening resume returned no result';
        routeUnknowns.set(admissionKey, unknownMessage);
        return finishDashboardSpawn({
          kind: 'ambiguous',
          policy: 'route-staged-opening',
          message: unknownMessage,
        });
      }

      let result: CurrentDashboardRouteOpeningResult;
      try {
        result = resumed as CurrentDashboardRouteOpeningResult;
        if (result.kind === 'created') {
          if (typeof result.sessionId !== 'string' || !result.sessionId) {
            throw new Error('created result has no Session identity');
          }
          return finishDashboardSpawn({
            kind: 'applied',
            action: 'dashboard.spawned',
            policy: 'route-staged-opening',
            sessionId: result.sessionId,
          });
        }
        if (result.kind === 'refused') {
          if (typeof result.message !== 'string' || typeof result.code !== 'string') {
            throw new Error('refused result has no stable error');
          }
          return finishDashboardSpawn({
            kind: 'rejected',
            reason: result.reason,
            code: result.code,
            message: result.message,
          });
        }
        if (result.kind === 'unknown') {
          if (typeof result.message !== 'string') throw new Error('unknown result has no message');
          routeUnknowns.set(admissionKey, result.message);
          return finishDashboardSpawn({
            kind: 'ambiguous',
            policy: 'route-staged-opening',
            message: result.message,
            ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
          });
        }
        throw new Error('result kind is invalid');
      } catch (error) {
        const unknownMessage = `Current Dashboard opening result is unreadable: ${message(error)}`;
        routeUnknowns.set(admissionKey, unknownMessage);
        return finishDashboardSpawn({
          kind: 'ambiguous',
          policy: 'route-staged-opening',
          message: unknownMessage,
        });
      }
    } finally {
      routeAdmission.release();
    }
  };

  const cleanupRelocationTargetScratches = async (input: {
    readonly sourceSessionId: string;
    readonly targetChatId: string;
    readonly relocationOperationIdentity: string;
    readonly relocationRequestHash: string;
    readonly routeReservation: object;
  }): Promise<ControlMutationCommandOutcome | undefined> => {
    const inspected = inspectRelocationTarget(options, input);
    if (inspected.kind === 'occupied') {
      return {
        kind: 'rejected',
        reason: 'transitionRejected',
        code: 'target_chat_has_session',
        message: inspected.message,
      };
    }
    if (inspected.kind === 'quarantined') return inspected;
    if (inspected.kind === 'clear') return undefined;

    for (const sessionId of inspected.sessionIds) {
      let projected: Awaited<ReturnType<SessionProjection['read']>>;
      try {
        projected = await options.downstream.projection.read({
          kind: 'byExternalSession',
          sessionId,
        });
      } catch (error) {
        return {
          kind: 'quarantined',
          message: `Current relocate scratch projection failed: ${message(error)}`,
        };
      }
      if (projected.kind === 'notReady') {
        return { kind: 'retryable', message: projected.message };
      }
      if (projected.kind === 'notFound') {
        // A concurrent exact Session close may have won after inspection. The
        // final strict target read below is the authority for whether retry is
        // still needed.
        continue;
      }
      if (projected.kind !== 'one'
          || projected.session.sessionId !== sessionId
          || projected.session.recordStatus !== 'active'
          || projected.session.route.kind !== 'chat'
          || projected.session.route.chatId !== input.targetChatId) {
        return {
          kind: 'quarantined',
          message: 'Current relocate scratch projection did not preserve its exact target binding',
        };
      }

      const closeOperation = `relocate-target-scratch:${computeInputHash({
        relocationOperationIdentity: input.relocationOperationIdentity,
        relocationRequestHash: input.relocationRequestHash,
        sessionId,
      })}`;
      let closed: ControlMutationCommandOutcome;
      try {
        closed = await options.downstream.runtime.submit({
          target: {
            kind: 'session',
            address: projected.session.address,
            controlRouteReservation: input.routeReservation,
          },
          idempotencyKey: closeOperation,
          command: {
            kind: 'control.mutate',
            input: {
              kind: 'close',
              reason: 'relocateScratch',
              expectedRoute: {
                scope: 'chat',
                canonicalAnchor: input.targetChatId,
                chatId: input.targetChatId,
                chatType: 'group',
              },
            },
          },
        });
      } catch (error) {
        return {
          kind: 'quarantined',
          message: `Current relocate scratch close outcome is unknown: ${message(error)}`,
        };
      }
      if ((closed.kind === 'applied' || closed.kind === 'duplicate')
          && closed.sessionId === sessionId
          && closed.result?.kind === 'closed') {
        continue;
      }
      if (closed.kind === 'retryable') return closed;
      if (closed.kind === 'rejected' && closed.reason === 'sessionNotFound') continue;
      if (closed.kind === 'rejected' && closed.reason === 'transitionRejected') {
        return {
          kind: 'rejected',
          reason: 'transitionRejected',
          code: 'target_chat_has_session',
          message: 'target_chat_has_session',
          ...(closed.details ? { details: closed.details } : {}),
        };
      }
      if (closed.kind === 'staleAddress') {
        return {
          kind: 'retryable',
          message: 'Current relocate scratch address became stale before close',
        };
      }
      return {
        kind: 'quarantined',
        message: closed.kind === 'ambiguous' || closed.kind === 'quarantined'
          ? `Current relocate scratch close is unresolved: ${closed.message}`
          : 'Current relocate scratch close returned no exact closed proof',
      };
    }

    const after = inspectRelocationTarget(options, input);
    if (after.kind === 'clear') return undefined;
    if (after.kind === 'occupied') {
      return {
        kind: 'rejected',
        reason: 'transitionRejected',
        code: 'target_chat_has_session',
        message: after.message,
      };
    }
    if (after.kind === 'quarantined') return after;
    return {
      kind: 'retryable',
      message: 'Current relocate scratch close has not left the target route',
    };
  };

  const submitRelocateRoute = async (
    request: SessionCommandRequest<ControlMutationCommand>,
  ): Promise<ControlMutationCommandOutcome> => {
    const command = request.command.input;
    if (command.kind !== 'relocate'
        || request.target.kind !== 'route'
        || request.target.route.kind === 'idempotency'
        || request.target.route.kind === 'schedule') {
      return {
        kind: 'rejected',
        reason: 'invalidCommand',
        message: 'route-targeted control requires a relocate command and concrete source route',
      };
    }
    const sourceAnchor = request.target.route.kind === 'thread'
      ? request.target.route.anchorId
      : request.target.route.chatId;
    if (sourceAnchor !== command.sourceAnchor) {
      return {
        kind: 'rejected',
        reason: 'invalidCommand',
        message: 'relocate source route does not match its canonical source anchor',
      };
    }

    let requestHash: string;
    try {
      requestHash = computeInputHash(command);
    } catch (error) {
      return {
        kind: 'rejected',
        reason: 'invalidCommand',
        message: `route relocation is not canonicalizable: ${message(error)}`,
      };
    }
    const relocationKey = `${request.target.route.kind}\u0000${sourceAnchor}`
      + `\u0000${request.idempotencyKey}`;
    const prior = relocationRecords.get(relocationKey);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        return {
          kind: 'rejected',
          reason: 'idempotencyConflict',
          message: 'route relocation idempotency key belongs to a different command',
        };
      }
      const terminal = prior.state === 'terminal'
        ? prior.outcome
        : await prior.attempt.terminal;
      return duplicateRelocation(terminal);
    }

    const attempt = createRelocationAttempt();
    relocationRecords.set(relocationKey, { requestHash, state: 'received', attempt });
    const finishRelocation = (
      outcome: ControlMutationCommandOutcome,
    ): ControlMutationCommandOutcome => {
      const current = relocationRecords.get(relocationKey);
      if (current?.state === 'received' && current.attempt === attempt) {
        if (outcome.kind === 'applied'
            || outcome.kind === 'duplicate'
            || outcome.kind === 'ambiguous'
            || outcome.kind === 'quarantined') {
          relocationRecords.set(relocationKey, {
            requestHash,
            state: 'terminal',
            outcome,
          });
        } else {
          relocationRecords.delete(relocationKey);
        }
      }
      attempt.settle(outcome);
      return outcome;
    };

    const targetRoute = {
      kind: 'chat' as const,
      chatId: command.targetChatId,
    };
    const targetAdmission = reserveCurrentRouteAdmission(currentRouteAdmissionKey({
      ownerLarkAppId: options.ownerLarkAppId,
      scope: 'chat',
      canonicalAnchor: command.targetChatId,
      chatId: command.targetChatId,
      chatType: 'group',
    }));
    await targetAdmission.ready;
    const reservation = Object.freeze(Object.create(null)) as object;
    currentRelocationRouteReservations.set(reservation, {
      ownerLarkAppId: options.ownerLarkAppId,
      activeSessions: options.activeSessions,
      route: targetRoute,
    });
    try {
      let projected: Awaited<ReturnType<SessionProjection['read']>>;
      try {
        projected = await options.downstream.projection.read({
          kind: 'byRoute',
          route: request.target.route,
        });
      } catch (error) {
        return finishRelocation({
          kind: 'quarantined',
          message: `Current relocate source projection failed: ${message(error)}`,
        });
      }
      if (projected.kind === 'notFound') {
        return finishRelocation({
          kind: 'rejected',
          reason: 'sessionNotFound',
          message: 'no_session_at_anchor',
        });
      }
      if (projected.kind === 'notReady') {
        return finishRelocation({ kind: 'retryable', message: projected.message });
      }
      if (projected.kind !== 'one') {
        return finishRelocation({
          kind: 'quarantined',
          message: 'Current relocate source projection did not resolve exactly one Session',
        });
      }
      const cleanupOutcome = await cleanupRelocationTargetScratches({
        sourceSessionId: projected.session.sessionId,
        targetChatId: command.targetChatId,
        relocationOperationIdentity: request.idempotencyKey,
        relocationRequestHash: requestHash,
        routeReservation: reservation,
      });
      if (cleanupOutcome) return finishRelocation(cleanupOutcome);
      let forwarded: ControlMutationCommandOutcome;
      try {
        forwarded = await options.downstream.runtime.submit({
          target: {
            kind: 'session',
            address: projected.session.address,
            controlRouteReservation: reservation,
          },
          idempotencyKey: request.idempotencyKey,
          command: request.command,
        });
      } catch (error) {
        forwarded = {
          kind: 'quarantined',
          message: `Current route relocation outcome is unknown: ${message(error)}`,
        };
      }
      return finishRelocation(forwarded);
    } finally {
      currentRelocationRouteReservations.delete(reservation);
      targetAdmission.release();
    }
  };

  return {
    submit<C extends SessionCommand>(
      request: SessionCommandRequest<C>,
    ): Promise<CommandOutcomeFor<C>> {
      if (request.command.kind === 'control.mutate'
          && request.command.input.kind === 'relocate'
          && request.target.kind === 'route') {
        return submitRelocateRoute(
          request as SessionCommandRequest<ControlMutationCommand>,
        ) as Promise<CommandOutcomeFor<C>>;
      }
      if (request.command.kind === 'dashboard.spawn'
          && request.target.kind === 'route') {
        return submitDashboardSpawnRoute(
          request as SessionCommandRequest<DashboardSpawnCommand>,
        ) as Promise<CommandOutcomeFor<C>>;
      }
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
