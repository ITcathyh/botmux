import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCurrentSessionExecutorRuntime } from '../src/core/current-session-executor-runtime.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import {
  createSessionExact,
  getSessionForOwnerStrict,
  init as initSessionStore,
  updateSession,
} from '../src/services/session-store.js';

describe('CurrentSessionExecutorRuntime owner-file integration', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'current-executor-runtime-'));
    previousDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = dataDir;
    initSessionStore('app-owner');
  });

  afterEach(() => {
    initSessionStore();
    if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('publishes replacement generation before activation and fences the old lease', async () => {
    const session = createSessionExact({
      sessionId: 'sid-real-owner-file',
      createdAt: '2026-08-10T00:00:00.000Z',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      title: 'Executor',
      chatType: 'group',
      scope: 'thread',
    });
    session.larkAppId = 'app-owner';
    updateSession(session);
    const ds = {
      session,
      worker: null,
      larkAppId: 'app-owner',
      chatId: 'oc_chat',
      chatType: 'group',
      scope: 'thread',
      workingDir: '/repo',
    } as DaemonSession;
    const registry = new Map<string, DaemonSession>();
    registry.set(activeSessionKey(ds), ds);
    const runtime = createCurrentSessionExecutorRuntime({ activeSessions: () => registry });

    const firstCommit = runtime.commitGeneration(ds);
    const firstWorker = {};
    ds.worker = firstWorker as never;
    const firstLease = runtime.activate(firstCommit, firstWorker);
    expect((await runtime.report(
      firstLease,
      { kind: 'inputReceived', turnId: 'turn-1' },
      decision => decision,
    )).kind).toBe('current');

    const replacementCommit = runtime.commitGeneration(ds);
    expect(getSessionForOwnerStrict('app-owner', session.sessionId)?.workerGeneration).toBe(2);
    expect((await runtime.report(
      firstLease,
      { kind: 'inputCommitted', turnId: 'turn-1' },
      decision => decision,
    )).kind).toBe('stale');

    const replacementWorker = {};
    ds.worker = replacementWorker as never;
    const replacementLease = runtime.activate(replacementCommit, replacementWorker);
    expect((await runtime.report(
      replacementLease,
      { kind: 'inputCommitted', turnId: 'turn-1' },
      decision => decision,
    )).kind).toBe('current');
  });
});
