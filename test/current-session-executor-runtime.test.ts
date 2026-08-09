import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionForOwnerStrict, updateSession } = vi.hoisted(() => ({
  getSessionForOwnerStrict: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../src/services/session-store.js', () => ({
  getSessionForOwnerStrict,
  updateSession,
}));

import { createCurrentSessionExecutorRuntime } from '../src/core/current-session-executor-runtime.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';

function makeSession(generation = 0): Session {
  return {
    sessionId: 'sid-current-executor',
    larkAppId: 'app-owner',
    rootMessageId: 'om_root',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    status: 'active',
    title: 'Executor',
    createdAt: '2026-08-10T00:00:00.000Z',
    workerGeneration: generation || undefined,
  } as Session;
}

function makeDs(generation = 0): DaemonSession {
  return {
    session: makeSession(generation),
    worker: null,
    workerGeneration: generation || undefined,
    larkAppId: 'app-owner',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    workingDir: '/repo',
  } as DaemonSession;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateSession.mockImplementation(() => undefined);
});

describe('CurrentSessionExecutorRuntime generation publication', () => {
  it('never revives an old lease when response loss reveals a future winner', () => {
    const runtime = createCurrentSessionExecutorRuntime({ activeSessions: () => undefined });
    const ds = makeDs(1);
    const worker = {};
    ds.worker = worker as never;
    const oldLease = runtime.activate(runtime.commitGeneration(ds), worker);
    expect(ds.workerGeneration).toBe(2);

    updateSession.mockImplementationOnce(() => { throw new Error('response lost'); });
    const future = makeSession(4);
    getSessionForOwnerStrict.mockReturnValueOnce(future);

    expect(() => runtime.commitGeneration(ds)).toThrow('response lost');
    expect(ds.workerGeneration).toBe(4);
    expect(ds.session.workerGeneration).toBe(4);
    expect(runtime.report(oldLease, { kind: 'inputReceived', turnId: 'turn-1' }).kind).toBe('stale');
  });

  it('accepts a reservation response loss only for the exact owner-bound generation', () => {
    const runtime = createCurrentSessionExecutorRuntime({ activeSessions: () => undefined });
    const ds = makeDs(1);
    updateSession.mockImplementationOnce(() => { throw new Error('response lost'); });
    getSessionForOwnerStrict.mockImplementationOnce(() => structuredClone(ds.session));

    expect(runtime.commitGeneration(ds).generation).toBe(2);
  });

  it('accepts exact response-loss readback for a deferred chat-scoped route', () => {
    const runtime = createCurrentSessionExecutorRuntime({ activeSessions: () => undefined });
    const ds = makeDs(1);
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.deferredScheduleRun = {
      taskId: 'task-1',
      turnId: 'turn-1',
      routingAnchor: 'schedule:task-1:run-1',
      createdAt: '2026-08-10T00:00:00.000Z',
    };
    updateSession.mockImplementationOnce(() => { throw new Error('response lost'); });
    getSessionForOwnerStrict.mockImplementationOnce(() => structuredClone(ds.session));

    expect(runtime.commitGeneration(ds).generation).toBe(2);
    expect(runtime.isQuarantined(ds)).toBe(false);
  });

  it('uses the canonical VC receiver registry key for current ownership', () => {
    const registry = new Map<string, DaemonSession>();
    const runtime = createCurrentSessionExecutorRuntime({ activeSessions: () => registry });
    const ds = makeDs();
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'app-listener',
      meetingId: 'meeting-1',
      memberId: 'member-1',
      memberEpoch: 1,
    };
    registry.set(activeSessionKey(ds), ds);
    const worker = {};
    const commit = runtime.commitGeneration(ds);
    ds.worker = worker as never;
    const lease = runtime.activate(commit, worker);

    expect(runtime.report(lease, { kind: 'inputReceived', turnId: 'turn-1' })).toMatchObject({
      kind: 'current',
      executorGeneration: 1,
    });
  });

  it('does not claim a same-generation response from a rebound route', () => {
    const runtime = createCurrentSessionExecutorRuntime({ activeSessions: () => undefined });
    const ds = makeDs(1);
    updateSession.mockImplementationOnce(() => { throw new Error('response lost'); });
    const rebound = makeSession(2);
    rebound.rootMessageId = 'om_other_root';
    getSessionForOwnerStrict.mockReturnValueOnce(rebound);

    expect(() => runtime.commitGeneration(ds)).toThrow('absent or rebound');
  });

  it('quarantines a same-generation response that is not the exact intended row', () => {
    const runtime = createCurrentSessionExecutorRuntime({ activeSessions: () => undefined });
    const ds = makeDs(1);
    updateSession.mockImplementationOnce(() => { throw new Error('response lost'); });
    const divergent = makeSession(2);
    divergent.title = 'concurrent writer';
    getSessionForOwnerStrict.mockReturnValueOnce(divergent);

    expect(() => runtime.commitGeneration(ds)).toThrow('response lost');
    expect(runtime.isQuarantined(ds)).toBe(true);
    getSessionForOwnerStrict.mockReturnValueOnce(divergent);
    expect(() => runtime.commitGeneration(ds)).toThrow('unexpected durable generation');
    expect(updateSession).toHaveBeenCalledTimes(1);
  });

  it('blocks another reservation while the prior publication outcome is unreadable', () => {
    const runtime = createCurrentSessionExecutorRuntime({ activeSessions: () => undefined });
    const ds = makeDs(1);
    updateSession.mockImplementationOnce(() => { throw new Error('response lost'); });
    getSessionForOwnerStrict.mockImplementationOnce(() => { throw new Error('disk unreadable'); });

    expect(() => runtime.commitGeneration(ds)).toThrow('outcome is unknown');
    expect(runtime.isQuarantined(ds)).toBe(true);
    getSessionForOwnerStrict.mockImplementationOnce(() => { throw new Error('still unreadable'); });
    expect(() => runtime.commitGeneration(ds)).toThrow('still unreadable');
    expect(updateSession).toHaveBeenCalledTimes(1);
  });

  it('blocks a new generation while an unknown exit fence cannot be reconciled', () => {
    const runtime = createCurrentSessionExecutorRuntime({ activeSessions: () => undefined });
    const ds = makeDs();
    const worker = {};
    const commit = runtime.commitGeneration(ds);
    ds.worker = worker as never;
    const lease = runtime.activate(commit, worker);

    updateSession.mockImplementationOnce(() => { throw new Error('fence response unknown'); });
    getSessionForOwnerStrict.mockImplementationOnce(() => { throw new Error('disk unreadable'); });
    expect(runtime.report(lease, { kind: 'workerExit' })).toMatchObject({ kind: 'unreadable' });
    expect(ds.session.workerGeneration).toBe(2);

    getSessionForOwnerStrict.mockImplementationOnce(() => { throw new Error('still unreadable'); });
    expect(() => runtime.commitGeneration(ds)).toThrow('still unreadable');
    expect(updateSession).toHaveBeenCalledTimes(2);
  });

  it('unblocks after strict readback proves the intended dead-generation fence', () => {
    const runtime = createCurrentSessionExecutorRuntime({ activeSessions: () => undefined });
    const ds = makeDs();
    const worker = {};
    const commit = runtime.commitGeneration(ds);
    ds.worker = worker as never;
    const lease = runtime.activate(commit, worker);

    updateSession.mockImplementationOnce(() => { throw new Error('fence response unknown'); });
    getSessionForOwnerStrict.mockImplementationOnce(() => { throw new Error('disk unreadable'); });
    expect(runtime.report(lease, { kind: 'workerExit' }).kind).toBe('unreadable');

    const fenced = makeSession(2);
    delete fenced.pid;
    getSessionForOwnerStrict.mockReturnValueOnce(fenced);
    expect(runtime.commitGeneration(ds).generation).toBe(3);
  });

  it('repairs a proven pre-publish exit fence with one higher reservation', () => {
    const runtime = createCurrentSessionExecutorRuntime({ activeSessions: () => undefined });
    const ds = makeDs();
    const worker = {};
    const commit = runtime.commitGeneration(ds);
    ds.worker = worker as never;
    const lease = runtime.activate(commit, worker);

    updateSession.mockImplementationOnce(() => { throw new Error('before publish'); });
    getSessionForOwnerStrict.mockReturnValueOnce(makeSession(1));
    expect(runtime.report(lease, { kind: 'workerExit' }).kind).toBe('unreadable');

    getSessionForOwnerStrict.mockReturnValueOnce(makeSession(1));
    expect(runtime.commitGeneration(ds).generation).toBe(3);
    expect(ds.session.workerGeneration).toBe(3);
  });

  it('keeps quarantine when readback reveals an unexpected future fence', () => {
    const runtime = createCurrentSessionExecutorRuntime({ activeSessions: () => undefined });
    const ds = makeDs();
    const worker = {};
    const commit = runtime.commitGeneration(ds);
    ds.worker = worker as never;
    const lease = runtime.activate(commit, worker);

    updateSession.mockImplementationOnce(() => { throw new Error('fence response unknown'); });
    getSessionForOwnerStrict.mockImplementationOnce(() => { throw new Error('disk unreadable'); });
    expect(runtime.report(lease, { kind: 'workerExit' }).kind).toBe('unreadable');

    getSessionForOwnerStrict.mockReturnValueOnce(makeSession(4));
    expect(() => runtime.commitGeneration(ds)).toThrow('unexpected durable generation');
    expect(ds.session.workerGeneration).toBe(4);
  });
});
