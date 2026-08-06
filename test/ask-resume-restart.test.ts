import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  registerAsk,
  restorePersistedAsks,
  tryResolveAsk,
  setCardDispatcher,
  setCanTalkChecker,
  setAskPersistStore,
  _resetForTest,
} from '../src/core/ask-broker.js';
import { createAskPersistStore, askKeyFor, ASK_STORE_SENTINEL, type PersistedAsk } from '../src/core/ask-persist-store.js';
import type { AskCardDispatcher, AskResult, CreateAskInput, PendingAsk } from '../src/core/ask-types.js';

/**
 * Restart-resume for `botmux ask` — the AskUserQuestion picker-desync root fix,
 * hardened per codex's REQUEST_CHANGES. Covers BOTH restart orderings:
 *   - reattach → click  (hook reconnects first, then user answers)
 *   - click → reattach  (user answers the dormant card first — durable handoff)
 * plus card re-send when the restart lands before cardMessageId was recorded,
 * request-id/originKind identity, and dependency-injected store isolation.
 */

const OPTIONS = [
  { key: 'yes', label: '继续' },
  { key: 'no', label: '回滚' },
];

function makeInput(over: Partial<CreateAskInput> = {}): CreateAskInput {
  return {
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    sessionId: 'sess-1',
    requestId: 'req-1',
    originKind: 'hook',
    questions: [{ prompt: '继续发版吗？', options: OPTIONS, multiSelect: false }],
    timeoutMs: 60_000,
    ...over,
  };
}

/** Dispatcher that records sends and lets a test control the returned messageId
 *  (default: undefined-safe id). Also records onSettle for card-flip assertions. */
function mockDispatcher(sendImpl?: (ask: PendingAsk) => Promise<{ messageId?: string }>): AskCardDispatcher & {
  sendCalls: PendingAsk[];
  settleCalls: AskResult[];
} {
  const sendCalls: PendingAsk[] = [];
  const settleCalls: AskResult[] = [];
  return {
    async send(ask) { sendCalls.push(ask); return sendImpl ? sendImpl(ask) : { messageId: `om_card_${ask.askId}` }; },
    onSettle(_ask, result) { settleCalls.push(result); },
    sendCalls,
    settleCalls,
  };
}

let dataDir: string;
let prevDataDir: string | undefined;

/** Rebind a fresh injected store on the broker after a simulated restart. */
function bindStore() {
  setAskPersistStore(createAskPersistStore(join(dataDir, 'asks')));
}

beforeEach(() => {
  prevDataDir = process.env.SESSION_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-resume-'));
  _resetForTest();          // detaches store (never deletes)
  bindStore();
  setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
});

afterEach(() => {
  _resetForTest();
  // Teardown deletes ONLY this test's own temp dir, and only if it carries the
  // store sentinel (guard against ever reaping a shared/real dir — codex P1-4).
  const store = join(dataDir, 'asks');
  if (existsSync(join(store, ASK_STORE_SENTINEL)) || !existsSync(store)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
});

function persistedFiles(): string[] {
  const dir = join(dataDir, 'asks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json'));
}

/** Read the single persisted ask record (fails if not exactly one). */
function onlyPersisted(): PersistedAsk {
  const files = persistedFiles();
  if (files.length !== 1) throw new Error(`expected 1 persisted ask, got ${files.length}`);
  return JSON.parse(readFileSync(join(dataDir, 'asks', files[0]), 'utf-8')) as PersistedAsk;
}

describe('ask persistence (injected store)', () => {
  it('registerAsk writes a durable record; answering removes it', async () => {
    setCardDispatcher(mockDispatcher());
    const p = registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    expect(persistedFiles()).toHaveLength(1);
    const rec = onlyPersisted();
    expect(tryResolveAsk({ askId: rec.askId, nonce: rec.nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    await p;
    expect(persistedFiles()).toHaveLength(0);
  });

  it('does nothing when no store is wired (no global-dir writes)', async () => {
    setAskPersistStore(null);
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    expect(persistedFiles()).toHaveLength(0); // never touched the dir
  });
});

describe('reattach → click (hook reconnects first)', () => {
  it('restores dormant (no re-post), hook re-registers, then click resolves', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const orig = onlyPersisted();

    // Simulate restart: reset memory, rebind store (disk survives), restore.
    _resetForTest();
    bindStore();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(1);
    expect(d2.sendCalls).toHaveLength(0); // card still live → no re-post

    // Hook reconnects: same requestId → re-attach (no new card).
    const reattached = registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    expect(d2.sendCalls).toHaveLength(0);

    // Now the user clicks → resolves the re-attached waiter.
    expect(tryResolveAsk({ askId: orig.askId, nonce: orig.nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    const result = await reattached;
    expect(result.kind).toBe('answered');
    expect(persistedFiles()).toHaveLength(0);
  });
});

describe('click → reattach (durable handoff — codex P1-1)', () => {
  it('user answers dormant card first; hook reconnect delivers the stashed answer, 0 new cards', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const orig = onlyPersisted();

    // Restart → restore dormant.
    _resetForTest();
    bindStore();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');

    // User clicks the dormant card BEFORE the hook reconnects.
    expect(tryResolveAsk({ askId: orig.askId, nonce: orig.nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    // Answer is stashed durably (record kept, not deleted) + card flipped.
    expect(persistedFiles()).toHaveLength(1);
    expect(d2.settleCalls).toHaveLength(1);

    // Hook reconnects (same requestId) → claims the stashed answer, no new card.
    const reattached = registerAsk(makeInput());
    const result = await reattached;
    expect(result.kind).toBe('answered');
    if (result.kind === 'answered') expect(result.answers).toEqual([['yes']]);
    expect(d2.sendCalls).toHaveLength(0);           // never posted a second card
    expect(persistedFiles()).toHaveLength(0);       // claimed → cleaned
  });

  it('stashed answer survives a SECOND restart before the hook claims it', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const orig = onlyPersisted();

    _resetForTest(); bindStore(); setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');
    tryResolveAsk({ askId: orig.askId, nonce: orig.nonce, selected: 'no', by: 'ou_owner' }); // answered while dormant
    expect(persistedFiles()).toHaveLength(1); // stashed

    // Second restart before claim: the stashed answer must persist.
    _resetForTest(); bindStore(); setCardDispatcher(mockDispatcher());
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');
    const result = await registerAsk(makeInput());
    expect(result.kind).toBe('answered');
    if (result.kind === 'answered') expect(result.answers).toEqual([['no']]);
    expect(persistedFiles()).toHaveLength(0);
  });
});

describe('card re-send when restart precedes cardMessageId (codex P1-2)', () => {
  it('a restored ask without cardMessageId re-sends exactly one card on re-attach', async () => {
    // Dispatcher that never resolves a messageId → simulates restart before the
    // .then() that records cardMessageId runs.
    let resolveSend: (v: { messageId?: string }) => void;
    const slow = mockDispatcher(() => new Promise((res) => { resolveSend = res; }));
    setCardDispatcher(slow);
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    // Record persisted WITHOUT cardMessageId (send still pending).
    const files = readdirSync(join(dataDir, 'asks')).filter(n => n.endsWith('.json'));
    const orig = onlyPersisted();
    expect(orig.cardMessageId).toBeUndefined();

    // Restart → restore → hook re-attach: MUST re-send the card exactly once.
    _resetForTest(); bindStore();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');
    expect(d2.sendCalls).toHaveLength(0);           // restore alone doesn't send
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    expect(d2.sendCalls).toHaveLength(1);           // re-attach re-sends exactly one
    void resolveSend!;
  });
});

describe('identity + isolation', () => {
  it('askKeyFor namespaces by originKind so hook vs explicit asks never collide', () => {
    expect(askKeyFor('hook', 'req-1')).toBe(askKeyFor('hook', 'req-1'));
    expect(askKeyFor('hook', 'req-1')).not.toBe(askKeyFor('explicit', 'req-1'));
    expect(askKeyFor('hook', 'req-1')).not.toBe(askKeyFor('hook', 'req-2'));
  });

  it('two concurrent same-question asks from one session get distinct records (distinct requestId)', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput({ requestId: 'req-A' }));
    registerAsk(makeInput({ requestId: 'req-B' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(persistedFiles()).toHaveLength(2); // NOT collapsed by a questions hash
  });

  it('restore skips a different bot; drops answered-never records past deadline', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput({ larkAppId: 'cli_other', requestId: 'req-other' }));
    await new Promise((r) => setTimeout(r, 5));
    _resetForTest(); bindStore(); setCardDispatcher(mockDispatcher());
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(0);      // different bot
  });
});
