/** Current JSON/worker-pool Adapter for staged Session control commands. */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Session } from '../types.js';
import * as legacySessionStore from '../services/session-store.js';
import {
  activateQueuedSession,
  resumeSession,
} from './session-manager.js';
import {
  closeSession,
  killWorker,
  latestPerBotEnvForRestart,
  sendWorkerSessionInput,
  suspendWorker,
  transferSession,
  type CloseSessionResult,
} from './worker-pool.js';
import type { DaemonToWorker } from '../types.js';
import {
  ensureCurrentSessionActivation,
  retireCurrentSessionActivation,
} from './current-session-activation.js';
import type {
  ControlMutationAppliedResult,
  ControlMutationInput,
  ControlMutationPort,
  ControlMutationTransitionResult,
  ControlSessionSnapshot,
} from './session-runtime.js';
import type {
  SessionStore,
  SessionStoreTransition,
  StoredSessionState,
} from './session-store.js';
import type { DaemonSession } from './types.js';
import { activeSessionKey, sessionAnchorId } from './types.js';
import { isSessionTransferring } from './worker-pool.js';
import { isRiffBackendSession, isSuspendableBackendType } from './persistent-backend.js';
import { protectedSessionMutationReasons } from './session-mutation-guard.js';
import { syncCurrentSessionWorkingDir } from './session-cwd.js';
import { resolveUnionIdFromOpenId } from '../im/lark/client.js';
import {
  isCurrentRelocationRouteReservation,
} from './current-ordinary-route-registry.js';
import {
  isDisposableCurrentRouteScratch,
  isDisposableStoredRouteScratch,
} from './current-route-scratch.js';
import { normalizeKanbanColumn } from './session-board.js';
import * as asyncTriggerStore from '../services/async-trigger-store.js';
import { sessionCliSelectionMismatch } from './session-cli-selection.js';
import { computeInputHash } from '../utils/canonical-input-hash.js';

interface CurrentControlPlan {
  readonly sessionId: string;
  readonly operationIdentity: string;
  readonly requestHash: string;
  readonly command: ControlMutationInput;
  readonly session: Session;
  readonly active?: DaemonSession;
  readonly routeReservation?: unknown;
}

type CurrentMetadataCommand = Extract<ControlMutationInput, {
  kind:
    | 'setBoardPlacement'
    | 'setLocked'
    | 'bindWhiteboard'
    | 'setChatDisplayName'
    | 'bindOwnerUnionId';
}>;

type CurrentControlExecution =
  | { readonly kind: 'close'; readonly result: CloseSessionResult }
  | { readonly kind: 'activate'; readonly result: Awaited<ReturnType<typeof activateQueuedSession>> }
  | { readonly kind: 'reopen'; readonly result: Awaited<ReturnType<typeof resumeSession>>; readonly wake: boolean; readonly activation?: unknown }
  | { readonly kind: 'restart'; readonly revived: boolean; readonly activation?: unknown }
  | { readonly kind: 'suspend'; readonly suspended: boolean }
  | {
      readonly kind: 'relocate';
      readonly result: Awaited<ReturnType<typeof transferSession>>;
    }
  | { readonly kind: 'relocateOwnerResolved'; readonly unionId: string | null }
  | {
      readonly kind: 'changeWorkingDirectory';
      readonly mode: 'respawn-resume' | 'cold-restart';
    }
  | { readonly kind: 'injectCommand'; readonly accepted: boolean }
  | { readonly kind: 'stale' };

type CloseSessionFailure = Exclude<CloseSessionResult, { ok: true }>;

function closeFailureTransition(
  result: CloseSessionFailure,
): ControlMutationTransitionResult {
  return result.closeDisposition === 'notApplied'
    ? { kind: 'retryable', message: result.error }
    : { kind: 'quarantined', message: result.error };
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === 'object';
}

function controlSessionSnapshot(session: Session): ControlSessionSnapshot {
  return {
    ...(session.title ? { title: session.title } : {}),
    chatId: session.chatId,
    rootMessageId: session.rootMessageId,
    ...(session.workingDir ? { workingDir: session.workingDir } : {}),
    ...(session.cliId ? { cliId: session.cliId } : {}),
  };
}

function samePersistedSession(left: Session, right: Session): boolean {
  const persisted = (session: Session): Session => (
    JSON.parse(JSON.stringify(session)) as Session
  );
  return isDeepStrictEqual(persisted(left), persisted(right));
}

type StoredSessionResolution = Session | 'ambiguous' | undefined;

function censusOwnerActiveSessions(
  ownerLarkAppId: string,
  activeSessions: ReadonlyMap<string, DaemonSession>,
): readonly DaemonSession[] | 'ambiguous' {
  const ownerSessions: DaemonSession[] = [];
  const sessionIds = new Set<string>();
  for (const [key, candidate] of activeSessions.entries()) {
    const ownerRelated = candidate.larkAppId === ownerLarkAppId
      || candidate.session.larkAppId === ownerLarkAppId;
    if (!ownerRelated) continue;
    let canonical = false;
    try { canonical = key === activeSessionKey(candidate); }
    catch { /* malformed owner evidence is ambiguous */ }
    if (!canonical
      || candidate.larkAppId !== ownerLarkAppId
      || (!!candidate.session.larkAppId && candidate.session.larkAppId !== ownerLarkAppId)
      || typeof candidate.session.sessionId !== 'string'
      || candidate.session.sessionId.length === 0
      || candidate.session.status !== 'active'
      || candidate.session.chatId !== candidate.chatId
      || (!!candidate.session.chatType && candidate.session.chatType !== candidate.chatType)
      || (candidate.session.scope ?? 'thread') !== candidate.scope
      || sessionIds.has(candidate.session.sessionId)) {
      return 'ambiguous';
    }
    sessionIds.add(candidate.session.sessionId);
    ownerSessions.push(candidate);
  }
  return ownerSessions;
}

function exactOwnedSession(
  ownerLarkAppId: string,
  activeSessions: ReadonlyMap<string, DaemonSession>,
  resolveStored: (sessionId: string) => StoredSessionResolution,
  sessionId: string,
): { session: Session; active?: DaemonSession } | 'ambiguous' | undefined {
  const census = censusOwnerActiveSessions(ownerLarkAppId, activeSessions);
  if (census === 'ambiguous') return 'ambiguous';
  const active = census.filter(candidate => candidate.session.sessionId === sessionId);
  const stored = resolveStored(sessionId);
  if (stored === 'ambiguous') return 'ambiguous';
  if (active[0] && !stored) return 'ambiguous';
  if (active[0] && stored && !samePersistedSession(active[0].session, stored)) return 'ambiguous';
  const session = active[0]?.session ?? stored;
  if (!session) return undefined;
  if (session.larkAppId && session.larkAppId !== ownerLarkAppId) return undefined;
  return { session, ...(active[0] ? { active: active[0] } : {}) };
}

function sameBinding(
  ownerLarkAppId: string,
  activeSessions: ReadonlyMap<string, DaemonSession>,
  resolveStored: (sessionId: string) => StoredSessionResolution,
  plan: CurrentControlPlan,
): boolean {
  const current = exactOwnedSession(ownerLarkAppId, activeSessions, resolveStored, plan.sessionId);
  if (current === undefined || current === 'ambiguous' || current.active !== plan.active) return false;
  return plan.active
    ? current.session === plan.session
    : samePersistedSession(current.session, plan.session);
}

function readbackMatches(
  state: StoredSessionState,
  command: CurrentMetadataCommand,
): boolean {
  if (command.kind === 'setBoardPlacement') {
    return (command.column === undefined || state.kanbanColumn === command.column)
      && (command.position === undefined || state.kanbanPosition === command.position);
  }
  if (command.kind === 'setLocked') return state.locked === command.locked;
  if (command.kind === 'bindWhiteboard') return state.whiteboardId === command.whiteboardId;
  if (command.kind === 'setChatDisplayName') {
    return state.chatDisplayName === command.chatDisplayName;
  }
  return state.ownerUnionId === command.ownerUnionId;
}

function metadataResult(
  state: StoredSessionState,
  command: CurrentMetadataCommand,
): ControlMutationAppliedResult {
  if (command.kind === 'setBoardPlacement') {
    return {
      kind: 'boardPlacementUpdated',
      ...(state.kanbanColumn ? { column: state.kanbanColumn } : {}),
      ...(state.kanbanPosition === undefined ? {} : { position: state.kanbanPosition }),
      queued: state.queued,
    };
  }
  if (command.kind === 'setLocked') return { kind: 'lockUpdated', locked: state.locked };
  if (command.kind === 'bindWhiteboard') {
    return { kind: 'whiteboardBound', whiteboardId: state.whiteboardId! };
  }
  if (command.kind === 'setChatDisplayName') {
    return { kind: 'chatDisplayNameUpdated', chatDisplayName: state.chatDisplayName! };
  }
  return { kind: 'ownerUnionIdBound', ownerUnionId: state.ownerUnionId! };
}

function applyMetadata(
  store: SessionStore,
  sessionId: string,
  command: CurrentMetadataCommand,
): ControlMutationTransitionResult {
  const loaded = store.load(sessionId);
  if (loaded.kind === 'notFound') {
    return { kind: 'rejected', reason: 'sessionNotFound', message: 'Current Session is not present' };
  }
  if (loaded.kind === 'unavailable') return { kind: 'retryable', message: loaded.message };
  if (loaded.kind === 'corrupt' || loaded.kind === 'futureVersion') {
    return { kind: 'quarantined', message: loaded.message };
  }
  if (readbackMatches(loaded.state, command)) {
    return { kind: 'committed', result: metadataResult(loaded.state, command) };
  }
  const applied = store.apply({
    sessionId,
    expected: loaded.version,
    transition: command as SessionStoreTransition,
  });
  if (applied.kind === 'applied') {
    return { kind: 'committed', result: metadataResult(applied.state, command) };
  }
  if (applied.kind === 'conflict') {
    return applied.current && readbackMatches(applied.current.state, command)
      ? { kind: 'committed', result: metadataResult(applied.current.state, command) }
      : { kind: 'retryable', message: 'Current Session metadata version changed before publication' };
  }
  if (applied.kind === 'rejected') {
    return {
      kind: 'rejected',
      reason: 'invalidCommand',
      message: applied.message,
    };
  }
  if (applied.kind === 'notApplied') return { kind: 'retryable', message: applied.message };
  const readback = store.load(sessionId);
  if (readback.kind === 'loaded' && readbackMatches(readback.state, command)) {
    return { kind: 'committed', result: metadataResult(readback.state, command) };
  }
  if (readback.kind === 'corrupt' || readback.kind === 'futureVersion') {
    return { kind: 'quarantined', message: readback.message };
  }
  return { kind: 'unknown', message: applied.message };
}

type WorkingDirectoryMetadataResult =
  | { readonly kind: 'ready'; readonly state: StoredSessionState }
  | Exclude<ControlMutationTransitionResult, { kind: 'committed' | 'effect' }>;

function workingDirectoryMatches(state: StoredSessionState, workingDir: string): boolean {
  return state.workingDir === workingDir && state.riffRepoDirs === undefined;
}

function applyWorkingDirectoryMetadata(
  store: SessionStore,
  sessionId: string,
  workingDir: string,
): WorkingDirectoryMetadataResult {
  const loaded = store.load(sessionId);
  if (loaded.kind === 'notFound') {
    return { kind: 'rejected', reason: 'sessionNotFound', message: 'Current Session is not present' };
  }
  if (loaded.kind === 'unavailable') return { kind: 'retryable', message: loaded.message };
  if (loaded.kind === 'corrupt' || loaded.kind === 'futureVersion') {
    return { kind: 'quarantined', message: loaded.message };
  }
  if (workingDirectoryMatches(loaded.state, workingDir)) {
    return { kind: 'ready', state: loaded.state };
  }
  const applied = store.apply({
    sessionId,
    expected: loaded.version,
    transition: { kind: 'changeWorkingDirectory', workingDir },
  });
  if (applied.kind === 'applied') return { kind: 'ready', state: applied.state };
  if (applied.kind === 'conflict') {
    return applied.current && workingDirectoryMatches(applied.current.state, workingDir)
      ? { kind: 'ready', state: applied.current.state }
      : { kind: 'retryable', message: 'Current Session working directory changed before publication' };
  }
  if (applied.kind === 'rejected') {
    return { kind: 'rejected', reason: 'invalidCommand', message: applied.message };
  }
  if (applied.kind === 'notApplied') return { kind: 'retryable', message: applied.message };
  const readback = store.load(sessionId);
  if (readback.kind === 'loaded' && workingDirectoryMatches(readback.state, workingDir)) {
    return { kind: 'ready', state: readback.state };
  }
  if (readback.kind === 'corrupt' || readback.kind === 'futureVersion') {
    return { kind: 'quarantined', message: readback.message };
  }
  return { kind: 'unknown', message: applied.message };
}

function convergeAsyncTriggerFault(
  active: DaemonSession,
  ownerLarkAppId: string,
  triggerId: string,
): ControlMutationTransitionResult {
  const fault = active.idempotentAsyncTurns?.get(triggerId);
  if (!fault?.postBarrierFault) {
    return {
      kind: 'committed',
      result: { kind: 'asyncTriggerFaultConverged', state: 'noChange', triggerId },
    };
  }
  if (fault.ownerLarkAppId !== ownerLarkAppId) {
    return {
      kind: 'quarantined',
      message: 'async trigger fault entry belongs to a different owner',
    };
  }
  try {
    const durable = asyncTriggerStore.lookup(active.session.sessionId, triggerId);
    if (durable?.ownerLarkAppId === ownerLarkAppId
        && durable.result.status === 'completed') {
      active.idempotentAsyncTurns?.delete(triggerId);
      return {
        kind: 'committed',
        result: { kind: 'asyncTriggerFaultConverged', state: 'noChange', triggerId },
      };
    }
    const settled = asyncTriggerStore.recordFailedStrict(
      active.session.sessionId,
      triggerId,
      Date.now(),
      ownerLarkAppId,
      'dispatch_unknown',
    );
    active.idempotentAsyncTurns?.delete(triggerId);
    if (settled === 'already_completed') {
      return {
        kind: 'committed',
        result: { kind: 'asyncTriggerFaultConverged', state: 'noChange', triggerId },
      };
    }
    active.asyncTriggerResults?.delete(triggerId);
    return {
      kind: 'committed',
      result: {
        kind: 'asyncTriggerFaultConverged',
        state: 'failed',
        triggerId,
        ...(active.chatId ? { chatId: active.chatId } : {}),
      },
    };
  } catch (error) {
    return {
      kind: 'retryable',
      message: `async trigger fault convergence failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function activationTerminal(value: unknown): unknown {
  if (!isObject(value)) return value;
  return value.kind === 'duplicate' ? value.outcome : value;
}

function protectedMutationRejection(
  sessionId: string,
  value: DaemonSession | Session,
): Extract<ControlMutationTransitionResult, { kind: 'rejected' }> | undefined {
  const reasons = protectedSessionMutationReasons(value);
  if (reasons.length === 0) return undefined;
  const session = 'session' in value ? value.session : value;
  const code = reasons.every(reason => reason === 'codex_app_dispatch')
    ? 'codex_app_dispatch_pending'
    : 'session_mutation_pending';
  return {
    kind: 'rejected',
    reason: 'transitionRejected',
    code,
    message: code,
    details: {
      blockingSessions: [{
        sessionId,
        ...(session.cliId ? { cliId: session.cliId } : {}),
        reasons,
      }],
    },
  };
}

export function createCurrentSessionControlPort(options: {
  readonly ownerLarkAppId: string;
  readonly activeSessions: Map<string, DaemonSession>;
  readonly sessionStore?: SessionStore;
  /** Owner-bound row resolver for lifecycle planning and exact revalidation. */
  readonly resolveStoredSession?: (sessionId: string) => StoredSessionResolution;
  /** Internal seam for cross-app owner identity resolution. */
  readonly resolveOwnerUnionId?: typeof resolveUnionIdFromOpenId;
  /** Internal fault-test seam; production verifies capabilities in the shared
   * Current ordinary-route registry. */
  readonly isRelocationRouteReservation?: typeof isCurrentRelocationRouteReservation;
}): ControlMutationPort {
  const store = options.sessionStore ?? legacySessionStore.createCurrentSessionStore({
    ownerLarkAppId: options.ownerLarkAppId,
    runtimeEpoch: `current-control:${randomUUID()}`,
  });
  const resolveStored = options.resolveStoredSession ?? ((sessionId: string): StoredSessionResolution => {
    try {
      const fresh = legacySessionStore.getSessionForOwnerStrict(
        options.ownerLarkAppId,
        sessionId,
      );
      const cached = legacySessionStore.getOwnedSession(sessionId);
      if (!fresh && !cached) return undefined;
      if (!fresh || !cached || !samePersistedSession(fresh, cached)) return 'ambiguous';
      // Lifecycle services still operate on the legacy cache object. Authority
      // comes from the fresh owner file only when both projections agree.
      return cached;
    } catch {
      return 'ambiguous';
    }
  });
  const relocationReservationIsCurrent = options.isRelocationRouteReservation
    ?? isCurrentRelocationRouteReservation;
  type CurrentControlEffect = {
    readonly plan: CurrentControlPlan;
    readonly phase: 'control' | 'relocateOwnerLookup' | 'relocateTransfer';
  };
  const intents = new WeakMap<object, CurrentControlEffect>();
  const continuations = new WeakMap<object, CurrentControlPlan>();
  const closeFailureReceipts = new Map<string, {
    readonly requestHash: string;
    readonly result?: CloseSessionFailure;
  }>();
  const closeReceiptKey = (sessionId: string, operationIdentity: string): string => (
    `${sessionId}\0${operationIdentity}`
  );
  const token = (): object => Object.freeze(Object.create(null)) as object;
  const effect = (
    plan: CurrentControlPlan,
    phase: CurrentControlEffect['phase'],
  ): Extract<ControlMutationTransitionResult, { kind: 'effect' }> => {
    const intent = token();
    const continuation = token();
    intents.set(intent, { plan, phase });
    continuations.set(continuation, plan);
    return { kind: 'effect', intent, continuation };
  };

  return {
    begin({ sessionId, operationIdentity, command, routeReservation }) {
      let requestHash: string;
      try {
        requestHash = computeInputHash(command);
      } catch (error) {
        return {
          kind: 'rejected',
          reason: 'invalidCommand',
          message: `Current control command is not canonicalizable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const priorCloseFailure = closeFailureReceipts.get(
        closeReceiptKey(sessionId, operationIdentity),
      );
      if (priorCloseFailure) {
        if (priorCloseFailure.requestHash !== requestHash) {
          return {
            kind: 'rejected',
            reason: 'transitionRejected',
            code: 'idempotency_conflict',
            message: 'operation identity already belongs to a different close command',
          };
        }
        // notApplied retains only the semantic hash: the same operation may
        // re-drive, but another payload may never capture its identity.
        if (priorCloseFailure.result) {
          return closeFailureTransition(priorCloseFailure.result);
        }
      }
      if (command.kind === 'close' && command.reason === 'relocateScratch') {
        const expected = command.expectedRoute;
        if (expected.scope !== 'chat'
            || !expected.chatId
            || expected.canonicalAnchor !== expected.chatId
            || !relocationReservationIsCurrent({
              token: routeReservation,
              ownerLarkAppId: options.ownerLarkAppId,
              activeSessions: options.activeSessions,
              route: { kind: 'chat', chatId: expected.chatId },
            })) {
          return {
            kind: 'rejected',
            reason: 'invalidCommand',
            code: 'target_route_not_reserved',
            message: 'target_route_not_reserved',
          };
        }
      }
      const exact = exactOwnedSession(
        options.ownerLarkAppId,
        options.activeSessions,
        resolveStored,
        sessionId,
      );
      if (exact === 'ambiguous') {
        return { kind: 'unknown', message: 'Current control has multiple exact owner bindings' };
      }
      if (!exact) {
        if (command.kind === 'close') {
          return {
            kind: 'committed',
            result: { kind: 'closed', alreadyClosed: true, known: false },
          };
        }
        return {
          kind: 'rejected',
          reason: 'sessionNotFound',
          message: 'Current Session is not owned by this Runtime Host',
        };
      }
      if (command.kind === 'setLocked'
        || command.kind === 'bindWhiteboard'
        || command.kind === 'setChatDisplayName'
        || command.kind === 'bindOwnerUnionId') {
        return applyMetadata(store, sessionId, command);
      }
      if (command.kind === 'setBoardPlacement'
        && !(command.column === 'in_progress' && exact.active?.session.queued)) {
        return applyMetadata(store, sessionId, command);
      }
      if (command.kind === 'changeWorkingDirectory' && !exact.active) {
        return {
          kind: 'rejected',
          reason: 'sessionNotFound',
          message: 'Current Session is not active in the owner registry',
        };
      }
      if (command.kind === 'relocate' && !exact.active) {
        return {
          kind: 'rejected',
          reason: 'sessionNotFound',
          message: 'Current Session is not active in the owner registry',
        };
      }
      if (command.kind === 'injectCommand' && !exact.active) {
        return {
          kind: 'rejected',
          reason: 'sessionNotFound',
          message: 'Current Session is not active in the owner registry',
        };
      }
      if (command.kind === 'convergeAsyncTriggerFault') {
        if (!exact.active) {
          return {
            kind: 'rejected',
            reason: 'sessionNotFound',
            message: 'Current Session is not active in the owner registry',
          };
        }
        return convergeAsyncTriggerFault(
          exact.active,
          options.ownerLarkAppId,
          command.triggerId,
        );
      }
      if (command.kind === 'relocate') {
        const active = exact.active!;
        if (!relocationReservationIsCurrent({
          token: routeReservation,
          ownerLarkAppId: options.ownerLarkAppId,
          activeSessions: options.activeSessions,
          route: { kind: 'chat', chatId: command.targetChatId },
        })) {
          return {
            kind: 'rejected',
            reason: 'invalidCommand',
            code: 'target_route_not_reserved',
            message: 'target_route_not_reserved',
          };
        }
        if (sessionAnchorId(active) !== command.sourceAnchor) {
          return {
            kind: 'rejected',
            reason: 'sessionNotFound',
            message: 'no_session_at_anchor',
          };
        }
        const requiresUnionLookup = !!active.session.ownerOpenId
          && !active.session.ownerUnionId
          && !!command.requester.unionId;
        const ownerMatches = requiresUnionLookup
          || active.session.ownerOpenId === undefined
          || (active.session.ownerUnionId && command.requester.unionId
            ? active.session.ownerUnionId === command.requester.unionId
            : active.session.ownerOpenId === command.requester.openId);
        if (!ownerMatches) {
          return {
            kind: 'rejected',
            reason: 'transitionRejected',
            code: 'not_session_owner',
            message: 'not_session_owner',
          };
        }
      }
      if (command.kind === 'close' && command.reason === 'agentCliMismatch') {
        const active = exact.active;
        const exempt = !active
          || exact.session.queued === true
          || !!active.adoptedFrom
          || active.initConfig?.adoptMode === true
          || !!exact.session.adoptedFrom
          || exact.session.title?.startsWith('Adopt:') === true
          || !sessionCliSelectionMismatch(exact.session, command.target);
        if (exempt) {
          return {
            kind: 'rejected',
            reason: 'transitionRejected',
            code: 'agent_cli_mismatch_not_applicable',
            message: 'agent_cli_mismatch_not_applicable',
          };
        }
        const rejected = protectedMutationRejection(sessionId, active);
        if (rejected) return rejected;
        if (isSessionTransferring(active)) {
          return {
            kind: 'rejected',
            reason: 'transitionRejected',
            code: 'session_transferring',
            message: 'session_transferring',
          };
        }
      }
      if (command.kind === 'close' && command.reason === 'relocateScratch') {
        const expected = command.expectedRoute;
        const ownerBindings = [...options.activeSessions.entries()].filter(([, candidate]) => (
          candidate.larkAppId === options.ownerLarkAppId
          && candidate.session.sessionId === sessionId
        ));
        if (ownerBindings.some(([key, candidate]) => key !== activeSessionKey(candidate))
            || (exact.active
              ? ownerBindings.length !== 1 || ownerBindings[0]![1] !== exact.active
              : ownerBindings.length !== 0)) {
          return {
            kind: 'unknown',
            message: 'Current relocate scratch has an ambiguous owner/canonical binding',
          };
        }
        const routeMatches = exact.active
          ? exact.active.scope === expected.scope
            && exact.active.chatId === expected.chatId
            && exact.active.chatType === expected.chatType
            && sessionAnchorId(exact.active) === expected.canonicalAnchor
          : (exact.session.scope ?? 'thread') === expected.scope
            && exact.session.chatId === expected.chatId
            && (exact.session.chatType ?? 'group') === expected.chatType;
        const stillDisposable = exact.active
          ? isDisposableCurrentRouteScratch(exact.active)
            && !isSessionTransferring(exact.active)
          : isDisposableStoredRouteScratch(exact.session);
        if (!routeMatches || !stillDisposable) {
          return {
            kind: 'rejected',
            reason: 'transitionRejected',
            code: 'target_chat_has_session',
            message: 'target_chat_has_session',
          };
        }
      }
      if (command.kind === 'close' && command.reason === 'prune') {
        const rejected = protectedMutationRejection(
          sessionId,
          exact.active ?? exact.session,
        );
        if (rejected) return rejected;
      }
      if (command.kind === 'activateQueued'
        && (!exact.active || exact.active.session.queued !== true)) {
        return {
          kind: 'rejected',
          reason: 'transitionRejected',
          ...(exact.active ? { code: 'not_queued' } : {}),
          message: exact.active
            ? 'not_queued'
            : 'queued Session is not active in the Current registry',
        };
      }
      if ((command.kind === 'restart' || command.kind === 'suspend') && !exact.active) {
        return {
          kind: 'rejected',
          reason: 'transitionRejected',
          code: 'session_not_active',
          message: 'Current Session is not active in the owner registry',
        };
      }
      if (command.kind === 'restart'
        || command.kind === 'suspend'
        || command.kind === 'changeWorkingDirectory') {
        const active = exact.active!;
        if (isSessionTransferring(active)) {
          return {
            kind: 'rejected',
            reason: 'transitionRejected',
            code: 'session_transferring',
            message: 'session_transferring',
          };
        }
        if (active.adoptedFrom || active.initConfig?.adoptMode) {
          const code = command.kind === 'restart'
            ? 'adopt_restart_unsupported'
            : command.kind === 'suspend'
              ? 'adopt_suspend_unsupported'
              : 'adopt_cd_unsupported';
          return { kind: 'rejected', reason: 'transitionRejected', code, message: code };
        }
        if (command.kind === 'restart' && isRiffBackendSession(active)) {
          return {
            kind: 'rejected',
            reason: 'transitionRejected',
            code: 'riff_restart_unsupported',
            message: 'riff_restart_unsupported',
          };
        }
        if (command.kind === 'changeWorkingDirectory' && isRiffBackendSession(active)) {
          return {
            kind: 'rejected',
            reason: 'transitionRejected',
            code: 'riff_cd_unsupported',
            message: 'riff_cd_unsupported',
          };
        }
        const rejected = protectedMutationRejection(sessionId, active);
        if (rejected) return rejected;
        if (command.kind === 'suspend' && command.source === 'hostOverload'
          && (active.lastScreenStatus !== 'idle'
            || !isSuspendableBackendType(active.initConfig?.backendType))) {
          return {
            kind: 'rejected',
            reason: 'transitionRejected',
            code: 'host_overload_candidate_changed',
            message: 'host_overload_candidate_changed',
          };
        }
      }
      if (command.kind === 'injectCommand') {
        const active = exact.active!;
        if (active.adoptedFrom || active.initConfig?.adoptMode) {
          return {
            kind: 'rejected',
            reason: 'transitionRejected',
            code: 'adopt_inject_unsupported',
            message: 'adopt_inject_unsupported',
          };
        }
        if ((!active.worker || active.worker.killed) && !isSessionTransferring(active)) {
          return {
            kind: 'rejected',
            reason: 'transitionRejected',
            code: 'no_live_worker',
            message: 'no_live_worker',
          };
        }
      }
      if (command.kind === 'suspend'
        && (!exact.active!.worker || exact.active!.worker!.killed)) {
        return {
          kind: 'committed',
          result: { kind: 'suspended', suspended: false },
        };
      }
      if (command.kind === 'reopen' && exact.session.status !== 'closed') {
        return {
          kind: 'rejected',
          reason: 'transitionRejected',
          code: 'not_closed',
          message: 'Current Session is not closed',
        };
      }
      if (command.kind === 'changeWorkingDirectory') {
        const metadata = applyWorkingDirectoryMetadata(
          store,
          sessionId,
          command.resolvedPath,
        );
        if (metadata.kind !== 'ready') return metadata;
        syncCurrentSessionWorkingDir(exact.active!, command.resolvedPath);
      }
      const plan: CurrentControlPlan = Object.freeze({
        sessionId,
        operationIdentity,
        requestHash,
        command,
        session: exact.session,
        ...(exact.active ? { active: exact.active } : {}),
        ...(routeReservation === undefined ? {} : { routeReservation }),
      });
      return effect(
        plan,
        command.kind === 'relocate'
          && !!exact.active?.session.ownerOpenId
          && !exact.active.session.ownerUnionId
          && !!command.requester.unionId
          ? 'relocateOwnerLookup'
          : command.kind === 'relocate'
            ? 'relocateTransfer'
            : 'control',
      );
    },

    async execute(intent): Promise<CurrentControlExecution> {
      if (!isObject(intent)) throw new Error('invalid Current control intent');
      const current = intents.get(intent);
      if (!current) throw new Error('Current control intent was already consumed');
      intents.delete(intent);
      const { plan } = current;
      if (current.phase === 'relocateOwnerLookup') {
        if (plan.command.kind !== 'relocate'
          || !sameBinding(options.ownerLarkAppId, options.activeSessions, resolveStored, plan)) {
          return { kind: 'stale' };
        }
        return {
          kind: 'relocateOwnerResolved',
          unionId: await (options.resolveOwnerUnionId ?? resolveUnionIdFromOpenId)(
            options.ownerLarkAppId,
            plan.session.ownerOpenId!,
          ),
        };
      }
      if (plan.command.kind === 'injectCommand') {
        if (!sameBinding(options.ownerLarkAppId, options.activeSessions, resolveStored, plan)) {
          return { kind: 'stale' };
        }
        return {
          kind: 'injectCommand',
          accepted: sendWorkerSessionInput(plan.active!, {
            type: 'inject_command',
            command: plan.command.command,
          }),
        };
      }
      if (plan.command.kind === 'close') {
        const result = await closeSession(plan.sessionId, {
          owner: {
            larkAppId: options.ownerLarkAppId,
            activeSessions: options.activeSessions,
          },
          isCurrent: () => sameBinding(
            options.ownerLarkAppId,
            options.activeSessions,
            resolveStored,
            plan,
          ),
        });
        if (result.ok) {
          await retireCurrentSessionActivation({
            ownerLarkAppId: options.ownerLarkAppId,
            sessionId: plan.sessionId,
            requestIdentity: `control-close:${plan.operationIdentity}`,
            reason: 'explicitClose',
          });
        }
        return { kind: 'close', result };
      }
      if (plan.command.kind === 'reopen') {
        if (!sameBinding(options.ownerLarkAppId, options.activeSessions, resolveStored, plan)) {
          return { kind: 'stale' };
        }
        const result = await resumeSession(plan.sessionId, options.activeSessions, {
          owner: {
            larkAppId: options.ownerLarkAppId,
            activeSessions: options.activeSessions,
          },
        });
        let activation: unknown;
        if (result.ok && plan.command.wake) {
          activation = await ensureCurrentSessionActivation({
            ownerLarkAppId: options.ownerLarkAppId,
            sessionId: plan.sessionId,
            requestIdentity: `control-reopen:${plan.operationIdentity}`,
            cause: 'dashboard',
            promptInput: '',
            resumeOrTurnId: true,
            activeSessions: options.activeSessions,
          });
        }
        return { kind: 'reopen', result, wake: plan.command.wake, activation };
      }
      if (plan.command.kind === 'restart') {
        if (!sameBinding(options.ownerLarkAppId, options.activeSessions, resolveStored, plan)) {
          return { kind: 'stale' };
        }
        const active = plan.active!;
        if (active.worker && !active.worker.killed) {
          active.workerReady = false;
          active.worker.send({
            type: 'restart',
            reason: 'operator',
            env: latestPerBotEnvForRestart(active),
          } as DaemonToWorker);
          return { kind: 'restart', revived: false };
        }
        const activation = await ensureCurrentSessionActivation({
          ownerLarkAppId: options.ownerLarkAppId,
          sessionId: plan.sessionId,
          requestIdentity: `control-restart:${plan.operationIdentity}`,
          cause: 'dashboard',
          promptInput: '',
          resumeOrTurnId: active.hasHistory,
          activeSessions: options.activeSessions,
        });
        return { kind: 'restart', revived: true, activation };
      }
      if (plan.command.kind === 'suspend') {
        if (!sameBinding(options.ownerLarkAppId, options.activeSessions, resolveStored, plan)) {
          return { kind: 'stale' };
        }
        return {
          kind: 'suspend',
          suspended: suspendWorker(
            plan.active!,
            plan.command.kind === 'suspend' && plan.command.source === 'hostOverload'
              ? 'host_overload_suspend'
              : 'manual_suspend',
          ),
        };
      }
      if (current.phase === 'relocateTransfer' && plan.command.kind === 'relocate') {
        if (!sameBinding(options.ownerLarkAppId, options.activeSessions, resolveStored, plan)) {
          return { kind: 'stale' };
        }
        const reservationIsCurrent = () => relocationReservationIsCurrent({
          token: plan.routeReservation,
          ownerLarkAppId: options.ownerLarkAppId,
          activeSessions: options.activeSessions,
          route: { kind: 'chat', chatId: plan.command.kind === 'relocate'
            ? plan.command.targetChatId
            : '' },
        });
        if (!reservationIsCurrent()) return { kind: 'stale' };
        return {
          kind: 'relocate',
          result: await transferSession(
            plan.sessionId,
            plan.command.targetChatId,
            plan.command.targetRootMessageId,
            'group',
            'chat',
            {
              owner: {
                larkAppId: options.ownerLarkAppId,
                activeSessions: options.activeSessions,
              },
              isCurrent: () => sameBinding(
                options.ownerLarkAppId,
                options.activeSessions,
                resolveStored,
                plan,
              ),
              isTargetRouteReservationCurrent: reservationIsCurrent,
            },
          ),
        };
      }
      if (plan.command.kind === 'changeWorkingDirectory') {
        if (!sameBinding(options.ownerLarkAppId, options.activeSessions, resolveStored, plan)) {
          return { kind: 'stale' };
        }
        const active = plan.active!;
        if (active.worker && !active.worker.killed) {
          active.workerReady = false;
          try {
            active.worker.send({
              type: 'restart',
              updateWorkingDir: plan.command.resolvedPath,
              env: latestPerBotEnvForRestart(active),
            } as DaemonToWorker);
            return { kind: 'changeWorkingDirectory', mode: 'respawn-resume' };
          } catch {
            killWorker(active);
            return { kind: 'changeWorkingDirectory', mode: 'cold-restart' };
          }
        }
        killWorker(active);
        return { kind: 'changeWorkingDirectory', mode: 'cold-restart' };
      }
      const active = plan.active;
      if (!active) throw new Error('Current queued activation lost its exact owner');
      if (!sameBinding(options.ownerLarkAppId, options.activeSessions, resolveStored, plan)) {
        return { kind: 'stale' };
      }
      return { kind: 'activate', result: await activateQueuedSession(active) };
    },

    resume(continuation, settlement) {
      if (!isObject(continuation)) {
        return { kind: 'unknown', message: 'invalid Current control continuation' };
      }
      const plan = continuations.get(continuation);
      if (!plan) return { kind: 'unknown', message: 'Current control continuation was already consumed' };
      continuations.delete(continuation);
      if (settlement.kind === 'threw') {
        return {
          kind: 'unknown',
          message: `Current control effect outcome is unknown: ${settlement.error instanceof Error ? settlement.error.message : String(settlement.error)}`,
        };
      }
      const execution = settlement.value as CurrentControlExecution;
      if (!execution || typeof execution !== 'object') {
        return { kind: 'unknown', message: 'Current control Adapter returned no settlement proof' };
      }
      if (execution.kind === 'stale') return { kind: 'staleAddress' };
      if (execution.kind === 'relocateOwnerResolved') {
        if (plan.command.kind !== 'relocate') {
          return { kind: 'unknown', message: 'relocate owner lookup lost its command' };
        }
        const ownerMatches = execution.unionId && plan.command.requester.unionId
          ? execution.unionId === plan.command.requester.unionId
          : plan.session.ownerOpenId === plan.command.requester.openId;
        if (!ownerMatches) {
          return {
            kind: 'rejected',
            reason: 'transitionRejected',
            code: 'not_session_owner',
            message: 'not_session_owner',
          };
        }
        if (!sameBinding(options.ownerLarkAppId, options.activeSessions, resolveStored, plan)) {
          return { kind: 'staleAddress' };
        }
        return effect(plan, 'relocateTransfer');
      }
      if (execution.kind === 'close') {
        const result = execution.result;
        if (result.ok) {
          return {
            kind: 'committed',
            result: {
              kind: 'closed',
              alreadyClosed: result.alreadyClosed,
              known: result.known,
            },
          };
        }
        if (plan.command.kind !== 'close') {
          return { kind: 'unknown', message: 'close effect lost its control command' };
        }
        const receipt = Object.freeze({ ...result });
        closeFailureReceipts.set(closeReceiptKey(plan.sessionId, plan.operationIdentity), {
          requestHash: plan.requestHash,
          ...(result.closeDisposition === 'unknown' ? { result: receipt } : {}),
        });
        return closeFailureTransition(receipt);
      }
      if (execution.kind === 'activate') {
        if (!execution.result.ok) {
          return execution.result.error === 'not_queued'
            ? {
                kind: 'rejected',
                reason: 'transitionRejected',
                message: execution.result.error,
              }
            : {
                kind: 'retryable',
                message: execution.result.error ?? 'queued activation did not commit',
              };
        }
        if (plan.command.kind === 'setBoardPlacement') {
          const metadata = applyMetadata(store, plan.sessionId, plan.command);
          if (metadata.kind === 'committed'
              || metadata.kind === 'unknown'
              || metadata.kind === 'quarantined') return metadata;
          return {
            kind: 'unknown',
            message: `queued activation committed before board metadata settled: ${'message' in metadata ? metadata.message : metadata.kind}`,
          };
        }
        return {
          kind: 'committed',
          result: {
            kind: 'queuedActivated',
            ...(normalizeKanbanColumn(plan.session.kanbanColumn)
              ? { column: normalizeKanbanColumn(plan.session.kanbanColumn)! }
              : {}),
            queued: false,
          },
        };
      }
      if (execution.kind === 'restart') {
        if (execution.revived) {
          const activation = activationTerminal(execution.activation);
          if (!isObject(activation)) {
            return { kind: 'unknown', message: 'Current restart returned no activation proof' };
          }
          if (activation.kind === 'retryable') {
            return { kind: 'retryable', message: String(activation.message) };
          }
          if (activation.kind === 'stale') return { kind: 'staleAddress' };
          if (activation.kind === 'ambiguous' || activation.kind === 'quarantined') {
            return { kind: 'unknown', message: String(activation.message) };
          }
          if (activation.kind === 'rejected') {
            return { kind: 'rejected', reason: 'transitionRejected', message: String(activation.message) };
          }
        }
        return {
          kind: 'committed',
          result: {
            kind: 'restarted',
            revived: execution.revived,
            session: controlSessionSnapshot(plan.session),
          },
        };
      }
      if (execution.kind === 'suspend') {
        return execution.suspended
          ? { kind: 'committed', result: { kind: 'suspended', suspended: true } }
          : {
              kind: 'rejected',
              reason: 'transitionRejected',
              code: 'backend_not_suspendable',
              message: 'Session backend cannot be suspended',
            };
      }
      if (execution.kind === 'relocate') {
        if (!execution.result.ok) {
          return execution.result.error === 'session_not_active'
            ? { kind: 'staleAddress' }
            : {
                kind: 'rejected',
                reason: 'transitionRejected',
                code: execution.result.error,
                message: execution.result.error,
              };
        }
        return {
          kind: 'committed',
          result: {
            kind: 'relocated',
            targetChatId: plan.command.kind === 'relocate'
              ? plan.command.targetChatId
              : plan.session.chatId,
            targetRootMessageId: plan.command.kind === 'relocate'
              ? plan.command.targetRootMessageId
              : plan.session.rootMessageId,
          },
        };
      }
      if (execution.kind === 'changeWorkingDirectory') {
        return {
          kind: 'committed',
          result: {
            kind: 'workingDirectoryChanged',
            mode: execution.mode,
            workingDir: plan.command.kind === 'changeWorkingDirectory'
              ? plan.command.resolvedPath
              : plan.session.workingDir!,
          },
        };
      }
      if (execution.kind === 'injectCommand') {
        return execution.accepted
          ? {
              kind: 'committed',
              result: {
                kind: 'commandInjected',
                command: plan.command.kind === 'injectCommand'
                  ? plan.command.command
                  : '',
              },
            }
          : {
              kind: 'rejected',
              reason: 'transitionRejected',
              code: 'no_live_worker',
              message: 'no_live_worker',
            };
      }
      if (!execution.result.ok) {
        if (execution.result.error === 'owner_mismatch') return { kind: 'staleAddress' };
        return {
          kind: 'rejected',
          reason: execution.result.error === 'not_found' ? 'sessionNotFound' : 'transitionRejected',
          ...(execution.result.error === 'not_found' ? { code: 'not_found' } : {}),
          message: execution.result.error,
          ...(execution.result.activeSessionId
            ? { details: { activeSessionId: execution.result.activeSessionId } }
            : {}),
        };
      }
      let executor: 'lazy' | 'active' | 'deferred' | 'unknown' = 'lazy';
      if (execution.wake) {
        const activation = activationTerminal(execution.activation);
        if (!isObject(activation)) {
          executor = 'unknown';
        } else if (activation.kind === 'active') {
          executor = activation.action === 'deferred' ? 'deferred' : 'active';
        } else if (activation.kind === 'ambiguous'
            || activation.kind === 'quarantined'
            || activation.kind === 'stale') {
          executor = 'unknown';
        }
      }
      return {
        kind: 'committed',
        result: {
          kind: 'reopened',
          wake: execution.wake,
          executor,
          session: controlSessionSnapshot(plan.session),
        },
      };
    },
  };
}

const portsByRegistry = new WeakMap<
  Map<string, DaemonSession>,
  Map<string, ControlMutationPort>
>();

export function currentSessionControlPort(options: {
  readonly ownerLarkAppId: string;
  readonly activeSessions: Map<string, DaemonSession>;
}): ControlMutationPort {
  let byOwner = portsByRegistry.get(options.activeSessions);
  if (!byOwner) {
    byOwner = new Map();
    portsByRegistry.set(options.activeSessions, byOwner);
  }
  let port = byOwner.get(options.ownerLarkAppId);
  if (!port) {
    port = createCurrentSessionControlPort(options);
    byOwner.set(options.ownerLarkAppId, port);
  }
  return port;
}
