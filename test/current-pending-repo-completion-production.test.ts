import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerBot } from '../src/bot-registry.js';
import {
  createCurrentPendingRepoCompletionProduction,
  type CurrentPendingRepoCompletionProductionAdapters,
} from '../src/core/current-pending-repo-completion-production.js';
import {
  createPendingWorktreePreparation,
  type PendingWorktreeCreateOptions,
  type PendingWorktreeCreateResult,
} from '../src/core/current-pending-worktree-preparation.js';
import { currentSessionRuntimeHost } from '../src/core/current-session-runtime.js';
import { stagePendingRepoSetup } from '../src/core/pending-repo-journal.js';
import * as sessionManager from '../src/core/session-manager.js';
import type {
  PendingRepoCompletionCommandOutcome,
  PendingRepoCompletionSelection,
  SessionAddress,
  SessionRuntime,
} from '../src/core/session-runtime.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as gitWorktree from '../src/services/git-worktree.js';
import * as sessionStore from '../src/services/session-store.js';
import * as worktreeSlugAI from '../src/services/worktree-slug-ai.js';
import type { CliTurnPayload } from '../src/types.js';

const APP = 'local_pending_repo_production';
const CHAT = 'oc_pending_repo_production';
const ROOT = 'om_pending_repo_production';
let bootSequence = 0;

const exactOpening: CliTurnPayload = {
  content: '<exact-opening>do not rebuild me</exact-opening>',
  codexAppInput: {
    text: 'exact visible text',
    additionalContext: {
      botmux_application_context: { kind: 'application', value: '<app-context exact="true" />' },
      botmux_message_context: { kind: 'untrusted', value: '<message-context exact="true" />' },
    },
    localImages: [{ path: '/tmp/exact.png', detail: 'original' }],
    clientUserMessageId: 'om_exact_opening',
  },
  codexAppSteerable: true,
};

function pendingSession(): DaemonSession {
  const session = sessionStore.createSession(CHAT, ROOT, 'pending production completion', 'group', 'thread');
  Object.assign(session, {
    larkAppId: APP,
    cliId: 'codex-app',
  });
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
    pendingPrompt: 'legacy fields must not rebuild the exact opening',
    pendingTurnId: 'om_exact_opening',
    pendingAttachments: [{ type: 'image', path: '/tmp/different.png', name: 'different.png' }],
  } as DaemonSession;
  stagePendingRepoSetup(ds, {
    mode: 'picker',
    turnId: 'om_exact_opening',
    cliInput: exactOpening,
  });
  return ds;
}

function makeEmptyPendingOpeningWithTail(ds: DaemonSession, turnId: string): void {
  ds.pendingPrompt = '';
  delete ds.pendingTurnId;
  delete ds.pendingCodexAppText;
  delete ds.pendingChatContext;
  delete ds.pendingAttachments;
  delete ds.pendingFollowUps;
  delete ds.session.pendingRepoSetup;
  ds.session.queuedActivationTail = [{
    id: `tail:${turnId}`,
    order: 1,
    userPrompt: `tail:${turnId}`,
    cliInput: { content: `tail:${turnId}` },
    turnId,
  }];
  ds.session.queuedActivationTailNextOrder = 1;
  sessionStore.updateSession(ds.session);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

async function settleBeforeDeadline<T>(pending: Promise<T>): Promise<T | 'deadline'> {
  return Promise.race([
    pending,
    new Promise<'deadline'>(resolve => setTimeout(() => resolve('deadline'), 100)),
  ]);
}

function initGitRepo(path: string): void {
  mkdirSync(path);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  execFileSync('git', ['init', '-b', 'master'], { cwd: path, env, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], {
    cwd: path,
    env,
    stdio: 'ignore',
  });
}

function externalAdapters(input: {
  readonly availableBots?: CurrentPendingRepoCompletionProductionAdapters['availableBots'];
  readonly createWorktree?: (
    repoPath: string,
    options: PendingWorktreeCreateOptions,
  ) => Promise<PendingWorktreeCreateResult | {
    readonly path: string;
    readonly branch: string;
    readonly baseRef: string;
  }>;
  readonly removeWorktree?: (repoPath: string, worktreePath: string) => Promise<void>;
  readonly forkWorker: (...args: Parameters<typeof workerPool.forkWorker>) => unknown;
}): CurrentPendingRepoCompletionProductionAdapters {
  return {
    availableBots: input.availableBots ?? vi.fn(async () => []),
    async prepareWorktree(preparationInput, assertCurrent) {
      const guard = <A extends readonly unknown[], R>(
        effect: (...args: A) => Promise<R>,
      ) => async (...args: A): Promise<R> => {
        assertCurrent();
        const result = await effect(...args);
        assertCurrent();
        return result;
      };
      return createPendingWorktreePreparation({
        slug: guard(async () => 'generated'),
        isGit: guard(async () => true),
        create: guard(async (repoPath, options) => {
          if (!input.createWorktree) {
            throw new Error('test did not provide a worktree create effect');
          }
          const result = await input.createWorktree(repoPath, options);
          return 'kind' in result ? result : { kind: 'created' as const, ...result };
        }),
        remove: guard(input.removeWorktree ?? (async () => undefined)),
        push: guard(async () => undefined),
      }).prepare(preparationInput);
    },
    async cleanupWorktrees(worktrees, assertCurrent) {
      for (const worktree of worktrees) {
        assertCurrent();
        try {
          await (input.removeWorktree ?? (async () => undefined))(
            worktree.sourcePath,
            worktree.path,
          );
        } catch (error) {
          return {
            kind: 'unknown' as const,
            message: error instanceof Error ? error.message : 'unknown cleanup failure',
          };
        }
        assertCurrent();
      }
      return { kind: 'cleaned' as const };
    },
    activationFor({ ownerLarkAppId, activeSessions }) {
      return {
        async ensure(request) {
          const matches = [...activeSessions.values()].filter(current => (
            current.larkAppId === ownerLarkAppId
            && current.session.sessionId === request.sessionId
          ));
          const current = matches.length === 1 ? matches[0] : undefined;
          if (!current) {
            return { kind: 'rejected', reason: 'notFound', message: 'test owner is stale' };
          }
          const accepted = input.forkWorker(
            current,
            request.promptInput,
            request.resumeOrTurnId ?? false,
          );
          if (accepted && (typeof accepted === 'object' || typeof accepted === 'function')) {
            try {
              const then = (accepted as { readonly then?: unknown }).then;
              if (typeof then === 'function') {
                void Promise.resolve(accepted).catch(() => undefined);
                return { kind: 'quarantined', message: 'test executor returned a thenable' };
              }
            } catch {
              return { kind: 'quarantined', message: 'test executor result is unreadable' };
            }
          }
          if (accepted === true) return { kind: 'active', action: 'activated' };
          if (accepted === false) {
            return { kind: 'retryable', message: 'worker refused pending-repo first start' };
          }
          return { kind: 'quarantined', message: 'test executor returned no acceptance proof' };
        },
      };
    },
  };
}

async function addressFor(
  host: ReturnType<typeof currentSessionRuntimeHost>,
  sessionId: string,
): Promise<SessionAddress> {
  const read = await host.projection.read({ kind: 'byExternalSession', sessionId });
  if (read.kind !== 'one') throw new Error(`expected one Session projection, got ${read.kind}`);
  return read.session.address;
}

function complete(
  runtime: SessionRuntime,
  address: SessionAddress,
  key: string,
  selection: PendingRepoCompletionSelection,
): Promise<PendingRepoCompletionCommandOutcome> {
  return runtime.submit({
    target: { kind: 'session', address },
    idempotencyKey: key,
    command: { kind: 'pendingRepo.complete', input: { selection } },
  });
}

let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pending-repo-production-'));
  previousDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
  sessionStore.init(APP);
  registerBot({
    larkAppId: APP,
    larkAppSecret: '',
    apiOnly: true,
    cliId: 'codex-app',
    codexAppCleanInput: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStore.init();
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Current pending-repo production composition', () => {
  it('joins card, text, and auto-worktree completion around one exact journaled opening', async () => {
    const ds = pendingSession();
    ds.pendingFollowUpInput = {
      userPrompt: 'unfolded post-start successor',
      cliInput: '<successor />',
      turnId: 'om_successor',
    };
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const gate = deferred<void>();
    const forkInputs: CliTurnPayload[] = [];
    const availableBots = vi.fn(async () => {
        throw new Error('exact journaled input must not be reverse rebuilt');
    });
    const createWorktree = vi.fn(async (repoPath: string, options: PendingWorktreeCreateOptions) => {
      await gate.promise;
      return {
        path: `${repoPath}-wt-${options.branch ?? 'generated'}`,
        branch: options.branch ?? 'wt/generated',
        baseRef: 'origin/main',
      };
    });
    const forkWorker = vi.fn((_current: DaemonSession, input: string | CliTurnPayload) => {
        forkInputs.push(structuredClone(typeof input === 'string' ? { content: input } : input));
        return true;
    });
    const adapters = externalAdapters({ availableBots, createWorktree, forkWorker });
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters,
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);
    const selection = {
      kind: 'worktree' as const,
      repositories: [{ sourcePath: '/repos/exact', childName: 'exact' }],
      branch: 'feat/exact',
      layout: { kind: 'sibling' as const },
    };

    const card = complete(host.runtime, address, 'pending-repo/exact-opening', selection);
    const text = complete(host.runtime, address, 'pending-repo/exact-opening', selection);
    const autoWorktree = complete(host.runtime, address, 'pending-repo/exact-opening', selection);
    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));
    gate.resolve();

    await expect(Promise.all([card, text, autoWorktree])).resolves.toEqual([
      expect.objectContaining({ kind: 'applied', action: 'pendingRepo.firstStartCommitted' }),
      expect.objectContaining({ kind: 'duplicate' }),
      expect.objectContaining({ kind: 'duplicate' }),
    ]);
    expect(availableBots).not.toHaveBeenCalled();
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(forkInputs).toEqual([exactOpening]);
    expect(ds.session.pendingRepoSetup?.cliInput).toEqual(exactOpening);
    expect(ds.session.pendingRepoSetup?.cliInput).not.toBe(exactOpening);
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.pendingRepoSetup?.cliInput)
      .toEqual(exactOpening);
    expect(ds.pendingRepo).toBe(false);
    expect(ds.pendingPrompt).toBeUndefined();
    expect(ds.pendingTurnId).toBeUndefined();
    expect(ds.pendingAttachments).toBeUndefined();
    expect(ds.pendingFollowUpInput).toEqual({
      userPrompt: 'unfolded post-start successor',
      cliInput: '<successor />',
      turnId: 'om_successor',
    });
  });

  it('falls back to the auto-worktree base after a proven pre-add target refusal', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const baseDir = join(dataDir, 'auto-repo');
    const occupiedTarget = join(dataDir, 'occupied-worktree-target');
    initGitRepo(baseDir);
    mkdirSync(occupiedTarget);
    vi.spyOn(worktreeSlugAI, 'worktreeSlugFromContextAI').mockResolvedValue('proven-refusal');
    const createRepoWorktree = gitWorktree.createRepoWorktree;
    const createWorktree = vi.spyOn(gitWorktree, 'createRepoWorktree')
      .mockImplementation((repoPath, options) => createRepoWorktree(repoPath, {
        ...options,
        worktreePath: occupiedTarget,
      }));
    const publish = vi.fn(async (_notice: { readonly content: string }) => undefined);
    let noticesAtFork = -1;
    const forkWorker = vi.spyOn(workerPool, 'forkWorker').mockImplementation(() => {
      noticesAtFork = publish.mock.calls.length;
      return true;
    });
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      notices: { publish },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(complete(host.runtime, address, 'pending-repo/pre-add-refusal', {
      kind: 'autoWorktree',
      baseDir,
    })).resolves.toMatchObject({
      kind: 'applied',
      action: 'pendingRepo.firstStartCommitted',
    });

    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds).toMatchObject({
      pendingRepo: false,
      pendingRepoCommitInFlight: false,
      workingDir: baseDir,
      session: { workingDir: baseDir },
    });
    expect(noticesAtFork).toBe(0);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0]?.[0].content).toContain(baseDir);
    expect(publish.mock.calls[0]?.[0].content).toContain('worktree target already exists');
  });

  it('keeps the production auto-worktree claim sticky and reports uncertainty after an untyped add-stage response loss', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    vi.spyOn(gitWorktree, 'isGitWorkTree').mockResolvedValue(true);
    vi.spyOn(worktreeSlugAI, 'worktreeSlugFromContextAI').mockResolvedValue('recorded');
    const createWorktree = vi.spyOn(gitWorktree, 'createRepoWorktree')
      .mockRejectedValue(new Error('response lost after git worktree add'));
    const forkWorker = vi.spyOn(workerPool, 'forkWorker').mockReturnValue(true);
    const publish = vi.fn(async (_notice: { readonly content: string }) => undefined);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      notices: { publish },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);
    const selection = {
      kind: 'autoWorktree' as const,
      baseDir: '/repos/recorded',
    };

    await expect(complete(
      host.runtime,
      address,
      'pending-repo/worktree-create-response-loss',
      selection,
    )).resolves.toMatchObject({
      kind: 'ambiguous',
      message: expect.stringContaining('response lost after git worktree add'),
    });
    expect(createWorktree).toHaveBeenCalledWith('/repos/recorded', { slug: 'recorded' });
    expect(forkWorker).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0]?.[0].content).toContain(
      'response lost after git worktree add',
    );
    expect(publish.mock.calls[0]?.[0].content).toMatch(/uncertain|unknown|不确定/i);
    expect(publish.mock.calls[0]?.[0].content)
      .not.toMatch(/worktree creation failed|创建 worktree 失败|auto-created|自动创建/i);
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingRepoCommitInFlight).toBe(true);

    await expect(complete(
      host.runtime,
      address,
      'pending-repo/worktree-create-response-loss',
      selection,
    )).resolves.toMatchObject({ kind: 'ambiguous' });
    expect(createWorktree).toHaveBeenCalledTimes(1);
  });

  it('reports one uncertainty notice for a manual worktree materialization response loss', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const forkWorker = vi.fn(() => true);
    const publish = vi.fn(async (_notice: { readonly content: string }) => undefined);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        createWorktree: vi.fn(async () => {
          throw new Error('manual git add response was lost');
        }),
        forkWorker,
      }),
      notices: { publish },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(complete(host.runtime, address, 'pending-repo/manual-create-loss-notice', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      layout: { kind: 'sibling' },
    })).resolves.toMatchObject({
      kind: 'ambiguous',
      message: expect.stringContaining('manual git add response was lost'),
    });

    expect(forkWorker).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0]?.[0].content).toContain('manual git add response was lost');
    expect(publish.mock.calls[0]?.[0].content).toMatch(/uncertain|unknown|不确定/i);
    expect(publish.mock.calls[0]?.[0].content)
      .not.toMatch(/worktree creation failed|创建 worktree 失败/i);
  });

  it('keeps the candidate mirror sticky when SessionStore publishes and then throws', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const forkWorker = vi.fn(() => true);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        availableBots: vi.fn(async () => []),
        forkWorker,
      }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);
    const publish = sessionStore.updateSession;
    vi.spyOn(sessionStore, 'updateSession').mockImplementationOnce(session => {
      publish(session);
      throw new Error('response lost after atomic publish');
    });

    await expect(complete(host.runtime, address, 'pending-repo/publish-loss', {
      kind: 'directory',
      path: '/repos/published-candidate',
      pinWorkingDir: true,
    })).resolves.toMatchObject({
      kind: 'ambiguous',
      message: expect.stringContaining('response lost after atomic publish'),
    });

    expect(forkWorker).not.toHaveBeenCalled();
    expect(ds).toMatchObject({
      pendingRepo: true,
      pendingRepoCommitInFlight: true,
      workingDir: '/repos/published-candidate',
      session: { workingDir: '/repos/published-candidate' },
    });
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.workingDir)
      .toBe('/repos/published-candidate');
  });

  it('restores and persists an unpinned directory after the real fork contract fills it in', async () => {
    const ds = pendingSession();
    expect(ds.workingDir).toBeUndefined();
    expect(ds.session.workingDir).toBeUndefined();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const forkWorker = vi.fn((current: DaemonSession) => {
      // Mirrors worker-pool's real first-start side effect: it materializes the
      // launch cwd in memory and fills a missing durable workingDir.
      current.workingDir = '/repos/default-unpinned';
      current.session.workingDir = '/repos/default-unpinned';
      sessionStore.updateSession(current.session);
      return true;
    });
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({ forkWorker }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(complete(host.runtime, address, 'pending-repo/unpinned-real-fork', {
      kind: 'directory',
      path: '/repos/default-unpinned',
      pinWorkingDir: false,
    })).resolves.toMatchObject({ kind: 'applied' });

    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.workingDir).toBeUndefined();
    expect(ds.session.workingDir).toBeUndefined();
    expect(sessionStore.getSessionFresh(ds.session.sessionId)?.workingDir).toBeUndefined();
  });

  it('publishes a created-worktree notice only after synchronous worker acceptance', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const publish = vi.fn(async (_notice: { readonly content: string }) => undefined);
    let noticesAtFork = -1;
    const forkWorker = vi.fn(() => {
      noticesAtFork = publish.mock.calls.length;
      return true;
    });
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        createWorktree: vi.fn(async () => ({
          path: '/repos/manual-created-after-acceptance',
          branch: 'feat/manual-created-after-acceptance',
          baseRef: 'origin/main',
        })),
        forkWorker,
      }),
      notices: { publish },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(complete(host.runtime, address, 'pending-repo/created-notice-after-acceptance', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      branch: 'feat/manual-created-after-acceptance',
      layout: { kind: 'sibling' },
    })).resolves.toMatchObject({
      kind: 'applied',
      action: 'pendingRepo.firstStartCommitted',
    });

    expect(noticesAtFork).toBe(0);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0]?.[0].content)
      .toContain('/repos/manual-created-after-acceptance');
  });

  it.each([
    {
      name: 'applied creation',
      createResult: {
        path: '/repos/notice-wt',
        branch: 'feat/notice-hang',
        baseRef: 'origin/main',
      },
      expected: { kind: 'applied', action: 'pendingRepo.firstStartCommitted' },
      forkCalls: 1,
    },
    {
      name: 'retryable typed refusal',
      createResult: {
        kind: 'refused' as const,
        message: 'typed create refusal while notice hangs',
      },
      expected: {
        kind: 'retryable',
        message: expect.stringContaining('typed create refusal while notice hangs'),
      },
      forkCalls: 0,
    },
  ])('does not let a never-settling notice block $name', async ({
    createResult,
    expected,
    forkCalls,
  }) => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const forkWorker = vi.fn(() => true);
    const publish = vi.fn(() => new Promise<void>(() => undefined));
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        createWorktree: vi.fn(async () => createResult),
        forkWorker,
      }),
      notices: { publish },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);

    const outcome = await settleBeforeDeadline(complete(
      host.runtime,
      address,
      `pending-repo/notice-hang/${forkCalls}`,
      {
        kind: 'worktree',
        repositories: [{ sourcePath: '/repos/notice-source', childName: 'notice-source' }],
        branch: 'feat/notice-hang',
        layout: { kind: 'sibling' },
      },
    ));

    expect(outcome).not.toBe('deadline');
    expect(outcome).toMatchObject(expected);
    expect(publish).toHaveBeenCalled();
    expect(forkWorker).toHaveBeenCalledTimes(forkCalls);
  });

  it('cleans every prepared worktree outside the lane before a typed fork refusal becomes retryable', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const cleanupGate = deferred<void>();
    const createWorktree = vi.fn()
      .mockResolvedValueOnce({
        path: '/repos/feat-fork-refusal-cleanup/alpha',
        branch: 'feat/fork-refusal-cleanup',
        baseRef: 'origin/main',
      })
      .mockResolvedValueOnce({
        path: '/repos/feat-fork-refusal-cleanup/beta',
        branch: 'feat/fork-refusal-cleanup',
        baseRef: 'origin/main',
      });
    const removeWorktree = vi.fn(async () => cleanupGate.promise);
    const forkWorker = vi.fn(() => false);
    const publish = vi.fn(async (_notice: { readonly content: string }) => undefined);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({ createWorktree, removeWorktree, forkWorker }),
      notices: { publish },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);

    let settled = false;
    const completion = complete(host.runtime, address, 'pending-repo/fork-refusal-cleanup', {
      kind: 'worktree',
      repositories: [
        { sourcePath: '/repos/alpha', childName: 'alpha' },
        { sourcePath: '/repos/beta', childName: 'beta' },
      ],
      branch: 'feat/fork-refusal-cleanup',
      layout: { kind: 'group', parentRoot: '/repos' },
    }).finally(() => { settled = true; });

    await vi.waitFor(() => expect(removeWorktree).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(ds.pendingRepoCommitInFlight).toBe(true);
    expect(publish).not.toHaveBeenCalled();

    cleanupGate.resolve();
    await expect(completion).resolves.toMatchObject({
      kind: 'retryable',
      message: expect.stringContaining('worker refused'),
    });
    expect(removeWorktree.mock.calls).toEqual([
      ['/repos/alpha', '/repos/feat-fork-refusal-cleanup/alpha'],
      ['/repos/beta', '/repos/feat-fork-refusal-cleanup/beta'],
    ]);
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingRepoCommitInFlight).toBe(false);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0]?.[0].content).toMatch(/rolled back|已回滚/i);
    expect(publish.mock.calls[0]?.[0].content)
      .not.toMatch(/worktree created:|worktree 已创建|已为本会话自动创建/i);
  });

  it('keeps a typed fork refusal sticky when prepared-worktree cleanup is uncertain', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const removeWorktree = vi.fn(async () => {
      throw new Error('cleanup response lost');
    });
    const forkWorker = vi.fn(() => false);
    const publish = vi.fn(async (_notice: { readonly content: string }) => undefined);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        createWorktree: vi.fn(async () => ({
          path: '/repos/source-fork-refusal',
          branch: 'feat/fork-refusal',
          baseRef: 'origin/main',
        })),
        removeWorktree,
        forkWorker,
      }),
      notices: { publish },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(complete(host.runtime, address, 'pending-repo/fork-refusal-cleanup-loss', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      branch: 'feat/fork-refusal',
      layout: { kind: 'sibling' },
    })).resolves.toMatchObject({
      kind: 'ambiguous',
      message: expect.stringContaining('cleanup response lost'),
    });

    expect(removeWorktree).toHaveBeenCalledWith(
      '/repos/source',
      '/repos/source-fork-refusal',
    );
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingRepoCommitInFlight).toBe(true);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0]?.[0].content).toContain('cleanup response lost');
    expect(publish.mock.calls[0]?.[0].content)
      .not.toMatch(/worktree created:|worktree 已创建|已为本会话自动创建/i);
  });

  it('rolls back prepared worktrees when durable-tail recovery is proven refused before fork', async () => {
    const ds = pendingSession();
    makeEmptyPendingOpeningWithTail(ds, 'om_tail_recovery_refused');
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const removeWorktree = vi.fn(async () => undefined);
    const forkWorker = vi.fn(() => true);
    const recoverTail = vi.spyOn(workerPool, 'prepareQueuedActivationRecoveryFork')
      .mockReturnValue({
        kind: 'refused',
        message: 'tail recovery candidate was proven not published',
      });
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        createWorktree: vi.fn(async () => ({
          path: '/repos/source-tail-recovery-refused',
          branch: 'feat/tail-recovery-refused',
          baseRef: 'origin/main',
        })),
        removeWorktree,
        forkWorker,
      }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(complete(host.runtime, address, 'pending-repo/tail-recovery-refused', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      branch: 'feat/tail-recovery-refused',
      layout: { kind: 'sibling' },
    })).resolves.toMatchObject({
      kind: 'retryable',
      message: expect.stringContaining('proven not published'),
    });

    expect(recoverTail).toHaveBeenCalledTimes(1);
    expect(forkWorker).not.toHaveBeenCalled();
    expect(removeWorktree).toHaveBeenCalledWith(
      '/repos/source',
      '/repos/source-tail-recovery-refused',
    );
    expect(ds.pendingRepoCommitInFlight).toBe(false);
  });

  it('keeps prepared worktrees sticky when durable-tail recovery outcome is unknown', async () => {
    const ds = pendingSession();
    makeEmptyPendingOpeningWithTail(ds, 'om_tail_recovery_unknown');
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const removeWorktree = vi.fn(async () => undefined);
    const forkWorker = vi.fn(() => true);
    const recoverTail = vi.spyOn(workerPool, 'prepareQueuedActivationRecoveryFork')
      .mockReturnValue({
        kind: 'unknown',
        message: 'tail recovery publication outcome is unknown',
      });
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        createWorktree: vi.fn(async () => ({
          path: '/repos/source-tail-recovery-unknown',
          branch: 'feat/tail-recovery-unknown',
          baseRef: 'origin/main',
        })),
        removeWorktree,
        forkWorker,
      }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(complete(host.runtime, address, 'pending-repo/tail-recovery-unknown', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      branch: 'feat/tail-recovery-unknown',
      layout: { kind: 'sibling' },
    })).resolves.toMatchObject({
      kind: 'ambiguous',
      message: expect.stringContaining('publication outcome is unknown'),
    });

    expect(recoverTail).toHaveBeenCalledTimes(1);
    expect(forkWorker).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(ds.pendingRepoCommitInFlight).toBe(true);
  });

  it('never removes prepared worktrees when the worker response is unknown', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const removeWorktree = vi.fn(async () => undefined);
    const forkWorker = vi.fn(() => {
      throw new Error('fork response lost after possible acceptance');
    });
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        createWorktree: vi.fn(async () => ({
          path: '/repos/source-unknown-worker',
          branch: 'feat/unknown-worker',
          baseRef: 'origin/main',
        })),
        removeWorktree,
        forkWorker,
      }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(complete(host.runtime, address, 'pending-repo/unknown-worker-no-cleanup', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      branch: 'feat/unknown-worker',
      layout: { kind: 'sibling' },
    })).resolves.toMatchObject({
      kind: 'ambiguous',
      message: expect.stringContaining('fork response lost'),
    });
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(ds.pendingRepoCommitInFlight).toBe(true);
  });

  it('dispatches an exact-identity uncertainty notice when a fork installs a worker then loses its response', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const publish = vi.fn(async () => undefined);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        createWorktree: vi.fn(async () => ({
          path: '/repos/source-switch-unknown',
          branch: 'feat/switch-unknown',
          baseRef: 'origin/main',
        })),
        forkWorker: vi.fn(() => {
          ds.worker = { killed: false } as DaemonSession['worker'];
          throw new Error('fork acceptance response lost');
        }),
      }),
      notices: { publish },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(complete(host.runtime, address, 'pending-repo/switch-unknown-notice', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      branch: 'feat/switch-unknown',
      layout: { kind: 'sibling' },
    })).resolves.toMatchObject({ kind: 'ambiguous' });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    const content = publish.mock.calls.map(([notice]) => notice.content).join();
    expect(content).toContain('fork acceptance response lost');
    expect(content).toMatch(/uncertain|unknown|不确定/i);
    expect(content).not.toContain(`/repo /repos/source-switch-unknown`);
  });

  it('removes a created worktree when the same DaemonSession is taken over before create returns', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const createGate = deferred<void>();
    vi.spyOn(worktreeSlugAI, 'worktreeSlugFromContextAI').mockResolvedValue('takeover');
    const createWorktree = vi.spyOn(gitWorktree, 'createRepoWorktree')
      .mockImplementation(async () => {
        await createGate.promise;
        return {
          path: '/repos/source-takeover',
          branch: 'wt/takeover',
          baseRef: 'origin/main',
        };
      });
    const removeWorktree = vi.spyOn(gitWorktree, 'removeRepoWorktree')
      .mockResolvedValue(undefined);
    const forkWorker = vi.spyOn(workerPool, 'forkWorker').mockReturnValue(true);
    const publish = vi.fn(async () => undefined);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      notices: { publish },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);
    const completion = complete(host.runtime, address, 'pending-repo/create-takeover-cleanup', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      layout: { kind: 'sibling' },
    });
    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));

    ds.pendingRepo = false;
    ds.worker = { killed: false } as DaemonSession['worker'];
    createGate.resolve();

    await expect(completion).resolves.toMatchObject({ kind: 'staleAddress' });
    expect(removeWorktree.mock.calls).toEqual([
      ['/repos/source', '/repos/source-takeover'],
    ]);
    expect(forkWorker).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('cleans a created worktree when a scope change aliases the same active-Session key', async () => {
    const ds = pendingSession();
    ds.chatId = ROOT;
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const createGate = deferred<void>();
    vi.spyOn(worktreeSlugAI, 'worktreeSlugFromContextAI').mockResolvedValue('route-alias');
    const createWorktree = vi.spyOn(gitWorktree, 'createRepoWorktree')
      .mockImplementation(async () => {
        await createGate.promise;
        return {
          path: '/repos/source-route-alias',
          branch: 'wt/route-alias',
          baseRef: 'origin/main',
        };
      });
    const removeWorktree = vi.spyOn(gitWorktree, 'removeRepoWorktree')
      .mockResolvedValue(undefined);
    const forkWorker = vi.spyOn(workerPool, 'forkWorker').mockReturnValue(true);
    const publish = vi.fn(async () => undefined);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      notices: { publish },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);
    const completion = complete(host.runtime, address, 'pending-repo/route-alias-cleanup', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      layout: { kind: 'sibling' },
    });
    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));

    expect(activeSessionKey(ds)).toBe(activeSessions.keys().next().value);
    ds.scope = 'chat';
    expect(activeSessionKey(ds)).toBe(activeSessions.keys().next().value);
    createGate.resolve();

    await expect(completion).resolves.toMatchObject({ kind: 'ambiguous' });
    expect(removeWorktree.mock.calls).toEqual([
      ['/repos/source', '/repos/source-route-alias'],
    ]);
    expect(forkWorker).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('cleans a created worktree when only the bound chat type changes', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const createGate = deferred<void>();
    vi.spyOn(worktreeSlugAI, 'worktreeSlugFromContextAI').mockResolvedValue('chat-type');
    const createWorktree = vi.spyOn(gitWorktree, 'createRepoWorktree')
      .mockImplementation(async () => {
        await createGate.promise;
        return {
          path: '/repos/source-chat-type',
          branch: 'wt/chat-type',
          baseRef: 'origin/main',
        };
      });
    const removeWorktree = vi.spyOn(gitWorktree, 'removeRepoWorktree')
      .mockResolvedValue(undefined);
    const forkWorker = vi.spyOn(workerPool, 'forkWorker').mockReturnValue(true);
    const publish = vi.fn(async () => undefined);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      notices: { publish },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);
    const completion = complete(host.runtime, address, 'pending-repo/chat-type-cleanup', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      layout: { kind: 'sibling' },
    });
    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));

    ds.chatType = 'p2p';
    createGate.resolve();

    await expect(completion).resolves.toMatchObject({ kind: 'ambiguous' });
    expect(removeWorktree.mock.calls).toEqual([
      ['/repos/source', '/repos/source-chat-type'],
    ]);
    expect(forkWorker).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not erase owner-loss cleanup uncertainty after a created result', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const createGate = deferred<void>();
    vi.spyOn(worktreeSlugAI, 'worktreeSlugFromContextAI').mockResolvedValue('cleanup-loss');
    const createWorktree = vi.spyOn(gitWorktree, 'createRepoWorktree')
      .mockImplementation(async () => {
        await createGate.promise;
        return {
          path: '/repos/source-cleanup-loss',
          branch: 'wt/cleanup-loss',
          baseRef: 'origin/main',
        };
      });
    const removeWorktree = vi.spyOn(gitWorktree, 'removeRepoWorktree')
      .mockRejectedValue(new Error('owner-loss cleanup response lost'));
    const forkWorker = vi.spyOn(workerPool, 'forkWorker').mockReturnValue(true);
    const publish = vi.fn(async () => undefined);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      notices: { publish },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);
    const completion = complete(host.runtime, address, 'pending-repo/owner-loss-cleanup-unknown', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      layout: { kind: 'sibling' },
    });
    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));

    ds.pendingRepo = false;
    ds.worker = { killed: false } as DaemonSession['worker'];
    createGate.resolve();

    await expect(completion).resolves.toMatchObject({
      kind: 'ambiguous',
      message: expect.stringContaining('owner-loss cleanup response lost'),
    });
    expect(removeWorktree.mock.calls).toEqual([
      ['/repos/source', '/repos/source-cleanup-loss'],
    ]);
    expect(forkWorker).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('cleans the exact production plan after ownership is lost between materialize and resume', async () => {
    registerBot({
      larkAppId: APP,
      larkAppSecret: '',
      apiOnly: true,
      cliId: 'riff',
      backendType: 'riff',
      codexAppCleanInput: true,
    });
    const ds = pendingSession();
    ds.session.cliId = 'riff';
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    vi.spyOn(worktreeSlugAI, 'worktreeSlugFromContextAI').mockResolvedValue('resume-gap');
    vi.spyOn(gitWorktree, 'createRepoWorktree').mockResolvedValue({
      path: '/repos/source-resume-gap',
      branch: 'wt/resume-gap',
      baseRef: 'origin/main',
    });
    const removeWorktree = vi.spyOn(gitWorktree, 'removeRepoWorktree')
      .mockResolvedValue(undefined);
    vi.spyOn(gitWorktree, 'pushWorktreeBranch')
      .mockRejectedValue(new Error('Riff warning schedules the resume-gap takeover'));
    const forkWorker = vi.spyOn(workerPool, 'forkWorker').mockReturnValue(true);
    let takeoverQueued = false;
    const publish = vi.fn(async () => {
      if (takeoverQueued) return;
      takeoverQueued = true;
      queueMicrotask(() => {
        queueMicrotask(() => {
          ds.pendingRepo = false;
          ds.worker = { killed: false } as DaemonSession['worker'];
        });
      });
    });
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      notices: { publish },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(complete(host.runtime, address, 'pending-repo/production-resume-gap', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      layout: { kind: 'sibling' },
    })).resolves.toMatchObject({ kind: 'staleAddress' });
    expect(removeWorktree.mock.calls).toEqual([
      ['/repos/source', '/repos/source-resume-gap'],
    ]);
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('keeps owner-independent production cleanup response loss ambiguous', async () => {
    registerBot({
      larkAppId: APP,
      larkAppSecret: '',
      apiOnly: true,
      cliId: 'riff',
      backendType: 'riff',
      codexAppCleanInput: true,
    });
    const ds = pendingSession();
    ds.session.cliId = 'riff';
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    vi.spyOn(worktreeSlugAI, 'worktreeSlugFromContextAI').mockResolvedValue('resume-loss');
    vi.spyOn(gitWorktree, 'createRepoWorktree').mockResolvedValue({
      path: '/repos/source-resume-loss',
      branch: 'wt/resume-loss',
      baseRef: 'origin/main',
    });
    const removeWorktree = vi.spyOn(gitWorktree, 'removeRepoWorktree')
      .mockRejectedValue(new Error('cleanup response lost after partial removal'));
    vi.spyOn(gitWorktree, 'pushWorktreeBranch')
      .mockRejectedValue(new Error('Riff warning schedules the cleanup-loss takeover'));
    const forkWorker = vi.spyOn(workerPool, 'forkWorker').mockReturnValue(true);
    let takeoverQueued = false;
    const publish = vi.fn(async () => {
      if (takeoverQueued) return;
      takeoverQueued = true;
      queueMicrotask(() => {
        queueMicrotask(() => {
          ds.pendingRepo = false;
          ds.worker = { killed: false } as DaemonSession['worker'];
        });
      });
    });
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      notices: { publish },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(complete(host.runtime, address, 'pending-repo/production-resume-cleanup-loss', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      layout: { kind: 'sibling' },
    })).resolves.toMatchObject({
      kind: 'ambiguous',
      message: expect.stringContaining('cleanup response lost after partial removal'),
    });
    expect(removeWorktree.mock.calls).toEqual([
      ['/repos/source', '/repos/source-resume-loss'],
    ]);
    expect(forkWorker).not.toHaveBeenCalled();
    expect(ds.pendingRepoCommitInFlight).toBe(true);
  });

  it('retains an old exact cleanup plan when a same-id replacement materializes first', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const removeWorktree = vi.fn(async () => undefined);
    const forkWorker = vi.fn(() => true);
    const createWorktree = vi.fn(async (
      _sourcePath: string,
      options: PendingWorktreeCreateOptions,
    ) => ({
      path: options.branch === 'feat/old-plan'
        ? '/repos/source-old-plan'
        : '/repos/source-new-plan',
      branch: options.branch!,
      baseRef: 'origin/main',
    }));
    const completionPort = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({ createWorktree, removeWorktree, forkWorker }),
      notices: { publish: vi.fn(async () => undefined) },
    });
    const oldBegin = completionPort.begin({
      sessionId: ds.session.sessionId,
      selection: {
        kind: 'worktree',
        repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
        branch: 'feat/old-plan',
        layout: { kind: 'sibling' },
      },
    });
    if (oldBegin.kind !== 'effect') throw new Error(`expected old effect, got ${oldBegin.kind}`);
    const oldMaterialized = await completionPort.execute(oldBegin.intent);

    const replacement = pendingSession();
    replacement.session.sessionId = ds.session.sessionId;
    ds.session.status = 'closed';
    activeSessions.set(activeSessionKey(ds), replacement);
    const oldCleanup = completionPort.resume(oldBegin.continuation, {
      kind: 'returned',
      value: oldMaterialized,
    });
    if (oldCleanup.kind !== 'effect') {
      throw new Error(`expected old cleanup effect, got ${oldCleanup.kind}`);
    }

    const replacementBegin = completionPort.begin({
      sessionId: replacement.session.sessionId,
      selection: {
        kind: 'worktree',
        repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
        branch: 'feat/new-plan',
        layout: { kind: 'sibling' },
      },
    });
    if (replacementBegin.kind !== 'effect') {
      throw new Error(`expected replacement effect, got ${replacementBegin.kind}`);
    }
    const replacementMaterialized = await completionPort.execute(replacementBegin.intent);

    const oldCleaned = await completionPort.execute(oldCleanup.intent);
    expect(completionPort.resume(oldCleanup.continuation, {
      kind: 'returned',
      value: oldCleaned,
    })).toEqual({ kind: 'staleAddress' });
    expect(removeWorktree.mock.calls).toEqual([
      ['/repos/source', '/repos/source-old-plan'],
    ]);
    const replacementDispatch = completionPort.resume(replacementBegin.continuation, {
      kind: 'returned',
      value: replacementMaterialized,
    });
    if (replacementDispatch.kind !== 'effect') {
      throw new Error(`expected replacement dispatch effect, got ${replacementDispatch.kind}`);
    }
    const replacementDispatched = await completionPort.execute(replacementDispatch.intent);
    expect(completionPort.resume(replacementDispatch.continuation, {
      kind: 'returned',
      value: replacementDispatched,
    })).toEqual({ kind: 'committed' });
    expect(forkWorker).toHaveBeenCalledTimes(1);
  });

  it('does not delete a same-id replacement plan when an old cleanup finishes later', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const cleanupGate = deferred<void>();
    const cleanupStarted = deferred<void>();
    const removeWorktree = vi.fn(async () => {
      cleanupStarted.resolve();
      await cleanupGate.promise;
    });
    const forkWorker = vi.fn(() => true);
    const createWorktree = vi.fn(async (
      _sourcePath: string,
      options: PendingWorktreeCreateOptions,
    ) => ({
      path: options.branch === 'feat/old-late-cleanup'
        ? '/repos/source-old-late-cleanup'
        : '/repos/source-new-during-cleanup',
      branch: options.branch!,
      baseRef: 'origin/main',
    }));
    const completionPort = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({ createWorktree, removeWorktree, forkWorker }),
      notices: { publish: vi.fn(async () => undefined) },
    });
    const oldBegin = completionPort.begin({
      sessionId: ds.session.sessionId,
      selection: {
        kind: 'worktree',
        repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
        branch: 'feat/old-late-cleanup',
        layout: { kind: 'sibling' },
      },
    });
    if (oldBegin.kind !== 'effect') throw new Error(`expected old effect, got ${oldBegin.kind}`);
    const oldMaterialized = await completionPort.execute(oldBegin.intent);

    const replacement = pendingSession();
    replacement.session.sessionId = ds.session.sessionId;
    ds.session.status = 'closed';
    activeSessions.set(activeSessionKey(ds), replacement);
    const oldCleanup = completionPort.resume(oldBegin.continuation, {
      kind: 'returned',
      value: oldMaterialized,
    });
    if (oldCleanup.kind !== 'effect') {
      throw new Error(`expected old cleanup effect, got ${oldCleanup.kind}`);
    }
    const oldCleanupResult = completionPort.execute(oldCleanup.intent);
    await cleanupStarted.promise;

    const replacementBegin = completionPort.begin({
      sessionId: replacement.session.sessionId,
      selection: {
        kind: 'worktree',
        repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
        branch: 'feat/new-during-cleanup',
        layout: { kind: 'sibling' },
      },
    });
    if (replacementBegin.kind !== 'effect') {
      throw new Error(`expected replacement effect, got ${replacementBegin.kind}`);
    }
    const replacementMaterialized = await completionPort.execute(replacementBegin.intent);
    cleanupGate.resolve();
    const oldCleaned = await oldCleanupResult;

    expect(completionPort.resume(oldCleanup.continuation, {
      kind: 'returned',
      value: oldCleaned,
    })).toEqual({ kind: 'staleAddress' });
    const replacementDispatch = completionPort.resume(replacementBegin.continuation, {
      kind: 'returned',
      value: replacementMaterialized,
    });
    if (replacementDispatch.kind !== 'effect') {
      throw new Error(`expected replacement dispatch effect, got ${replacementDispatch.kind}`);
    }
    const replacementDispatched = await completionPort.execute(replacementDispatch.intent);
    expect(completionPort.resume(replacementDispatch.continuation, {
      kind: 'returned',
      value: replacementDispatched,
    })).toEqual({ kind: 'committed' });
    expect(removeWorktree.mock.calls).toEqual([
      ['/repos/source', '/repos/source-old-late-cleanup'],
    ]);
    expect(forkWorker).toHaveBeenCalledTimes(1);
  });

  it('cleans a known created worktree when ownership is lost during the Riff push', async () => {
    registerBot({
      larkAppId: APP,
      larkAppSecret: '',
      apiOnly: true,
      cliId: 'riff',
      backendType: 'riff',
      codexAppCleanInput: true,
    });
    const ds = pendingSession();
    ds.session.cliId = 'riff';
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const pushGate = deferred<void>();
    vi.spyOn(gitWorktree, 'createRepoWorktree').mockResolvedValue({
      path: '/repos/source-feat-push-loss',
      branch: 'feat/push-loss',
      baseRef: 'origin/main',
    });
    const pushWorktree = vi.spyOn(gitWorktree, 'pushWorktreeBranch')
      .mockImplementation(async () => pushGate.promise);
    const removeWorktree = vi.spyOn(gitWorktree, 'removeRepoWorktree')
      .mockResolvedValue(undefined);
    const forkWorker = vi.spyOn(workerPool, 'forkWorker').mockReturnValue(true);
    const publish = vi.fn(async () => undefined);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      notices: { publish },
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);
    const completion = complete(host.runtime, address, 'pending-repo/push-owner-loss', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      branch: 'feat/push-loss',
      layout: { kind: 'sibling' },
    });
    await vi.waitFor(() => expect(pushWorktree).toHaveBeenCalledTimes(1));

    ds.pendingRepo = false;
    ds.worker = { killed: false } as DaemonSession['worker'];
    pushGate.resolve();

    await expect(completion).resolves.toMatchObject({ kind: 'staleAddress' });
    expect(removeWorktree.mock.calls).toEqual([
      ['/repos/source', '/repos/source-feat-push-loss'],
    ]);
    expect(forkWorker).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('releases the Session lane across worktree and roster awaits, then fences a late replacement', async () => {
    const ds = pendingSession();
    delete ds.session.pendingRepoSetup?.cliInput;
    sessionStore.updateSession(ds.session);
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const worktreeGate = deferred<void>();
    const rosterGate = deferred<void>();
    const createWorktree = vi.fn(async (_repoPath: string, options: PendingWorktreeCreateOptions) => {
      await worktreeGate.promise;
      return {
        path: options.worktreePath!,
        branch: options.branch!,
        baseRef: 'origin/main',
      };
    });
    const availableBots = vi.fn(async () => {
      await rosterGate.promise;
      return [{ name: 'peer', displayName: 'Peer Bot', openId: 'ou_peer' }];
    });
    const removeWorktree = vi.fn(async () => undefined);
    const forkWorker = vi.fn(() => true);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        availableBots,
        createWorktree,
        removeWorktree,
        forkWorker,
      }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);
    const completion = complete(host.runtime, address, 'pending-repo/late-replacement', {
      kind: 'worktree',
      repositories: [
        { sourcePath: '/repos/alpha', childName: 'alpha' },
        { sourcePath: '/repos/beta', childName: 'beta' },
      ],
      branch: 'feat/roster-owner-loss',
      layout: { kind: 'group', parentRoot: '/repos' },
    });
    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));

    await expect(host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'pending-repo/rename-during-worktree',
      command: {
        kind: 'control.rename',
        input: {
          title: 'lane stayed available',
          updatedAt: '2026-08-10T00:00:00.000Z',
          source: 'user',
        },
      },
    })).resolves.toMatchObject({ kind: 'applied', action: 'control.renamed' });

    worktreeGate.resolve();
    await vi.waitFor(() => expect(availableBots).toHaveBeenCalledTimes(1));
    await expect(host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'pending-repo/rename-during-roster',
      command: {
        kind: 'control.rename',
        input: {
          title: 'lane stayed available through roster',
          updatedAt: '2026-08-10T00:00:01.000Z',
          source: 'user',
        },
      },
    })).resolves.toMatchObject({ kind: 'applied', action: 'control.renamed' });

    const replacement = pendingSession();
    replacement.session.sessionId = 'replacement-session';
    replacement.session.title = 'replacement must survive';
    replacement.pendingRepo = false;
    replacement.pendingRepoCommitInFlight = true;
    replacement.workingDir = '/repos/replacement';
    replacement.session.workingDir = '/repos/replacement';
    replacement.worker = { killed: false } as DaemonSession['worker'];
    ds.session.status = 'closed';
    activeSessions.set(activeSessionKey(ds), replacement);
    rosterGate.resolve();

    await expect(completion).resolves.toMatchObject({ kind: 'staleAddress' });
    expect(removeWorktree.mock.calls).toEqual([
      ['/repos/alpha', '/repos/feat-roster-owner-loss/alpha'],
      ['/repos/beta', '/repos/feat-roster-owner-loss/beta'],
    ]);
    expect(forkWorker).not.toHaveBeenCalled();
    expect(replacement).toMatchObject({
      pendingRepo: false,
      pendingRepoCommitInFlight: true,
      workingDir: '/repos/replacement',
      session: {
        sessionId: 'replacement-session',
        title: 'replacement must survive',
        workingDir: '/repos/replacement',
      },
    });
    expect(replacement.worker?.killed).toBe(false);
  });

  it('fences a newer exact completion claim before rebuilding the opening after roster lookup', async () => {
    const ds = pendingSession();
    delete ds.session.pendingRepoSetup?.cliInput;
    sessionStore.updateSession(ds.session);
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const rosterGate = deferred<void>();
    const availableBots = vi.fn(async () => {
      await rosterGate.promise;
      return [];
    });
    const buildNewTopicCliInput = vi.spyOn(sessionManager, 'buildNewTopicCliInput');
    const forkWorker = vi.fn(() => true);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({ availableBots, forkWorker }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);
    const completion = complete(host.runtime, address, 'pending-repo/exact-claim-aba', {
      kind: 'directory',
      path: '/repos/source',
      pinWorkingDir: true,
    });
    await vi.waitFor(() => expect(availableBots).toHaveBeenCalledTimes(1));
    expect(ds.pendingRepoCommitClaimToken).toEqual(expect.any(String));

    ds.pendingRepoCommitInFlight = false;
    ds.pendingRepoCommitClaimToken = undefined;
    const newerClaim = 'newer-production-completion-claim';
    ds.pendingRepoCommitInFlight = true;
    ds.pendingRepoCommitClaimToken = newerClaim;
    rosterGate.resolve();

    await expect(completion).resolves.toMatchObject({ kind: 'staleAddress' });
    expect(buildNewTopicCliInput).not.toHaveBeenCalled();
    expect(forkWorker).not.toHaveBeenCalled();
    expect(ds.pendingRepoCommitInFlight).toBe(true);
    expect(ds.pendingRepoCommitClaimToken).toBe(newerClaim);
  });

  it('fences a late result from a replacement Session installed in the same DaemonSession shell', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const worktreeGate = deferred<void>();
    const forkWorker = vi.fn(() => true);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        availableBots: vi.fn(async () => []),
        createWorktree: vi.fn(async () => {
          await worktreeGate.promise;
          return { path: '/repos/old-result', branch: 'wt/old', baseRef: 'origin/main' };
        }),
        forkWorker,
      }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);
    const completion = complete(host.runtime, address, 'pending-repo/same-shell-replacement', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      layout: { kind: 'sibling' },
    });
    await vi.waitFor(() => expect(ds.pendingRepoCommitInFlight).toBe(true));

    const replacementSession = structuredClone(ds.session);
    replacementSession.sessionId = 'same-shell-replacement-session';
    replacementSession.title = 'same shell replacement';
    replacementSession.workingDir = '/repos/same-shell-replacement';
    ds.session = replacementSession;
    ds.workingDir = '/repos/same-shell-replacement';
    ds.pendingRepo = true;
    ds.pendingRepoCommitInFlight = true;
    worktreeGate.resolve();

    await expect(completion).resolves.toMatchObject({ kind: 'staleAddress' });
    expect(forkWorker).not.toHaveBeenCalled();
    expect(ds).toMatchObject({
      pendingRepo: true,
      pendingRepoCommitInFlight: true,
      workingDir: '/repos/same-shell-replacement',
      session: {
        sessionId: 'same-shell-replacement-session',
        title: 'same shell replacement',
        workingDir: '/repos/same-shell-replacement',
      },
    });
  });

  it('stops later external I/O when the exact Session changes during worktree creation', async () => {
    const ds = pendingSession();
    delete ds.session.pendingRepoSetup?.cliInput;
    sessionStore.updateSession(ds.session);
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const worktreeGate = deferred<void>();
    const createWorktree = vi.fn(async () => {
      await worktreeGate.promise;
      return { path: '/repos/old-wt', branch: 'wt/old', baseRef: 'origin/main' };
    });
    const availableBots = vi.fn(async () => []);
    const forkWorker = vi.fn(() => true);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({ availableBots, createWorktree, forkWorker }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);
    const completion = complete(host.runtime, address, 'pending-repo/replace-during-worktree', {
      kind: 'worktree',
      repositories: [{ sourcePath: '/repos/source', childName: 'source' }],
      layout: { kind: 'sibling' },
    });
    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));

    const replacement = structuredClone(ds.session);
    replacement.cliId = 'gemini';
    replacement.cliPathOverride = '/replacement/cli';
    ds.session = replacement;
    ds.chatId = 'oc_replacement_must_not_be_read';
    worktreeGate.resolve();

    await expect(completion).resolves.toMatchObject({ kind: 'staleAddress' });
    expect(availableBots).not.toHaveBeenCalled();
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it.each([
    ['resolved async return', () => Promise.resolve(true)],
    ['rejected async return', () => Promise.reject(new Error('async fork failed'))],
  ])('treats a %s from the sync worker primitive as unknown', async (_name, result) => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const forkWorker = vi.fn(() => result() as unknown as boolean);
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        availableBots: vi.fn(async () => []),
        forkWorker,
      }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);

    await expect(complete(host.runtime, address, `pending-repo/${_name}`, {
      kind: 'directory',
      path: '/repos/async-fork',
      pinWorkingDir: true,
    })).resolves.toMatchObject({ kind: 'ambiguous' });

    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingRepoCommitInFlight).toBe(true);
    expect(ds.pendingPrompt).toBeDefined();
  });

  it('quarantines a lost fork response and never replays the same first start', async () => {
    const ds = pendingSession();
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    const forkWorker = vi.fn(() => {
      throw new Error('response lost after worker acceptance');
    });
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        availableBots: vi.fn(async () => []),
        forkWorker,
      }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);
    const selection = {
      kind: 'directory' as const,
      path: '/repos/response-loss',
      pinWorkingDir: true,
    };

    await expect(complete(host.runtime, address, 'pending-repo/response-loss', selection))
      .resolves.toMatchObject({
        kind: 'ambiguous',
        message: expect.stringContaining('response lost after worker acceptance'),
      });
    expect(ds).toMatchObject({
      pendingRepo: true,
      pendingRepoCommitInFlight: true,
      workingDir: '/repos/response-loss',
    });

    await expect(complete(host.runtime, address, 'pending-repo/response-loss', selection))
      .resolves.toMatchObject({ kind: 'ambiguous' });
    expect(forkWorker).toHaveBeenCalledTimes(1);
  });

  it('does not commit or write opening history after the worker primitive replaces the exact Session', async () => {
    const ds = pendingSession();
    const originalSession = ds.session;
    const activeSessions = new Map([[activeSessionKey(ds), ds]]);
    let replacementSession: typeof ds.session | undefined;
    const forkWorker = vi.fn((current: DaemonSession) => {
      replacementSession = structuredClone(current.session);
      replacementSession.title = 'same-id replacement';
      delete replacementSession.lastUserPrompt;
      delete replacementSession.lastCliInput;
      delete replacementSession.lastCliTurnPayload;
      current.session = replacementSession;
      return true;
    });
    const pendingRepoCompletion = createCurrentPendingRepoCompletionProduction({
      ownerLarkAppId: APP,
      activeSessions,
      adapters: externalAdapters({
        availableBots: vi.fn(async () => []),
        forkWorker,
      }),
    });
    const host = currentSessionRuntimeHost({
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: `pending-production-${++bootSequence}`,
      keyedTriggerAdmissionBlocked: () => false,
      pendingRepoCompletion,
    });
    const address = await addressFor(host, ds.session.sessionId);
    const selection = {
      kind: 'directory' as const,
      path: '/repos/same-id-replacement',
      pinWorkingDir: true,
    };

    await expect(complete(
      host.runtime,
      address,
      'pending-repo/worker-replaces-session',
      selection,
    )).resolves.toMatchObject({
      kind: 'ambiguous',
      message: expect.stringContaining('Session identity changed'),
    });

    expect(ds.session).toBe(replacementSession);
    expect(ds.session).not.toBe(originalSession);
    expect(ds.session.sessionId).toBe(originalSession.sessionId);
    expect(ds.session.lastUserPrompt).toBeUndefined();
    expect(ds.session.lastCliInput).toBeUndefined();
    expect(ds.session.lastCliTurnPayload).toBeUndefined();
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingRepoCommitInFlight).toBe(true);
    expect(ds.pendingPrompt).toBe('legacy fields must not rebuild the exact opening');

    await expect(complete(
      host.runtime,
      address,
      'pending-repo/worker-replaces-session',
      selection,
    )).resolves.toMatchObject({ kind: 'ambiguous' });
    expect(forkWorker).toHaveBeenCalledTimes(1);
  });
});
