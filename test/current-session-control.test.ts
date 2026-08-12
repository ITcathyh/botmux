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
  settleCurrentSessionRetirement: vi.fn(),
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
  settleCurrentSessionRetirement: lifecycle.settleCurrentSessionRetirement,
}));

import {
  createCurrentSessionControlPort as createCurrentSessionControlPortImpl,
  currentSessionControlPort,
} from '../src/core/current-session-control.js';
import {
  currentRouteAdmissionKey,
  reserveCurrentRouteAdmission,
} from '../src/core/current-route-admission.js';
import type { CurrentSessionActivationCoordinator } from '../src/core/current-session-activation.js';
import type {
  ControlMutationInput,
  ControlMutationPort,
  ControlMutationTransitionResult,
  KeyedTriggerAuthority,
  KeyedTriggerTurnPort,
  SessionDirectory,
} from '../src/core/session-runtime.js';
import { createSessionRuntimeHost } from '../src/core/session-runtime.js';
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
const OWNER_BOT_ID = 'bot_controlowner' as never;
const RUNTIME_EPOCH = 'daemon-epoch-1';
const defaultActivation = {
  ensure: lifecycle.ensureCurrentSessionActivation,
  reconcile: vi.fn(),
  retire: lifecycle.retireCurrentSessionActivation,
  settleRetirement: lifecycle.settleCurrentSessionRetirement,
} as unknown as CurrentSessionActivationCoordinator;
const defaultRouteScratchRetirement = {
  retire: vi.fn(async () => ({ kind: 'cleared' as const })),
};

type ControlPortOptions = Parameters<typeof createCurrentSessionControlPortImpl>[0];
function createCurrentSessionControlPort(
  options: Omit<ControlPortOptions, 'ownerBotId' | 'runtimeEpoch' | 'activation'>
  & Partial<Pick<ControlPortOptions, 'ownerBotId' | 'runtimeEpoch' | 'activation'>>,
): ReturnType<typeof createCurrentSessionControlPortImpl> {
  return createCurrentSessionControlPortImpl({
    ownerBotId: OWNER_BOT_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    activation: defaultActivation,
    routeScratchRetirement: defaultRouteScratchRetirement,
    ...options,
  });
}

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

const unusedRuntimeKeyedTriggers: KeyedTriggerAuthority = {
  inspect: () => ({ kind: 'unreadable', message: 'unused' }),
  reserve: () => ({ kind: 'unreadable', message: 'unused' }),
  begin: () => ({ kind: 'unreadable', message: 'unused' }),
  settleDispatchUnknown: () => ({ kind: 'unreadable', message: 'unused' }),
};

const unusedRuntimeKeyedTurns: KeyedTriggerTurnPort = {
  prepare: () => ({ kind: 'unreadable', message: 'unused' }),
  acceptAtMostOnce: async () => ({ kind: 'refused', message: 'unused' }),
  failClose: async () => ({ kind: 'unreadable', message: 'unused' }),
};

function runtimeDirectory(): SessionDirectory {
  const row = {
    key: 'current-control-runtime-row',
    sessionId: SESSION_ID,
    route: { kind: 'thread' as const, anchorId: 'om_current_control' },
    ordinaryIngressBinding: {
      scope: 'thread' as const,
      canonicalAnchor: 'om_current_control',
      chatId: 'oc_current_control',
      chatType: 'group' as const,
    },
    recordStatus: 'active' as const,
    executorStatus: 'working' as const,
  };
  return {
    async read(query) {
      if (query.kind === 'list') return { kind: 'list', rows: [row] };
      if (query.kind === 'dashboardSnapshot') {
        return { kind: 'notReady', message: 'unused dashboard snapshot' };
      }
      const matches = query.kind === 'byExternalSession'
        ? query.sessionId === SESSION_ID
        : query.route.kind === 'thread'
          && query.route.anchorId === row.route.anchorId;
      return matches ? { kind: 'one', row } : { kind: 'notFound' };
    },
  };
}

async function runtimeAddressFor(controlMutation: ControlMutationPort) {
  const host = createSessionRuntimeHost({
    directory: runtimeDirectory(),
    keyedTriggers: unusedRuntimeKeyedTriggers,
    keyedTriggerTurns: unusedRuntimeKeyedTurns,
    controlMutation,
  });
  const projected = await host.projection.read({
    kind: 'byExternalSession',
    sessionId: SESSION_ID,
  });
  if (projected.kind !== 'one') throw new Error('expected exact Runtime test Session');
  return { host, address: projected.session.address };
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
    lifecycle.retireCurrentSessionActivation.mockResolvedValue({
      kind: 'retired',
      action: 'retired',
    });
    lifecycle.settleCurrentSessionRetirement.mockImplementation(async request => (
      request.disposition === 'unknown'
        ? { kind: 'quarantined', message: 'provider outcome is unknown' }
        : { kind: 'settled', disposition: request.disposition }
    ));
    lifecycle.ensureCurrentSessionActivation.mockResolvedValue({
      kind: 'active',
      action: 'started',
    });
    lifecycle.activateQueuedSession.mockResolvedValue({ ok: true });
    lifecycle.resumeSession.mockResolvedValue({ ok: true });
    lifecycle.sendWorkerSessionInput.mockReturnValue(true);
    lifecycle.suspendWorker.mockReturnValue(true);
    defaultRouteScratchRetirement.retire.mockReset();
    defaultRouteScratchRetirement.retire.mockResolvedValue({ kind: 'cleared' });
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

  it('fails closed when one Bot epoch is rebound to another owner or activation coordinator', () => {
    const registry = new Map<string, DaemonSession>();
    const firstActivation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(),
    } as unknown as CurrentSessionActivationCoordinator;
    const secondActivation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(),
    } as unknown as CurrentSessionActivationCoordinator;
    const input = {
      ownerBotId: OWNER_BOT_ID,
      ownerLarkAppId: OWNER,
      runtimeEpoch: RUNTIME_EPOCH,
      activation: firstActivation,
      activeSessions: registry,
    };

    const first = currentSessionControlPort(input);
    expect(currentSessionControlPort(input)).toBe(first);
    expect(() => currentSessionControlPort({
      ...input,
      activation: secondActivation,
    })).toThrow(/different activation coordinator/i);
    expect(() => currentSessionControlPort({
      ...input,
      ownerLarkAppId: FOREIGN_OWNER,
    })).toThrow(/different Lark App/i);
    expect(() => currentSessionControlPort({
      ...input,
      ownerLarkAppId: FOREIGN_OWNER,
      runtimeEpoch: `${RUNTIME_EPOCH}-next`,
      activation: secondActivation,
    })).toThrow(/different Lark App/i);
  });

  it('replaces one Bot cache binding on a new daemon epoch without retaining the old port', () => {
    const registry = new Map<string, DaemonSession>();
    const firstActivation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(),
    } as unknown as CurrentSessionActivationCoordinator;
    const nextActivation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(),
    } as unknown as CurrentSessionActivationCoordinator;
    const firstInput = {
      ownerBotId: OWNER_BOT_ID,
      ownerLarkAppId: OWNER,
      runtimeEpoch: 'daemon-epoch-cache-first',
      activation: firstActivation,
      activeSessions: registry,
    };
    const nextInput = {
      ...firstInput,
      runtimeEpoch: 'daemon-epoch-cache-next',
      activation: nextActivation,
    };

    const first = currentSessionControlPort(firstInput);
    const next = currentSessionControlPort(nextInput);

    expect(next).not.toBe(first);
    expect(currentSessionControlPort(nextInput)).toBe(next);
    expect(currentSessionControlPort(firstInput)).not.toBe(first);
  });

  it('isolates cache bindings for different stable Bots that share one Lark App', () => {
    const registry = new Map<string, DaemonSession>();
    const firstActivation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(),
    } as unknown as CurrentSessionActivationCoordinator;
    const otherActivation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(),
    } as unknown as CurrentSessionActivationCoordinator;
    const first = currentSessionControlPort({
      ownerBotId: OWNER_BOT_ID,
      ownerLarkAppId: OWNER,
      runtimeEpoch: 'daemon-epoch-shared-app',
      activation: firstActivation,
      activeSessions: registry,
    });
    const other = currentSessionControlPort({
      ownerBotId: 'bot_other_control_owner' as never,
      ownerLarkAppId: OWNER,
      runtimeEpoch: 'daemon-epoch-shared-app',
      activation: otherActivation,
      activeSessions: registry,
    });

    expect(other).not.toBe(first);
  });

  it('accepts an equal persisted binding and makes post-retirement replacement sticky-unknown', async () => {
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
    expect(staleResult).toMatchObject({
      kind: 'unknown',
      message: expect.stringContaining('after activation retirement committed'),
    });
    expect(lifecycle.closeSession).toHaveBeenCalledTimes(1);
  });

  it('uses the injected owner coordinator to fence close before the provider', async () => {
    const events: string[] = [];
    const activation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(async () => {
        events.push('retire');
        return { kind: 'retryable' as const, message: 'activation fence unavailable' };
      }),
    };
    lifecycle.closeSession.mockImplementation(async () => {
      events.push('close');
      return { ok: true, alreadyClosed: false, known: true };
    });
    const current = session();
    const port = createCurrentSessionControlPort({
      ownerBotId: OWNER_BOT_ID,
      ownerLarkAppId: OWNER,
      runtimeEpoch: RUNTIME_EPOCH,
      activation,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => current,
    });

    await expect(settleEffect(
      port,
      begin(port, { kind: 'close', reason: 'dashboard' }, 'close-fenced'),
    )).resolves.toEqual({
      kind: 'retryable',
      message: 'activation fence unavailable',
    });
    expect(activation.retire).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'control-close:close-fenced',
      reason: 'explicitClose',
    });
    expect(events).toEqual(['retire']);
    expect(lifecycle.retireCurrentSessionActivation).not.toHaveBeenCalled();
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

  it('re-drives a proven-open close refusal through a fresh retirement receipt', async () => {
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
    expect(lifecycle.retireCurrentSessionActivation).toHaveBeenCalledTimes(2);
    const [firstRetirement, secondRetirement] = lifecycle.retireCurrentSessionActivation.mock.calls;
    expect(secondRetirement![0].requestIdentity).not.toBe(firstRetirement![0].requestIdentity);
    expect(lifecycle.settleCurrentSessionRetirement).toHaveBeenNthCalledWith(1, {
      ...firstRetirement![0],
      disposition: 'notApplied',
    });
    expect(lifecycle.settleCurrentSessionRetirement).toHaveBeenNthCalledWith(2, {
      ...secondRetirement![0],
      disposition: 'applied',
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
    expect(lifecycle.settleCurrentSessionRetirement).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'control-close:unknown-close',
      reason: 'explicitClose',
      disposition: 'unknown',
    });
    expect(lifecycle.closeSession).toHaveBeenCalledTimes(1);
  });

  it('settles the activation fence as unknown when the close provider throws', async () => {
    lifecycle.closeSession.mockRejectedValue(new Error('provider transport lost'));
    const current = session();
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => current,
    });
    const effect = begin(port, { kind: 'close', reason: 'dashboard' }, 'throwing-close');
    if (effect.kind !== 'effect') throw new Error(`expected effect, got ${effect.kind}`);

    await expect(port.execute(effect.intent)).rejects.toThrow('provider transport lost');
    expect(lifecycle.settleCurrentSessionRetirement).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'control-close:throwing-close',
      reason: 'explicitClose',
      disposition: 'unknown',
    });
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

  it('publishes passivation before suspending the provider executor', async () => {
    const events: string[] = [];
    const activation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(async () => {
        events.push('retire');
        return { kind: 'retired' as const, action: 'retired' as const };
      }),
      settleRetirement: vi.fn(async ({ disposition }) => {
        events.push(`settle:${disposition}`);
        return { kind: 'settled' as const, disposition: 'applied' as const };
      }),
    };
    lifecycle.suspendWorker.mockImplementation(() => {
      events.push('suspend');
      return true;
    });
    const ds = activeSession({}, {
      worker: { killed: false } as DaemonSession['worker'],
    });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activation,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    await expect(settleEffect(
      port,
      begin(port, { kind: 'suspend', source: 'dashboard' }, 'suspend-fenced'),
    )).resolves.toMatchObject({
      kind: 'committed',
      result: { kind: 'suspended', suspended: true },
    });
    expect(activation.retire).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'control-suspend:suspend-fenced',
      reason: 'passivation',
    });
    expect(events).toEqual(['retire', 'suspend', 'settle:applied']);
  });

  it('still publishes passivation when suspend finds no live worker', async () => {
    const ds = activeSession({}, { worker: null });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    const transition = begin(
      port,
      { kind: 'suspend', source: 'dashboard' },
      'suspend-dormant',
    );
    expect(transition.kind).toBe('effect');
    await expect(settleEffect(port, transition)).resolves.toEqual({
      kind: 'committed',
      result: { kind: 'suspended', suspended: false },
    });
    expect(lifecycle.retireCurrentSessionActivation).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'control-suspend:suspend-dormant',
      reason: 'passivation',
    });
    expect(lifecycle.suspendWorker).not.toHaveBeenCalled();
  });

  it('codes a reopen effect whose durable row disappeared as not_found', async () => {
    const closed = session({ status: 'closed' });
    const routeReservation = Object.freeze({});
    lifecycle.resumeSession.mockResolvedValueOnce({ ok: false, error: 'not_found' });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ({ ...closed }),
      isRouteAdmissionToken: ({ token }) => token === routeReservation,
    });

    await expect(settleEffect(
      port,
      port.begin({
        sessionId: SESSION_ID,
        operationIdentity: 'missing-on-reopen',
        command: { kind: 'reopen', source: 'dashboard', wake: false },
        routeReservation,
      }),
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
    const reopened = activeSession();
    const routeReservation = Object.freeze({});
    lifecycle.resumeSession.mockImplementationOnce(async () => {
      registry.set(activeSessionKey(reopened), reopened);
      return { ok: true, ds: reopened };
    });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: registry,
      sessionStore: unusedStore(),
      resolveStoredSession: () => registry.get(activeSessionKey(reopened))?.session ?? ({ ...closed }),
      isRouteAdmissionToken: ({ token }) => token === routeReservation,
    });

    await expect(settleEffect(
      port,
      port.begin({
        sessionId: SESSION_ID,
        operationIdentity: 'owner-reopen',
        command: { kind: 'reopen', source: 'dashboard', wake: false },
        routeReservation,
      }),
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
        routeConflictPolicy: 'failClosed',
      },
    });
    expect(defaultRouteScratchRetirement.retire).toHaveBeenCalledWith({
      expectedRoute: {
        scope: 'thread',
        canonicalAnchor: 'om_current_control',
        chatId: 'oc_current_control',
        chatType: 'group',
      },
      source: 'resume',
      parentSessionId: SESSION_ID,
      parentOperationIdentity: 'owner-reopen',
      heldRouteAdmissionToken: routeReservation,
    });
    expect(lifecycle.ensureCurrentSessionActivation).not.toHaveBeenCalled();
  });

  it('wakes a reopened Session only after its new exact binding is published', async () => {
    const events: string[] = [];
    const registry = new Map<string, DaemonSession>();
    const closed = session({ status: 'closed' });
    const reopened = activeSession();
    const routeReservation = Object.freeze({});
    lifecycle.resumeSession.mockImplementationOnce(async () => {
      events.push('resume');
      registry.set(activeSessionKey(reopened), reopened);
      return { ok: true, ds: reopened };
    });
    const activation = {
      reconcile: vi.fn(),
      retire: vi.fn(),
      ensure: vi.fn(async () => {
        expect(registry.get(activeSessionKey(reopened))).toBe(reopened);
        events.push('ensure');
        return { kind: 'active' as const, action: 'started' as const };
      }),
    };
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activation,
      activeSessions: registry,
      sessionStore: unusedStore(),
      resolveStoredSession: () => registry.get(activeSessionKey(reopened))?.session ?? closed,
      isRouteAdmissionToken: ({ token }) => token === routeReservation,
    });

    await expect(settleEffect(
      port,
      port.begin({
        sessionId: SESSION_ID,
        operationIdentity: 'owner-reopen-wake',
        command: { kind: 'reopen', source: 'dashboard', wake: true },
        routeReservation,
      }),
    )).resolves.toMatchObject({
      kind: 'committed',
      result: { kind: 'reopened', wake: true, executor: 'active' },
    });
    expect(activation.ensure).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'control-reopen:owner-reopen-wake',
      cause: 'dashboard',
      promptInput: '',
      resumeOrTurnId: true,
    });
    expect(events).toEqual(['resume', 'ensure']);
  });

  it('requires a held exact route admission before a Dashboard reopen can enter its effect', () => {
    const closed = session({ status: 'closed' });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => closed,
      isRouteAdmissionToken: () => false,
    });

    expect(begin(
      port,
      { kind: 'reopen', source: 'dashboard', wake: false },
      'owner-reopen-unreserved',
    )).toEqual({
      kind: 'rejected',
      reason: 'invalidCommand',
      code: 'target_route_not_reserved',
      message: 'target_route_not_reserved',
    });
    expect(defaultRouteScratchRetirement.retire).not.toHaveBeenCalled();
    expect(lifecycle.resumeSession).not.toHaveBeenCalled();
  });

  it('fails closed when a classified route scratch accepts input before reopen cleanup', async () => {
    const closed = session({ status: 'closed' });
    const routeReservation = Object.freeze({});
    const retirement = {
      retire: vi.fn(async () => ({
        kind: 'occupied' as const,
        activeSessionId: 'scratch-accepted-input',
      })),
    };
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => closed,
      isRouteAdmissionToken: ({ token }) => token === routeReservation,
      routeScratchRetirement: retirement,
    });
    const effect = port.begin({
      sessionId: SESSION_ID,
      operationIdentity: 'owner-reopen-accepted-input',
      command: { kind: 'reopen', source: 'dashboard', wake: false },
      routeReservation,
    });

    await expect(settleEffect(port, effect)).resolves.toEqual({
      kind: 'rejected',
      reason: 'transitionRejected',
      message: 'anchor_occupied',
      details: { activeSessionId: 'scratch-accepted-input' },
    });
    expect(lifecycle.resumeSession).not.toHaveBeenCalled();
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
    const isRouteAdmissionToken = vi.fn(() => true);
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
      isRouteAdmissionToken,
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
        reason: 'routeScratch',
        source: 'relocate',
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
    expect(isRouteAdmissionToken).toHaveBeenCalledWith({
      token: routeReservation,
      key: `${OWNER}\0chat\0oc_relocate_target\0oc_relocate_target\0group`,
    });
    expect(lifecycle.closeSession).not.toHaveBeenCalled();
  });

  it('retires exact live and persisted-only scratches only under the held target route', async () => {
    const command: ControlMutationInput = {
      kind: 'close',
      reason: 'routeScratch',
      source: 'relocate',
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
      isRouteAdmissionToken: ({ token }) => token === liveReservation,
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
      isRouteAdmissionToken: ({ token }) => token === durableReservation,
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

  it('rejects persisted-only scratch close unless the canonical anchor exactly matches its scope', () => {
    const persistedThread = session({
      chatId: 'oc_route_target',
      rootMessageId: 'om_actual_thread',
      scope: 'thread',
      cliId: undefined,
      lastCliInput: undefined,
    });
    const reservation = Object.freeze({});
    const threadPort = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => persistedThread,
      isRouteAdmissionToken: () => true,
    });

    expect(threadPort.begin({
      sessionId: SESSION_ID,
      operationIdentity: 'persisted-thread-wrong-anchor',
      routeReservation: reservation,
      command: {
        kind: 'close',
        reason: 'routeScratch',
        source: 'resume',
        expectedRoute: {
          scope: 'thread',
          canonicalAnchor: 'om_other_thread',
          chatId: 'oc_route_target',
          chatType: 'group',
        },
      },
    })).toMatchObject({
      kind: 'rejected',
      code: 'target_chat_has_session',
    });

    const persistedChat = session({
      chatId: 'oc_route_target',
      rootMessageId: 'om_irrelevant_for_chat',
      scope: 'chat',
      cliId: undefined,
      lastCliInput: undefined,
    });
    const chatPort = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      sessionStore: unusedStore(),
      resolveStoredSession: () => persistedChat,
      isRouteAdmissionToken: () => true,
    });

    expect(chatPort.begin({
      sessionId: SESSION_ID,
      operationIdentity: 'persisted-chat-wrong-anchor',
      routeReservation: reservation,
      command: {
        kind: 'close',
        reason: 'routeScratch',
        source: 'resume',
        expectedRoute: {
          scope: 'chat',
          canonicalAnchor: 'oc_route_alias',
          chatId: 'oc_route_target',
          chatType: 'group',
        },
      },
    })).toMatchObject({
      kind: 'rejected',
      code: 'target_route_not_reserved',
    });
    expect(lifecycle.closeSession).not.toHaveBeenCalled();
  });

  it('does not enter the scratch close provider when held route admission is released during retirement', async () => {
    let retirementStarted!: () => void;
    let finishRetirement!: () => void;
    const started = new Promise<void>(resolve => { retirementStarted = resolve; });
    const finish = new Promise<void>(resolve => { finishRetirement = resolve; });
    const activation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(async () => {
        retirementStarted();
        await finish;
        return { kind: 'retired' as const, action: 'retired' as const };
      }),
      settleRetirement: vi.fn(async () => ({
        kind: 'quarantined' as const,
        message: 'route authority changed after retirement',
      })),
    };
    const scratch = activeSession({
      chatId: 'oc_route_release',
      rootMessageId: 'oc_route_release',
      scope: 'chat',
      cliId: undefined,
      lastCliInput: undefined,
    });
    const route = {
      scope: 'chat' as const,
      canonicalAnchor: 'oc_route_release',
      chatId: 'oc_route_release',
      chatType: 'group' as const,
    };
    const admission = reserveCurrentRouteAdmission(currentRouteAdmissionKey({
      ownerLarkAppId: OWNER,
      ...route,
    }));
    await admission.ready;
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activation,
      activeSessions: new Map([[activeSessionKey(scratch), scratch]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => scratch.session,
    });
    const effect = port.begin({
      sessionId: SESSION_ID,
      operationIdentity: 'scratch-route-released',
      routeReservation: admission.token,
      command: {
        kind: 'close',
        reason: 'routeScratch',
        source: 'resume',
        expectedRoute: route,
      },
    });

    const settling = settleEffect(port, effect);
    await started;
    admission.release();
    finishRetirement();

    await expect(settling).resolves.toMatchObject({
      kind: 'unknown',
      message: expect.stringContaining('route authority changed'),
    });
    expect(activation.settleRetirement).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'control-close:scratch-route-released',
      reason: 'explicitClose',
      disposition: 'unknown',
    });
    expect(lifecycle.closeSession).not.toHaveBeenCalled();
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

  it.each([
    ['staleBeforeEffect', { kind: 'staleAddress' }],
    ['unknownAfterEffect', { kind: 'unknown', message: 'activation lifecycle changed' }],
  ] as const)('maps revived restart activation %s without retrying an invoked effect', async (kind, expected) => {
    const ds = activeSession({}, { worker: null });
    const activation = {
      ensure: vi.fn(async () => ({ kind, message: 'activation lifecycle changed' })),
      reconcile: vi.fn(),
      retire: vi.fn(),
      settleRetirement: vi.fn(),
    };
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activation,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    await expect(settleEffect(
      port,
      begin(port, { kind: 'restart', source: 'dashboard' }, `restart-${kind}`),
    )).resolves.toEqual(expected);
  });

  it('retires the live lifecycle before sending provider restart IPC', async () => {
    const events: string[] = [];
    const activation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(async () => {
        events.push('retire');
        return { kind: 'retired' as const, action: 'retired' as const };
      }),
      settleRetirement: vi.fn(async ({ disposition }) => {
        events.push(`settle:${disposition}`);
        return { kind: 'settled' as const, disposition: 'applied' as const };
      }),
    };
    const send = vi.fn(() => { events.push('restart-ipc'); });
    const ds = activeSession({}, {
      worker: { killed: false, send } as DaemonSession['worker'],
    });
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activation,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: unusedStore(),
      resolveStoredSession: () => ds.session,
    });

    await expect(settleEffect(
      port,
      begin(port, { kind: 'restart', source: 'dashboard' }, 'restart-live'),
    )).resolves.toMatchObject({
      kind: 'committed',
      result: { kind: 'restarted', revived: false },
    });
    expect(activation.retire).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'control-restart:restart-live',
      reason: 'replacement',
    });
    expect(activation.ensure).not.toHaveBeenCalled();
    expect(events).toEqual(['retire', 'restart-ipc', 'settle:applied']);
  });

  it.each([
    ['close', { kind: 'close', reason: 'dashboard' }],
    ['restart', { kind: 'restart', source: 'dashboard' }],
    ['suspend', { kind: 'suspend', source: 'dashboard' }],
  ] as const)('revalidates the exact binding after the %s retirement await', async (
    _label,
    command,
  ) => {
    const originalSend = vi.fn();
    const original = activeSession({}, {
      worker: { killed: false, send: originalSend } as DaemonSession['worker'],
    });
    const replacement = activeSession({}, {
      worker: { killed: false, send: vi.fn() } as DaemonSession['worker'],
    });
    const registry = new Map([[activeSessionKey(original), original]]);
    const activation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(async () => {
        registry.set(activeSessionKey(replacement), replacement);
        return { kind: 'retired' as const, action: 'retired' as const };
      }),
      settleRetirement: vi.fn(async () => ({
        kind: 'quarantined' as const,
        message: 'binding changed after retirement',
      })),
    };
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activation,
      activeSessions: registry,
      sessionStore: unusedStore(),
      resolveStoredSession: () => registry.get(activeSessionKey(replacement))!.session,
    });

    await expect(settleEffect(
      port,
      begin(port, command, `post-retire-${_label}`),
    )).resolves.toMatchObject({
      kind: 'unknown',
      message: expect.stringContaining('after activation retirement committed'),
    });
    expect(lifecycle.closeSession).not.toHaveBeenCalled();
    expect(lifecycle.suspendWorker).not.toHaveBeenCalled();
    expect(originalSend).not.toHaveBeenCalled();
    expect(replacement.worker?.send).not.toHaveBeenCalled();
    expect(activation.settleRetirement).toHaveBeenCalledWith(expect.objectContaining({
      disposition: 'unknown',
    }));
  });

  it('keeps a retire-then-replace control sticky in SessionRuntime and never enters the provider', async () => {
    const original = activeSession({}, {
      worker: { killed: false, send: vi.fn() } as DaemonSession['worker'],
    });
    const replacement = activeSession({}, {
      worker: { killed: false, send: vi.fn() } as DaemonSession['worker'],
    });
    const registry = new Map([[activeSessionKey(original), original]]);
    let current = original;
    const activation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(async () => {
        current = replacement;
        registry.set(activeSessionKey(replacement), replacement);
        return { kind: 'retired' as const, action: 'retired' as const };
      }),
      settleRetirement: vi.fn(async () => ({
        kind: 'quarantined' as const,
        message: 'binding changed after retirement',
      })),
    };
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activation,
      activeSessions: registry,
      sessionStore: unusedStore(),
      resolveStoredSession: () => current.session,
    });
    const { host, address } = await runtimeAddressFor(port);
    const request = {
      target: { kind: 'session' as const, address },
      idempotencyKey: 'retire-replace-sticky',
      command: {
        kind: 'control.mutate' as const,
        input: { kind: 'close' as const, reason: 'dashboard' as const },
      },
    };

    await expect(host.runtime.submit(request)).resolves.toMatchObject({ kind: 'ambiguous' });
    await expect(host.runtime.submit(request)).resolves.toMatchObject({ kind: 'ambiguous' });

    expect(activation.retire).toHaveBeenCalledTimes(1);
    expect(activation.settleRetirement).toHaveBeenCalledTimes(1);
    expect(lifecycle.closeSession).not.toHaveBeenCalled();
    expect(original.worker?.send).not.toHaveBeenCalled();
    expect(replacement.worker?.send).not.toHaveBeenCalled();
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
    const events: string[] = [];
    const activation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(async () => {
        events.push('retire');
        return { kind: 'retired' as const, action: 'retired' as const };
      }),
      settleRetirement: vi.fn(async ({ disposition }) => {
        events.push(`settle:${disposition}`);
        return { kind: 'settled' as const, disposition: 'applied' as const };
      }),
    };
    const send = vi.fn(() => { events.push('restart-ipc'); });
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
      apply: vi.fn(() => {
        events.push('metadata');
        return { kind: 'applied' as const, state: after, nextVersion: storeVersion() };
      }),
    };
    const registry = new Map([[activeSessionKey(ds), ds]]);
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activation,
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
    expect(activation.retire).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'control-cd:cwd-one',
      reason: 'replacement',
    });
    expect(events).toEqual(['metadata', 'retire', 'restart-ipc', 'settle:applied']);
  });

  it('keeps committed cwd metadata sticky when activation retirement is retryable', async () => {
    const send = vi.fn();
    const ds = activeSession({ workingDir: '/roles/old' }, {
      workingDir: '/roles/old',
      worker: { killed: false, send } as DaemonSession['worker'],
      initConfig: {
        backendType: 'tmux',
        workingDir: '/roles/old',
      } as DaemonSession['initConfig'],
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
    const activation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(async () => ({
        kind: 'retryable' as const,
        message: 'activation retirement not yet proven',
      })),
    };
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activation,
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
      sessionStore: store,
      resolveStoredSession: () => ds.session,
    });
    const { host, address } = await runtimeAddressFor(port);
    const request = {
      target: { kind: 'session' as const, address },
      idempotencyKey: 'cwd-metadata-sticky',
      command: {
        kind: 'control.mutate' as const,
        input: {
          kind: 'changeWorkingDirectory' as const,
          resolvedPath: '/roles/new',
        },
      },
    };

    await expect(host.runtime.submit(request)).resolves.toMatchObject({ kind: 'ambiguous' });
    await expect(host.runtime.submit(request)).resolves.toMatchObject({ kind: 'ambiguous' });
    await expect(host.runtime.submit({
      ...request,
      command: {
        kind: 'control.mutate',
        input: { kind: 'changeWorkingDirectory', resolvedPath: '/roles/other' },
      },
    })).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'idempotencyConflict',
    });

    expect(store.apply).toHaveBeenCalledTimes(1);
    expect(activation.retire).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(ds.session.workingDir).toBe('/roles/new');
  });

  it('keeps cwd metadata sticky when the binding is replaced before execute starts', async () => {
    const originalSend = vi.fn();
    const replacementSend = vi.fn();
    const original = activeSession({ workingDir: '/roles/old' }, {
      workingDir: '/roles/old',
      worker: { killed: false, send: originalSend } as DaemonSession['worker'],
      initConfig: { backendType: 'tmux', workingDir: '/roles/old' } as DaemonSession['initConfig'],
    });
    const replacement = activeSession({ workingDir: '/roles/new' }, {
      workingDir: '/roles/new',
      worker: { killed: false, send: replacementSend } as DaemonSession['worker'],
      initConfig: { backendType: 'tmux', workingDir: '/roles/new' } as DaemonSession['initConfig'],
    });
    const registry = new Map([[activeSessionKey(original), original]]);
    let current = original;
    const store: SessionStore = {
      load: vi.fn(() => ({
        kind: 'loaded',
        state: storedState({ workingDir: '/roles/old' }),
        version: storeVersion(),
      })),
      apply: vi.fn(() => {
        current = replacement;
        registry.set(activeSessionKey(replacement), replacement);
        return {
          kind: 'applied' as const,
          state: storedState({ workingDir: '/roles/new' }),
          nextVersion: storeVersion(),
        };
      }),
    };
    const activation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(),
    };
    const port = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activation,
      activeSessions: registry,
      sessionStore: store,
      resolveStoredSession: () => current.session,
    });
    const { host, address } = await runtimeAddressFor(port);
    const request = {
      target: { kind: 'session' as const, address },
      idempotencyKey: 'cwd-replaced-before-execute',
      command: {
        kind: 'control.mutate' as const,
        input: { kind: 'changeWorkingDirectory' as const, resolvedPath: '/roles/new' },
      },
    };

    await expect(host.runtime.submit(request)).resolves.toMatchObject({ kind: 'ambiguous' });
    await expect(host.runtime.submit(request)).resolves.toMatchObject({ kind: 'ambiguous' });
    await expect(host.runtime.submit({
      ...request,
      command: {
        kind: 'control.mutate',
        input: { kind: 'changeWorkingDirectory', resolvedPath: '/roles/other' },
      },
    })).resolves.toMatchObject({ kind: 'rejected', reason: 'idempotencyConflict' });

    expect(store.apply).toHaveBeenCalledTimes(1);
    expect(activation.retire).not.toHaveBeenCalled();
    expect(originalSend).not.toHaveBeenCalled();
    expect(replacementSend).not.toHaveBeenCalled();
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
    ['unreachable live worker', 'unreachable', 'replacement'],
    ['no live worker', 'missing', 'passivation'],
    ['already-dead worker', 'killed', 'passivation'],
  ] as const)('uses cold restart and destroys stale backing state for %s', async (
    _label,
    workerState,
    retirementReason,
  ) => {
    const send = vi.fn(() => { throw new Error('worker channel closed'); });
    const ds = activeSession({ workingDir: '/roles/old' }, {
      workingDir: '/roles/old',
      worker: workerState === 'missing'
        ? null
        : { killed: workerState === 'killed', send } as DaemonSession['worker'],
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
    expect(lifecycle.retireCurrentSessionActivation).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'control-cd:operation-1',
      reason: retirementReason,
    });
    expect(lifecycle.ensureCurrentSessionActivation).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(workerState === 'unreachable' ? 1 : 0);
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
    const replacement = activeSession({ workingDir: '/roles/new' }, {
      worker: { killed: false, send: vi.fn() } as DaemonSession['worker'],
    });
    const activation = {
      ensure: vi.fn(),
      reconcile: vi.fn(),
      retire: vi.fn(async () => {
        current = replacement;
        registry.set(activeSessionKey(replacement), replacement);
        return { kind: 'retired' as const, action: 'retired' as const };
      }),
      settleRetirement: vi.fn(async () => ({
        kind: 'quarantined' as const,
        message: 'binding changed after retirement',
      })),
    };
    const fencedPort = createCurrentSessionControlPort({
      ownerLarkAppId: OWNER,
      activation,
      activeSessions: registry,
      sessionStore: store,
      resolveStoredSession: () => current.session,
    });
    const fencedEffect = begin(fencedPort, {
      kind: 'changeWorkingDirectory',
      resolvedPath: '/roles/new',
    }, 'cwd-replaced-during-retire');

    await expect(settleEffect(fencedPort, fencedEffect)).resolves.toMatchObject({
      kind: 'unknown',
      message: expect.stringContaining('after metadata and activation retirement committed'),
    });
    expect(activation.retire).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'control-cd:cwd-replaced-during-retire',
      reason: 'replacement',
    });
    expect(activation.settleRetirement).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'control-cd:cwd-replaced-during-retire',
      reason: 'replacement',
      disposition: 'unknown',
    });
    expect(send).not.toHaveBeenCalled();
    expect(replacement.worker?.send).not.toHaveBeenCalled();
    expect(lifecycle.killWorker).not.toHaveBeenCalled();
  });
});
