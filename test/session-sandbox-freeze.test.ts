/**
 * Unit tests for freezeSessionSandboxDecision (core/worker-pool): the pending-
 * session freeze that closes the auto-worktree fail-open window.
 *
 * The auto-worktree fail-closed gate runs BEFORE any git/notice await; the worker
 * fork runs AFTER the up-to-30s build. Both must consume ONE sandbox snapshot.
 * Freezing the decision inputs (sandbox / readIsolation + path lists) on the
 * session at pending-session establishment — and making the fork read the
 * session fields — means a dashboard `PUT /api/bot-sandbox` toggle landing
 * mid-build changes NEITHER side: the gate can't degrade on the old value while
 * the fork isolates on the new one (the write-escape the gate exists to
 * prevent).
 *
 * Run: pnpm vitest run test/session-sandbox-freeze.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.SESSION_DATA_DIR =
    `${process.env.TMPDIR ?? '/tmp'}/botmux-session-sandbox-freeze-${process.pid}`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  return { updateSession: vi.fn() };
});

vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return { ...actual };
});
vi.mock('../src/services/session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/session-store.js')>();
  return { ...actual, updateSession: (...args: any[]) => mocks.updateSession(...args) };
});
vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return {
    ...actual,
    getBot: vi.fn(() => ({
      config: { larkAppId: 'app-freeze', cliId: 'claude-code' },
      botName: 'TestBot', botOpenId: 'ou_bot', resolvedAllowedUsers: [],
    })),
  };
});

import { freezeSessionSandboxDecision } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import type { BotConfig } from '../src/bot-registry.js';

function makeSession(): DaemonSession {
  return {
    session: {
      sessionId: 'sess_freeze', chatId: 'oc_freeze', rootMessageId: 'om_freeze', title: 'freeze',
      status: 'active', createdAt: new Date().toISOString(), scope: 'thread', chatType: 'group',
      larkAppId: 'app_freeze', ownerOpenId: 'ou_owner', workingDir: '/tmp', cliId: 'claude-code',
    },
    worker: null, workerPort: null, workerToken: null, larkAppId: 'app_freeze',
    chatId: 'oc_freeze', chatType: 'group', scope: 'thread', spawnedAt: Date.now(),
    cliVersion: '1.0.0', lastMessageAt: Date.now(), hasHistory: false, workingDir: '/tmp',
  } as DaemonSession;
}

function botCfg(overrides: Partial<BotConfig> = {}): BotConfig {
  return { larkAppId: 'app_freeze', larkAppSecret: 'secret', ...overrides } as BotConfig;
}

beforeEach(() => {
  mocks.updateSession.mockClear();
});

describe('freezeSessionSandboxDecision', () => {
  it('records the live bot config on the session at freeze time and persists it', () => {
    const ds = makeSession();
    freezeSessionSandboxDecision(ds, botCfg({
      sandbox: true, readIsolation: true, sandboxNetwork: false,
      sandboxHidePaths: ['/secret'], sandboxReadonlyPaths: ['/ro'],
    }));
    expect(ds.session.sandbox).toBe(true);
    expect(ds.session.readIsolation).toBe(true);
    expect(ds.session.sandboxNetwork).toBe(false);
    expect(ds.session.sandboxHidePaths).toEqual(['/secret']);
    expect(ds.session.sandboxReadonlyPaths).toEqual(['/ro']);
    expect(mocks.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('is FROZEN: a live sandbox off→on flip after the freeze does not change the recorded decision', () => {
    // The fail-open window: freeze with sandbox OFF, then the dashboard flips
    // the live bot config ON while the worktree build is in flight
    // (updateBotSandbox publishes bot.config.sandbox = true immediately). The
    // fork consumes ds.session.sandbox / ds.session.readIsolation — they must
    // stay OFF, so no local sandbox engages on the real default dir.
    const ds = makeSession();
    const cfg = botCfg({ sandbox: false, readIsolation: false });
    freezeSessionSandboxDecision(ds, cfg);
    expect(ds.session.sandbox).toBe(false);
    expect(ds.session.readIsolation).toBe(false);

    cfg.sandbox = true;       // PUT /api/bot-sandbox during the build
    cfg.readIsolation = true;

    // The fork's SpawnOpts reads (worker-pool forkWorker):
    expect(ds.session.sandbox === true).toBe(false);                          // sandbox arm
    expect(ds.session.readIsolation ?? (cfg.readIsolation === true)).toBe(false); // readIsolation arm
    // A second freeze call must not re-freeze either (idempotent).
    freezeSessionSandboxDecision(ds, cfg);
    expect(ds.session.sandbox).toBe(false);
    expect(ds.session.readIsolation).toBe(false);
    expect(mocks.updateSession).toHaveBeenCalledTimes(1); // only the first freeze persisted
  });

  it('is FROZEN in the other direction too: a live on→off flip keeps the recorded ON decision', () => {
    const ds = makeSession();
    const cfg = botCfg({ sandbox: true, readIsolation: true });
    freezeSessionSandboxDecision(ds, cfg);

    cfg.sandbox = false;      // dashboard flips OFF during the build
    cfg.readIsolation = false;

    expect(ds.session.sandbox === true).toBe(true);
    expect(ds.session.readIsolation ?? (cfg.readIsolation === true)).toBe(true);
  });

  it('resume session pre-dating the field stays NOT sandboxed and leaves readIsolation to the live fallback', () => {
    const ds = makeSession();
    freezeSessionSandboxDecision(ds, botCfg({ sandbox: true, readIsolation: true }), { resume: true });
    expect(ds.session.sandbox).toBe(false);
    expect(ds.session.sandboxHidePaths).toEqual([]);
    expect(ds.session.sandboxNetwork).toBe(true);
    // readIsolation is NOT frozen on resume: the SpawnOpts live-config fallback
    // preserves the legacy restore behavior for sessions persisted before the
    // freeze field existed.
    expect(ds.session.readIsolation).toBeUndefined();
  });
});
