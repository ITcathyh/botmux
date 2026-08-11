import { beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({
  activateQueuedSession: vi.fn(),
  closeSession: vi.fn(),
  ensureCurrentSessionActivation: vi.fn(),
  isSessionTransferring: vi.fn(),
  killWorker: vi.fn(),
  latestPerBotEnvForRestart: vi.fn(),
  resumeSession: vi.fn(),
  retireCurrentSessionActivation: vi.fn(),
  sendWorkerSessionInput: vi.fn(),
  suspendWorker: vi.fn(),
}));

const legacyStore = vi.hoisted(() => ({
  createCurrentSessionStore: vi.fn(),
  getOwnedSession: vi.fn(),
  getSessionForOwnerStrict: vi.fn(),
}));

const asyncTriggerStore = vi.hoisted(() => ({
  lookup: vi.fn(),
  recordFailedStrict: vi.fn(),
}));

vi.mock('../src/services/session-store.js', () => legacyStore);
vi.mock('../src/services/async-trigger-store.js', () => asyncTriggerStore);

vi.mock('../src/core/session-manager.js', () => ({
  activateQueuedSession: lifecycle.activateQueuedSession,
  resumeSession: lifecycle.resumeSession,
}));

vi.mock('../src/core/worker-pool.js', () => ({
  closeSession: lifecycle.closeSession,
  isSessionTransferring: lifecycle.isSessionTransferring,
  killWorker: lifecycle.killWorker,
  latestPerBotEnvForRestart: lifecycle.latestPerBotEnvForRestart,
  sendWorkerSessionInput: lifecycle.sendWorkerSessionInput,
  suspendWorker: lifecycle.suspendWorker,
}));

vi.mock('../src/core/current-session-activation.js', () => ({
  ensureCurrentSessionActivation: lifecycle.ensureCurrentSessionActivation,
  retireCurrentSessionActivation: lifecycle.retireCurrentSessionActivation,
}));

import { createCurrentSessionControlPort } from '../src/core/current-session-control.js';
import type {
  ControlMutationInput,
  ControlMutationPort,
  ControlMutationTransitionResult,
} from '../src/core/session-runtime.js';
import type {
  SessionStore,
  SessionStoreVersion,
  StoredSessionState,
} from '../src/core/session-store.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';

const OWNER = 'cli_owner';
const FOREIGN_OWNER = 'cli_foreign';
const SESSION_ID = 'session-current-control';

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: SESSION_ID,
    chatId: 'oc_current_control',
    rootMessageId: 'om_current_control',
    scope: 'thread',
    chatType: 'group',
    title: 'Current control',
    status: 'active',
    larkAppId: OWNER,
    createdAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function activeSession(
  sessionOverrides: Partial<Session> = {},
  runtimeOverrides: Partial<DaemonSession> = {},
): DaemonSession {
  const persisted = session(sessionOverrides);
  return {
    session: persisted,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: OWNER,
    chatId: persisted.chatId,
    chatType: persisted.chatType ?? 'group',
    scope: persisted.scope ?? 'thread',
    spawnedAt: 1,
    cliVersion: 'test',
    lastMessageAt: 1,
    hasHistory: true,
    ...runtimeOverrides,
  } as DaemonSession;
}

function storedState(overrides: Partial<StoredSessionState> = {}): StoredSessionState {
  return {
    sessionId: SESSION_ID,
    route: { kind: 'thread', anchorId: 'om_current_control' },
    recordStatus: 'active',
    title: 'Current control',
    executorGeneration: 1,
    queued: false,
    locked: false,
    ...overrides,
  };
}

function storeVersion(): SessionStoreVersion {
  return Object.freeze({}) as SessionStoreVersion;
}

function unusedStore(): SessionStore {
  return {
    load: vi.fn(() => ({ kind: 'notFound' as const })),
    apply: vi.fn(() => ({ kind: 'notApplied' as const, message: 'unused' })),
  };
}

function begin(
  port: ControlMutationPort,
  command: ControlMutationInput,
  operationIdentity = 'operation-1',
): ControlMutationTransitionResult {
  return port.begin({
    sessionId: SESSION_ID,
    operationIdentity,
    command,
  });
}

async function settleEffect(
  port: ControlMutationPort,
  effect: ControlMutationTransitionResult,
): Promise<ControlMutationTransitionResult> {
  if (effect.kind !== 'effect') throw new Error(`expected effect, got ${effect.kind}`);
  const value = await port.execute(effect.intent);
  return port.resume(effect.continuation, { kind: 'returned', value });
}

describe('Current Session control adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.isSessionTransferring.mockReturnValue(false);
    lifecycle.killWorker.mockImplementation(() => undefined);
    lifecycle.closeSession.mockImplementation(async (
      _sessionId: string,
      options: { isCurrent?: () => boolean } = {},
    ) => options.isCurrent?.() === false
      ? {
          ok: false,
          alreadyClosed: false,
          error: 'executor_generation_stale',
          closeDisposition: 'notApplied',
        }
      : { ok: true, alreadyClosed: false, known: true });
    lifecycle.retireCurrentSessionActivation.mockResolvedValue(undefined);
    lifecycle.ensureCurrentSessionActivation.mockResolvedValue({
      kind: 'active',
      action: 'started',
    });
    lifecycle.activateQueuedSession.mockResolvedValue({ ok: true });
    lifecycle.resumeSession.mockResolvedValue({ ok: true });
    lifecycle.sendWorkerSessionInput.mockReturnValue(true);
    lifecycle.suspendWorker.mockReturnValue(true);
    legacyStore.getOwnedSession.mockReset();
    legacyStore.getSessionForOwnerStrict.mockReset();
    asyncTriggerStore.lookup.mockReset();
    asyncTriggerStore.recordFailedStrict.mockReset();
    asyncTriggerStore.recordFailedStrict.mockReturnValue('written_failed');
  });

  it('fails closed when the owner-bound resolver finds a foreign row or no row', () => {
    const foreign = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => session({ larkAppId: FOREIGN_OWNER }),
    });
    const missing = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => undefined,
    });

    expect(begin(foreign, { kind: 'setLocked', locked: true })).toEqual({
      kind: 'rejected',
      reason: 'sessionNotFound',
      message: 'Current Session is not owned by this Runtime Host',
    });
    expect(begin(missing, { kind: 'activateQueued', source: 'dashboard' })).toEqual({
      kind: 'rejected',
      reason: 'sessionNotFound',
      message: 'Current Session is not owned by this Runtime Host',
    });
  });

  it('accepts an equal persisted binding and preserves a replaced-row close refusal', async () => {
    let current = session();
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ({ ...current }),
    });

    await expect(settleEffect(
      port,
      begin(port, { kind: 'close', reason: 'dashboard' }, 'equal-binding'),
    )).resolves.toEqual({
      kind: 'committed',
      result: { kind: 'closed', alreadyClosed: false, known: true },
    });
    expect(lifecycle.closeSession).toHaveBeenNthCalledWith(1, SESSION_ID, {
      owner: {
        larkAppId: OWNER,
        activeSessions: expect.any(Map),
      },
      isCurrent: expect.any(Function),
    });

    const staleEffect = begin(port, { kind: 'close', reason: 'dashboard' }, 'stale-binding');
    current = session({ title: 'Replacement row' });

    const staleResult = await settleEffect(port, staleEffect);
    expect(staleResult).toEqual({
      kind: 'retryable',
      message: 'executor_generation_stale',
    });
    expect(begin(port, { kind: 'close', reason: 'dashboard' }, 'stale-binding'))
      .toMatchObject({ kind: 'effect' });
    expect(lifecycle.closeSession).toHaveBeenCalledTimes(2);
  });

  it('preserves and replays a typed backend close failure without running the effect twice', async () => {
    const failure = {
      ok: false as const,
      alreadyClosed: false as const,
      error: 'riff_cancel_failed' as const,
      closeDisposition: 'unknown' as const,
      taskId: 'task-current-control',
    };
    lifecycle.closeSession.mockResolvedValue(failure);
    const current = session({ backendType: 'riff', riffParentTaskId: failure.taskId });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => current,
    });
    const command = { kind: 'close' as const, reason: 'dashboard' as const };

    const first = await settleEffect(port, begin(port, command, 'riff-close-failure'));
    expect(first).toEqual({ kind: 'quarantined', message: 'riff_cancel_failed' });
    expect(begin(port, command, 'riff-close-failure')).toEqual(first);
    expect(begin(port, { kind: 'close', reason: 'prune' }, 'riff-close-failure'))
      .toMatchObject({
        kind: 'rejected',
        reason: 'transitionRejected',
        code: 'idempotency_conflict',
      });
    expect(lifecycle.closeSession).toHaveBeenCalledTimes(1);
  });

  it('keeps a proven-open close refusal hash-only and re-drives the same operation', async () => {
    lifecycle.closeSession.mockReset();
    lifecycle.closeSession
      .mockResolvedValueOnce({
        ok: false,
        alreadyClosed: false,
        error: 'riff_shutdown_fence_in_progress',
        closeDisposition: 'notApplied',
        taskId: 'task-current-control',
      })
      .mockResolvedValueOnce({ ok: true, alreadyClosed: false, known: true });
    const current = session({ backendType: 'riff', riffParentTaskId: 'task-current-control' });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => current,
    });
    const command = { kind: 'close' as const, reason: 'dashboard' as const };

    await expect(settleEffect(port, begin(port, command, 'proven-open-close')))
      .resolves.toEqual({
        kind: 'retryable',
        message: 'riff_shutdown_fence_in_progress',
      });
    expect(begin(port, { kind: 'close', reason: 'prune' }, 'proven-open-close'))
      .toMatchObject({
        kind: 'rejected',
        code: 'idempotency_conflict',
      });
    await expect(settleEffect(port, begin(port, command, 'proven-open-close')))
      .resolves.toEqual({
        kind: 'committed',
        result: { kind: 'closed', alreadyClosed: false, known: true },
      });
    expect(lifecycle.closeSession).toHaveBeenCalledTimes(2);
  });

  it('keeps an unknown close outcome sticky and never re-drives its effect', async () => {
    lifecycle.closeSession.mockReset();
    lifecycle.closeSession.mockResolvedValue({
      ok: false,
      alreadyClosed: false,
      error: 'riff_cancel_failed',
      closeDisposition: 'unknown',
      taskId: 'task-current-control',
    });
    const current = session({ backendType: 'riff', riffParentTaskId: 'task-current-control' });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => current,
    });
    const command = { kind: 'close' as const, reason: 'dashboard' as const };

    const first = await settleEffect(port, begin(port, command, 'unknown-close'));
    expect(first).toEqual({
      kind: 'quarantined',
      message: 'riff_cancel_failed',
    });
    expect(begin(port, command, 'unknown-close')).toEqual(first);
    expect(lifecycle.closeSession).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a failed close identity is reused with another target payload', async () => {
    const failure = {
      ok: false as const,
      alreadyClosed: false as const,
      error: 'executor_generation_stale' as const,
      closeDisposition: 'notApplied' as const,
    };
    lifecycle.closeSession.mockResolvedValue(failure);
    const ds = activeSession({ cliId: 'traex' });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });
    const first = {
      kind: 'close' as const,
      reason: 'agentCliMismatch' as const,
      target: { cliId: 'codex' as const },
    };
    const conflicting = {
      ...first,
      target: { cliId: 'claude-code' as const },
    };

    await expect(settleEffect(port, begin(port, first, 'failed-close-conflict')))
      .resolves.toMatchObject({
        kind: 'retryable',
        message: 'executor_generation_stale',
      });
    expect(begin(port, conflicting, 'failed-close-conflict')).toMatchObject({
      kind: 'rejected',
      code: 'idempotency_conflict',
    });
    expect(lifecycle.closeSession).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the fresh owner row diverges from the lifecycle cache', () => {
    const stale = session({ title: 'stale lifecycle cache' });
    const fresh = session({ title: 'fresh owner row' });
    const ds = activeSession(stale);
    const registry = new Map([[activeSessionKey(ds), ds]]);
    legacyStore.getSessionForOwnerStrict.mockReturnValue(fresh);
    legacyStore.getOwnedSession.mockReturnValue(stale);
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: registry,
      sessionStore: unusedStore(),
    });

    for (const command of [
      { kind: 'close', reason: 'dashboard' },
      { kind: 'reopen', source: 'dashboard', wake: false },
      { kind: 'restart', source: 'dashboard' },
    ] as const) {
      expect(begin(port, command)).toEqual({
        kind: 'unknown',
        message: 'Current control has multiple exact owner bindings',
      });
    }
    expect(lifecycle.closeSession).not.toHaveBeenCalled();
    expect(lifecycle.resumeSession).not.toHaveBeenCalled();
    expect(lifecycle.ensureCurrentSessionActivation).not.toHaveBeenCalled();
  });

  it('accepts JSON-equivalent owner rows when the live cache retains undefined properties', () => {
    const ds = activeSession();
    ds.session.initialUserTurnPending = undefined;
    const fresh = JSON.parse(JSON.stringify(ds.session)) as Session;
    legacyStore.getSessionForOwnerStrict.mockReturnValue(fresh);
    legacyStore.getOwnedSession.mockReturnValue(ds.session);
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
    });

    expect(begin(port, { kind: 'close', reason: 'dashboard' }, 'json-shape-equivalent'))
      .toMatchObject({ kind: 'effect' });
  });

  it('rejects activation when the active Current Session is no longer queued', () => {
    const ds = activeSession({ queued: false });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    expect(begin(port, { kind: 'activateQueued', source: 'dashboard' })).toEqual({
      kind: 'rejected',
      reason: 'transitionRejected',
      code: 'not_queued',
      message: 'not_queued',
    });
  });

  it('codes non-active restart and suspend rejections for the HTTP adapter', () => {
    const stored = session({ status: 'active' });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => stored,
    });

    for (const command of [
      { kind: 'restart', source: 'dashboard' },
      { kind: 'suspend', source: 'dashboard' },
    ] as const) {
      expect(begin(port, command)).toEqual({
        kind: 'rejected',
        reason: 'transitionRejected',
        code: 'session_not_active',
        message: 'Current Session is not active in the owner registry',
      });
    }
  });

  it('codes reopen of an active Session as not_closed', () => {
    const ds = activeSession({ status: 'active' });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    expect(begin(port, { kind: 'reopen', source: 'dashboard', wake: false })).toEqual({
      kind: 'rejected',
      reason: 'transitionRejected',
      code: 'not_closed',
      message: 'Current Session is not closed',
    });
  });

  it('codes a non-suspendable backend settlement without exposing diagnostic prose', async () => {
    const ds = activeSession({}, {
      worker: { killed: false } as DaemonSession['worker'],
    });
    lifecycle.suspendWorker.mockReturnValue(false);
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    await expect(settleEffect(
      port,
      begin(port, { kind: 'suspend', source: 'dashboard' }, 'non-suspendable'),
    )).resolves.toEqual({
      kind: 'rejected',
      reason: 'transitionRejected',
      code: 'backend_not_suspendable',
      message: 'Session backend cannot be suspended',
    });
  });

  it('codes a reopen effect whose durable row disappeared as not_found', async () => {
    const closed = session({ status: 'closed' });
    lifecycle.resumeSession.mockResolvedValueOnce({ ok: false, error: 'not_found' });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ({ ...closed }),
    });

    await expect(settleEffect(
      port,
      begin(port, { kind: 'reopen', source: 'dashboard', wake: false }, 'missing-on-reopen'),
    )).resolves.toEqual({
      kind: 'rejected',
      reason: 'sessionNotFound',
      code: 'not_found',
      message: 'not_found',
    });
  });

  it('quarantines a live owner Session registered under a non-canonical alias', () => {
    const ds = activeSession({ queued: true });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([['non-canonical-alias', ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => undefined,
    });

    expect(begin(port, { kind: 'activateQueued', source: 'dashboard' })).toEqual({
      kind: 'unknown',
      message: 'Current control has multiple exact owner bindings',
    });
  });

  it('censuses malformed owner evidence before resolving another Session selector', () => {
    const requested = activeSession();
    const malformedSibling = activeSession({ sessionId: 'malformed-sibling' });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([
        [activeSessionKey(requested), requested],
        ['non-canonical-sibling', malformedSibling],
      ]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => requested.session,
    });

    expect(begin(port, { kind: 'close', reason: 'dashboard' })).toEqual({
      kind: 'unknown',
      message: 'Current control has multiple exact owner bindings',
    });
    expect(lifecycle.closeSession).not.toHaveBeenCalled();
  });

  it('does not let a foreign owner alias with the same sessionId drive close or reopen', () => {
    const foreign = activeSession({ larkAppId: FOREIGN_OWNER }, {
      larkAppId: FOREIGN_OWNER,
    });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(foreign), foreign]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => undefined,
    });

    expect(begin(port, { kind: 'close', reason: 'dashboard' })).toEqual({
      kind: 'committed',
      result: { kind: 'closed', alreadyClosed: true, known: false },
    });
    expect(begin(port, { kind: 'reopen', source: 'dashboard', wake: false })).toEqual({
      kind: 'rejected',
      reason: 'sessionNotFound',
      message: 'Current Session is not owned by this Runtime Host',
    });
    expect(lifecycle.closeSession).not.toHaveBeenCalled();
    expect(lifecycle.resumeSession).not.toHaveBeenCalled();
  });

  it('passes the exact owner registry to persisted-session reopen', async () => {
    const registry = new Map<string, DaemonSession>();
    const closed = session({ status: 'closed' });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: registry,
      sessionStore: unusedStore(),
      resolveStoredSession: () => ({ ...closed }),
    });

    await expect(settleEffect(
      port,
      begin(port, { kind: 'reopen', source: 'dashboard', wake: false }, 'owner-reopen'),
    )).resolves.toEqual({
      kind: 'committed',
      result: {
        kind: 'reopened',
        wake: false,
        executor: 'lazy',
        session: {
          title: 'Current control',
          chatId: 'oc_current_control',
          rootMessageId: 'om_current_control',
        },
      },
    });
    expect(lifecycle.resumeSession).toHaveBeenCalledWith(SESSION_ID, registry, {
      owner: {
        larkAppId: OWNER,
        activeSessions: registry,
      },
    });
  });

  it('returns exact protected-session evidence for prune admission', () => {
    const ds = activeSession({
      cliId: 'codex',
      queued: true,
      queuedActivationPending: true,
      queuedActivationTail: [{ order: 1 }] as Session['queuedActivationTail'],
      pendingRepoSetup: {} as Session['pendingRepoSetup'],
    }, {
      initialStartPending: true,
    });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    expect(begin(port, { kind: 'close', reason: 'prune' })).toEqual({
      kind: 'rejected',
      reason: 'transitionRejected',
      code: 'session_mutation_pending',
      message: 'session_mutation_pending',
      details: {
        blockingSessions: [{
          sessionId: SESSION_ID,
          cliId: 'codex',
          reasons: [
            'queued_todo',
            'activation_head',
            'activation_tail',
            'repository_setup',
            'initial_start',
          ],
        }],
      },
    });
  });

  it('refuses an Agent CLI mismatch close after the exact Session already matches the target', () => {
    const ds = activeSession({ cliId: 'codex', agentFrozen: true });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    expect(begin(port, {
      kind: 'close',
      reason: 'agentCliMismatch',
      target: { cliId: 'codex' },
    }, 'agent-already-matching')).toEqual({
      kind: 'rejected',
      reason: 'transitionRejected',
      code: 'agent_cli_mismatch_not_applicable',
      message: 'agent_cli_mismatch_not_applicable',
    });
    expect(lifecycle.closeSession).not.toHaveBeenCalled();
  });

  it('refuses relocate scratch retirement when accepted input appears after classification', () => {
    const ds = activeSession({
      chatId: 'oc_relocate_target',
      rootMessageId: 'oc_relocate_target',
      scope: 'chat',
      cliId: undefined,
      lastCliInput: undefined,
    });
    const routeReservation = Object.freeze({});
    const isRelocationRouteReservation = vi.fn(() => true);
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
      isRelocationRouteReservation,
    });

    // The route registry classified this row as disposable before the trigger
    // accepted work. The Session-lane begin is the final authority.
    ds.session.lastCliInput = 'accepted trigger input';
    const result = port.begin({
      sessionId: SESSION_ID,
      operationIdentity: 'relocate-scratch-race',
      routeReservation,
      command: {
        kind: 'close',
        reason: 'relocateScratch',
        expectedRoute: {
          scope: 'chat',
          canonicalAnchor: 'oc_relocate_target',
          chatId: 'oc_relocate_target',
          chatType: 'group',
        },
      } as unknown as ControlMutationInput,
    });

    expect(result).toEqual({
      kind: 'rejected',
      reason: 'transitionRejected',
      code: 'target_chat_has_session',
      message: 'target_chat_has_session',
    });
    expect(isRelocationRouteReservation).toHaveBeenCalledWith({
      token: routeReservation,
      ownerLarkAppId: OWNER,
      activeSessions: expect.any(Map),
      route: { kind: 'chat', chatId: 'oc_relocate_target' },
    });
    expect(lifecycle.closeSession).not.toHaveBeenCalled();
  });

  it('retires exact live and persisted-only scratches only under the held target route', async () => {
    const command: ControlMutationInput = {
      kind: 'close',
      reason: 'relocateScratch',
      expectedRoute: {
        scope: 'chat',
        canonicalAnchor: 'oc_relocate_target',
        chatId: 'oc_relocate_target',
        chatType: 'group',
      },
    };
    const live = activeSession({
      chatId: 'oc_relocate_target',
      rootMessageId: 'oc_relocate_target',
      scope: 'chat',
      cliId: undefined,
      lastCliInput: undefined,
    });
    const liveReservation = Object.freeze({});
    const livePort = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(live), live]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => live.session,
      isRelocationRouteReservation: ({ token }) => token === liveReservation,
    });

    const liveEffect = livePort.begin({
      sessionId: SESSION_ID,
      operationIdentity: 'retire-live-scratch',
      command,
      routeReservation: liveReservation,
    });
    await expect(settleEffect(livePort, liveEffect)).resolves.toMatchObject({
      kind: 'committed',
      result: { kind: 'closed', known: true },
    });

    const durable = session({
      chatId: 'oc_relocate_target',
      rootMessageId: 'oc_relocate_target',
      scope: 'chat',
      cliId: undefined,
      lastCliInput: undefined,
    });
    const durableReservation = Object.freeze({});
    const durablePort = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => durable,
      isRelocationRouteReservation: ({ token }) => token === durableReservation,
    });
    const durableEffect = durablePort.begin({
      sessionId: SESSION_ID,
      operationIdentity: 'retire-durable-scratch',
      command,
      routeReservation: durableReservation,
    });
    await expect(settleEffect(durablePort, durableEffect)).resolves.toMatchObject({
      kind: 'committed',
      result: { kind: 'closed', known: true },
    });
    expect(lifecycle.closeSession).toHaveBeenCalledTimes(2);
  });

  it('revalidates Agent CLI close exemptions, protected work, and transfer at admission', () => {
    const command = {
      kind: 'close' as const,
      reason: 'agentCliMismatch' as const,
      target: { cliId: 'codex' as const },
    };
    const queued = activeSession({ cliId: 'traex', queued: true });
    const adopted = activeSession({ cliId: 'traex', title: 'Adopt: external-pane' });
    const protectedSession = activeSession({ cliId: 'traex', queuedActivationPending: true });
    const transferring = activeSession({ cliId: 'traex' });
    const portFor = (ds: DaemonSession) => createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    for (const ds of [queued, adopted]) {
      expect(begin(portFor(ds), command)).toMatchObject({
        kind: 'rejected',
        code: 'agent_cli_mismatch_not_applicable',
      });
    }
    expect(begin(portFor(protectedSession), command)).toMatchObject({
      kind: 'rejected',
      code: 'session_mutation_pending',
      details: {
        blockingSessions: [{ sessionId: SESSION_ID, reasons: ['activation_head'] }],
      },
    });
    lifecycle.isSessionTransferring.mockImplementation(ds => ds === transferring);
    expect(begin(portFor(transferring), command)).toMatchObject({
      kind: 'rejected',
      code: 'session_transferring',
    });
    expect(lifecycle.closeSession).not.toHaveBeenCalled();
  });

  it('revalidates host-overload idle and persistent-backend eligibility at admission', () => {
    const ds = activeSession({}, {
      worker: { killed: false } as DaemonSession['worker'],
      lastScreenStatus: 'idle',
      initConfig: { backendType: 'tmux' } as DaemonSession['initConfig'],
    });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    expect(begin(port, { kind: 'suspend', source: 'hostOverload' }, 'eligible').kind)
      .toBe('effect');

    ds.lastScreenStatus = 'working';
    expect(begin(port, { kind: 'suspend', source: 'hostOverload' }, 'now-working'))
      .toMatchObject({ kind: 'rejected', code: 'host_overload_candidate_changed' });

    ds.lastScreenStatus = 'idle';
    ds.initConfig = { backendType: 'pty' } as DaemonSession['initConfig'];
    expect(begin(port, { kind: 'suspend', source: 'hostOverload' }, 'now-pty'))
      .toMatchObject({ kind: 'rejected', code: 'host_overload_candidate_changed' });
  });

  it('accepts metadata CAS conflict only when conflict readback proves the desired value', () => {
    const before = storedState();
    const desired = storedState({ locked: true });
    const desiredConflict: SessionStore = {
      load: vi.fn(() => ({ kind: 'loaded', state: before, version: storeVersion() })),
      apply: vi.fn(() => ({
        kind: 'conflict',
        current: { state: desired, version: storeVersion() },
      })),
    };
    const staleConflict: SessionStore = {
      load: vi.fn(() => ({ kind: 'loaded', state: before, version: storeVersion() })),
      apply: vi.fn(() => ({
        kind: 'conflict',
        current: { state: storedState({ locked: false }), version: storeVersion() },
      })),
    };

    const desiredPort = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: desiredConflict,
      resolveStoredSession: () => session(),
    });
    const stalePort = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: staleConflict,
      resolveStoredSession: () => session(),
    });

    expect(begin(desiredPort, { kind: 'setLocked', locked: true })).toEqual({
      kind: 'committed',
      result: { kind: 'lockUpdated', locked: true },
    });
    expect(begin(stalePort, { kind: 'setLocked', locked: true })).toEqual({
      kind: 'retryable',
      message: 'Current Session metadata version changed before publication',
    });
  });

  it('uses strict readback to settle an unknown metadata publication', () => {
    const before = storedState();
    const desired = storedState({ whiteboardId: 'whiteboard-1' });
    const load = vi.fn()
      .mockReturnValueOnce({ kind: 'loaded', state: before, version: storeVersion() })
      .mockReturnValueOnce({ kind: 'loaded', state: desired, version: storeVersion() });
    const store: SessionStore = {
      load,
      apply: vi.fn(() => ({ kind: 'unknown', message: 'publish ACK lost' })),
    };
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: store,
      resolveStoredSession: () => session(),
    });

    expect(begin(port, { kind: 'bindWhiteboard', whiteboardId: 'whiteboard-1' })).toEqual({
      kind: 'committed',
      result: { kind: 'whiteboardBound', whiteboardId: 'whiteboard-1' },
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps metadata outcome unknown when publication and readback are inconclusive', () => {
    const load = vi.fn()
      .mockReturnValueOnce({
        kind: 'loaded',
        state: storedState(),
        version: storeVersion(),
      })
      .mockReturnValueOnce({ kind: 'unavailable', message: 'readback unavailable' });
    const store: SessionStore = {
      load,
      apply: vi.fn(() => ({ kind: 'unknown', message: 'publish ACK lost' })),
    };
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: store,
      resolveStoredSession: () => session(),
    });

    expect(begin(port, { kind: 'setChatDisplayName', chatDisplayName: 'New chat' }))
      .toEqual({ kind: 'unknown', message: 'publish ACK lost' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('threads each operation identity into a fresh lifecycle activation request', async () => {
    const ds = activeSession();
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    await expect(settleEffect(
      port,
      begin(port, { kind: 'restart', source: 'dashboard' }, 'restart-one'),
    )).resolves.toEqual({
      kind: 'committed',
      result: {
        kind: 'restarted',
        revived: true,
        session: {
          title: 'Current control',
          chatId: 'oc_current_control',
          rootMessageId: 'om_current_control',
        },
      },
    });
    await expect(settleEffect(
      port,
      begin(port, { kind: 'restart', source: 'dashboard' }, 'restart-two'),
    )).resolves.toEqual({
      kind: 'committed',
      result: {
        kind: 'restarted',
        revived: true,
        session: {
          title: 'Current control',
          chatId: 'oc_current_control',
          rootMessageId: 'om_current_control',
        },
      },
    });

    expect(lifecycle.ensureCurrentSessionActivation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      requestIdentity: 'control-restart:restart-one',
    }));
    expect(lifecycle.ensureCurrentSessionActivation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      requestIdentity: 'control-restart:restart-two',
    }));
  });

  it('injects a validated command only through the exact live owner binding', async () => {
    const ds = activeSession({}, {
      worker: { killed: false } as DaemonSession['worker'],
    });
    const registry = new Map([[activeSessionKey(ds), ds]]);
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: registry,
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    await expect(settleEffect(port, begin(port, {
      kind: 'injectCommand',
      command: '/status',
    }, 'slash-one'))).resolves.toEqual({
      kind: 'committed',
      result: { kind: 'commandInjected', command: '/status' },
    });
    expect(lifecycle.sendWorkerSessionInput).toHaveBeenCalledOnce();
    expect(lifecycle.sendWorkerSessionInput).toHaveBeenCalledWith(ds, {
      type: 'inject_command',
      command: '/status',
    });
  });

  it.each([
    {
      label: 'adopted pane',
      runtime: {
        worker: { killed: false },
        adoptedFrom: { source: 'tmux', tmuxTarget: '0:1.0', cwd: '/tmp' },
      },
      code: 'adopt_inject_unsupported',
    },
    {
      label: 'dormant executor',
      runtime: { worker: null },
      code: 'no_live_worker',
    },
  ])('rejects command injection for $label before the worker effect', ({ runtime, code }) => {
    const ds = activeSession({}, runtime as Partial<DaemonSession>);
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    expect(begin(port, { kind: 'injectCommand', command: '/status' }))
      .toMatchObject({ kind: 'rejected', code });
    expect(lifecycle.sendWorkerSessionInput).not.toHaveBeenCalled();
  });

  it('preserves transfer buffering when the old worker is already detached', async () => {
    const ds = activeSession({}, { worker: null });
    lifecycle.isSessionTransferring.mockReturnValue(true);
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    await expect(settleEffect(port, begin(port, {
      kind: 'injectCommand',
      command: '/status',
    }))).resolves.toMatchObject({
      kind: 'committed',
      result: { kind: 'commandInjected', command: '/status' },
    });
    expect(lifecycle.sendWorkerSessionInput).toHaveBeenCalledWith(ds, {
      type: 'inject_command',
      command: '/status',
    });
  });

  it('converges one flagged async turn exactly once and consumes only that trigger', () => {
    const sibling = 'trigger-sibling';
    const ds = activeSession({}, {
      asyncTriggerResults: new Map([
        ['trigger-fault', { status: 'pending', createdAt: 1 }],
        [sibling, { status: 'pending', createdAt: 2 }],
      ]),
      idempotentAsyncTurns: new Map([
        ['trigger-fault', {
          ownerLarkAppId: OWNER,
          key: 'fault-key',
          kind: 'turn',
          workerGeneration: 1,
          postBarrierFault: true,
        }],
        [sibling, {
          ownerLarkAppId: OWNER,
          key: 'sibling-key',
          kind: 'turn',
          workerGeneration: 1,
        }],
      ]),
    });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    expect(begin(port, {
      kind: 'convergeAsyncTriggerFault',
      triggerId: 'trigger-fault',
    })).toEqual({
      kind: 'committed',
      result: {
        kind: 'asyncTriggerFaultConverged',
        state: 'failed',
        triggerId: 'trigger-fault',
        chatId: 'oc_current_control',
      },
    });
    expect(begin(port, {
      kind: 'convergeAsyncTriggerFault',
      triggerId: 'trigger-fault',
    })).toEqual({
      kind: 'committed',
      result: {
        kind: 'asyncTriggerFaultConverged',
        state: 'noChange',
        triggerId: 'trigger-fault',
      },
    });
    expect(asyncTriggerStore.recordFailedStrict).toHaveBeenCalledOnce();
    expect(ds.idempotentAsyncTurns?.has('trigger-fault')).toBe(false);
    expect(ds.asyncTriggerResults?.has('trigger-fault')).toBe(false);
    expect(ds.idempotentAsyncTurns?.has(sibling)).toBe(true);
    expect(ds.asyncTriggerResults?.has(sibling)).toBe(true);
  });

  it('preserves a fault for retry when strict terminal publication is unknown', () => {
    const ds = activeSession({}, {
      asyncTriggerResults: new Map([['trigger-fault', { status: 'pending', createdAt: 1 }]]),
      idempotentAsyncTurns: new Map([['trigger-fault', {
        ownerLarkAppId: OWNER,
        key: 'fault-key',
        kind: 'turn',
        workerGeneration: 1,
        postBarrierFault: true,
      }]]),
    });
    asyncTriggerStore.recordFailedStrict.mockImplementation(() => {
      throw new Error('EIO after publication attempt');
    });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    expect(begin(port, {
      kind: 'convergeAsyncTriggerFault',
      triggerId: 'trigger-fault',
    })).toMatchObject({
      kind: 'retryable',
      message: expect.stringContaining('EIO'),
    });
    expect(ds.idempotentAsyncTurns?.has('trigger-fault')).toBe(true);
    expect(ds.asyncTriggerResults?.has('trigger-fault')).toBe(true);
  });

  it('lets durable completion win without deleting the completed in-memory result', () => {
    const completed = { status: 'completed' as const, createdAt: 1, completedAt: 2, content: 'done' };
    const ds = activeSession({}, {
      asyncTriggerResults: new Map([['trigger-fault', completed]]),
      idempotentAsyncTurns: new Map([['trigger-fault', {
        ownerLarkAppId: OWNER,
        key: 'fault-key',
        kind: 'turn',
        workerGeneration: 1,
        postBarrierFault: true,
      }]]),
    });
    asyncTriggerStore.lookup.mockReturnValue({
      ownerLarkAppId: OWNER,
      triggerId: 'trigger-fault',
      result: completed,
    });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    expect(begin(port, {
      kind: 'convergeAsyncTriggerFault',
      triggerId: 'trigger-fault',
    })).toMatchObject({
      kind: 'committed',
      result: { kind: 'asyncTriggerFaultConverged', state: 'noChange' },
    });
    expect(asyncTriggerStore.recordFailedStrict).not.toHaveBeenCalled();
    expect(ds.idempotentAsyncTurns?.has('trigger-fault')).toBe(false);
    expect(ds.asyncTriggerResults?.get('trigger-fault')).toBe(completed);
  });

  it('does not consume a foreign owner or non-canonical alias with the same session id', () => {
    const foreign = activeSession({ larkAppId: FOREIGN_OWNER }, {
      larkAppId: FOREIGN_OWNER,
      idempotentAsyncTurns: new Map([['trigger-fault', {
        ownerLarkAppId: FOREIGN_OWNER,
        key: 'foreign-key',
        kind: 'turn',
        workerGeneration: 1,
        postBarrierFault: true,
      }]]),
    });
    const alias = activeSession({}, {
      idempotentAsyncTurns: new Map([['trigger-fault', {
        ownerLarkAppId: OWNER,
        key: 'alias-key',
        kind: 'turn',
        workerGeneration: 1,
        postBarrierFault: true,
      }]]),
    });
    const foreignPort = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(foreign), foreign]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => undefined,
    });
    const aliasPort = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([['alias', alias]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => undefined,
    });

    expect(begin(foreignPort, {
      kind: 'convergeAsyncTriggerFault',
      triggerId: 'trigger-fault',
    })).toMatchObject({ kind: 'rejected', reason: 'sessionNotFound' });
    expect(begin(aliasPort, {
      kind: 'convergeAsyncTriggerFault',
      triggerId: 'trigger-fault',
    })).toMatchObject({ kind: 'unknown' });
    expect(asyncTriggerStore.recordFailedStrict).not.toHaveBeenCalled();
    expect(foreign.idempotentAsyncTurns?.has('trigger-fault')).toBe(true);
    expect(alias.idempotentAsyncTurns?.has('trigger-fault')).toBe(true);
  });

  it('publishes a cwd transition before restarting the exact live executor', async () => {
    const send = vi.fn();
    const ds = activeSession({
      workingDir: '/roles/old',
      riffRepoDirs: ['/roles/old'],
    }, {
      workingDir: '/roles/old',
      worker: { killed: false, send } as DaemonSession['worker'],
      initConfig: {
        backendType: 'tmux',
        workingDir: '/roles/old',
      } as DaemonSession['initConfig'],
    });
    const before = storedState({
      workingDir: '/roles/old',
      riffRepoDirs: ['/roles/old'],
    } as Partial<StoredSessionState>);
    const after = storedState({ workingDir: '/roles/new' } as Partial<StoredSessionState>);
    const store: SessionStore = {
      load: vi.fn(() => ({ kind: 'loaded', state: before, version: storeVersion() })),
      apply: vi.fn(() => ({ kind: 'applied', state: after, nextVersion: storeVersion() })),
    };
    const registry = new Map([[activeSessionKey(ds), ds]]);
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: registry,
      sessionStore: store,
      resolveStoredSession: () => ds.session,
    });

    const result = await settleEffect(port, begin(port, {
      kind: 'changeWorkingDirectory',
      resolvedPath: '/roles/new',
    } as ControlMutationInput, 'cwd-one'));

    expect(result).toEqual({
      kind: 'committed',
      result: {
        kind: 'workingDirectoryChanged',
        mode: 'respawn-resume',
        workingDir: '/roles/new',
      },
    });
    expect(store.apply).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION_ID,
      transition: { kind: 'changeWorkingDirectory', workingDir: '/roles/new' },
    }));
    expect(ds.workingDir).toBe('/roles/new');
    expect(ds.session.workingDir).toBe('/roles/new');
    expect(ds.session.riffRepoDirs).toBeUndefined();
    expect(ds.initConfig?.workingDir).toBe('/roles/new');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'restart',
      updateWorkingDir: '/roles/new',
    }));
  });

  it.each([
    {
      label: 'adopted pane',
      runtime: { adoptedFrom: { source: 'tmux', tmuxTarget: '0:1.0', cwd: '/roles/old' } },
      code: 'adopt_cd_unsupported',
    },
    {
      label: 'Riff lineage',
      runtime: { initConfig: { backendType: 'riff', workingDir: '/roles/old' } },
      code: 'riff_cd_unsupported',
    },
    {
      label: 'protected activation',
      session: { queuedActivationPending: true },
      code: 'session_mutation_pending',
    },
  ])('rejects cwd for $label before Store publication', ({ runtime = {}, session: row = {}, code }) => {
    const ds = activeSession(row as Partial<Session>, runtime as Partial<DaemonSession>);
    const store = unusedStore();
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: store,
      resolveStoredSession: () => ds.session,
    });

    expect(begin(port, {
      kind: 'changeWorkingDirectory',
      resolvedPath: '/roles/new',
    })).toMatchObject({ kind: 'rejected', code });
    expect(store.load).not.toHaveBeenCalled();
    expect(lifecycle.killWorker).not.toHaveBeenCalled();
  });

  it('rejects cwd while transfer owns the Session before Store publication', () => {
    const ds = activeSession();
    const store = unusedStore();
    lifecycle.isSessionTransferring.mockReturnValue(true);
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: store,
      resolveStoredSession: () => ds.session,
    });

    expect(begin(port, {
      kind: 'changeWorkingDirectory',
      resolvedPath: '/roles/new',
    })).toMatchObject({ kind: 'rejected', code: 'session_transferring' });
    expect(store.load).not.toHaveBeenCalled();
  });

  it.each([
    ['unreachable live worker', true],
    ['no live worker', false],
  ] as const)('uses cold restart and destroys stale backing state for %s', async (_label, hasWorker) => {
    const send = vi.fn(() => { throw new Error('worker channel closed'); });
    const ds = activeSession({ workingDir: '/roles/old' }, {
      workingDir: '/roles/old',
      worker: hasWorker ? { killed: false, send } as DaemonSession['worker'] : null,
      initConfig: { backendType: 'tmux', workingDir: '/roles/old' } as DaemonSession['initConfig'],
    });
    const store: SessionStore = {
      load: vi.fn(() => ({
        kind: 'loaded',
        state: storedState({ workingDir: '/roles/old' }),
        version: storeVersion(),
      })),
      apply: vi.fn(() => ({
        kind: 'applied',
        state: storedState({ workingDir: '/roles/new' }),
        nextVersion: storeVersion(),
      })),
    };
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: store,
      resolveStoredSession: () => ds.session,
    });

    await expect(settleEffect(port, begin(port, {
      kind: 'changeWorkingDirectory',
      resolvedPath: '/roles/new',
    }))).resolves.toEqual({
      kind: 'committed',
      result: {
        kind: 'workingDirectoryChanged',
        mode: 'cold-restart',
        workingDir: '/roles/new',
      },
    });
    expect(send).toHaveBeenCalledTimes(hasWorker ? 1 : 0);
    expect(lifecycle.killWorker).toHaveBeenCalledWith(ds);
  });

  it('does not restart a replacement executor after cwd metadata commits', async () => {
    const send = vi.fn();
    const original = activeSession({ workingDir: '/roles/old' }, {
      worker: { killed: false, send } as DaemonSession['worker'],
    });
    let current = original;
    const registry = new Map([[activeSessionKey(original), original]]);
    const store: SessionStore = {
      load: vi.fn(() => ({
        kind: 'loaded',
        state: storedState({ workingDir: '/roles/old' }),
        version: storeVersion(),
      })),
      apply: vi.fn(() => ({
        kind: 'applied',
        state: storedState({ workingDir: '/roles/new' }),
        nextVersion: storeVersion(),
      })),
    };
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: registry,
      sessionStore: store,
      resolveStoredSession: () => current.session,
    });
    const effect = begin(port, {
      kind: 'changeWorkingDirectory',
      resolvedPath: '/roles/new',
    });
    const replacement = activeSession({ workingDir: '/roles/new' }, {
      worker: { killed: false, send: vi.fn() } as DaemonSession['worker'],
    });
    current = replacement;
    registry.set(activeSessionKey(replacement), replacement);

    await expect(settleEffect(port, effect)).resolves.toEqual({ kind: 'staleAddress' });
    expect(send).not.toHaveBeenCalled();
    expect(replacement.worker?.send).not.toHaveBeenCalled();
    expect(lifecycle.killWorker).not.toHaveBeenCalled();
  });
});
