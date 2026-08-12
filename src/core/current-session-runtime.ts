import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import * as asyncTriggerStore from '../services/async-trigger-store.js';
import * as idempotencyStore from '../services/idempotency-store.js';
import * as sessionStore from '../services/session-store.js';
import type { Session } from '../types.js';
import { parseBotId, type BotId } from './bot-identity.js';
import {
  currentDashboardProjectionProtocol,
  type CurrentDashboardProjectionProtocol,
} from './dashboard-projection.js';
import {
  composeRowFromActive,
  composeRowFromClosed,
  composeRowFromPersistedActive,
  type SessionRow,
} from './dashboard-rows.js';
import {
  effectiveSessionCliId,
  requestAgentSessionRename,
  type AgentSessionRenameRequest,
} from './session-rename.js';
import {
  activeSessionAnchorId,
  activeSessionKey,
  storedActiveSessionAnchorId,
  type DaemonSession,
} from './types.js';
import {
  currentSessionCommandLane,
  currentSessionLaneAddress,
} from './current-session-command-lane.js';
import { createCurrentKeyedTriggerTurnPort } from './current-keyed-trigger-turn.js';
import { currentSessionActivationCoordinator } from './current-session-activation.js';
import {
  createCurrentOrdinaryRouteRegistryRuntime,
  type CurrentOrdinaryRouteOpeningCreator,
} from './current-ordinary-route-registry.js';
import type { CurrentDashboardRouteOpeningPort } from './current-dashboard-route-opening.js';
import {
  createSessionRuntimeHost,
  type CommandOutcomeFor,
  type ControlRenameEffectPort,
  type ControlMutationPort,
  type KeyedTriggerAuthority,
  type KeyedTriggerBeginResult,
  type KeyedTriggerObservation,
  type KeyedTriggerReserveResult,
  type KeyedTriggerSettlementResult,
  type OrdinaryIngressPort,
  type PendingRepoCompletionPort,
  type ScheduledFirePort,
  type SessionDirectory,
  type SessionDirectoryQuery,
  type SessionDirectoryRead,
  type SessionDirectoryRow,
  type OrdinaryIngressRouteBinding,
  type SessionCommand,
  type SessionCommandRequest,
  type SessionAddress,
  type SessionProjection,
  type SessionRuntime,
  type SessionRoute,
  type SessionView,
  type KeyedTriggerTurnPort,
} from './session-runtime.js';

interface CurrentKeyedTriggerToken {
  key: string;
  record?: idempotencyStore.IdempotencyRecord;
}

function currentToken(value: unknown): CurrentKeyedTriggerToken | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<CurrentKeyedTriggerToken>;
  return typeof candidate.key === 'string' ? candidate as CurrentKeyedTriggerToken : undefined;
}

function sameRecordIdentity(
  record: idempotencyStore.IdempotencyRecord,
  candidate: {
    ownerLarkAppId: string;
    sessionId: string;
    triggerId: string;
    requestHash: string;
    ownerBootId: string;
  },
): boolean {
  return record.ownerLarkAppId === candidate.ownerLarkAppId
    && record.sessionId === candidate.sessionId
    && record.triggerId === candidate.triggerId
    && record.requestHash === candidate.requestHash
    && record.ownerBootId === candidate.ownerBootId;
}

function sameRecordSnapshot(
  left: idempotencyStore.IdempotencyRecord,
  right: idempotencyStore.IdempotencyRecord,
): boolean {
  return sameRecordIdentity(left, right)
    && left.revision === right.revision
    && left.state === right.state
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

type CurrentOwnerLiveSessionCensus =
  | { kind: 'ready'; sessions: DaemonSession[]; bySessionId: Map<string, DaemonSession> }
  | { kind: 'unreadable'; message: string };

function currentOwnerLiveSessionCensus(
  activeSessions: ReadonlyMap<string, DaemonSession>,
  ownerLarkAppId: string,
): CurrentOwnerLiveSessionCensus {
  const sessions: DaemonSession[] = [];
  const bySessionId = new Map<string, DaemonSession>();
  for (const [key, ds] of activeSessions) {
    const ownerRelated = ds.larkAppId === ownerLarkAppId
      || ds.session.larkAppId === ownerLarkAppId;
    if (!ownerRelated) continue;
    let canonical = false;
    try { canonical = key === activeSessionKey(ds); }
    catch { /* malformed owner evidence keeps the partition unavailable */ }
    if (!canonical
      || ds.larkAppId !== ownerLarkAppId
      || (!!ds.session.larkAppId && ds.session.larkAppId !== ownerLarkAppId)
      || typeof ds.session.sessionId !== 'string'
      || ds.session.sessionId.length === 0
      || ds.session.status !== 'active'
      || ds.session.chatId !== ds.chatId
      || (!!ds.session.chatType && ds.session.chatType !== ds.chatType)
      || (ds.session.scope ?? 'thread') !== ds.scope) {
      return {
        kind: 'unreadable',
        message: 'current Session registry found a malformed live owner binding',
      };
    }
    if (bySessionId.has(ds.session.sessionId)) {
      return {
        kind: 'unreadable',
        message: 'current Session registry found multiple live owner bindings for one Session',
      };
    }
    sessions.push(ds);
    bySessionId.set(ds.session.sessionId, ds);
  }
  return { kind: 'ready', sessions, bySessionId };
}

interface CurrentControlRenameIntent {
  readonly active: DaemonSession;
  readonly session: DaemonSession['session'];
  readonly sessionId: string;
  readonly title: string;
}

/** Capture the exact owner/canonical worker in-lane, then revalidate that same
 * binding immediately before the lane-external native rename send. */
export function createCurrentControlRenameEffectPort(input: {
  readonly ownerLarkAppId: string;
  readonly activeSessions: ReadonlyMap<string, DaemonSession>;
}): ControlRenameEffectPort {
  const intents = new WeakMap<object, CurrentControlRenameIntent>();
  return {
    begin(command) {
      const census = currentOwnerLiveSessionCensus(
        input.activeSessions,
        input.ownerLarkAppId,
      );
      if (census.kind === 'unreadable') {
        return { kind: 'unknown', message: census.message };
      }
      const active = census.bySessionId.get(command.sessionId);
      if (!active) return { kind: 'settled', result: { status: 'not_running' } };
      const intent = Object.freeze(Object.create(null)) as object;
      intents.set(intent, {
        active,
        session: active.session,
        sessionId: command.sessionId,
        title: command.title,
      });
      return { kind: 'effect', intent };
    },

    async execute(intent): Promise<AgentSessionRenameRequest> {
      if (!intent || typeof intent !== 'object') {
        return { status: 'failed', error: 'invalid_native_rename_intent' };
      }
      const captured = intents.get(intent);
      if (!captured) return { status: 'failed', error: 'stale_native_rename_intent' };
      intents.delete(intent);
      const census = currentOwnerLiveSessionCensus(
        input.activeSessions,
        input.ownerLarkAppId,
      );
      if (census.kind === 'unreadable') {
        return { status: 'failed', error: 'owner_binding_unavailable' };
      }
      const current = census.bySessionId.get(captured.sessionId);
      if (current !== captured.active || current.session !== captured.session) {
        const cliId = effectiveSessionCliId(captured.active);
        return { status: 'not_running', ...(cliId ? { cliId } : {}) };
      }
      return requestAgentSessionRename(captured.active, captured.title);
    },
  };
}

class CurrentKeyedTriggerRegistryInvariantError extends Error {}

/** Current JSON/journal implementation of the keyed at-most-once protocol. */
class CurrentKeyedTriggerAuthority implements KeyedTriggerAuthority {
  constructor(
    private readonly ownerLarkAppId: string,
    private readonly activeSessions: Map<string, DaemonSession>,
    private readonly ownerBootId: string,
    private readonly admissionBlocked: () => boolean,
  ) {}

  private observeRecord(record: idempotencyStore.IdempotencyRecord): Extract<KeyedTriggerObservation, { kind: 'present' }> {
    const census = currentOwnerLiveSessionCensus(this.activeSessions, this.ownerLarkAppId);
    if (census.kind === 'unreadable') {
      throw new CurrentKeyedTriggerRegistryInvariantError(census.message);
    }
    const live = census.bySessionId.get(record.sessionId);
    const executorLive = !!live?.worker && !live.worker.killed;
    const persistedOwned = sessionStore.getSessionForOwnerStrict(
      this.ownerLarkAppId,
      record.sessionId,
    );
    const chatId = live?.chatId ?? persistedOwned?.chatId ?? '';
    const asyncRecord = asyncTriggerStore.lookup(record.sessionId, record.triggerId);
    const terminal = asyncRecord?.ownerLarkAppId === record.ownerLarkAppId
      ? asyncRecord.result.status
      : 'pending';
    return {
      kind: 'present',
      token: { key: '', record } satisfies CurrentKeyedTriggerToken,
      requestHash: record.requestHash,
      sessionId: record.sessionId,
      triggerId: record.triggerId,
      chatId,
      leaseState: record.state,
      ownerBoot: record.ownerBootId === this.ownerBootId ? 'current' : 'other',
      terminal,
      executorLive,
    };
  }

  private terminalizeUnknown(
    record: idempotencyStore.IdempotencyRecord,
    message: string,
  ): Extract<KeyedTriggerReserveResult, { kind: 'ambiguous' | 'unreadable' }> {
    try {
      asyncTriggerStore.recordFailedStrict(
        record.sessionId,
        record.triggerId,
        Date.now(),
        this.ownerLarkAppId,
        'dispatch_unknown',
      );
      return { kind: 'ambiguous', durable: true, message };
    } catch (error) {
      return {
        kind: 'unreadable',
        message: `dispatch outcome became ambiguous but terminal evidence could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  inspect(key: string): KeyedTriggerObservation {
    if (this.admissionBlocked()) {
      return {
        kind: 'blocked',
        message: 'device credential activation in progress; retry the idempotent trigger shortly',
      };
    }
    try {
      const record = idempotencyStore.lookup(this.ownerLarkAppId, key);
      if (!record) return { kind: 'absent', token: { key } satisfies CurrentKeyedTriggerToken };
      const observation = this.observeRecord(record);
      observation.token = { key, record } satisfies CurrentKeyedTriggerToken;
      return observation;
    } catch (error) {
      return {
        kind: 'unreadable',
        message: `idempotency lease unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private recoverReserveAfterThrow(
    input: Parameters<KeyedTriggerAuthority['reserve']>[0],
    candidate: CurrentKeyedTriggerToken,
    originalError: unknown,
  ): KeyedTriggerReserveResult {
    const attemptedIdentity = {
      ownerLarkAppId: this.ownerLarkAppId,
      sessionId: input.sessionId,
      triggerId: input.triggerId,
      requestHash: input.requestHash,
      ownerBootId: this.ownerBootId,
    };
    try {
      const current = idempotencyStore.lookup(this.ownerLarkAppId, input.key);
      if (!current) {
        return {
          kind: 'retryable',
          message: `idempotency claim was proven not applied: ${originalError instanceof Error ? originalError.message : String(originalError)}`,
        };
      }
      if (current.requestHash !== input.requestHash) {
        return { kind: 'conflict', message: 'idempotency key already used with a different request payload' };
      }
      if (sameRecordIdentity(current, attemptedIdentity)) {
        if (current.state === 'reserved') {
          // The atomic rename landed and the response/fsync path threw. Exact
          // readback proves this candidate owns the published reserved lease, so
          // continue instead of lying that the command is freely retryable.
          return {
            kind: 'reserved',
            token: { key: input.key, record: current } satisfies CurrentKeyedTriggerToken,
          };
        }
        return this.terminalizeUnknown(
          current,
          `idempotency claim advanced past the dispatch fence before its result was known: ${originalError instanceof Error ? originalError.message : String(originalError)}`,
        );
      }
      if (candidate.record && sameRecordSnapshot(current, candidate.record)) {
        // A takeover write failed before publication; the exact older-boot
        // candidate remains. Leave it for a clean retry/takeover.
        return {
          kind: 'retryable',
          message: `idempotency takeover was proven not applied: ${originalError instanceof Error ? originalError.message : String(originalError)}`,
        };
      }
      const observation = this.observeRecord(current);
      observation.token = { key: input.key, record: current } satisfies CurrentKeyedTriggerToken;
      return { kind: 'existing', observation };
    } catch (readbackError) {
      return {
        kind: 'unreadable',
        message: `idempotency claim result is unprovable after write failure: ${readbackError instanceof Error ? readbackError.message : String(readbackError)}`,
      };
    }
  }

  reserve(input: Parameters<KeyedTriggerAuthority['reserve']>[0]): KeyedTriggerReserveResult {
    const candidate = currentToken(input.candidate);
    if (!candidate || candidate.key !== input.key) {
      return { kind: 'unreadable', message: 'invalid current keyed-trigger admission token' };
    }
    try {
      const result = candidate.record
        ? idempotencyStore.takeover({
            ownerLarkAppId: this.ownerLarkAppId,
            key: input.key,
            expect: candidate.record,
            sessionId: input.sessionId,
            triggerId: input.triggerId,
            requestHash: input.requestHash,
            ownerBootId: this.ownerBootId,
            now: Date.now(),
          })
        : idempotencyStore.claim({
            ownerLarkAppId: this.ownerLarkAppId,
            key: input.key,
            sessionId: input.sessionId,
            triggerId: input.triggerId,
            requestHash: input.requestHash,
            ownerBootId: this.ownerBootId,
            now: Date.now(),
          });
      if (result.kind === 'existing') {
        const observation = this.observeRecord(result.record);
        observation.token = { key: input.key, record: result.record } satisfies CurrentKeyedTriggerToken;
        return { kind: 'existing', observation };
      }
      return {
        kind: 'reserved',
        token: { key: input.key, record: result.record } satisfies CurrentKeyedTriggerToken,
      };
    } catch (error) {
      if (error instanceof idempotencyStore.IdempotencyConflictError) {
        return { kind: 'conflict', message: error.message };
      }
      if (error instanceof CurrentKeyedTriggerRegistryInvariantError) {
        return { kind: 'unreadable', message: error.message };
      }
      return this.recoverReserveAfterThrow(input, candidate, error);
    }
  }

  private reconcileBeginFailure(
    key: string,
    before: idempotencyStore.IdempotencyRecord,
    error: unknown,
  ): KeyedTriggerBeginResult {
    try {
      const release = idempotencyStore.compareAndRemove(this.ownerLarkAppId, key, before);
      if (release.kind === 'removed' || release.kind === 'absent') {
        return {
          kind: 'retryable',
          message: `idempotency attempt-barrier was proven not applied: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (release.sameIdentity && release.current.state === 'attempting') {
        return this.terminalizeUnknown(
          release.current,
          `idempotency attempt-barrier crossed then failed; outcome unknown (at-most-once, not re-run): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        kind: 'unreadable',
        message: `idempotency attempt-barrier lost exact authority: ${error instanceof Error ? error.message : String(error)}`,
      };
    } catch (releaseError) {
      return {
        kind: 'unreadable',
        message: `idempotency attempt-barrier state is unprovable: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
      };
    }
  }

  begin(token: unknown): KeyedTriggerBeginResult {
    const current = currentToken(token);
    if (!current?.record) {
      return { kind: 'unreadable', message: 'invalid current keyed-trigger lease token' };
    }
    const before = current.record;
    if (this.admissionBlocked()) {
      return this.reconcileBeginFailure(
        current.key,
        before,
        new Error('device credential activation acquired before dispatch'),
      );
    }
    const pendingCreatedAt = Date.now();
    try {
      const next = idempotencyStore.transition(this.ownerLarkAppId, current.key, before, {
        state: 'attempting',
        now: pendingCreatedAt,
      });
      // Keep the existing best-effort pending-result durability. The Runtime
      // owns when it happens; Target-A does not promote it to a commit receipt.
      asyncTriggerStore.recordPending(
        next.sessionId,
        next.triggerId,
        pendingCreatedAt,
        this.ownerLarkAppId,
      );
      return {
        kind: 'started',
        token: { key: current.key, record: next } satisfies CurrentKeyedTriggerToken,
        pendingCreatedAt,
      };
    } catch (error) {
      return this.reconcileBeginFailure(current.key, before, error);
    }
  }

  settleDispatchUnknown(token: unknown): KeyedTriggerSettlementResult {
    const current = currentToken(token);
    if (!current?.record) {
      return { kind: 'unreadable', message: 'invalid current keyed-trigger lease token' };
    }
    try {
      const terminal = asyncTriggerStore.recordFailedStrict(
        current.record.sessionId,
        current.record.triggerId,
        Date.now(),
        this.ownerLarkAppId,
        'dispatch_unknown',
      );
      return { kind: terminal === 'already_completed' ? 'completed' : 'failed' };
    } catch (error) {
      return {
        kind: 'unreadable',
        message: `dispatch failed and terminal outcome could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

function routeFor(session: Pick<Session, 'scope' | 'chatId' | 'rootMessageId'>): SessionRoute {
  if (session.scope === 'chat') return { kind: 'chat', chatId: session.chatId };
  return { kind: 'thread', anchorId: session.rootMessageId };
}

function ordinaryIngressBindingFor(
  session: Pick<Session, 'scope' | 'chatId' | 'chatType' | 'rootMessageId'>,
  canonicalAnchor: string,
  chatType = session.chatType ?? 'group',
): OrdinaryIngressRouteBinding {
  const scope = session.scope === 'chat' ? 'chat' : 'thread';
  return {
    scope,
    canonicalAnchor,
    chatId: session.chatId,
    chatType,
  };
}

function executorStatusFor(ds: DaemonSession): SessionDirectoryRow['executorStatus'] {
  if (ds.session.queued) return 'idle';
  if (!ds.worker || ds.worker.killed) return 'dormant';
  if (ds.lastScreenStatus === 'idle' || ds.lastScreenStatus === 'limited') return 'idle';
  return 'working';
}

function sameJsonPersistedSession(left: Session, right: Session): boolean {
  const persisted = (session: Session): unknown => JSON.parse(JSON.stringify(session)) as unknown;
  return isDeepStrictEqual(persisted(left), persisted(right));
}

class CurrentSessionDirectory implements SessionDirectory {
  constructor(
    private readonly ownerLarkAppId: string,
    private readonly activeSessions: Map<string, DaemonSession>,
    private readonly dashboardProjectionProtocol: CurrentDashboardProjectionProtocol,
  ) {}

  private openingBarrierMatches(
    query: Extract<SessionDirectoryQuery, { kind: 'byExternalSession' | 'byRoute' }>,
  ): boolean {
    const census = currentOwnerLiveSessionCensus(this.activeSessions, this.ownerLarkAppId);
    if (census.kind === 'unreadable') return false;
    for (const ds of census.sessions) {
      if (!ds.dashboardSpawnOpeningPending) continue;
      if (query.kind === 'byExternalSession') {
        if (ds.session.sessionId === query.sessionId) return true;
        continue;
      }
      const route = routeFor(ds.session);
      if (route.kind === 'thread' && query.route.kind === 'thread'
          && route.anchorId === query.route.anchorId) return true;
      if (route.kind === 'chat' && query.route.kind === 'chat'
          && route.chatId === query.route.chatId) return true;
    }
    return false;
  }

  private rows(): Extract<SessionDirectoryRead, { kind: 'list' | 'notReady' }> {
    const rows = new Map<string, SessionDirectoryRow>();
    const openingBarriers = new Set<string>();
    const settledLiveSessions = new Map<string, DaemonSession>();
    const census = currentOwnerLiveSessionCensus(this.activeSessions, this.ownerLarkAppId);
    if (census.kind === 'unreadable') {
      return { kind: 'notReady', message: census.message };
    }
    for (const ds of census.sessions) {
      if (ds.dashboardSpawnOpeningPending) {
        openingBarriers.add(ds.session.sessionId);
        continue;
      }
      settledLiveSessions.set(ds.session.sessionId, ds);
      rows.set(ds.session.sessionId, {
        key: ds.session.sessionId,
        sessionId: ds.session.sessionId,
        route: routeFor(ds.session),
        ordinaryIngressBinding: ordinaryIngressBindingFor(
          ds.session,
          activeSessionAnchorId(ds),
          ds.chatType,
        ),
        recordStatus: ds.session.status === 'active' ? 'active' : 'closed',
        executorStatus: executorStatusFor(ds),
      });
    }
    const durableSessions = sessionStore.listSessionsForOwnerStrict(this.ownerLarkAppId);
    const durableBySessionId = new Map(
      durableSessions.map(session => [session.sessionId, session]),
    );
    for (const [sessionId, ds] of settledLiveSessions) {
      const durable = durableBySessionId.get(sessionId);
      if (!durable || !sameJsonPersistedSession(ds.session, durable)) {
        return {
          kind: 'notReady',
          message: 'current live Session differs from its owner-strict durable row',
        };
      }
    }
    for (const session of durableSessions) {
      if (rows.has(session.sessionId) || openingBarriers.has(session.sessionId)) continue;
      rows.set(session.sessionId, {
        key: session.sessionId,
        sessionId: session.sessionId,
        route: routeFor(session),
        ordinaryIngressBinding: ordinaryIngressBindingFor(
          session,
          storedActiveSessionAnchorId(session),
        ),
        recordStatus: session.status === 'active' ? 'active' : 'closed',
        executorStatus: session.queued ? 'idle' : 'dormant',
      });
    }
    return { kind: 'list', rows: [...rows.values()] };
  }

  private dashboardRows():
    | { kind: 'rows'; rows: SessionRow[] }
    | Extract<SessionDirectoryRead, { kind: 'notReady' }> {
    const rows = new Map<string, SessionRow>();
    const openingBarriers = new Set<string>();
    const settledLiveSessions = new Map<string, DaemonSession>();
    const census = currentOwnerLiveSessionCensus(this.activeSessions, this.ownerLarkAppId);
    if (census.kind === 'unreadable') {
      return { kind: 'notReady', message: census.message };
    }
    for (const ds of census.sessions) {
      if (ds.dashboardSpawnOpeningPending) {
        openingBarriers.add(ds.session.sessionId);
        continue;
      }
      settledLiveSessions.set(ds.session.sessionId, ds);
      rows.set(ds.session.sessionId, composeRowFromActive(ds));
    }
    const durableSessions = sessionStore.listSessionsForOwnerStrict(this.ownerLarkAppId);
    const durableBySessionId = new Map(
      durableSessions.map(session => [session.sessionId, session]),
    );
    for (const [sessionId, ds] of settledLiveSessions) {
      const durable = durableBySessionId.get(sessionId);
      if (!durable || !sameJsonPersistedSession(ds.session, durable)) {
        return {
          kind: 'notReady',
          message: 'current live Session differs from its owner-strict durable row',
        };
      }
    }
    for (const session of durableSessions) {
      if (rows.has(session.sessionId) || openingBarriers.has(session.sessionId)) continue;
      rows.set(
        session.sessionId,
        session.status === 'closed'
          ? composeRowFromClosed(session)
          : composeRowFromPersistedActive(session),
      );
    }
    return { kind: 'rows', rows: [...rows.values()] };
  }

  async read(query: SessionDirectoryQuery): Promise<SessionDirectoryRead> {
    if (query.kind === 'dashboardSnapshot') {
      const dashboard = this.dashboardRows();
      if (dashboard.kind === 'notReady') return dashboard;
      // Row rebuild + cursor capture are one JS run-to-completion segment, so
      // no published event can be included in the cursor but absent from rows.
      return {
        kind: 'dashboardSnapshot',
        snapshot: this.dashboardProjectionProtocol.snapshot(dashboard.rows),
      };
    }
    if (query.kind !== 'list' && this.openingBarrierMatches(query)) {
      return {
        kind: 'notReady',
        message: 'Current Dashboard Session opening has not settled',
      };
    }
    const snapshot = this.rows();
    if (snapshot.kind === 'notReady') return snapshot;
    const rows = snapshot.rows;
    if (query.kind === 'list') return { kind: 'list', rows };
    const matches = query.kind === 'byExternalSession'
      ? rows.filter((candidate) => candidate.sessionId === query.sessionId)
      : rows.filter((candidate) => {
          const binding = candidate.ordinaryIngressBinding;
          if (binding.scope === 'thread' && query.route.kind === 'thread') {
            return binding.canonicalAnchor === query.route.anchorId;
          }
          if (binding.scope === 'chat' && query.route.kind === 'chat') {
            return binding.canonicalAnchor === query.route.chatId;
          }
          return false;
        });
    if (query.kind === 'byRoute') {
      const active = matches.filter(candidate => candidate.recordStatus === 'active');
      if (active.length === 1) return { kind: 'one', row: active[0] };
      if (active.length > 1) {
        return { kind: 'notReady', message: 'current Session projection has multiple active owner bindings' };
      }
      return { kind: 'notFound' };
    }
    if (matches.length > 1) {
      return { kind: 'notReady', message: 'current Session projection has multiple matching owner bindings' };
    }
    return matches[0] ? { kind: 'one', row: matches[0] } : { kind: 'notFound' };
  }
}

export interface CurrentSessionRuntimeHost {
  runtime: SessionRuntime;
  projection: SessionProjection;
}

interface CachedCurrentSessionRuntimeHost {
  ownerLarkAppId: string;
  runtimeEpoch: string;
  ordinaryIngress?: OrdinaryIngressPort;
  ordinaryRouteOpeningCreator?: CurrentOrdinaryRouteOpeningCreator;
  dashboardRouteOpening?: CurrentDashboardRouteOpeningPort;
  pendingRepoCompletion?: PendingRepoCompletionPort;
  scheduledFire?: ScheduledFirePort;
  controlMutation?: ControlMutationPort;
  controlRenameEffect: ControlRenameEffectPort;
  portBindings: {
    ordinaryIngress?: OrdinaryIngressPort;
    pendingRepoCompletion?: PendingRepoCompletionPort;
    scheduledFire?: ScheduledFirePort;
    controlMutation?: ControlMutationPort;
    controlRenameEffect?: ControlRenameEffectPort;
  };
  innerHost: CurrentSessionRuntimeHost;
  routeHost?: CurrentSessionRuntimeHost;
  lease: { active: boolean };
  host: CurrentSessionRuntimeHost;
}

const hostsByRegistry = new WeakMap<
  Map<string, DaemonSession>,
  Map<string, CachedCurrentSessionRuntimeHost>
>();
const adapterBotIdsByRegistry = new WeakMap<
  Map<string, DaemonSession>,
  Map<string, BotId>
>();

function ownerBotIdForCurrentAdapter(options: {
  ownerBotId: BotId | undefined;
  ownerLarkAppId: string;
  activeSessions: Map<string, DaemonSession>;
}): BotId {
  if (options.ownerBotId) return options.ownerBotId;
  let byOwner = adapterBotIdsByRegistry.get(options.activeSessions);
  if (!byOwner) {
    byOwner = new Map();
    adapterBotIdsByRegistry.set(options.activeSessions, byOwner);
  }
  let botId = byOwner.get(options.ownerLarkAppId);
  if (!botId) {
    botId = parseBotId(`bot_${randomUUID().replaceAll('-', '')}`);
    byOwner.set(options.ownerLarkAppId, botId);
  }
  return botId;
}

const controlRenameEffectsByRegistry = new WeakMap<
  Map<string, DaemonSession>,
  Map<string, ControlRenameEffectPort>
>();

function currentControlRenameEffectPort(input: {
  readonly ownerBotId: BotId;
  readonly ownerLarkAppId: string;
  readonly activeSessions: Map<string, DaemonSession>;
  readonly runtimeEpoch: string;
}): ControlRenameEffectPort {
  let byOwnerEpoch = controlRenameEffectsByRegistry.get(input.activeSessions);
  if (!byOwnerEpoch) {
    byOwnerEpoch = new Map();
    controlRenameEffectsByRegistry.set(input.activeSessions, byOwnerEpoch);
  }
  const key = `${input.ownerBotId}\0${input.runtimeEpoch}`;
  const cached = byOwnerEpoch.get(key);
  if (cached) return cached;
  const port = createCurrentControlRenameEffectPort(input);
  byOwnerEpoch.set(key, port);
  return port;
}

function leaseCurrentSessionRuntimeHost(
  host: CurrentSessionRuntimeHost,
  lease: { active: boolean },
): CurrentSessionRuntimeHost {
  const outerByInner = new WeakMap<object, SessionAddress>();
  const innerByOuter = new WeakMap<object, SessionAddress>();
  const outwardAddress = (inner: SessionAddress): SessionAddress => {
    const existing = outerByInner.get(inner);
    if (existing) return existing;
    const outer = Object.freeze(Object.create(null)) as SessionAddress;
    outerByInner.set(inner, outer);
    innerByOuter.set(outer, inner);
    return outer;
  };
  const outwardView = (view: SessionView): SessionView => ({
    ...view,
    address: outwardAddress(view.address),
  });
  return {
    runtime: {
      submit<C extends SessionCommand>(
        request: SessionCommandRequest<C>,
      ): Promise<CommandOutcomeFor<C>> {
        if (!lease.active) {
          return Promise.resolve({ kind: 'staleAddress' } as CommandOutcomeFor<C>);
        }
        if (request.target.kind !== 'session') return host.runtime.submit(request);
        const innerAddress = innerByOuter.get(request.target.address);
        if (!innerAddress) {
          return Promise.resolve({ kind: 'staleAddress' } as CommandOutcomeFor<C>);
        }
        return host.runtime.submit({
          ...request,
          target: { ...request.target, address: innerAddress },
        } as SessionCommandRequest<C>);
      },
    },
    projection: {
      async read(query) {
        if (!lease.active) {
          return {
            kind: 'notReady',
            message: 'Current SessionRuntime Host lease was superseded',
          };
        }
        const projected = await host.projection.read(query);
        if (!lease.active) {
          return {
            kind: 'notReady',
            message: 'Current SessionRuntime Host lease was superseded',
          };
        }
        if (projected.kind === 'one') {
          return { kind: 'one', session: outwardView(projected.session) };
        }
        if (projected.kind === 'list') {
          return { kind: 'list', sessions: projected.sessions.map(outwardView) };
        }
        return projected;
      },
    },
  };
}

/** One owner-bound runtime instance per immutable registry/daemon epoch. */
export function currentSessionRuntimeHost(options: {
  /** Canonical owner; all production callers must supply the I1 binding. */
  ownerBotId: BotId;
  ownerLarkAppId: string;
  activeSessions: Map<string, DaemonSession>;
  ownerBootId: string;
  runtimeEpoch?: string;
  keyedTriggerAdmissionBlocked: () => boolean;
  /** Internal execution seam used by fault tests; production uses Current. */
  keyedTriggerTurns?: KeyedTriggerTurnPort;
  /** Production composition seam for ordinary Lark message ingress. */
  ordinaryIngress?: OrdinaryIngressPort;
  /** Production-owned full opening creation; absent keeps route targets unsupported. */
  ordinaryRouteOpeningCreator?: CurrentOrdinaryRouteOpeningCreator;
  /** Staged Dashboard chat-route opening; route admission stays in the registry wrapper. */
  dashboardRouteOpening?: CurrentDashboardRouteOpeningPort;
  /** Staged Current seam for pending-repository first-start completion. */
  pendingRepoCompletion?: PendingRepoCompletionPort;
  /** Internal FI seam; production shares the process-local Current protocol. */
  dashboardProjectionProtocol?: CurrentDashboardProjectionProtocol;
  /** Staged Current seam for scheduled execution. */
  scheduledFire?: ScheduledFirePort;
  /** Staged Current seam for lifecycle and Dashboard control mutations. */
  controlMutation?: ControlMutationPort;
  /** Owner-bound exact-worker native rename seam. */
  controlRenameEffect?: ControlRenameEffectPort;
}): CurrentSessionRuntimeHost {
  const runtimeEpoch = options.runtimeEpoch ?? options.ownerBootId;
  // Pre-I1 JavaScript tests can omit the compile-time-required binding. Their
  // adapter identity remains opaque and process-local; production is gated.
  const stableOwnerKey = ownerBotIdForCurrentAdapter(options);
  const activation = currentSessionActivationCoordinator({
    ownerBotId: stableOwnerKey,
    ownerLarkAppId: options.ownerLarkAppId,
    runtimeEpoch,
    activeSessions: options.activeSessions,
  });
  const controlRenameEffect = options.controlRenameEffect
    ?? currentControlRenameEffectPort({
      ownerBotId: stableOwnerKey,
      ownerLarkAppId: options.ownerLarkAppId,
      activeSessions: options.activeSessions,
      runtimeEpoch,
    });
  const cacheable = options.keyedTriggerTurns === undefined
    && options.dashboardProjectionProtocol === undefined;
  const createInnerHost = (input: {
    portBindings?: {
      ordinaryIngress?: OrdinaryIngressPort;
      pendingRepoCompletion?: PendingRepoCompletionPort;
      scheduledFire?: ScheduledFirePort;
      controlMutation?: ControlMutationPort;
      controlRenameEffect?: ControlRenameEffectPort;
    };
  } = {}): CurrentSessionRuntimeHost => createSessionRuntimeHost({
    ownerBotId: stableOwnerKey,
    directory: new CurrentSessionDirectory(
      options.ownerLarkAppId,
      options.activeSessions,
      options.dashboardProjectionProtocol ?? currentDashboardProjectionProtocol,
    ),
    keyedTriggers: new CurrentKeyedTriggerAuthority(
      options.ownerLarkAppId,
      options.activeSessions,
      options.ownerBootId,
      options.keyedTriggerAdmissionBlocked,
    ),
    keyedTriggerTurns: options.keyedTriggerTurns ?? createCurrentKeyedTriggerTurnPort({
      ownerLarkAppId: options.ownerLarkAppId,
      activeSessions: options.activeSessions,
      activation,
    }),
    ...(input.portBindings
      ? { portBindings: input.portBindings }
      : {
          ordinaryIngress: options.ordinaryIngress,
          pendingRepoCompletion: options.pendingRepoCompletion,
          scheduledFire: options.scheduledFire,
          controlMutation: options.controlMutation,
          controlRenameEffect,
        }),
    sessionStore: sessionStore.createCurrentSessionStore({
      ownerLarkAppId: options.ownerLarkAppId,
      runtimeEpoch,
    }),
    commandLane: currentSessionCommandLane,
    sessionLaneAddress: sessionId => currentSessionLaneAddress(
      runtimeEpoch,
      stableOwnerKey,
      sessionId,
    ),
  });
  const composeRouteHost = (
    innerHost: CurrentSessionRuntimeHost,
    ordinaryIngress: OrdinaryIngressPort | undefined,
    openingCreator: CurrentOrdinaryRouteOpeningCreator | undefined,
    dashboardRouteOpening: CurrentDashboardRouteOpeningPort | undefined,
  ): CurrentSessionRuntimeHost | undefined => (
    ordinaryIngress && openingCreator
      ? {
          projection: innerHost.projection,
          runtime: createCurrentOrdinaryRouteRegistryRuntime({
            ownerLarkAppId: options.ownerLarkAppId,
            activeSessions: options.activeSessions,
            openingCreator,
            dashboardRouteOpening,
            downstream: innerHost,
          }),
        }
      : undefined
  );

  if (!cacheable) {
    const innerHost = createInnerHost();
    return composeRouteHost(
      innerHost,
      options.ordinaryIngress,
      options.ordinaryRouteOpeningCreator,
      options.dashboardRouteOpening,
    ) ?? innerHost;
  }

  let byOwner = hostsByRegistry.get(options.activeSessions);
  if (!byOwner) {
    byOwner = new Map();
    hostsByRegistry.set(options.activeSessions, byOwner);
  }
  const cached = byOwner.get(stableOwnerKey);
  if (cached && cached.ownerLarkAppId !== options.ownerLarkAppId) {
    throw new Error('Current SessionRuntime Bot is already bound to a different Lark owner');
  }
  if (cached?.runtimeEpoch === runtimeEpoch) {
    const ordinaryCompatible = options.ordinaryIngress === undefined
      || cached.ordinaryIngress === options.ordinaryIngress;
    const routeCreatorCompatible = options.ordinaryRouteOpeningCreator === undefined
      || cached.ordinaryRouteOpeningCreator === options.ordinaryRouteOpeningCreator;
    const dashboardRouteCompatible = options.dashboardRouteOpening === undefined
      || cached.dashboardRouteOpening === options.dashboardRouteOpening;
    const pendingRepoCompatible = options.pendingRepoCompletion === undefined
      || cached.pendingRepoCompletion === options.pendingRepoCompletion;
    const scheduledFireCompatible = options.scheduledFire === undefined
      || cached.scheduledFire === options.scheduledFire;
    const controlCompatible = options.controlMutation === undefined
      || cached.controlMutation === options.controlMutation;
    const renameEffectCompatible = options.controlRenameEffect === undefined
      || cached.controlRenameEffect === options.controlRenameEffect;
    if (ordinaryCompatible && routeCreatorCompatible && dashboardRouteCompatible
        && pendingRepoCompatible && scheduledFireCompatible
        && controlCompatible && renameEffectCompatible) {
      return cached.host;
    }
    if (!ordinaryCompatible && cached.ordinaryIngress !== undefined) {
      throw new Error('Current SessionRuntime owner epoch already has a different ordinary ingress port');
    }
    if (!pendingRepoCompatible && cached.pendingRepoCompletion !== undefined) {
      throw new Error('Current SessionRuntime owner epoch already has a different pending-repo completion port');
    }
    if (!scheduledFireCompatible && cached.scheduledFire !== undefined) {
      throw new Error('Current SessionRuntime owner epoch already has a different scheduled-fire port');
    }
    if (!controlCompatible && cached.controlMutation !== undefined) {
      throw new Error('Current SessionRuntime owner epoch already has a different control mutation port');
    }
    if (!renameEffectCompatible) {
      throw new Error('Current SessionRuntime owner epoch already has a different control rename effect port');
    }
    if (!routeCreatorCompatible && cached.ordinaryRouteOpeningCreator !== undefined) {
      throw new Error('Current SessionRuntime owner epoch already has a different ordinary route opening creator');
    }
    if (!dashboardRouteCompatible && cached.dashboardRouteOpening !== undefined) {
      throw new Error('Current SessionRuntime owner epoch already has a different Dashboard route opening port');
    }
    const ordinaryIngress = options.ordinaryIngress ?? cached.ordinaryIngress;
    const ordinaryRouteOpeningCreator = options.ordinaryRouteOpeningCreator
      ?? cached.ordinaryRouteOpeningCreator;
    const dashboardRouteOpening = options.dashboardRouteOpening
      ?? cached.dashboardRouteOpening;
    const pendingRepoCompletion = options.pendingRepoCompletion
      ?? cached.pendingRepoCompletion;
    const scheduledFire = options.scheduledFire ?? cached.scheduledFire;
    const controlMutation = options.controlMutation ?? cached.controlMutation;
    const resolvedControlRenameEffect = options.controlRenameEffect
      ?? cached.controlRenameEffect;
    const routeCompositionChanged = ordinaryIngress !== cached.ordinaryIngress
      || ordinaryRouteOpeningCreator !== cached.ordinaryRouteOpeningCreator
      || dashboardRouteOpening !== cached.dashboardRouteOpening;
    const routeHost = routeCompositionChanged
      ? composeRouteHost(
          cached.innerHost,
          ordinaryIngress,
          ordinaryRouteOpeningCreator,
          dashboardRouteOpening,
        )
      : cached.routeHost ?? composeRouteHost(
          cached.innerHost,
          ordinaryIngress,
          ordinaryRouteOpeningCreator,
          dashboardRouteOpening,
        );
    cached.portBindings.ordinaryIngress = ordinaryIngress;
    cached.portBindings.pendingRepoCompletion = pendingRepoCompletion;
    cached.portBindings.scheduledFire = scheduledFire;
    cached.portBindings.controlMutation = controlMutation;
    cached.portBindings.controlRenameEffect = resolvedControlRenameEffect;
    const composedHost = routeHost ?? cached.innerHost;
    const lease = { active: true };
    const host = leaseCurrentSessionRuntimeHost(composedHost, lease);
    cached.lease.active = false;
    byOwner.set(stableOwnerKey, {
      ownerLarkAppId: options.ownerLarkAppId,
      runtimeEpoch,
      ordinaryIngress,
      ordinaryRouteOpeningCreator,
      dashboardRouteOpening,
      pendingRepoCompletion,
      scheduledFire,
      controlMutation,
      controlRenameEffect: resolvedControlRenameEffect,
      portBindings: cached.portBindings,
      innerHost: cached.innerHost,
      routeHost,
      lease,
      host,
    });
    return host;
  }

  const portBindings = {
    ordinaryIngress: options.ordinaryIngress,
    pendingRepoCompletion: options.pendingRepoCompletion,
    scheduledFire: options.scheduledFire,
    controlMutation: options.controlMutation,
    controlRenameEffect,
  };
  const innerHost = createInnerHost({ portBindings });
  const routeHost = composeRouteHost(
    innerHost,
    options.ordinaryIngress,
    options.ordinaryRouteOpeningCreator,
    options.dashboardRouteOpening,
  );
  const lease = { active: true };
  const host = leaseCurrentSessionRuntimeHost(routeHost ?? innerHost, lease);
  if (cached) cached.lease.active = false;
  byOwner.set(stableOwnerKey, {
    ownerLarkAppId: options.ownerLarkAppId,
    runtimeEpoch,
    ordinaryIngress: options.ordinaryIngress,
    ordinaryRouteOpeningCreator: options.ordinaryRouteOpeningCreator,
    dashboardRouteOpening: options.dashboardRouteOpening,
    pendingRepoCompletion: options.pendingRepoCompletion,
    scheduledFire: options.scheduledFire,
    controlMutation: options.controlMutation,
    controlRenameEffect,
    portBindings,
    innerHost,
    routeHost,
    lease,
    host,
  });
  return host;
}
