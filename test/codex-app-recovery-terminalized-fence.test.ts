/**
 * Regression: recovery-seam at-most-once fence for the turn-level idempotency key
 * (turnIdempotencyKey, PR #818). A keyed follow-up delivered to a LIVE codex-app
 * worker records a durable `accepted` entry on the Codex App dispatch ledger. If
 * that turn is interrupted, the turn lease terminalizes it to a durable
 * `failed(dispatch_unknown)` (the caller is told "not run, at-most-once") but —
 * unlike a fresh async-virtual session — LEAVES the shared session open and
 * un-quarantined. The daemon then eager-reforks that session at boot
 * (restoreActiveSessions → durable-owner → forkWorker), and the recovery path
 * (`codexAppRecoveredDispatches` → worker init → `recoveredAcceptedInputs`, keyed
 * on `state==='accepted'` ALONE, with no `noReplay`) would otherwise re-issue
 * `turn/start` for a turn the caller already saw as `failed`.
 *
 * The fence (`retireTerminalizedCodexAppLedgerEntriesForRecovery`, run inside
 * forkWorker BEFORE the recovery snapshot) durably retires exactly those
 * `accepted` entries whose OWNER-MATCHED async terminal is
 * `failed(dispatch_unknown)`, so they never reach the recovery snapshot — while
 * leaving pending / completed / prepared / foreign-owned entries untouched.
 *
 * Drives the REAL async-trigger-store (temp SESSION_DATA_DIR) + the REAL ledger
 * helpers; only session-store.updateSession is stubbed so persistence is
 * observable without a real sessions file.
 *
 * Run:  pnpm vitest run test/codex-app-recovery-terminalized-fence.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DaemonSession } from '../src/core/types.js';
import type { CodexAppDispatchLedgerEntry } from '../src/types.js';

let tempDir: string;
let prevDataDir: string | undefined;

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Observe durable persistence without a real sessions-*.json write.
const updateSessionMock = vi.fn();
vi.mock('../src/services/session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/session-store.js')>();
  return { ...actual, updateSession: (...a: any[]) => updateSessionMock(...a) };
});

import * as asyncTriggerStore from '../src/services/async-trigger-store.js';
import { __testOnly_retireTerminalizedCodexAppLedgerEntriesForRecovery as retireFence } from '../src/core/worker-pool.js';

const APP = 'app_recovery_fence';
const OTHER_APP = 'app_other_bot';
const SID = 'sess_shared_codex_app';

let dispatchSeq = 0;
function accepted(turnId: string, content = 'keyed follow-up'): CodexAppDispatchLedgerEntry {
  return { dispatchId: `disp-${turnId}-${dispatchSeq++}`, turnId, state: 'accepted', content, dispatchAttempt: 1 };
}
function prepared(turnId: string, content = 'in-flight'): CodexAppDispatchLedgerEntry {
  return { dispatchId: `disp-${turnId}-${dispatchSeq++}`, turnId, state: 'prepared', content, dispatchAttempt: 1 };
}

function ds(ledger: CodexAppDispatchLedgerEntry[], larkAppId = APP): DaemonSession {
  return {
    session: { sessionId: SID, chatId: 'oc_x', rootMessageId: '', scope: 'chat', status: 'active',
      createdAt: '2026-06-01T00:00:00.000Z', larkAppId, cliId: 'codex-app', codexAppDispatchLedger: ledger },
    worker: null, workerPort: null, workerToken: null, larkAppId,
    chatId: 'oc_x', chatType: 'group', scope: 'chat', spawnedAt: 1, cliVersion: 'test',
    lastMessageAt: 1, hasHistory: true, workingDir: '/tmp',
  } as unknown as DaemonSession;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'codex-recovery-fence-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tempDir;
  updateSessionMock.mockClear();
  dispatchSeq = 0;
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR; else process.env.SESSION_DATA_DIR = prevDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('codex-app recovery fence — terminalized keyed turn is not replayed (PR #818)', () => {
  it('retires an accepted entry whose OWN async terminal is failed(dispatch_unknown), keeps a pending sibling', () => {
    const term = accepted('turn-terminalized');
    const live = accepted('turn-still-pending');
    const session = ds([term, live]);
    // Owner-matched durable dispatch_unknown for the terminalized turn; a plain
    // pending record for the sibling (never terminalized).
    asyncTriggerStore.recordFailedStrict(SID, term.turnId, Date.now(), APP, 'dispatch_unknown');
    asyncTriggerStore.recordPending(SID, live.turnId, Date.now(), APP);

    retireFence(session);

    const remaining = session.session.codexAppDispatchLedger!.map(e => e.turnId);
    // The terminalized turn is durably retired → it can never reach the recovery
    // snapshot → never replayed as turn/start.
    expect(remaining).not.toContain('turn-terminalized');
    // The pending sibling is untouched (a legitimate not-yet-run turn must still resume).
    expect(remaining).toContain('turn-still-pending');
    expect(updateSessionMock).toHaveBeenCalledTimes(1); // durable persist happened
  });

  it('is a no-op when the async terminal is completed (completed wins — never retire a finished turn)', () => {
    const done = accepted('turn-completed');
    const session = ds([done]);
    asyncTriggerStore.recordCompleted(SID, done.turnId, 'the answer', Date.now(), APP);

    retireFence(session);

    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).toContain('turn-completed');
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('is a no-op for a foreign-owned dispatch_unknown (owner-positive-proof: only OUR failed retires OUR entry)', () => {
    const term = accepted('turn-foreign-failed');
    const session = ds([term], APP);
    // A foreign bot wrote failed on the SAME sessionId/triggerId (adversarial /
    // sessionId collision). ownerLarkAppId != our APP → must be ignored.
    asyncTriggerStore.recordFailedStrict(SID, term.turnId, Date.now(), OTHER_APP, 'dispatch_unknown');

    retireFence(session);

    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).toContain('turn-foreign-failed');
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('never retires a PREPARED entry even when its async terminal is failed (crossed write boundary → generation fence owns it)', () => {
    const prep = prepared('turn-prepared');
    const session = ds([prep]);
    asyncTriggerStore.recordFailedStrict(SID, prep.turnId, Date.now(), APP, 'dispatch_unknown');

    retireFence(session);

    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).toContain('turn-prepared');
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('does NOT retire past a prepared successor (cancelCodexAppDispatch refuses; entry survives for the generation fence)', () => {
    // accepted head is terminalized, but a later PREPARED frame exists → removing
    // the head would reorder the FIFO under a live prepared frame. The fence must
    // leave it (cancel refuses prepared_successor_exists).
    const head = accepted('turn-terminalized-head');
    const succ = prepared('turn-prepared-successor');
    const session = ds([head, succ]);
    asyncTriggerStore.recordFailedStrict(SID, head.turnId, Date.now(), APP, 'dispatch_unknown');

    retireFence(session);

    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId))
      .toEqual(['turn-terminalized-head', 'turn-prepared-successor']);
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('is idempotent — a second recovery seam with the entry already gone does nothing', () => {
    const term = accepted('turn-idem');
    const session = ds([term]);
    asyncTriggerStore.recordFailedStrict(SID, term.turnId, Date.now(), APP, 'dispatch_unknown');

    retireFence(session);
    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).not.toContain('turn-idem');
    updateSessionMock.mockClear();
    // Re-run at the next fork seam: nothing left to retire.
    retireFence(session);
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('re-checks the durable truth every seam (failed persisted, ledger retirement not yet done → this fork completes it)', () => {
    // Models codex\'s window: exit-time best-effort retirement never ran (or crashed
    // right after the durable failed landed), so the accepted entry is still on the
    // ledger at the NEXT fork. The recovery seam re-reads the authoritative async
    // truth and finishes the retirement — no reliance on exit-time cleanup.
    const term = accepted('turn-window');
    const session = ds([term]);
    asyncTriggerStore.recordFailedStrict(SID, term.turnId, Date.now(), APP, 'dispatch_unknown');

    retireFence(session);

    expect(session.session.codexAppDispatchLedger!.map(e => e.turnId)).not.toContain('turn-window');
    expect(updateSessionMock).toHaveBeenCalledTimes(1);
  });
});
