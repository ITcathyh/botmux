/**
 * End-to-end idempotency tests that drive the REAL triggerSessionTurn dispatch
 * path (not just the extracted helpers) for a fresh async virtual trigger, using
 * the REAL idempotency-store + async-trigger-store (temp SESSION_DATA_DIR).
 * Boundaries (lark client / session-store / worker-pool) are mocked so we can
 * make forkWorker throw and assert the barrier / fork-fault convergence codex
 * asked for: a synchronous dispatch throw must record a durable failed
 * (dispatch_unknown), close, and NOT leave the caller polling `running`; a
 * same-key retry must reuse (never double-fork).
 *
 * Run:  pnpm vitest run test/trigger-session-idempotency-e2e.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TriggerRequest } from '../src/services/trigger-types.js';

let tempDir: string;
let prevDataDir: string | undefined;

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Lark client — no real chat for a fresh async virtual trigger, but imported.
vi.mock('../src/im/lark/client.js', () => ({
  getMessageChatId: vi.fn(),
  getChatMode: vi.fn(async () => 'group'),
  sendMessage: vi.fn(async () => 'om_x'),
  replyMessage: vi.fn(async () => 'om_x'),
  listChatBotMembers: vi.fn(async () => []),
}));

const defaultGetBot = () => ({ config: { cliId: 'codex-app', apiOnly: true } });
const mockGetBot = vi.fn(defaultGetBot);
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...a: any[]) => mockGetBot(...a),
  effectiveDefaultWorkingDir: vi.fn(() => '/tmp'),
}));

vi.mock('../src/services/groups-store.js', () => ({ isInChat: vi.fn(async () => true) }));
vi.mock('../src/services/oncall-store.js', () => ({ getOncallStatus: vi.fn(() => undefined) }));

let sessionSeq = 0;
const createdSessions: any[] = [];
let createExactShouldThrow = false;
let updateShouldThrow = false;
vi.mock('../src/services/session-store.js', () => ({
  createCurrentSessionStore: vi.fn(() => ({
    load: vi.fn(() => ({ kind: 'notFound' })),
    apply: vi.fn(() => ({ kind: 'unknown', message: 'unused mocked Current Store' })),
  })),
  createSession: vi.fn((chatId: string, anchor: string, title: string) => {
    const s = { sessionId: `sess-${++sessionSeq}`, chatId, rootMessageId: anchor, title, scope: 'chat', status: 'active', createdAt: '2026-06-01T00:00:00.000Z' };
    createdSessions.push(s);
    return s;
  }),
  createSessionExact: vi.fn((input: any) => {
    if (createExactShouldThrow) throw new Error('injected createSessionExact failure');
    const s = {
      sessionId: input.sessionId,
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      title: input.title,
      scope: input.scope,
      status: 'active',
      createdAt: input.createdAt,
    };
    createdSessions.push(s);
    return s;
  }),
  updateSession: vi.fn(() => {
    if (updateShouldThrow) throw new Error('injected updateSession failure');
  }),
  getSession: vi.fn((id: string) => createdSessions.find(s => s.sessionId === id)),
  getOwnedSession: vi.fn((id: string) => createdSessions.find(s => s.sessionId === id)),
  getSessionForOwnerStrict: vi.fn((_owner: string, id: string) => createdSessions.find(s => s.sessionId === id)),
  closeSession: vi.fn((id: string) => {
    const session = createdSessions.find(s => s.sessionId === id);
    if (session) session.status = 'closed';
  }),
  listSessionsStrict: vi.fn(() => createdSessions),
  listSessionsForOwnerStrict: vi.fn(() => createdSessions),
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
}));

vi.mock('../src/services/message-queue.js', () => ({ ensureQueue: vi.fn() }));
let buildInputShouldThrow = false;
vi.mock('../src/core/session-manager.js', () => ({
  buildFollowUpContent: vi.fn((p: string) => p),
  buildFollowUpCliInput: vi.fn((p: string) => ({ content: p })),
  buildNewTopicPrompt: vi.fn((p: string) => p),
  buildNewTopicCliInput: vi.fn((p: string) => {
    if (buildInputShouldThrow) throw new Error('injected buildNewTopicCliInput failure');
    return { content: p };
  }),
  ensureSessionWhiteboard: vi.fn(),
  getAvailableBots: vi.fn(async () => []),
  rememberLastCliInput: vi.fn(),
}));
vi.mock('../src/services/default-worktree.js', () => ({ botAutoWorktreeEnabled: vi.fn(() => false) }));
vi.mock('../src/im/lark/card-handler.js', () => ({ runAutoWorktreeCommit: vi.fn(async () => {}) }));

// worker-pool: forkWorker is the dispatch side effect we make throw on demand.
let forkShouldThrow = false;
let forkShouldRefuse = false;
let closeShouldThrow = false;
let closeShouldRefuse = false;
let onFork: ((ds: any, forkArg: any) => void) | undefined;
const mockForkWorker = vi.fn((ds: any, _prompt: any, forkArg: any) => {
  if (forkShouldThrow) throw new Error('injected fork failure');
  if (forkShouldRefuse) return false;
  onFork?.(ds, forkArg);
  ds.worker = { killed: false };
  return true;
});
const mockCloseSession = vi.fn(async () => {
  if (closeShouldThrow) throw new Error('injected close failure');
  if (closeShouldRefuse) return { ok: false, error: 'injected close refusal' };
  return { ok: true, alreadyClosed: false, known: true };
});
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: (...a: any[]) => mockForkWorker(...a),
  sendWorkerInput: vi.fn(() => true),
  getCurrentCliVersion: vi.fn(() => 'test'),
  setActiveSessionIfActive: (map: Map<string, any>, key: string, ds: any) => { map.set(key, ds); return true; },
  closeSession: (...a: any[]) => mockCloseSession(...a),
  getDaemonBootId: () => 'boot-CURRENT',
  // master refactor: trigger-session now takes the active-session key lock and
  // checks the queued-activation admission gate. The lock just runs the action;
  // no queued-activation gate in these fresh-async-virtual tests.
  withActiveSessionKeyLock: (_map: any, _key: string, action: () => any) => action(),
  hasQueuedActivationAdmissionGate: () => false,
}));

import { triggerSessionTurn, convergeIdempotentAsyncTurnOnWorkerExit, buildExternalEventDataContext } from '../src/core/trigger-session.js';
import * as asyncTriggerStore from '../src/services/async-trigger-store.js';
import * as idempotencyStore from '../src/services/idempotency-store.js';
import { acquireDeviceIsolationFreeze, releaseDeviceIsolationFreeze, resetDeviceIsolationActivationForTest } from '../src/core/device-isolation-activation.js';

const APP = 'local_riff';
function freshAsyncReq(idempotencyKey: string, instruction = 'do the thing'): TriggerRequest {
  return {
    source: { type: 'webhook', sourceName: 'riff' } as any,
    target: { kind: 'turn', botId: APP },
    envelope: { format: 'text', sourceName: 'riff', trusted: false },
    instruction,
    options: { asyncReturnSessionId: true, idempotencyKey },
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'trig-idem-e2e-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tempDir;
  sessionSeq = 0; createdSessions.length = 0;
  createExactShouldThrow = false;
  updateShouldThrow = false;
  buildInputShouldThrow = false;
  forkShouldThrow = false;
  forkShouldRefuse = false;
  closeShouldThrow = false;
  closeShouldRefuse = false;
  onFork = undefined;
  mockGetBot.mockImplementation(defaultGetBot);
  mockForkWorker.mockClear(); mockCloseSession.mockClear();
});
afterEach(() => {
  resetDeviceIsolationActivationForTest(); // clear any freeze lease a test acquired
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR; else process.env.SESSION_DATA_DIR = prevDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('triggerSessionTurn — idempotency dispatch (real stores)', () => {
  it('first call: forks once, writes a reserved→attempting lease, returns idempotent:false', async () => {
    const res = await triggerSessionTurn(freshAsyncReq('k-1'), { larkAppId: APP, activeSessions: new Map() });
    expect(res.ok).toBe(true);
    expect(res.idempotent).toBe(false);
    expect(createdSessions).toHaveLength(1);
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
    const lease = idempotencyStore.lookup(APP, 'k-1');
    expect(lease?.state).toBe('attempting'); // barrier crossed before fork
    expect(lease?.sessionId).toBe(res.target?.sessionId);
  });

  it('keeps the keyed at-most-once policy CLI-neutral on a non-Codex adapter', async () => {
    mockGetBot.mockImplementation(() => ({ config: { cliId: 'claude-code', apiOnly: true } }));
    const shared = new Map();
    const first = await triggerSessionTurn(freshAsyncReq('k-claude'), {
      larkAppId: APP,
      activeSessions: shared,
    });
    const retry = await triggerSessionTurn(freshAsyncReq('k-claude'), {
      larkAppId: APP,
      activeSessions: shared,
    });

    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    expect(retry.action).toBe('queued');
    expect(retry.idempotent).toBe(true);
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
    expect(mockForkWorker.mock.calls[0][2]).toMatchObject({ atMostOnce: true });
  });

  it('same key + same payload retry: reuses, does NOT fork again', async () => {
    const shared = new Map();
    const first = await triggerSessionTurn(freshAsyncReq('k-2'), { larkAppId: APP, activeSessions: shared });
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
    const second = await triggerSessionTurn(freshAsyncReq('k-2'), { larkAppId: APP, activeSessions: shared });
    expect(second.ok).toBe(true);
    expect(second.idempotent).toBe(true);
    expect(second.target?.sessionId).toBe(first.target?.sessionId);
    expect(mockForkWorker).toHaveBeenCalledTimes(1); // still ONE fork
    expect(createdSessions).toHaveLength(1);
  });

  it('concurrent same-key admission has one winner and never double-forks', async () => {
    const shared = new Map();
    const [first, second] = await Promise.all([
      triggerSessionTurn(freshAsyncReq('k-concurrent'), { larkAppId: APP, activeSessions: shared }),
      triggerSessionTurn(freshAsyncReq('k-concurrent'), { larkAppId: APP, activeSessions: shared }),
    ]);

    expect(mockForkWorker).toHaveBeenCalledTimes(1);
    expect([first, second].filter(result => result.ok)).toHaveLength(2);
    expect([first, second].filter(result => result.idempotent === false)).toHaveLength(1);
    expect([first, second].filter(result => result.idempotent === true)).toHaveLength(1);
    expect(first.target?.sessionId).toBe(second.target?.sessionId);
    expect(createdSessions).toHaveLength(1);
    expect(idempotencyStore.lookup(APP, 'k-concurrent')?.state).toBe('attempting');
  });

  it('same key + DIFFERENT payload → 409 idempotency_conflict, no second fork', async () => {
    const shared = new Map();
    await triggerSessionTurn(freshAsyncReq('k-3', 'payload A'), { larkAppId: APP, activeSessions: shared });
    const conflict = await triggerSessionTurn(freshAsyncReq('k-3', 'payload B'), { larkAppId: APP, activeSessions: shared });
    expect(conflict.ok).toBe(false);
    expect(conflict.errorCode).toBe('idempotency_conflict');
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
    expect(createdSessions).toHaveLength(1);
  });

  it('same key, same instruction, but DIFFERENT options.status → 409 (requestHash covers full options)', async () => {
    // codex #776 round-4: status firing→resolved changes the rendered prompt; the
    // hash must change too, else the resolved event silently reuses the firing turn.
    const firing: TriggerRequest = { ...freshAsyncReq('k-status'), options: { asyncReturnSessionId: true, idempotencyKey: 'k-status', status: 'firing' } };
    const resolved: TriggerRequest = { ...freshAsyncReq('k-status'), options: { asyncReturnSessionId: true, idempotencyKey: 'k-status', status: 'resolved' } };
    await triggerSessionTurn(firing, { larkAppId: APP, activeSessions: new Map() });
    const res = await triggerSessionTurn(resolved, { larkAppId: APP, activeSessions: new Map() });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('idempotency_conflict');
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
  });

  it('fork throw AFTER the barrier → durable async failed(dispatch_unknown) + close, retry does NOT re-run', async () => {
    forkShouldThrow = true;
    const shared = new Map();
    const res = await triggerSessionTurn(freshAsyncReq('k-4'), { larkAppId: APP, activeSessions: shared });
    // The HTTP result reports a terminal failed (at-most-once), not queued.
    expect(res.state).toBe('failed');
    expect(res.errorCode).toBe('no_output');
    const sid = res.target!.sessionId!;
    // Authoritative durable failed evidence is written (so trigger-result converges).
    expect(asyncTriggerStore.lookup(sid, res.triggerId!)?.result.status).toBe('failed');
    expect(asyncTriggerStore.lookup(sid, res.triggerId!)?.result.reason).toBe('dispatch_unknown');
    expect(mockCloseSession).toHaveBeenCalledWith(sid);
    expect(shared.size).toBe(0);
    expect(createdSessions.find(session => session.sessionId === sid)?.status).toBe('closed');
    // Retry with the same key must NOT dispatch again — it resolves terminal.
    forkShouldThrow = false;
    const forkBefore = mockForkWorker.mock.calls.length;
    const retry = await triggerSessionTurn(freshAsyncReq('k-4'), { larkAppId: APP, activeSessions: new Map() });
    expect(retry.state).toBe('failed');
    expect(mockForkWorker.mock.calls.length).toBe(forkBefore); // no new fork
  });

  it('fork refusal AFTER the barrier never reports queued and converges dispatch_unknown', async () => {
    forkShouldRefuse = true;
    const shared = new Map();
    const res = await triggerSessionTurn(freshAsyncReq('k-refused'), {
      larkAppId: APP,
      activeSessions: shared,
    });

    expect(res.ok).toBe(false);
    expect(res.state).toBe('failed');
    expect(res.errorCode).toBe('no_output');
    expect(idempotencyStore.lookup(APP, 'k-refused')?.state).toBe('attempting');
    expect(asyncTriggerStore.lookup(res.target!.sessionId!, res.triggerId!)?.result).toMatchObject({
      status: 'failed',
      reason: 'dispatch_unknown',
    });
    expect(mockCloseSession).toHaveBeenCalledWith(res.target!.sessionId!);
    expect(shared.size).toBe(0);
    expect(createdSessions.find(session => session.sessionId === res.target!.sessionId)?.status).toBe('closed');
  });

  it('arms lease, durable pending, and in-memory pending before worker acceptance', async () => {
    onFork = (ds, forkArg) => {
      expect(idempotencyStore.lookup(APP, 'k-order')?.state).toBe('attempting');
      expect(asyncTriggerStore.lookup(ds.session.sessionId, forkArg.turnId)?.result.status).toBe('pending');
      expect(ds.asyncTriggerResults?.get(forkArg.turnId)?.status).toBe('pending');
      expect(ds.idempotentAsyncTurns?.get(forkArg.turnId)).toMatchObject({ key: 'k-order', kind: 'fresh' });
    };

    const result = await triggerSessionTurn(freshAsyncReq('k-order'), {
      larkAppId: APP,
      activeSessions: new Map(),
    });

    expect(result.ok).toBe(true);
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
  });

  it('DOUBLE failure (fork throw + terminal write throw) → 5xx trigger_failed, NOT a phantom state:failed', async () => {
    forkShouldThrow = true;
    const shared = new Map();
    const terminalSpy = vi.spyOn(asyncTriggerStore, 'recordFailedStrict')
      .mockImplementationOnce(() => { throw new Error('injected terminal write failure'); });
    const res = await triggerSessionTurn(freshAsyncReq('k-dbl'), { larkAppId: APP, activeSessions: shared });
    terminalSpy.mockRestore();
    expect(res.ok).toBe(false);
    expect(res.state).not.toBe('failed');       // no phantom terminal
    expect(res.errorCode).toBe('trigger_failed'); // honest 5xx-class hard error
    expect(mockCloseSession).toHaveBeenCalledTimes(1);
    expect(shared.size).toBe(0);
    expect(createdSessions[0]?.status).toBe('closed');
  });

  it.each(['pre-write', 'post-write response loss'])('%s pending failure after the attempt fence never materializes a Session or forks', async (mode) => {
    const realRecordPending = asyncTriggerStore.recordPending;
    const pendingSpy = vi.spyOn(asyncTriggerStore, 'recordPending')
      .mockImplementationOnce((...args) => {
        if (mode === 'post-write response loss') realRecordPending(...args);
        throw new Error(`injected ${mode} pending failure`);
      });
    const shared = new Map();
    const key = mode === 'pre-write' ? 'k-pending-pre' : 'k-pending-post';

    const result = await triggerSessionTurn(freshAsyncReq(key), {
      larkAppId: APP,
      activeSessions: shared,
    });
    pendingSpy.mockRestore();

    expect(result).toMatchObject({ ok: false, state: 'failed', errorCode: 'no_output' });
    expect(idempotencyStore.lookup(APP, key)?.state).toBe('attempting');
    expect(asyncTriggerStore.lookup(result.target!.sessionId!, result.triggerId!)?.result).toMatchObject({
      status: 'failed',
      reason: 'dispatch_unknown',
    });
    expect(mockForkWorker).not.toHaveBeenCalled();
    expect(createdSessions).toHaveLength(0);
    expect(shared.size).toBe(0);
  });

  it.each([
    ['createSessionExact', () => { createExactShouldThrow = true; }],
    ['updateSession', () => { updateShouldThrow = true; }],
    ['buildNewTopicCliInput', () => { buildInputShouldThrow = true; }],
  ])('materialization fault in %s converges dispatch_unknown and removes every published owner', async (_label, inject) => {
    inject();
    const shared = new Map();

    const result = await triggerSessionTurn(freshAsyncReq(`k-materialize-${_label}`), {
      larkAppId: APP,
      activeSessions: shared,
    });

    expect(result).toMatchObject({ ok: false, state: 'failed', errorCode: 'no_output' });
    expect(idempotencyStore.lookup(APP, `k-materialize-${_label}`)?.state).toBe('attempting');
    expect(asyncTriggerStore.lookup(result.target!.sessionId!, result.triggerId!)?.result).toMatchObject({
      status: 'failed',
      reason: 'dispatch_unknown',
    });
    expect(mockForkWorker).not.toHaveBeenCalled();
    expect(shared.size).toBe(0);
    for (const session of createdSessions) expect(session.status).toBe('closed');
  });

  it.each(['refused', 'threw'])('fail-close %s is quarantined instead of reporting a terminal response', async (mode) => {
    forkShouldThrow = true;
    closeShouldRefuse = mode === 'refused';
    closeShouldThrow = mode === 'threw';
    const shared = new Map();

    const result = await triggerSessionTurn(freshAsyncReq(`k-close-${mode}`), {
      larkAppId: APP,
      activeSessions: shared,
    });

    expect(result.ok).toBe(false);
    expect(result.state).not.toBe('failed');
    expect(result.errorCode).toBe('trigger_failed');
    expect(mockCloseSession).toHaveBeenCalledTimes(1);
  });

  // ── codex #776 finding #1: attempt-barrier (transition reserved→attempting)
  //    fault. The barrier-fail release must genuinely CONVERGE the lease — not
  //    swallow a `changed`/EIO — so a same-boot retry does the right thing.
  //    Two disk states codex named: pre-rename (disk still reserved) and
  //    post-rename (disk landed attempting, then fsync threw).

  it('barrier PRE-rename fault (transition throws, disk still reserved) → 5xx; same-key retry starts FRESH (re-forks once)', async () => {
    const shared = new Map(); // real daemon shares ONE activeSessions map across calls
    // First call: make the barrier transition throw WITHOUT mutating disk (the
    // lease stays `reserved`). Barrier-fail release must cleanly compareAndRemove
    // it so the retry is not blocked by a same-boot reserved orphan.
    const spy = vi.spyOn(idempotencyStore, 'transition').mockImplementationOnce(() => { throw new Error('injected pre-rename barrier fault'); });
    const first = await triggerSessionTurn(freshAsyncReq('k-bpre'), { larkAppId: APP, activeSessions: shared });
    expect(first.ok).toBe(false);
    expect(first.errorCode).toBe('trigger_failed');
    expect(mockForkWorker).not.toHaveBeenCalled(); // barrier failed before fork
    // Lease was released (clean reserved removal) — no leftover blocking the key.
    expect(idempotencyStore.lookup(APP, 'k-bpre')).toBeUndefined();
    spy.mockRestore();
    // Retry: real transition now works → fresh claim + one fork + attempting lease.
    const retry = await triggerSessionTurn(freshAsyncReq('k-bpre'), { larkAppId: APP, activeSessions: shared });
    expect(retry.ok).toBe(true);
    expect(retry.idempotent).toBe(false);
    expect(mockForkWorker).toHaveBeenCalledTimes(1); // exactly one fork total
    expect(idempotencyStore.lookup(APP, 'k-bpre')?.state).toBe('attempting');
  });

  it('barrier POST-rename fault (disk landed attempting, then throw) → observable durable failed; same-key retry does NOT re-fork', async () => {
    // Simulate the rename landing (disk becomes attempting) THEN a post-rename
    // fsync throw: advance the real on-disk lease to attempting, then throw. The
    // barrier-fail release sees compareAndRemove→changed(attempting) and must
    // durably terminalize (never delete the crossed fence) AND report an
    // observable terminal (state:failed with the sessionId), not a bare 5xx.
    const realTransition = idempotencyStore.transition;
    const spy = vi.spyOn(idempotencyStore, 'transition').mockImplementationOnce((owner: any, key: any, from: any, patch: any) => {
      realTransition(owner, key, from, patch); // rename lands: disk now attempting
      throw new Error('injected post-rename barrier fault (fsync)');
    });
    const first = await triggerSessionTurn(freshAsyncReq('k-bpost'), { larkAppId: APP, activeSessions: new Map() });
    spy.mockRestore();
    expect(first.ok).toBe(false);
    expect(first.state).toBe('failed');            // observable terminal, not bare 5xx
    expect(first.errorCode).toBe('no_output');
    expect(mockForkWorker).not.toHaveBeenCalled(); // threw before fork
    const sid = first.target!.sessionId!;
    // The crossed fence was durably terminalized (dispatch_unknown), NOT deleted.
    expect(asyncTriggerStore.lookup(sid, first.triggerId!)?.result.status).toBe('failed');
    expect(asyncTriggerStore.lookup(sid, first.triggerId!)?.result.reason).toBe('dispatch_unknown');
    // Retry with the same key resolves TERMINAL (at-most-once) — never re-forks.
    const retry = await triggerSessionTurn(freshAsyncReq('k-bpost'), { larkAppId: APP, activeSessions: new Map() });
    expect(retry.state).toBe('failed');
    expect(mockForkWorker).not.toHaveBeenCalled(); // still zero forks
  });

  it('barrier release compareAndRemove EIO leaves only a non-terminal lease and never reports phantom failed', async () => {
    // Barrier transition throws pre-rename (disk still reserved), but the release
    // compareAndRemove ALSO throws (EIO) → the lease state is unprovable. We must
    // NOT re-dispatch it, but there is no Session or async terminal evidence, so
    // neither the first call nor a retry may claim an observable `state:failed`.
    const tSpy = vi.spyOn(idempotencyStore, 'transition').mockImplementationOnce(() => { throw new Error('injected barrier fault'); });
    const rSpy = vi.spyOn(idempotencyStore, 'compareAndRemove').mockImplementationOnce(() => { throw new Error('injected EIO on release unlink'); });
    const first = await triggerSessionTurn(freshAsyncReq('k-beio'), { larkAppId: APP, activeSessions: new Map() });
    tSpy.mockRestore(); rSpy.mockRestore();
    expect(first.ok).toBe(false);
    expect(first.errorCode).toBe('trigger_failed');
    expect(first.state).not.toBe('failed');
    expect(mockForkWorker).not.toHaveBeenCalled();
    // The reserved lease is still on disk (release couldn't prove removal)…
    const stranded = idempotencyStore.lookup(APP, 'k-beio');
    expect(stranded?.state).toBe('reserved');
    expect(createdSessions).toHaveLength(0);
    expect(asyncTriggerStore.lookup(stranded!.sessionId, stranded!.triggerId)).toBeUndefined();
    // …and the retry remains fail-closed without inventing terminal evidence.
    const retry = await triggerSessionTurn(freshAsyncReq('k-beio'), { larkAppId: APP, activeSessions: new Map() });
    expect(retry.errorCode).toBe('trigger_failed');
    expect(retry.state).not.toBe('failed');
    expect(retry.idempotent).toBe(true);
    expect(mockForkWorker).not.toHaveBeenCalled(); // no dispatch on the orphan
  });

  it('post-rename barrier plus terminal-write failure is non-terminal first, then retry persists dispatch_unknown', async () => {
    const realTransition = idempotencyStore.transition;
    const transitionSpy = vi.spyOn(idempotencyStore, 'transition').mockImplementationOnce((...args: any[]) => {
      realTransition(...args as Parameters<typeof realTransition>);
      throw new Error('injected post-rename response loss');
    });
    const terminalSpy = vi.spyOn(asyncTriggerStore, 'recordFailedStrict')
      .mockImplementationOnce(() => { throw new Error('injected terminal write failure'); });

    const first = await triggerSessionTurn(freshAsyncReq('k-bpost-double'), {
      larkAppId: APP,
      activeSessions: new Map(),
    });
    transitionSpy.mockRestore();
    terminalSpy.mockRestore();

    expect(first.ok).toBe(false);
    expect(first.errorCode).toBe('trigger_failed');
    expect(first.state).not.toBe('failed');
    const stranded = idempotencyStore.lookup(APP, 'k-bpost-double');
    expect(stranded?.state).toBe('attempting');
    expect(createdSessions).toHaveLength(0);
    expect(mockForkWorker).not.toHaveBeenCalled();

    const retry = await triggerSessionTurn(freshAsyncReq('k-bpost-double'), {
      larkAppId: APP,
      activeSessions: new Map(),
    });
    expect(retry.errorCode).toBe('no_output');
    expect(retry.state).toBe('failed');
    expect(retry.idempotent).toBe(true);
    expect(asyncTriggerStore.lookup(stranded!.sessionId, stranded!.triggerId)?.result).toMatchObject({
      status: 'failed',
      reason: 'dispatch_unknown',
    });
    expect(mockForkWorker).not.toHaveBeenCalled();
  });

  // ── codex #776 round-6 finding #1: worker exits with NO final_output. The
  //    dispatched turn stamps ds.idempotentAsyncTurns; the worker-exit handler
  //    must converge it to a durable dispatch_unknown so a same-key retry AND
  //    trigger-result both resolve `failed`, never re-forking / polling forever.
  it('worker exit with no final_output → durable dispatch_unknown; retry + poll both failed, no 2nd fork', async () => {
    const shared = new Map();
    const first = await triggerSessionTurn(freshAsyncReq('k-wx'), { larkAppId: APP, activeSessions: shared });
    expect(first.ok).toBe(true);
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
    const sid = first.target!.sessionId!;
    // Locate the dispatched DaemonSession + its stamped generation.
    const ds = [...shared.values()].find((d: any) => d.session.sessionId === sid) as any;
    expect(ds?.idempotentAsyncTurns?.get(first.triggerId!)).toBeDefined();
    const gen = ds.idempotentAsyncTurns.get(first.triggerId!).workerGeneration;
    // Simulate the real worker-exit handler: worker=null (dead), then converge.
    ds.worker = null;
    convergeIdempotentAsyncTurnOnWorkerExit(ds, gen);
    // Durable authoritative terminal is written…
    expect(asyncTriggerStore.lookup(sid, first.triggerId!)?.result.status).toBe('failed');
    expect(asyncTriggerStore.lookup(sid, first.triggerId!)?.result.reason).toBe('dispatch_unknown');
    // …the entry is dropped (idempotent: a later gen exit is a no-op)…
    expect(ds.idempotentAsyncTurns?.get(first.triggerId!)).toBeUndefined();
    // …and a same-key retry resolves TERMINAL without a second fork.
    const retry = await triggerSessionTurn(freshAsyncReq('k-wx'), { larkAppId: APP, activeSessions: shared });
    expect(retry.state).toBe('failed');
    expect(retry.idempotent).toBe(true);
    expect(mockForkWorker).toHaveBeenCalledTimes(1); // still ONE fork
  });

  it('worker-exit convergence ignores a NON-matching generation (no retro-fail of a later turn)', async () => {
    const shared = new Map();
    const first = await triggerSessionTurn(freshAsyncReq('k-wxgen'), { larkAppId: APP, activeSessions: shared });
    const sid = first.target!.sessionId!;
    const ds = [...shared.values()].find((d: any) => d.session.sessionId === sid) as any;
    const gen = ds.idempotentAsyncTurns.get(first.triggerId!).workerGeneration;
    // A DIFFERENT (older) generation exits → must NOT converge this turn.
    convergeIdempotentAsyncTurnOnWorkerExit(ds, gen - 1);
    expect(asyncTriggerStore.lookup(sid, first.triggerId!)?.result.status).toBe('pending'); // untouched
    expect(ds.idempotentAsyncTurns?.get(first.triggerId!)).toBeDefined(); // entry intact
  });

  it('FINDING #3: a FOREIGN completed on the same sessionId does NOT clear the exit-convergence stamp', async () => {
    // codex round-7 #3: async-trigger-store is keyed by sessionId; a foreign bot's
    // completed on the same sessionId/triggerId must NOT be treated as OUR
    // completion and clear our only exit-convergence stamp — else onCliExit leaves
    // no stamp, resolveIdempotencyHit reuses the attempting lease (foreign outcome
    // ignored + liveWorker), and the later onWorkerExit — stampless — can never
    // converge → permanent running. Convergence must still write OUR durable failed
    // (recordFailedStrict is owner-proofed and would throw on a real foreign-owned
    // file; here the foreign record is under a DIFFERENT session file, so our write
    // to our own session succeeds).
    const shared = new Map();
    const first = await triggerSessionTurn(freshAsyncReq('k-fc3'), { larkAppId: APP, activeSessions: shared });
    const sid = first.target!.sessionId!;
    const ds = [...shared.values()].find((d: any) => d.session.sessionId === sid) as any;
    const gen = ds.idempotentAsyncTurns.get(first.triggerId!).workerGeneration;
    // Foreign bot writes a completed on OUR sessionId/triggerId (adversarial /
    // sessionId collision). ownerLarkAppId != our APP.
    asyncTriggerStore.recordCompleted(sid, first.triggerId!, 'B answer', 100, 'cli_OTHER_BOT');
    ds.worker = null;
    convergeIdempotentAsyncTurnOnWorkerExit(ds, gen);
    // The foreign completed did NOT count as our completion: convergence attempted
    // our durable failed. recordFailedStrict is completed-wins + owner-proofed, so
    // the on-disk foreign completed stays (owner mismatch → our write threw inside,
    // entry intact for reconcile). The KEY invariant: the entry was NOT silently
    // cleared by the foreign completed.
    const rec = asyncTriggerStore.lookup(sid, first.triggerId!);
    expect(rec?.ownerLarkAppId).toBe('cli_OTHER_BOT'); // foreign evidence untouched (owner-proof)
    expect(ds.idempotentAsyncTurns?.get(first.triggerId!)).toBeDefined();  // entry NOT cleared by foreign completed
  });

  it('FINDING #1: keyed at-most-once turn forks with atMostOnce so the worker never replays it after CLI exit', async () => {
    // codex round-7 #1: the fork must carry atMostOnce so the worker excludes the
    // input from BOTH inflight carry-over and pendingMessages on CLI exit. Assert
    // the daemon side passes it (the worker-side no-replay is unit-tested in
    // inflight-input-tracker + worker restart integration).
    mockForkWorker.mockClear();
    await triggerSessionTurn(freshAsyncReq('k-amo'), { larkAppId: APP, activeSessions: new Map() });
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
    const forkArg = mockForkWorker.mock.calls[0][2]; // third arg = resumeOrTurnId
    expect(typeof forkArg).toBe('object');
    expect(forkArg.atMostOnce).toBe(true);
    expect(forkArg.turnId).toBeTruthy();
  });

  // ── codex #776 round-6 finding #4: the raw idempotencyKey must NOT leak into
  //    the rendered prompt, or trim-equivalent keys ('k' vs ' k ') would produce
  //    a different prompt while the hash (which excludes the key) matches — a
  //    silent reuse flagged as `prompt differs`. The renderer strips the key too.
  it('idempotencyKey is stripped from the rendered event prompt (normalized-key seam)', () => {
    const withKey = { ...freshAsyncReq('  spaced-key  '), options: { asyncReturnSessionId: true, idempotencyKey: '  spaced-key  ', status: 'firing' } } as any;
    const prompt = buildExternalEventDataContext(withKey, 'trg_x');
    expect(prompt).not.toContain('spaced-key');   // raw key never rendered
    expect(prompt).not.toContain('idempotencyKey'); // field itself stripped
    expect(prompt).toContain('"status": "firing"'); // other options still rendered
  });

  it('passes the canonical key-free business envelope to the actual keyed fork', async () => {
    const request = {
      ...freshAsyncReq('  actual-spaced-key  '),
      options: {
        asyncReturnSessionId: true,
        idempotencyKey: '  actual-spaced-key  ',
        status: 'firing',
      },
    } as any;

    await triggerSessionTurn(request, { larkAppId: APP, activeSessions: new Map() });

    expect(mockForkWorker).toHaveBeenCalledTimes(1);
    const actualPromptInput = mockForkWorker.mock.calls[0][1] as { content: string };
    expect(actualPromptInput.content).not.toContain('actual-spaced-key');
    expect(actualPromptInput.content).not.toContain('idempotencyKey');
    expect(actualPromptInput.content).toContain('"status": "firing"');
  });

  it('trim-equivalent keys reuse the SAME lease and do NOT 409 (prompt is identical after strip)', async () => {
    const shared = new Map();
    const a = await triggerSessionTurn({ ...freshAsyncReq('k-trim'), options: { asyncReturnSessionId: true, idempotencyKey: 'k-trim' } } as any, { larkAppId: APP, activeSessions: shared });
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
    // A retry with a whitespace-padded key trims to the same lookup key; because
    // the renderer strips the key, optionsForHash AND the rendered prompt are
    // identical → legitimate reuse, NOT a 409 idempotency_conflict.
    const b = await triggerSessionTurn({ ...freshAsyncReq('k-trim'), options: { asyncReturnSessionId: true, idempotencyKey: '  k-trim  ' } } as any, { larkAppId: APP, activeSessions: shared });
    expect(b.errorCode).not.toBe('idempotency_conflict');
    expect(b.idempotent).toBe(true);
    expect(b.target?.sessionId).toBe(a.target?.sessionId);
    expect(mockForkWorker).toHaveBeenCalledTimes(1); // no second fork
  });

  // ── codex #776 round-8 finding #1: forkWorker defers (returns without forking)
  //    during a device-isolation freeze. A keyed dispatch must NOT cross the
  //    barrier + report queued in that window, or a retry sees failed while the
  //    deferred fork later runs. Refuse up-front, retryable, nothing dispatched.
  it('keyed dispatch during a device-isolation freeze → retryable error, NO lease/async/fork', async () => {
    const acq = acquireDeviceIsolationFreeze({ nonce: 'n1', inventoryGeneration: 'g1', leaseMs: 30_000 });
    expect(acq.ok).toBe(true);
    const res = await triggerSessionTurn(freshAsyncReq('k-freeze'), { larkAppId: APP, activeSessions: new Map() });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('trigger_failed');
    expect(res.state).not.toBe('failed');           // NOT a terminal — retryable
    expect(mockForkWorker).not.toHaveBeenCalled();   // nothing dispatched/deferred
    expect(idempotencyStore.lookup(APP, 'k-freeze')).toBeUndefined(); // no lease claimed
    expect(createdSessions).toHaveLength(0);         // no provisional/closed Session garbage
    // After release, the same key dispatches cleanly (exactly once).
    if (acq.ok) releaseDeviceIsolationFreeze({ nonce: 'n1', leaseId: acq.lease.leaseId });
    const ok = await triggerSessionTurn(freshAsyncReq('k-freeze'), { larkAppId: APP, activeSessions: new Map() });
    expect(ok.ok).toBe(true);
    expect(ok.idempotent).toBe(false);
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
    expect(idempotencyStore.lookup(APP, 'k-freeze')?.state).toBe('attempting');
  });

  // ── codex #776 round-8 finding #2: if the exit-convergence durable write FAILS
  //    (EIO/ENOSPC), the helper must report write_failed so the daemon fail-closes
  //    the session (observable terminal), not strand the poller on running.
  it('worker-exit convergence write failure → returns write_failed (daemon fail-closes)', async () => {
    const shared = new Map();
    const first = await triggerSessionTurn(freshAsyncReq('k-wf'), { larkAppId: APP, activeSessions: shared });
    const sid = first.target!.sessionId!;
    const ds = [...shared.values()].find((d: any) => d.session.sessionId === sid) as any;
    const gen = ds.idempotentAsyncTurns.get(first.triggerId!).workerGeneration;
    // Inject an EIO/ENOSPC-class failure on the durable dispatch_unknown write.
    const wSpy = vi.spyOn(asyncTriggerStore, 'recordFailedStrict').mockImplementationOnce(() => { throw new Error('injected ENOSPC on durable write'); });
    ds.worker = null;
    const outcome = convergeIdempotentAsyncTurnOnWorkerExit(ds, gen);
    wSpy.mockRestore();
    expect(outcome).toBe('write_failed');
    // Entry is KEPT (not dropped) so a later retry / reconcile can still converge.
    expect(ds.idempotentAsyncTurns?.get(first.triggerId!)).toBeDefined();
    // The durable failed was NOT written (write threw) — async record stays pending;
    // the daemon wrapper (failCloseIdempotentTurnIfConvergenceWriteFailed) is what
    // closes the session on this write_failed signal (asserted via source-lock).
    expect(asyncTriggerStore.lookup(sid, first.triggerId!)?.result.status).toBe('pending');
  });
});
