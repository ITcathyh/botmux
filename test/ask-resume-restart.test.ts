import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  registerAsk,
  restorePersistedAsks,
  submitAsk,
  tryResolveAsk,
  toggleAsk,
  setCardDispatcher,
  setCanTalkChecker,
  _resetForTest,
  _getPending,
} from '../src/core/ask-broker.js';
import { computeAskKey, listPersistedAsks } from '../src/core/ask-persist-store.js';
import { config } from '../src/config.js';
import type { AskCardDispatcher, AskResult, CreateAskInput, PendingAsk } from '../src/core/ask-types.js';

/**
 * Restart-resume for `botmux ask` (the AskUserQuestion picker-desync root fix).
 *
 * A daemon restart between "card posted" and "user clicked" used to lose the
 * in-memory pending ask → the click hit `stale` ("此 ask 已失效") and the CLI
 * hook fell into a stuck native picker. These tests exercise the fix: persist on
 * register, restore as a DORMANT ask on boot, and re-attach a reconnecting hook
 * by stable key so the answer flows back through the normal directive.
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
    questions: [{ prompt: '继续发版吗？', options: OPTIONS, multiSelect: false }],
    timeoutMs: 60_000,
    ...over,
  };
}

function mockDispatcher(): AskCardDispatcher & { sendCalls: PendingAsk[] } {
  const sendCalls: PendingAsk[] = [];
  return {
    async send(ask) { sendCalls.push(ask); return { messageId: `om_card_${ask.askId}` }; },
    onSettle() { /* no-op */ },
    sendCalls,
  };
}

let dataDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  prevDataDir = process.env.SESSION_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-ask-resume-'));
  config.session.dataDir = dataDir; // maps onto SESSION_DATA_DIR
  _resetForTest();
  setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
});

afterEach(() => {
  _resetForTest();
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('ask persistence', () => {
  it('registerAsk writes a durable record; settle removes it', async () => {
    setCardDispatcher(mockDispatcher());
    const promise = registerAsk(makeInput());
    // Card dispatch is async; let it land.
    await new Promise((r) => setTimeout(r, 5));

    const persisted = listPersistedAsks();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].sessionId).toBe('sess-1');
    expect(persisted[0].cardMessageId).toMatch(/^om_card_/);
    const askId = persisted[0].askId;

    // Answer it → record removed.
    expect(tryResolveAsk({ askId, nonce: persisted[0].nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    await promise;
    expect(listPersistedAsks()).toHaveLength(0);
  });

  it('multi-select toggle persists accumulated checkbox state', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput({ questions: [{ prompt: '多选', options: OPTIONS, multiSelect: true }] }));
    await new Promise((r) => setTimeout(r, 5));
    const { askId, nonce } = listPersistedAsks()[0];
    toggleAsk({ askId, nonce, questionIndex: 0, key: 'yes', by: 'ou_owner' });
    expect(listPersistedAsks()[0].selections[0]).toEqual(['yes']);
    toggleAsk({ askId, nonce, questionIndex: 0, key: 'no', by: 'ou_owner' });
    expect(listPersistedAsks()[0].selections[0]).toEqual(['yes', 'no']);
  });
});

describe('restorePersistedAsks (daemon restart recovery)', () => {
  it('restores a persisted ask as dormant WITHOUT re-posting the card', async () => {
    // Simulate: a prior daemon posted+persisted an ask, then died.
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const before = listPersistedAsks()[0];

    // New daemon boot: reset in-memory state (disk survives), wire a fresh
    // dispatcher, restore.
    _resetForTest();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    const n = restorePersistedAsks(Date.now(), 'cli_app');

    expect(n).toBe(1);
    // Dormant restore must NOT re-post a card (the original is still live).
    expect(d2.sendCalls).toHaveLength(0);
    // The dormant ask is queryable and clickable.
    const snap = _getPending(before.askId);
    expect(snap?.askId).toBe(before.askId);
    expect(snap?.cardMessageId).toBe(before.cardMessageId);
  });

  it('skips restoring asks belonging to a different bot', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput({ larkAppId: 'cli_other', sessionId: 'sess-other' }));
    await new Promise((r) => setTimeout(r, 5));
    _resetForTest();
    setCardDispatcher(mockDispatcher());
    // This daemon serves cli_app, not cli_other → nothing to restore.
    expect(restorePersistedAsks(Date.now(), 'cli_app')).toBe(0);
  });

  it('drops persisted asks whose deadline already passed while down', async () => {
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput({ timeoutMs: 1_000 }));
    await new Promise((r) => setTimeout(r, 5));
    _resetForTest();
    setCardDispatcher(mockDispatcher());
    // now is well past the 1s deadline.
    expect(restorePersistedAsks(Date.now() + 10_000, 'cli_app')).toBe(0);
    expect(listPersistedAsks(Date.now() + 10_000)).toHaveLength(0);
  });
});

describe('re-attach: reconnecting hook resolves the restored card', () => {
  it('registerAsk with the same key re-attaches to the dormant ask (no new card), then a click resolves it', async () => {
    // Prior daemon: post + persist.
    setCardDispatcher(mockDispatcher());
    registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const orig = listPersistedAsks()[0];

    // Restart: restore dormant.
    _resetForTest();
    const d2 = mockDispatcher();
    setCardDispatcher(d2);
    setCanTalkChecker((_a, _c, openId) => openId === 'ou_owner');
    restorePersistedAsks(Date.now(), 'cli_app');

    // The surviving hook reconnects → re-registers the SAME ask (same session +
    // questions → same key). This must re-attach, NOT post a second card.
    const reattached = registerAsk(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    expect(d2.sendCalls).toHaveLength(0); // no duplicate card

    // A click now resolves the re-attached waiter through the normal path.
    expect(tryResolveAsk({ askId: orig.askId, nonce: orig.nonce, selected: 'yes', by: 'ou_owner' })).toBe('accepted');
    const result: AskResult = await reattached;
    expect(result.kind).toBe('answered');
    expect(listPersistedAsks()).toHaveLength(0); // cleaned on settle
  });

  it('computeAskKey is stable for same session+questions and differs otherwise', () => {
    const qs = makeInput().questions;
    expect(computeAskKey('sess-1', qs)).toBe(computeAskKey('sess-1', qs));
    expect(computeAskKey('sess-1', qs)).not.toBe(computeAskKey('sess-2', qs));
    const qs2 = [{ prompt: 'different?', options: OPTIONS, multiSelect: false }];
    expect(computeAskKey('sess-1', qs)).not.toBe(computeAskKey('sess-1', qs2));
  });
});
