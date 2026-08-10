/**
 * End-to-end tests for TURN-LEVEL idempotency (契約①, PR #71): a follow-up async
 * turn on an EXISTING session, keyed by options.turnIdempotencyKey. Drives the
 * REAL triggerSessionTurn deliverToExisting path against the REAL idempotency- +
 * async-trigger-store (temp SESSION_DATA_DIR). Boundaries (lark / session-store /
 * worker-pool) mocked so we can drive the worker-live (sendWorkerInput) and
 * dormant (forkWorker) dispatch branches and assert the at-most-once lease.
 *
 * The turn lease key is namespaced `turn:<sessionId>:<key>` and reuses the same
 * reserved→attempting barrier + worker-exit convergence as the fresh-session key.
 *
 * Run:  pnpm vitest run test/trigger-session-turn-idempotency.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import type { DaemonSession } from '../src/core/types.js';

let tempDir: string;
let prevDataDir: string | undefined;

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/im/lark/client.js', () => ({
  getMessageChatId: vi.fn(),
  getChatMode: vi.fn(async () => 'group'),
  sendMessage: vi.fn(async () => 'om_x'),
  replyMessage: vi.fn(async () => 'om_x'),
  listChatBotMembers: vi.fn(async () => []),
}));

const mockGetBot = vi.fn(() => ({ config: { cliId: 'codex-app', apiOnly: true } }));
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...a: any[]) => mockGetBot(...a),
  effectiveDefaultWorkingDir: vi.fn(() => '/tmp'),
}));

vi.mock('../src/services/groups-store.js', () => ({ isInChat: vi.fn(async () => true) }));
vi.mock('../src/services/oncall-store.js', () => ({ getOncallStatus: vi.fn(() => undefined) }));

const existingRows: any[] = [];
vi.mock('../src/services/session-store.js', () => ({
  createSession: vi.fn(),
  updateSession: vi.fn(),
  getSession: vi.fn((id: string) => existingRows.find(s => s.sessionId === id)),
  getOwnedSession: vi.fn((id: string) => existingRows.find(s => s.sessionId === id)),
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
}));

vi.mock('../src/services/message-queue.js', () => ({ ensureQueue: vi.fn() }));
vi.mock('../src/core/session-manager.js', () => ({
  buildFollowUpContent: vi.fn((p: string) => p),
  buildFollowUpCliInput: vi.fn((p: string) => ({ content: p })),
  buildNewTopicPrompt: vi.fn((p: string) => p),
  buildNewTopicCliInput: vi.fn((p: string) => ({ content: p })),
  ensureSessionWhiteboard: vi.fn(),
  getAvailableBots: vi.fn(async () => []),
  rememberLastCliInput: vi.fn(),
}));
vi.mock('../src/services/default-worktree.js', () => ({ botAutoWorktreeEnabled: vi.fn(() => false) }));
vi.mock('../src/im/lark/card-handler.js', () => ({ runAutoWorktreeCommit: vi.fn(async () => {}) }));

// worker-pool: sendWorkerInput (worker-live) + forkWorker (dormant) are the two
// dispatch side effects. Either can be made to throw/refuse on demand.
let forkShouldThrow = false;
let sendShouldRefuse = false;
const mockForkWorker = vi.fn(() => { if (forkShouldThrow) throw new Error('injected fork failure'); });
const mockSendWorkerInput = vi.fn(() => !sendShouldRefuse);
const mockCloseSession = vi.fn(async () => ({ ok: true, alreadyClosed: false, known: true }));
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: (...a: any[]) => mockForkWorker(...a),
  sendWorkerInput: (...a: any[]) => mockSendWorkerInput(...a),
  getCurrentCliVersion: vi.fn(() => 'test'),
  setActiveSessionIfActive: (map: Map<string, any>, key: string, ds: any) => { map.set(key, ds); return true; },
  closeSession: (...a: any[]) => mockCloseSession(...a),
  getDaemonBootId: () => 'boot-CURRENT',
  withActiveSessionKeyLock: (_map: any, _key: string, action: () => any) => action(),
  hasQueuedActivationAdmissionGate: () => false,
}));

import { triggerSessionTurn } from '../src/core/trigger-session.js';
import * as asyncTriggerStore from '../src/services/async-trigger-store.js';
import * as idempotencyStore from '../src/services/idempotency-store.js';
import { sessionKey } from '../src/core/types.js';

const APP = 'local_riff';
const SID = 'sess_existing';
const CHAT = `http_async_${'0'.repeat(8)}-0000-0000-0000-000000000000`;

function followUpReq(turnIdempotencyKey: string | undefined, instruction = 'follow up please'): TriggerRequest {
  return {
    source: { type: 'webhook', sourceName: 'riff' } as any,
    target: { kind: 'turn', botId: APP, sessionId: SID },
    envelope: { format: 'text', sourceName: 'riff', trusted: false },
    instruction,
    options: { asyncReturnSessionId: true, ...(turnIdempotencyKey ? { turnIdempotencyKey } : {}) },
  };
}

function existingDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  const s = { sessionId: SID, chatId: CHAT, rootMessageId: '', scope: 'chat', status: 'active', createdAt: '2026-06-01T00:00:00.000Z' };
  return {
    session: s,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: APP,
    chatId: CHAT,
    chatType: 'group',
    scope: 'chat',
    spawnedAt: 1,
    cliVersion: 'test',
    lastMessageAt: 1,
    hasHistory: true,
    ...overrides,
  } as DaemonSession;
}

/** activeSessions map holding one existing session keyed canonically. */
function activeWith(ds: DaemonSession): Map<string, DaemonSession> {
  return new Map<string, DaemonSession>([[sessionKey(CHAT, APP), ds]]);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'trig-turn-idem-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tempDir;
  existingRows.length = 0;
  existingRows.push({ sessionId: SID, chatId: CHAT, scope: 'chat', status: 'active' });
  forkShouldThrow = false; sendShouldRefuse = false;
  mockForkWorker.mockClear(); mockSendWorkerInput.mockClear(); mockCloseSession.mockClear();
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR; else process.env.SESSION_DATA_DIR = prevDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('turn-level idempotency — worker LIVE (sendWorkerInput) branch', () => {
  it('first follow-up: sends once, writes a turn:<sid>:<key> attempting lease, echoes turnIdempotencyKey', async () => {
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const res = await triggerSessionTurn(followUpReq('tk-1'), { larkAppId: APP, activeSessions: activeWith(ds) });
    expect(res.ok).toBe(true);
    expect(res.idempotent).toBeFalsy();
    expect(res.turnIdempotencyKey).toBe('tk-1');
    expect(mockSendWorkerInput).toHaveBeenCalledTimes(1);
    // At-most-once: the keyed live-delivery MUST carry atMostOnce so a CLI crash
    // never replays it onto the auto-restarted CLI after terminalization (the
    // live-branch replay defect — the fresh-session/dormant paths use the fork
    // init's atMostOnce, the live path needs it threaded through the message IPC).
    expect(mockSendWorkerInput.mock.calls[0][3]?.atMostOnce).toBe(true);
    const lease = idempotencyStore.lookup(APP, `turn:${SID}:tk-1`);
    expect(lease?.state).toBe('attempting'); // barrier crossed before send
    expect(lease?.sessionId).toBe(SID);
    // The idempotent-async-turn convergence stamp is set for at-most-once.
    expect(ds.idempotentAsyncTurn?.key).toBe(`turn:${SID}:tk-1`);
    expect(ds.idempotentAsyncTurn?.triggerId).toBe(res.triggerId);
  });

  it('same key + same payload retry: reuses in-flight turn, does NOT send again', async () => {
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const active = activeWith(ds);
    const first = await triggerSessionTurn(followUpReq('tk-2'), { larkAppId: APP, activeSessions: active });
    expect(mockSendWorkerInput).toHaveBeenCalledTimes(1);
    // Retry while the worker is still live → resolveIdempotencyHit sees an
    // attempting lease + liveWorker → reuse.
    const second = await triggerSessionTurn(followUpReq('tk-2'), { larkAppId: APP, activeSessions: active });
    expect(second.idempotent).toBe(true);
    expect(second.triggerId).toBe(first.triggerId);
    expect(mockSendWorkerInput).toHaveBeenCalledTimes(1); // still ONE send
  });

  it('same key + DIFFERENT payload → 409 idempotency_conflict, no second send', async () => {
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const active = activeWith(ds);
    await triggerSessionTurn(followUpReq('tk-3', 'payload A'), { larkAppId: APP, activeSessions: active });
    const conflict = await triggerSessionTurn(followUpReq('tk-3', 'payload B'), { larkAppId: APP, activeSessions: active });
    expect(conflict.ok).toBe(false);
    expect(conflict.errorCode).toBe('idempotency_conflict');
    expect(mockSendWorkerInput).toHaveBeenCalledTimes(1);
  });

  it('completed turn: same-key retry reuses (async-store completed wins over lease)', async () => {
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const active = activeWith(ds);
    const first = await triggerSessionTurn(followUpReq('tk-done'), { larkAppId: APP, activeSessions: active });
    // Simulate the turn completing (final_output path records completed).
    asyncTriggerStore.recordCompleted(SID, first.triggerId!, 'the answer', Date.now(), APP);
    const retry = await triggerSessionTurn(followUpReq('tk-done'), { larkAppId: APP, activeSessions: active });
    expect(retry.idempotent).toBe(true);
    expect(retry.triggerId).toBe(first.triggerId);
    expect(mockSendWorkerInput).toHaveBeenCalledTimes(1); // no re-dispatch
  });

  it('send REFUSED after barrier → durable failed(dispatch_unknown); same-key retry resolves terminal, no re-send', async () => {
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const active = activeWith(ds);
    sendShouldRefuse = true;
    const res = await triggerSessionTurn(followUpReq('tk-refuse'), { larkAppId: APP, activeSessions: active });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('trigger_failed');
    // Authoritative durable failed so trigger-result converges (not stuck running).
    expect(asyncTriggerStore.lookup(SID, res.triggerId!)?.result.status).toBe('failed');
    expect(asyncTriggerStore.lookup(SID, res.triggerId!)?.result.reason).toBe('dispatch_unknown');
    expect(ds.idempotentAsyncTurn).toBeUndefined(); // stamp cleared on refusal
    // Retry: at-most-once — resolves the terminal, never re-sends.
    sendShouldRefuse = false;
    const sendsBefore = mockSendWorkerInput.mock.calls.length;
    const retry = await triggerSessionTurn(followUpReq('tk-refuse'), { larkAppId: APP, activeSessions: active });
    expect(retry.state).toBe('failed');
    expect(retry.idempotent).toBe(true);
    expect(mockSendWorkerInput.mock.calls.length).toBe(sendsBefore); // no new send
  });
});

describe('turn-level idempotency — worker DORMANT (forkWorker) branch', () => {
  it('first follow-up on a dormant worker: forks once with atMostOnce+resume, attempting lease', async () => {
    const ds = existingDs({ worker: null, hasHistory: true }); // dormant
    const res = await triggerSessionTurn(followUpReq('tk-fork'), { larkAppId: APP, activeSessions: activeWith(ds) });
    expect(res.ok).toBe(true);
    expect(res.turnIdempotencyKey).toBe('tk-fork');
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
    const forkArg = mockForkWorker.mock.calls[0][2];
    expect(forkArg.atMostOnce).toBe(true);   // at-most-once rides the fork init
    expect(forkArg.resume).toBe(true);       // existing session resumes context
    expect(idempotencyStore.lookup(APP, `turn:${SID}:tk-fork`)?.state).toBe('attempting');
  });

  it('fork throw AFTER the barrier → durable failed(dispatch_unknown); retry does NOT re-fork', async () => {
    const ds = existingDs({ worker: null, hasHistory: true });
    const active = activeWith(ds);
    forkShouldThrow = true;
    const res = await triggerSessionTurn(followUpReq('tk-fthrow'), { larkAppId: APP, activeSessions: active });
    expect(res.state).toBe('failed');
    expect(res.errorCode).toBe('no_output');
    expect(asyncTriggerStore.lookup(SID, res.triggerId!)?.result.reason).toBe('dispatch_unknown');
    expect(ds.idempotentAsyncTurn).toBeUndefined();
    forkShouldThrow = false;
    const forksBefore = mockForkWorker.mock.calls.length;
    const retry = await triggerSessionTurn(followUpReq('tk-fthrow'), { larkAppId: APP, activeSessions: active });
    expect(retry.state).toBe('failed');
    expect(mockForkWorker.mock.calls.length).toBe(forksBefore); // no new fork
  });
});

describe('turn-level idempotency — no key (unchanged behavior)', () => {
  it('a follow-up WITHOUT turnIdempotencyKey dispatches normally and writes no lease', async () => {
    const ds = existingDs({ worker: { killed: false, send: vi.fn() } as any });
    const res = await triggerSessionTurn(followUpReq(undefined), { larkAppId: APP, activeSessions: activeWith(ds) });
    expect(res.ok).toBe(true);
    expect(res.turnIdempotencyKey).toBeUndefined();
    expect(mockSendWorkerInput).toHaveBeenCalledTimes(1);
    // No key → a plain replayable input (atMostOnce must NOT be set, else an
    // ordinary follow-up would be wrongly dropped on a CLI restart).
    expect(mockSendWorkerInput.mock.calls[0][3]?.atMostOnce).toBeUndefined();
    expect(ds.idempotentAsyncTurn).toBeUndefined(); // no lease, no convergence stamp
  });
});
