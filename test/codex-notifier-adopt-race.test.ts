/**
 * PR #686 follow-up — the two pre-existing races the Codex-notifier「继续处理」
 * takeover exposed, isolated to their pure decision helpers so they can be
 * exercised without standing up the whole daemon:
 *
 *  P1 · notifierAdoptStaleOrTransferring — after the dynamic import + AbortSignal
 *       await, a concurrent /relay transfer (or /close/swap/re-create) must abort
 *       the takeover BEFORE any mutation, so the outer handler never renders a
 *       bogus green「已接管」over a half-rewritten / relayed session.
 *
 *  P2 · notifierAdoptWouldDropInput — the "would clear drop undelivered input?"
 *       predicate must NOT gate on pendingRepo: input buffered in the just-
 *       committed launch window (pendingRepo=false, pendingRawInput/
 *       pendingFollowUpInput still waiting on prompt_ready) is just as real as
 *       the repo-select pending buffer.
 *
 * Run: pnpm vitest run test/codex-notifier-adopt-race.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  transferring: new WeakSet<object>(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient, WSClient: class { start() {} } };
});

// isSessionTransferring is the only worker-pool behaviour these pure helpers
// depend on. Back it by a test-controlled WeakSet keyed on the session object so
// a test can flip a ds "into transfer" without a real relay gate.
vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return {
    ...actual,
    isSessionTransferring: (ds: any) => mocks.transferring.has(ds),
  };
});

import {
  __testOnly_notifierAdoptStaleOrTransferring as staleOrTransferring,
  __testOnly_notifierAdoptWouldDropInput as wouldDropInput,
  __testOnly_clearPendingRepoStateForNotifierAdopt as clearForAdopt,
} from '../src/daemon.js';
import type { DaemonSession } from '../src/core/types.js';

const KEY = 'oc_dm:cli_app';

function makeDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: {
      sessionId: 'sid-1',
      status: 'active',
      cliSessionId: undefined,
    },
    worker: null,
    larkAppId: 'cli_app',
    chatId: 'oc_dm',
    ...overrides,
  } as unknown as DaemonSession;
}

describe('P1 · notifierAdoptStaleOrTransferring', () => {
  beforeEach(() => {
    // Fresh transfer set per test (WeakSet has no clear()).
    mocks.transferring = new WeakSet();
  });

  it('healthy, still-mapped, non-transferring session → proceed (false)', () => {
    const ds = makeDs();
    const sessions = new Map([[KEY, ds]]);
    expect(staleOrTransferring(ds, sessions, KEY, 'sid-1')).toBe(false);
  });

  it('session swapped out of the active map → abort (true)', () => {
    const ds = makeDs();
    const other = makeDs({ session: { sessionId: 'sid-2', status: 'active' } as any });
    const sessions = new Map([[KEY, other]]); // key now points elsewhere
    expect(staleOrTransferring(ds, sessions, KEY, 'sid-1')).toBe(true);
  });

  it('active-map entry removed (/close) → abort (true)', () => {
    const ds = makeDs();
    const sessions = new Map<string, DaemonSession>(); // key gone
    expect(staleOrTransferring(ds, sessions, KEY, 'sid-1')).toBe(true);
  });

  it('session identity drifted (re-created under the same key) → abort (true)', () => {
    const ds = makeDs();
    const sessions = new Map([[KEY, ds]]);
    ds.session.sessionId = 'sid-DIFFERENT';
    expect(staleOrTransferring(ds, sessions, KEY, 'sid-1')).toBe(true);
  });

  it('session no longer active (closed) → abort (true)', () => {
    const ds = makeDs({ session: { sessionId: 'sid-1', status: 'closed' } as any });
    const sessions = new Map([[KEY, ds]]);
    expect(staleOrTransferring(ds, sessions, KEY, 'sid-1')).toBe(true);
  });

  it('a /relay transfer opened its gate on this session → abort (true)', () => {
    const ds = makeDs();
    const sessions = new Map([[KEY, ds]]);
    mocks.transferring.add(ds); // relay in progress
    expect(staleOrTransferring(ds, sessions, KEY, 'sid-1')).toBe(true);
  });
});

describe('P2 · notifierAdoptWouldDropInput', () => {
  it('nothing pending → false', () => {
    expect(wouldDropInput(makeDs())).toBe(false);
  });

  it('repo-select pending buffer (pendingRepo=true) → true', () => {
    expect(wouldDropInput(makeDs({ pendingRepo: true, pendingPrompt: 'hello' } as any))).toBe(true);
  });

  it('pendingRawInput in the launch window with pendingRepo ALREADY false → true (the P2 window)', () => {
    // commitRepoSelection has set pendingRepo=false and forked; pendingRawInput
    // still awaits the new worker's prompt_ready. The old predicate gated on
    // pendingRepo===true and would MISS this — silently dropping the raw input.
    const ds = makeDs({ pendingRepo: false, pendingRawInput: '/status' } as any);
    expect(wouldDropInput(ds)).toBe(true);
  });

  it('pendingFollowUpInput staged for prompt_ready with pendingRepo false → true', () => {
    const ds = makeDs({
      pendingRepo: false,
      pendingFollowUpInput: { userPrompt: 'go', cliInput: 'wrapped go' },
    } as any);
    expect(wouldDropInput(ds)).toBe(true);
  });

  it('whitespace-only buffers do not count as droppable input', () => {
    const ds = makeDs({ pendingRepo: false, pendingRawInput: '   ', pendingPrompt: '  ' } as any);
    expect(wouldDropInput(ds)).toBe(false);
  });

  it('mention/context-only pending (no submittable text) → false', () => {
    // pendingMentions / codexApp*Context are not submittable input on their own.
    const ds = makeDs({
      pendingRepo: true,
      pendingMentions: [{ openId: 'ou_x' }],
      pendingCodexAppApplicationContext: { some: 'ctx' },
    } as any);
    expect(wouldDropInput(ds)).toBe(false);
  });
});

describe('P2 · clear actually removes what the predicate flagged', () => {
  it('the launch-window fields the predicate now covers are all cleared', () => {
    const ds = makeDs({
      pendingRepo: false,
      pendingRawInput: '/status',
      pendingFollowUpInput: { userPrompt: 'go', cliInput: 'wrapped go' },
      pendingPrompt: 'hi',
    } as any);
    expect(wouldDropInput(ds)).toBe(true);
    clearForAdopt(ds);
    // Everything the predicate reads is now gone → a second check is false.
    expect(wouldDropInput(ds)).toBe(false);
    expect(ds.pendingRawInput).toBeUndefined();
    expect(ds.pendingFollowUpInput).toBeUndefined();
    expect(ds.pendingRepo).toBe(false);
  });
});
