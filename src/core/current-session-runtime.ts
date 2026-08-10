import * as asyncTriggerStore from '../services/async-trigger-store.js';
import * as idempotencyStore from '../services/idempotency-store.js';
import * as sessionStore from '../services/session-store.js';
import type { Session } from '../types.js';
import {
  activeSessionAnchorId,
  storedActiveSessionAnchorId,
  type DaemonSession,
} from './types.js';
import {
  currentSessionCommandLane,
  currentSessionLaneAddress,
} from './current-session-command-lane.js';
import { createCurrentKeyedTriggerTurnPort } from './current-keyed-trigger-turn.js';
import {
  createCurrentOrdinaryRouteRegistryRuntime,
  type CurrentOrdinaryRouteOpeningCreator,
} from './current-ordinary-route-registry.js';
import {
  createSessionRuntimeHost,
  type CommandOutcomeFor,
  type KeyedTriggerAuthority,
  type KeyedTriggerBeginResult,
  type KeyedTriggerObservation,
  type KeyedTriggerReserveResult,
  type KeyedTriggerSettlementResult,
  type OrdinaryIngressPort,
  type PendingRepoCompletionPort,
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

function activeBySessionId(
  activeSessions: Map<string, DaemonSession>,
  ownerLarkAppId: string,
  sessionId: string,
): DaemonSession | undefined {
  for (const ds of activeSessions.values()) {
    if (ds.larkAppId === ownerLarkAppId && ds.session.sessionId === sessionId) return ds;
  }
  return undefined;
}

/** Current JSON/journal implementation of the keyed at-most-once protocol. */
class CurrentKeyedTriggerAuthority implements KeyedTriggerAuthority {
  constructor(
    private readonly ownerLarkAppId: string,
    private readonly activeSessions: Map<string, DaemonSession>,
    private readonly ownerBootId: string,
    private readonly admissionBlocked: () => boolean,
  ) {}

  private observeRecord(record: idempotencyStore.IdempotencyRecord): Extract<KeyedTriggerObservation, { kind: 'present' }> {
    const live = activeBySessionId(this.activeSessions, this.ownerLarkAppId, record.sessionId);
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
      return { kind: terminal };
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

class CurrentSessionDirectory implements SessionDirectory {
  constructor(
    private readonly ownerLarkAppId: string,
    private readonly activeSessions: Map<string, DaemonSession>,
  ) {}

  private rows(): SessionDirectoryRow[] {
    const rows = new Map<string, SessionDirectoryRow>();
    for (const ds of this.activeSessions.values()) {
      if (ds.larkAppId !== this.ownerLarkAppId) continue;
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
    for (const session of sessionStore.listSessionsForOwnerStrict(this.ownerLarkAppId)) {
      if (rows.has(session.sessionId)) continue;
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
    return [...rows.values()];
  }

  async read(query: SessionDirectoryQuery): Promise<SessionDirectoryRead> {
    const rows = this.rows();
    if (query.kind === 'list') return { kind: 'list', rows };
    const matches = query.kind === 'byExternalSession'
      ? rows.filter((candidate) => candidate.sessionId === query.sessionId)
      : rows.filter((candidate) => {
          if (candidate.route.kind === 'thread' && query.route.kind === 'thread') {
            return candidate.route.anchorId === query.route.anchorId;
          }
          if (candidate.route.kind === 'chat' && query.route.kind === 'chat') {
            return candidate.route.chatId === query.route.chatId;
          }
          return false;
        });
    if (query.kind === 'byRoute') {
      const active = matches.filter(candidate => candidate.recordStatus === 'active');
      if (active.length === 1) return { kind: 'one', row: active[0] };
      if (active.length > 1) {
        return { kind: 'notReady', message: 'current Session projection has multiple active owner bindings' };
      }
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
  runtimeEpoch: string;
  ordinaryIngress?: OrdinaryIngressPort;
  ordinaryRouteOpeningCreator?: CurrentOrdinaryRouteOpeningCreator;
  pendingRepoCompletion?: PendingRepoCompletionPort;
  portBindings: {
    ordinaryIngress?: OrdinaryIngressPort;
    pendingRepoCompletion?: PendingRepoCompletionPort;
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
          target: { kind: 'session', address: innerAddress },
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
  /** Staged Current seam for pending-repository first-start completion. */
  pendingRepoCompletion?: PendingRepoCompletionPort;
}): CurrentSessionRuntimeHost {
  const runtimeEpoch = options.runtimeEpoch ?? options.ownerBootId;
  const cacheable = options.keyedTriggerTurns === undefined;
  const createInnerHost = (input: {
    portBindings?: {
      ordinaryIngress?: OrdinaryIngressPort;
      pendingRepoCompletion?: PendingRepoCompletionPort;
    };
  } = {}): CurrentSessionRuntimeHost => createSessionRuntimeHost({
    directory: new CurrentSessionDirectory(options.ownerLarkAppId, options.activeSessions),
    keyedTriggers: new CurrentKeyedTriggerAuthority(
      options.ownerLarkAppId,
      options.activeSessions,
      options.ownerBootId,
      options.keyedTriggerAdmissionBlocked,
    ),
    keyedTriggerTurns: options.keyedTriggerTurns ?? createCurrentKeyedTriggerTurnPort({
      ownerLarkAppId: options.ownerLarkAppId,
      activeSessions: options.activeSessions,
    }),
    ...(input.portBindings
      ? { portBindings: input.portBindings }
      : {
          ordinaryIngress: options.ordinaryIngress,
          pendingRepoCompletion: options.pendingRepoCompletion,
        }),
    sessionStore: sessionStore.createCurrentSessionStore({
      ownerLarkAppId: options.ownerLarkAppId,
      runtimeEpoch,
    }),
    commandLane: currentSessionCommandLane,
    sessionLaneAddress: sessionId => currentSessionLaneAddress(
      runtimeEpoch,
      options.ownerLarkAppId,
      sessionId,
    ),
  });
  const composeRouteHost = (
    innerHost: CurrentSessionRuntimeHost,
    ordinaryIngress: OrdinaryIngressPort | undefined,
    openingCreator: CurrentOrdinaryRouteOpeningCreator | undefined,
  ): CurrentSessionRuntimeHost | undefined => (
    ordinaryIngress && openingCreator
      ? {
          projection: innerHost.projection,
          runtime: createCurrentOrdinaryRouteRegistryRuntime({
            ownerLarkAppId: options.ownerLarkAppId,
            activeSessions: options.activeSessions,
            openingCreator,
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
    ) ?? innerHost;
  }

  let byOwner = hostsByRegistry.get(options.activeSessions);
  if (!byOwner) {
    byOwner = new Map();
    hostsByRegistry.set(options.activeSessions, byOwner);
  }
  const cached = byOwner.get(options.ownerLarkAppId);
  if (cached?.runtimeEpoch === runtimeEpoch) {
    const ordinaryCompatible = options.ordinaryIngress === undefined
      || cached.ordinaryIngress === options.ordinaryIngress;
    const routeCreatorCompatible = options.ordinaryRouteOpeningCreator === undefined
      || cached.ordinaryRouteOpeningCreator === options.ordinaryRouteOpeningCreator;
    const pendingRepoCompatible = options.pendingRepoCompletion === undefined
      || cached.pendingRepoCompletion === options.pendingRepoCompletion;
    if (ordinaryCompatible && routeCreatorCompatible && pendingRepoCompatible) {
      return cached.host;
    }
    if (!ordinaryCompatible && cached.ordinaryIngress !== undefined) {
      throw new Error('Current SessionRuntime owner epoch already has a different ordinary ingress port');
    }
    if (!pendingRepoCompatible && cached.pendingRepoCompletion !== undefined) {
      throw new Error('Current SessionRuntime owner epoch already has a different pending-repo completion port');
    }
    if (!routeCreatorCompatible && cached.ordinaryRouteOpeningCreator !== undefined) {
      throw new Error('Current SessionRuntime owner epoch already has a different ordinary route opening creator');
    }
    const ordinaryIngress = options.ordinaryIngress ?? cached.ordinaryIngress;
    const ordinaryRouteOpeningCreator = options.ordinaryRouteOpeningCreator
      ?? cached.ordinaryRouteOpeningCreator;
    const pendingRepoCompletion = options.pendingRepoCompletion
      ?? cached.pendingRepoCompletion;
    const routeHost = cached.routeHost ?? composeRouteHost(
      cached.innerHost,
      ordinaryIngress,
      ordinaryRouteOpeningCreator,
    );
    cached.portBindings.ordinaryIngress = ordinaryIngress;
    cached.portBindings.pendingRepoCompletion = pendingRepoCompletion;
    const composedHost = routeHost ?? cached.innerHost;
    const lease = { active: true };
    const host = leaseCurrentSessionRuntimeHost(composedHost, lease);
    cached.lease.active = false;
    byOwner.set(options.ownerLarkAppId, {
      runtimeEpoch,
      ordinaryIngress,
      ordinaryRouteOpeningCreator,
      pendingRepoCompletion,
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
  };
  const innerHost = createInnerHost({ portBindings });
  const routeHost = composeRouteHost(
    innerHost,
    options.ordinaryIngress,
    options.ordinaryRouteOpeningCreator,
  );
  const lease = { active: true };
  const host = leaseCurrentSessionRuntimeHost(routeHost ?? innerHost, lease);
  if (cached) cached.lease.active = false;
  byOwner.set(options.ownerLarkAppId, {
    runtimeEpoch,
    ordinaryIngress: options.ordinaryIngress,
    ordinaryRouteOpeningCreator: options.ordinaryRouteOpeningCreator,
    pendingRepoCompletion: options.pendingRepoCompletion,
    portBindings,
    innerHost,
    routeHost,
    lease,
    host,
  });
  return host;
}
