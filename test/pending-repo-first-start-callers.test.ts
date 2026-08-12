import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerBot, requireBotId } from '../src/bot-registry.js';
import { handleCommand } from '../src/core/command-handler.js';
import type { CurrentPendingRepoCompletionSubmitInput } from '../src/core/current-pending-repo-completion-submit.js';
import { stagePendingRepoSetup } from '../src/core/pending-repo-journal.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { commitRepoSelection, runAutoWorktreeCommit } from '../src/im/lark/card-handler.js';
import * as sessionStore from '../src/services/session-store.js';

const APP = 'local_pending_repo_callers';
const CHAT = 'oc_pending_repo_callers';
const ROOT = 'om_pending_repo_callers';

function pendingSession(): DaemonSession {
  const session = sessionStore.createSession(CHAT, ROOT, 'pending caller', 'group', 'thread');
  Object.assign(session, { larkAppId: APP, cliId: 'codex-app' });
  const ds = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: APP,
    chatId: CHAT,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1,
    cliVersion: 'test',
    lastMessageAt: 1,
    hasHistory: false,
    pendingRepo: true,
    pendingPrompt: 'must remain owned by Runtime',
    pendingTurnId: 'om_caller_opening',
    pendingAttachments: [{ type: 'file', path: '/tmp/exact.md', name: 'exact.md' }],
  } as DaemonSession;
  stagePendingRepoSetup(ds, {
    mode: 'picker',
    turnId: 'om_caller_opening',
    cliInput: { content: '<exact>caller opening</exact>' },
  });
  return ds;
}

let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pending-repo-callers-'));
  previousDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
  sessionStore.init(APP);
  registerBot({
    larkAppId: APP,
    larkAppSecret: '',
    apiOnly: true,
    cliId: 'codex-app',
    codexAppCleanInput: true,
    workingDir: process.cwd(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStore.init();
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('pending-repo first-start callers', () => {
  it('card directory completion delegates mutation and fork ownership to the typed submit helper', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const submit = vi.fn(async (_input: CurrentPendingRepoCompletionSubmitInput) => ({
      kind: 'applied' as const,
      action: 'pendingRepo.firstStartCommitted' as const,
      sessionId: ds.session.sessionId,
    }));
    const reply = vi.fn(async () => 'om_reply');

    await expect(commitRepoSelection({
      ds,
      rootId: ROOT,
      larkAppId: APP,
      activeSessions,
      sessionReply: reply,
      submitPendingRepoCompletion: submit,
    }, '/repos/card-selected', 'card-selected')).resolves.toBe(true);

    expect(submit).toHaveBeenCalledWith({
      ownerBotId: requireBotId(APP),
      ownerLarkAppId: APP,
      activeSessions,
      sessionId: ds.session.sessionId,
      daemonSession: ds,
      selection: {
        kind: 'directory',
        path: '/repos/card-selected',
        pinWorkingDir: true,
      },
    });
    expect(ds).toMatchObject({
      pendingRepo: true,
      pendingPrompt: 'must remain owned by Runtime',
      pendingTurnId: 'om_caller_opening',
      pendingAttachments: [{ type: 'file', path: '/tmp/exact.md', name: 'exact.md' }],
      worker: null,
    });
    expect(ds.workingDir).toBeUndefined();
    expect(ds.session.workingDir).toBeUndefined();
  });

  it('typed refusal leaves the pending opening intact without a legacy fallback', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const submit = vi.fn(async (_input: CurrentPendingRepoCompletionSubmitInput) => ({
      kind: 'rejected' as const,
      reason: 'selectionBusy' as const,
      message: 'another selection already owns this opening',
    }));

    await expect(commitRepoSelection({
      ds,
      rootId: ROOT,
      larkAppId: APP,
      activeSessions,
      sessionReply: vi.fn(async () => 'om_reply'),
      submitPendingRepoCompletion: submit,
    }, '/repos/refused', 'refused')).resolves.toBe(false);

    expect(submit).toHaveBeenCalledOnce();
    expect(ds).toMatchObject({
      pendingRepo: true,
      pendingPrompt: 'must remain owned by Runtime',
      pendingTurnId: 'om_caller_opening',
      pendingAttachments: [{ type: 'file', path: '/tmp/exact.md', name: 'exact.md' }],
      worker: null,
    });
    expect(ds.workingDir).toBeUndefined();
    expect(ds.session.workingDir).toBeUndefined();
  });

  it('auto-worktree completion submits worktree intent without caller-owned mutation', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const submit = vi.fn(async (_input: CurrentPendingRepoCompletionSubmitInput) => ({
      kind: 'applied' as const,
      action: 'pendingRepo.firstStartCommitted' as const,
      sessionId: ds.session.sessionId,
    }));

    await runAutoWorktreeCommit({
      ds,
      anchor: ROOT,
      larkAppId: APP,
      baseDir: '/repos/automatic-base',
      activeSessions,
      notify: vi.fn(),
      submitPendingRepoCompletion: submit,
    });

    expect(submit).toHaveBeenCalledWith({
      ownerBotId: requireBotId(APP),
      ownerLarkAppId: APP,
      activeSessions,
      sessionId: ds.session.sessionId,
      daemonSession: ds,
      selection: {
        kind: 'autoWorktree',
        baseDir: '/repos/automatic-base',
      },
    });
    expect(ds).toMatchObject({
      pendingRepo: true,
      pendingPrompt: 'must remain owned by Runtime',
      pendingTurnId: 'om_caller_opening',
      worker: null,
    });
    expect(ds.workingDir).toBeUndefined();
  });

  it('bare text /repo submits the unpinned default directory without a local fork path', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const submit = vi.fn(async (_input: CurrentPendingRepoCompletionSubmitInput) => ({
      kind: 'applied' as const,
      action: 'pendingRepo.firstStartCommitted' as const,
      sessionId: ds.session.sessionId,
    }));
    const reply = vi.fn(async () => 'om_reply');

    await handleCommand('/repo', ROOT, {
      messageId: 'om_bare_repo',
      rootId: ROOT,
      chatId: CHAT,
      senderId: 'ou_owner',
      senderType: 'user',
      msgType: 'text',
      content: '/repo',
      createTime: '1',
    }, {
      activeSessions,
      sessionReply: reply,
      getActiveCount: () => 1,
      lastRepoScan: new Map(),
      submitPendingRepoCompletion: submit,
    }, APP);

    expect(submit).toHaveBeenCalledWith({
      ownerBotId: requireBotId(APP),
      ownerLarkAppId: APP,
      activeSessions,
      sessionId: ds.session.sessionId,
      daemonSession: ds,
      selection: {
        kind: 'directory',
        path: process.cwd(),
        pinWorkingDir: false,
      },
    });
    expect(ds).toMatchObject({
      pendingRepo: true,
      pendingPrompt: 'must remain owned by Runtime',
      pendingTurnId: 'om_caller_opening',
      worker: null,
    });
    expect(ds.workingDir).toBeUndefined();
  });
});
