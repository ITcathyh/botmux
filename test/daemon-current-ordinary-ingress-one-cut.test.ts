import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-current-one-cut-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;

  return {
    dataDir,
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_send'),
    addReaction: vi.fn(async () => 'reaction-id'),
    getChatMode: vi.fn(async () => 'group' as const),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined) => (
      openId ? { openId, type: 'user' as const } : undefined
    )),
    updateSession: vi.fn(),
    downloadResources: vi.fn(async () => ({ attachments: [], needLogin: false })),
    getAvailableBots: vi.fn(async () => []),

    compileOrdinary: vi.fn(),
    currentRuntimeHost: undefined as any,
    currentSessionRuntimeHost: vi.fn(),
    useActualCurrentHost: false,

    sendWorkerInput: vi.fn(() => true),
    forkWorker: vi.fn(),
    forkAdoptWorker: vi.fn(),
    sessionActivationEnsure: vi.fn(),
    sessionActivationReconcile: vi.fn(),
    sessionActivationRetire: vi.fn(),
    admitQueuedActivationTail: vi.fn(),
    promoteQueuedActivationTail: vi.fn(),
    stagePendingRepoSetup: vi.fn(),
    persistPendingRepoCardMessageId: vi.fn(),
    createRepoWorktree: vi.fn(async (repoPath: string) => ({
      path: `${repoPath}/.botmux-test-worktree`,
      branch: 'botmux/test',
      baseRef: 'HEAD',
    })),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
    addReaction: mocks.addReaction,
    getChatMode: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
  };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return {
    ...actual,
    resolveSender: (...args: any[]) => mocks.resolveSender(...args),
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return {
    ...actual,
    updateSession: (...args: any[]) => {
      mocks.updateSession(...args);
      return actual.updateSession(...args);
    },
  };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return {
    ...actual,
    downloadResources: mocks.downloadResources,
    getAvailableBots: mocks.getAvailableBots,
  };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return {
    ...actual,
    sendWorkerInput: mocks.sendWorkerInput,
    forkWorker: mocks.forkWorker,
    forkAdoptWorker: mocks.forkAdoptWorker,
    admitQueuedActivationTail: mocks.admitQueuedActivationTail,
    promoteQueuedActivationTail: mocks.promoteQueuedActivationTail,
  };
});

vi.mock('../src/core/current-session-activation.js', async () => {
  const actual = await vi.importActual<any>('../src/core/current-session-activation.js');
  const coordinator = Object.freeze({
    ensure: (...args: any[]) => mocks.sessionActivationEnsure(...args),
    reconcile: (...args: any[]) => mocks.sessionActivationReconcile(...args),
    retire: (...args: any[]) => mocks.sessionActivationRetire(...args),
  });
  return {
    ...actual,
    currentSessionActivationCoordinator: vi.fn(() => coordinator),
  };
});

vi.mock('../src/core/pending-repo-journal.js', async () => {
  const actual = await vi.importActual<any>('../src/core/pending-repo-journal.js');
  return {
    ...actual,
    stagePendingRepoSetup: (...args: any[]) => {
      mocks.stagePendingRepoSetup(...args);
      return actual.stagePendingRepoSetup(...args);
    },
    persistPendingRepoCardMessageId: (...args: any[]) => {
      mocks.persistPendingRepoCardMessageId(...args);
      return actual.persistPendingRepoCardMessageId(...args);
    },
  };
});

vi.mock('../src/services/git-worktree.js', async () => {
  const actual = await vi.importActual<any>('../src/services/git-worktree.js');
  return { ...actual, createRepoWorktree: mocks.createRepoWorktree };
});

vi.mock('../src/im/lark/ordinary-im-turn-adapter.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/ordinary-im-turn-adapter.js');
  mocks.compileOrdinary.mockImplementation(actual.compileLarkOrdinaryImTurn);
  return { ...actual, compileLarkOrdinaryImTurn: mocks.compileOrdinary };
});

vi.mock('../src/core/current-session-runtime.js', async () => {
  const actual = await vi.importActual<any>('../src/core/current-session-runtime.js');
  mocks.currentSessionRuntimeHost.mockImplementation((options: any) => (
    mocks.useActualCurrentHost
      ? actual.currentSessionRuntimeHost(options)
      : mocks.currentRuntimeHost
  ));
  return { ...actual, currentSessionRuntimeHost: mocks.currentSessionRuntimeHost };
});

import { getBot, registerBot } from '../src/bot-registry.js';
import {
  createSessionRuntimeHost,
  type KeyedTriggerAuthority,
  type KeyedTriggerTurnPort,
  type OrdinaryIngressPort,
  type SessionDirectory,
  type SessionDirectoryRow,
} from '../src/core/session-runtime.js';
import type {
  SessionStore,
  SessionStoreVersion,
  StoredSessionState,
} from '../src/core/session-store.js';
import { activeSessionKey, sessionKey, type DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';
import * as sessionStore from '../src/services/session-store.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
} from '../src/daemon.js';

const APP = 'current_one_cut_app';
const CHAT_A = 'oc_current_one_cut_a';
const CHAT_B = 'oc_current_one_cut_b';
const ANCHOR_A = 'om_current_one_cut_root_a';
const ANCHOR_B = 'om_current_one_cut_root_b';
const OWNER = 'ou_current_one_cut_owner';
const NOW = '2026-08-10T00:00:00.000Z';

const unusedKeyedAuthority: KeyedTriggerAuthority = {
  inspect: () => ({ kind: 'unreadable', message: 'not used by ordinary ingress' }),
  reserve: () => ({ kind: 'unreadable', message: 'not used by ordinary ingress' }),
  begin: () => ({ kind: 'unreadable', message: 'not used by ordinary ingress' }),
  settleDispatchUnknown: () => ({ kind: 'unreadable', message: 'not used by ordinary ingress' }),
};

const unusedKeyedTurns: KeyedTriggerTurnPort = {
  prepare: () => ({ kind: 'unreadable', message: 'not used by ordinary ingress' }),
  acceptAtMostOnce: () => ({ kind: 'refused', message: 'not used by ordinary ingress' }),
  failClose: async () => ({ kind: 'unreadable', message: 'not used by ordinary ingress' }),
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function event(messageId: string, rootId: string, chatId: string, content: string): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: messageId,
      root_id: rootId,
      chat_id: chatId,
      message_type: 'text',
      content: JSON.stringify({ text: content }),
      create_time: String(Date.now()),
    },
  };
}

function postEvent(
  messageId: string,
  rootId: string,
  chatId: string,
  content: string,
  imageKey: string,
): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: messageId,
      root_id: rootId,
      chat_id: chatId,
      message_type: 'post',
      content: JSON.stringify({
        zh_cn: {
          content: [
            [{ tag: 'text', text: content }],
            [{ tag: 'img', image_key: imageKey }],
          ],
        },
      }),
      create_time: String(Date.now()),
    },
  };
}

function context(messageId: string, anchor: string, chatId: string): any {
  return {
    chatId,
    messageId,
    chatType: 'group' as const,
    scope: 'thread' as const,
    anchor,
    larkAppId: APP,
  };
}

function newTopicContext(messageId: string, anchor: string, chatId: string): any {
  return {
    chatId,
    messageId,
    chatType: 'group' as const,
    scope: 'thread' as const,
    anchor,
    larkAppId: APP,
  };
}

function neutralOpeningTurn(overrides: Record<string, unknown> = {}): any {
  return {
    source: 'lark.im',
    route: {
      scope: 'thread',
      canonicalAnchor: ANCHOR_A,
      chatId: CHAT_A,
      chatType: 'group',
    },
    messageKey: 'om_current_opening_policy',
    content: 'ordinary opening policy turn',
    sender: {
      kind: 'human',
      openId: OWNER,
      unionId: `on_${OWNER}`,
    },
    mentions: [],
    postParticipantMentions: [],
    resources: [],
    foldedForwardContext: false,
    vc: { contextMayLag: false },
    ...overrides,
  };
}

function daemonSession(sessionId: string, anchor: string, chatId: string): DaemonSession {
  const send = vi.fn();
  return {
    session: {
      sessionId,
      larkAppId: APP,
      rootMessageId: anchor,
      chatId,
      chatType: 'group',
      scope: 'thread',
      status: 'active',
      title: sessionId,
      createdAt: NOW,
      lastCliInput: { content: 'prior accepted turn' },
    } as Session,
    worker: { killed: false, send } as DaemonSession['worker'],
    workerPort: null,
    workerToken: null,
    workerGeneration: 4,
    larkAppId: APP,
    chatId,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.parse(NOW),
    cliVersion: 'test',
    lastMessageAt: Date.parse(NOW),
    hasHistory: true,
    ownerOpenId: OWNER,
    lastCliInput: { content: 'prior accepted turn' },
  } as DaemonSession;
}

function rowFor(ds: DaemonSession): SessionDirectoryRow {
  return {
    key: sessionKey(ds.session.rootMessageId, ds.larkAppId),
    sessionId: ds.session.sessionId,
    route: { kind: 'thread', anchorId: ds.session.rootMessageId },
    ordinaryIngressBinding: {
      scope: 'thread',
      canonicalAnchor: ds.session.rootMessageId,
      chatId: ds.chatId,
      chatType: ds.chatType,
    },
    recordStatus: 'active',
    executorStatus: ds.worker && !ds.worker.killed ? 'working' : 'dormant',
  };
}

class RegistryDirectory implements SessionDirectory {
  async read(query: Parameters<SessionDirectory['read']>[0]) {
    const rows = [...activeSessions.values()].map(rowFor);
    if (query.kind === 'list') return { kind: 'list' as const, rows };
    const row = query.kind === 'byExternalSession'
      ? rows.find(candidate => candidate.sessionId === query.sessionId)
      : rows.find(candidate => (
          candidate.route.kind === query.route.kind
          && candidate.route.kind === 'thread'
          && candidate.route.anchorId === (
            query.route as { kind: 'thread'; anchorId: string }
          ).anchorId
        ));
    return row ? { kind: 'one' as const, row } : { kind: 'notFound' as const };
  }
}

class MemorySessionStore implements SessionStore {
  private readonly states = new Map<string, StoredSessionState>();
  private readonly versions = new Map<string, SessionStoreVersion>();

  constructor(sessions: readonly DaemonSession[]) {
    for (const ds of sessions) {
      this.states.set(ds.session.sessionId, {
        sessionId: ds.session.sessionId,
        route: { kind: 'thread', anchorId: ds.session.rootMessageId },
        recordStatus: 'active',
        title: ds.session.title,
        executorGeneration: ds.workerGeneration ?? 0,
      });
      this.versions.set(ds.session.sessionId, Object.freeze({}) as SessionStoreVersion);
    }
  }

  load(sessionId: string): ReturnType<SessionStore['load']> {
    const state = this.states.get(sessionId);
    const version = this.versions.get(sessionId);
    if (!state || !version) return { kind: 'notFound' };
    return { kind: 'loaded', state: { ...state }, version };
  }

  apply(input: Parameters<SessionStore['apply']>[0]): ReturnType<SessionStore['apply']> {
    const current = this.states.get(input.sessionId);
    const version = this.versions.get(input.sessionId);
    if (!current || !version) return { kind: 'notApplied', message: 'missing Session' };
    if (version !== input.expected) {
      return { kind: 'conflict', current: { state: { ...current }, version } };
    }
    const state: StoredSessionState = {
      ...current,
      title: input.transition.title,
      titleUpdatedAt: input.transition.updatedAt,
      titleSource: input.transition.source,
    };
    const nextVersion = Object.freeze({}) as SessionStoreVersion;
    this.states.set(input.sessionId, state);
    this.versions.set(input.sessionId, nextVersion);
    return { kind: 'applied', state: { ...state }, nextVersion };
  }
}

function installRuntime(
  sessions: readonly DaemonSession[],
  ordinaryIngress: OrdinaryIngressPort,
) {
  const host = createSessionRuntimeHost({
    directory: new RegistryDirectory(),
    keyedTriggers: unusedKeyedAuthority,
    keyedTriggerTurns: unusedKeyedTurns,
    ordinaryIngress,
    sessionStore: new MemorySessionStore(sessions),
  });
  const daemonSubmit = vi.fn(host.runtime.submit.bind(host.runtime));
  mocks.currentRuntimeHost = {
    projection: host.projection,
    runtime: { submit: daemonSubmit },
  };
  return { host, daemonSubmit };
}

function immediateIngress(): OrdinaryIngressPort {
  return {
    begin: vi.fn(() => ({ kind: 'committed' as const })),
    execute: vi.fn(async () => undefined),
    resume: vi.fn(() => ({ kind: 'committed' as const })),
  };
}

function installRouteRuntime(
  submit: ReturnType<typeof vi.fn> = vi.fn(async () => ({
    kind: 'applied' as const,
    action: 'ordinary.inputCommitted' as const,
    policy: 'ordinary-replayable' as const,
    durability: 'processLocal' as const,
    sessionId: 'session-opened-by-route',
  })),
) {
  mocks.currentRuntimeHost = {
    projection: {
      read: vi.fn(async () => ({ kind: 'notFound' as const })),
    },
    runtime: { submit },
  };
  return submit;
}

async function acquireOpeningCreator(): Promise<any> {
  installRouteRuntime();
  const messageId = 'om_current_acquire_opening_creator';
  await handleNewTopic(
    event(messageId, ANCHOR_A, CHAT_A, 'acquire opening creator'),
    newTopicContext(messageId, ANCHOR_A, CHAT_A),
  );
  const options = mocks.currentSessionRuntimeHost.mock.calls.at(-1)?.[0] as any;
  return options?.ordinaryRouteOpeningCreator;
}

async function resolveOpeningPolicy(creator: any, turn: any): Promise<any> {
  const begun = creator.begin(turn);
  if (begun.kind !== 'effect') throw new Error(`expected opening effect, got ${begun.kind}`);
  return creator.execute(begun.intent);
}

function clearRouteSpies(): void {
  for (const spy of [
    mocks.compileOrdinary,
    mocks.currentSessionRuntimeHost,
    mocks.sendWorkerInput,
    mocks.forkWorker,
    mocks.forkAdoptWorker,
    mocks.sessionActivationEnsure,
    mocks.admitQueuedActivationTail,
    mocks.promoteQueuedActivationTail,
    mocks.stagePendingRepoSetup,
    mocks.replyMessage,
    mocks.sendMessage,
  ]) spy.mockClear();
}

function legacyCalls(): string[] {
  return [
    ['send', mocks.sendWorkerInput],
    ['fork', mocks.forkWorker],
    ['forkAdopt', mocks.forkAdoptWorker],
    ['tail.admit', mocks.admitQueuedActivationTail],
    ['tail.promote', mocks.promoteQueuedActivationTail],
    ['pendingRepo.stage', mocks.stagePendingRepoSetup],
  ].flatMap(([name, spy]) => Array.from(
    { length: (spy as ReturnType<typeof vi.fn>).mock.calls.length },
    () => name as string,
  ));
}

beforeEach(() => {
  mkdirSync(mocks.dataDir, { recursive: true });
  vi.clearAllMocks();
  activeSessions.clear();
  mocks.useActualCurrentHost = false;
  sessionStore.init(APP);
  const bot = registerBot({
    larkAppId: APP,
    larkAppSecret: 'test-secret',
    cliId: 'claude-code',
    allowedUsers: [OWNER],
  });
  bot.resolvedAllowedUsers = [OWNER];
  mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
  mocks.getAvailableBots.mockResolvedValue([]);
  mocks.sessionActivationEnsure.mockImplementation(async (input: any) => {
    const current = [...activeSessions.values()].find(candidate => (
      candidate.larkAppId === APP
      && candidate.session.sessionId === input.sessionId
      && activeSessions.get(activeSessionKey(candidate)) === candidate
    ));
    if (!current) {
      return { kind: 'retryable', message: 'test Current activation target is unavailable' };
    }
    try {
      const accepted = mocks.forkWorker(
        current,
        input.promptInput,
        input.resumeOrTurnId ?? false,
      );
      return accepted === true
        ? { kind: 'active', action: 'deferred' }
        : { kind: 'retryable', message: 'test Current activation was not accepted' };
    } catch (error) {
      return {
        kind: 'ambiguous',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
  mocks.sessionActivationReconcile.mockResolvedValue({ kind: 'active', action: 'deferred' });
  mocks.sessionActivationRetire.mockResolvedValue({ kind: 'retired', action: 'retired' });
});

afterAll(() => {
  rmSync(mocks.dataDir, { recursive: true, force: true });
});

describe('daemon existing-owner ordinary ingress one-cut', () => {
  it('submits every legacy disposition through the canonical compiler/runtime seam exactly once', async () => {
    const cases = [
      {
        name: 'live send',
        arrange(_ds: DaemonSession) {},
      },
      {
        name: 'cold fork',
        arrange(ds: DaemonSession) { ds.worker = null; },
      },
      {
        name: 'activation tail',
        arrange(ds: DaemonSession) {
          ds.initialStartPending = true;
          ds.session.queuedActivationPending = true;
          ds.session.queuedActivationInput = { content: 'retained opening' };
          ds.session.queuedActivationTurnId = 'om_retained_opening';
        },
      },
      {
        name: 'pending repo',
        arrange(ds: DaemonSession) {
          ds.pendingRepo = true;
          ds.pendingPrompt = '';
        },
      },
    ];
    const observations: Array<Record<string, unknown>> = [];

    for (const [index, testCase] of cases.entries()) {
      clearRouteSpies();
      activeSessions.clear();
      const anchor = `${ANCHOR_A}_${index}`;
      const messageId = `om_current_one_cut_${index}`;
      const ds = daemonSession(`session-current-one-cut-${index}`, anchor, CHAT_A);
      testCase.arrange(ds);
      activeSessions.set(sessionKey(anchor, APP), ds);
      const { daemonSubmit } = installRuntime([ds], immediateIngress());

      const outcome = await handleThreadReply(
        event(messageId, anchor, CHAT_A, `ordinary ${index}`),
        context(messageId, anchor, CHAT_A),
      );
      const compiled = mocks.compileOrdinary.mock.results[0]?.value as any;
      const submitted = daemonSubmit.mock.calls[0]?.[0] as any;
      observations.push({
        name: testCase.name,
        outcome,
        compileCalls: mocks.compileOrdinary.mock.calls.length,
        hostCalls: mocks.currentSessionRuntimeHost.mock.calls.length,
        submitCalls: daemonSubmit.mock.calls.length,
        submittedKind: submitted?.command?.kind,
        submittedKey: submitted?.idempotencyKey,
        submittedTurnIsCompilerResult: compiled !== undefined
          && submitted?.command?.input?.turn === compiled,
        legacyCalls: legacyCalls(),
      });
    }

    expect(observations).toEqual(cases.map((testCase, index) => ({
      name: testCase.name,
      outcome: undefined,
      compileCalls: 1,
      hostCalls: 1,
      submitCalls: 1,
      submittedKind: 'ordinary.ingress',
      submittedKey: `om_current_one_cut_${index}`,
      submittedTurnIsCompilerResult: true,
      legacyCalls: [],
    })));
  });

  it('releases the delivery lock after enqueue while Session effects remain FIFO', async () => {
    const firstGate = deferred<void>();
    const firstMaterializeStarted = deferred<void>();
    const sessionA = daemonSession('session-current-one-cut-a', ANCHOR_A, CHAT_A);
    const sessionB = daemonSession('session-current-one-cut-b', ANCHOR_B, CHAT_B);
    activeSessions.set(sessionKey(ANCHOR_A, APP), sessionA);
    activeSessions.set(sessionKey(ANCHOR_B, APP), sessionB);

    const begin = vi.fn(({ sessionId, turn }: Parameters<OrdinaryIngressPort['begin']>[0]) => ({
      kind: 'effect' as const,
      intent: { sessionId, messageKey: turn.messageKey },
      continuation: { sessionId, messageKey: turn.messageKey },
    }));
    const execute = vi.fn(async (intent: unknown) => {
      const current = intent as { sessionId: string; messageKey: string };
      if (current.sessionId === sessionA.session.sessionId) {
        if (current.messageKey === 'om_pending_a_n') firstMaterializeStarted.resolve();
        await firstGate.promise;
      }
      return { kind: 'materialized' };
    });
    const ingress: OrdinaryIngressPort = {
      begin,
      execute,
      resume: vi.fn(() => ({ kind: 'committed' as const })),
    };
    const { host, daemonSubmit } = installRuntime([sessionA, sessionB], ingress);
    const projectedA = await host.projection.read({
      kind: 'byExternalSession',
      sessionId: sessionA.session.sessionId,
    });
    if (projectedA.kind !== 'one') throw new Error('expected Session A projection');

    const first = handleThreadReply(
      event('om_pending_a_n', ANCHOR_A, CHAT_A, 'A/N'),
      context('om_pending_a_n', ANCHOR_A, CHAT_A),
    );
    let control: ReturnType<typeof host.runtime.submit> | undefined;
    let follower: Promise<void> | undefined;
    let otherSession: Promise<void> | undefined;
    try {
      await vi.waitFor(() => {
        expect(mocks.compileOrdinary).toHaveBeenCalledWith(expect.objectContaining({
          message: expect.objectContaining({ messageId: 'om_pending_a_n' }),
        }));
        expect(daemonSubmit).toHaveBeenCalledTimes(1);
      }, { timeout: 1_000 });
      await firstMaterializeStarted.promise;

      control = host.runtime.submit({
        target: { kind: 'session', address: projectedA.session.address },
        idempotencyKey: 'control-while-a-n-materializes',
        command: {
          kind: 'control.rename',
          input: {
            title: 'control advanced',
            updatedAt: '2026-08-10T00:00:01.000Z',
            source: 'user',
          },
        },
      });

      follower = handleThreadReply(
        event('om_pending_a_n_plus_1', ANCHOR_A, CHAT_A, 'A/N+1'),
        context('om_pending_a_n_plus_1', ANCHOR_A, CHAT_A),
      );
      otherSession = handleThreadReply(
        event('om_other_b_n', ANCHOR_B, CHAT_B, 'B/N'),
        context('om_other_b_n', ANCHOR_B, CHAT_B),
      );

      await expect(otherSession).resolves.toBeUndefined();
      await vi.waitFor(() => {
        const compiledMessageIds = mocks.compileOrdinary.mock.calls.map(
          call => call[0]?.message?.messageId,
        );
        expect(compiledMessageIds).toEqual(expect.arrayContaining([
          'om_pending_a_n',
          'om_pending_a_n_plus_1',
          'om_other_b_n',
        ]));
        expect(daemonSubmit).toHaveBeenCalledTimes(3);
      }, { timeout: 1_000 });
      expect(execute).not.toHaveBeenCalledWith({
        sessionId: sessionA.session.sessionId,
        messageKey: 'om_pending_a_n_plus_1',
      });

      firstGate.resolve();
      await expect(control).resolves.toMatchObject({
        kind: 'applied',
        action: 'control.renamed',
      });
      await expect(follower).resolves.toBeUndefined();
      await expect(first).resolves.toBeUndefined();
      await vi.waitFor(() => {
        expect(execute).toHaveBeenCalledWith({
          sessionId: sessionA.session.sessionId,
          messageKey: 'om_pending_a_n_plus_1',
        });
      }, { timeout: 1_000 });

      expect(mocks.currentSessionRuntimeHost).toHaveBeenCalledTimes(3);
      expect(legacyCalls()).toEqual([]);
    } finally {
      firstGate.resolve();
      await Promise.allSettled([
        first,
        ...(control ? [control] : []),
        ...(follower ? [follower] : []),
        ...(otherSession ? [otherSession] : []),
      ]);
    }
  });

  it('does not submit an old inbound after projection wait observes a replacement binding', async () => {
    const original = daemonSession(
      'session-current-one-cut-replaced',
      ANCHOR_A,
      CHAT_A,
    );
    activeSessions.set(sessionKey(ANCHOR_A, APP), original);
    const { host, daemonSubmit } = installRuntime([original], immediateIngress());
    const projectionStarted = deferred<void>();
    const releaseProjection = deferred<void>();
    const read = host.projection.read.bind(host.projection);
    mocks.currentRuntimeHost = {
      projection: {
        async read(query: Parameters<typeof host.projection.read>[0]) {
          projectionStarted.resolve();
          await releaseProjection.promise;
          return read(query);
        },
      },
      runtime: { submit: daemonSubmit },
    };

    const delivery = handleThreadReply(
      event('om_replaced_during_projection', ANCHOR_A, CHAT_A, 'old inbound'),
      context('om_replaced_during_projection', ANCHOR_A, CHAT_A),
    );
    await projectionStarted.promise;

    const replacement = daemonSession(
      original.session.sessionId,
      ANCHOR_A,
      CHAT_A,
    );
    activeSessions.set(sessionKey(ANCHOR_A, APP), replacement);
    releaseProjection.resolve();

    await expect(delivery).resolves.toBeUndefined();
    expect(mocks.compileOrdinary).toHaveBeenCalledTimes(1);
    expect(daemonSubmit).toHaveBeenCalledTimes(0);
    expect(legacyCalls()).toEqual([]);
  });
});

describe('daemon no-owner ordinary route one-cut', () => {
  it('submits a folded new-topic turn to the route before quota/resource/sender I/O', async () => {
    const submit = installRouteRuntime();
    const messageId = 'om_current_new_route_followup';
    const seedId = 'om_current_new_route_seed';
    const ctx = {
      ...newTopicContext(messageId, ANCHOR_A, CHAT_A),
      forwardSeedData: event(
        seedId,
        ANCHOR_A,
        CHAT_A,
        'seed diagnostic context',
      ),
    };

    await expect(handleNewTopic(
      event(messageId, ANCHOR_A, CHAT_A, 'apply the requested patch'),
      ctx,
    )).resolves.toBeUndefined();

    expect(mocks.compileOrdinary).toHaveBeenCalledTimes(1);
    const compilerInput = mocks.compileOrdinary.mock.calls[0]![0] as any;
    expect(compilerInput).toMatchObject({
      route: {
        scope: 'thread',
        canonicalAnchor: ANCHOR_A,
        chatId: CHAT_A,
        chatType: 'group',
      },
      message: { messageId },
      foldedForwardContext: true,
    });
    expect(compilerInput.message.content).toContain('seed diagnostic context');
    expect(compilerInput.message.content).toContain('apply the requested patch');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      target: {
        kind: 'route',
        route: { kind: 'thread', anchorId: ANCHOR_A },
      },
      idempotencyKey: messageId,
      command: {
        kind: 'ordinary.ingress',
        input: { turn: mocks.compileOrdinary.mock.results[0]!.value },
      },
    }));
    expect(mocks.downloadResources).toHaveBeenCalledTimes(0);
    expect(mocks.resolveSender).toHaveBeenCalledTimes(0);
    expect(activeSessions.size).toBe(0);
    expect(legacyCalls()).toEqual([]);
  });

  it('submits a no-owner thread reply to the route exactly once', async () => {
    const submit = installRouteRuntime();
    const messageId = 'om_current_no_owner_reply';

    await expect(handleThreadReply(
      event(messageId, ANCHOR_A, CHAT_A, 'ordinary no-owner reply'),
      context(messageId, ANCHOR_A, CHAT_A),
    )).resolves.toBeUndefined();

    expect(mocks.compileOrdinary).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      target: {
        kind: 'route',
        route: { kind: 'thread', anchorId: ANCHOR_A },
      },
      idempotencyKey: messageId,
      command: expect.objectContaining({ kind: 'ordinary.ingress' }),
    }));
    expect(mocks.downloadResources).toHaveBeenCalledTimes(0);
    expect(mocks.resolveSender).toHaveBeenCalledTimes(0);
    expect(activeSessions.size).toBe(0);
    expect(legacyCalls()).toEqual([]);
  });

  it('keeps listener rendering facts typed and provider content neutral', async () => {
    const submit = installRouteRuntime();
    const messageId = 'om_current_listener_route';
    const listener = {
      name: 'Alert listener',
      replyCardTitle: 'Production alert',
      prompt: 'Investigate this alert safely.',
      workingDir: '/repos/alert-service',
      messageText: 'provider raw alert',
      messageTitle: 'Disk pressure',
      msgType: 'text',
      senderOpenId: 'ou_alert_bot',
      senderName: 'Alert Bot',
      senderType: 'bot' as const,
    };

    await expect(handleNewTopic(
      event(messageId, ANCHOR_A, CHAT_A, 'provider raw alert'),
      {
        ...newTopicContext(messageId, ANCHOR_A, CHAT_A),
        messageListener: listener,
      },
    )).resolves.toBeUndefined();

    const compilerInput = mocks.compileOrdinary.mock.calls[0]![0] as any;
    expect(compilerInput.message.content).toBe('provider raw alert');
    expect(compilerInput.message.content).not.toContain('<message_listener>');
    expect(compilerInput.messageListener).toMatchObject({
      replyCardTitle: 'Production alert',
      prompt: 'Investigate this alert safely.',
      workingDir: '/repos/alert-service',
      messageText: 'provider raw alert',
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(mocks.downloadResources).toHaveBeenCalledTimes(0);
    expect(mocks.resolveSender).toHaveBeenCalledTimes(0);
  });

  it('supplies one complete stable owner/boot Host composition on every acquisition', async () => {
    installRouteRuntime();
    const firstId = 'om_current_full_host_first';
    const secondId = 'om_current_full_host_second';

    await handleNewTopic(
      event(firstId, ANCHOR_A, CHAT_A, 'first host acquisition'),
      newTopicContext(firstId, ANCHOR_A, CHAT_A),
    );
    await handleNewTopic(
      event(secondId, ANCHOR_B, CHAT_B, 'second host acquisition'),
      newTopicContext(secondId, ANCHOR_B, CHAT_B),
    );

    expect(mocks.currentSessionRuntimeHost).toHaveBeenCalledTimes(2);
    const first = mocks.currentSessionRuntimeHost.mock.calls[0]![0] as any;
    const second = mocks.currentSessionRuntimeHost.mock.calls[1]![0] as any;
    expect(first).toMatchObject({
      ownerBotId: getBot(APP).botId,
      ownerLarkAppId: APP,
      activeSessions,
      ownerBootId: expect.any(String),
      runtimeEpoch: expect.any(String),
      ordinaryIngress: expect.any(Object),
      ordinaryRouteOpeningCreator: expect.any(Object),
      dashboardRouteOpening: expect.any(Object),
      pendingRepoCompletion: expect.any(Object),
      scheduledFire: expect.any(Object),
      controlMutation: expect.any(Object),
    });
    expect(second.ownerBootId).toBe(first.ownerBootId);
    expect(second.runtimeEpoch).toBe(first.runtimeEpoch);
    expect(second.ordinaryIngress).toBe(first.ordinaryIngress);
    expect(second.ordinaryRouteOpeningCreator).toBe(first.ordinaryRouteOpeningCreator);
    expect(second.dashboardRouteOpening).toBe(first.dashboardRouteOpening);
    expect(second.pendingRepoCompletion).toBe(first.pendingRepoCompletion);
    expect(second.scheduledFire).toBe(first.scheduledFire);
    expect(second.controlMutation).toBe(first.controlMutation);
  });

  it('releases the route delivery lock after enqueue while completion is pending', async () => {
    const gates = [deferred<any>(), deferred<any>()];
    let submissionIndex = 0;
    const submit = installRouteRuntime(vi.fn(
      () => gates[submissionIndex++]!.promise,
    ));
    const firstId = 'om_current_route_pending_first';
    const secondId = 'om_current_route_pending_second';
    const first = handleNewTopic(
      event(firstId, ANCHOR_A, CHAT_A, 'first'),
      newTopicContext(firstId, ANCHOR_A, CHAT_A),
    );
    let second: Promise<void> | undefined;

    try {
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1), { timeout: 1_000 });
      second = handleNewTopic(
        event(secondId, ANCHOR_A, CHAT_A, 'second'),
        newTopicContext(secondId, ANCHOR_A, CHAT_A),
      );
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2), { timeout: 1_000 });
      expect(mocks.downloadResources).toHaveBeenCalledTimes(0);
      expect(mocks.resolveSender).toHaveBeenCalledTimes(0);
    } finally {
      const outcome = {
        kind: 'applied' as const,
        action: 'ordinary.inputCommitted' as const,
        policy: 'ordinary-replayable' as const,
        durability: 'processLocal' as const,
        sessionId: 'session-opened-by-route',
      };
      for (const gate of gates) gate.resolve(outcome);
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });

  it.each([
    { kind: 'staleAddress' as const },
    { kind: 'retryable' as const, message: 'retry later' },
    {
      kind: 'ambiguous' as const,
      state: 'commitUnknown' as const,
      policy: 'ordinary-replayable' as const,
      durability: 'processLocal' as const,
      sessionId: 'session-ambiguous',
      message: 'commit is unknown',
      idempotent: true,
    },
  ])('never falls back to legacy creation after $kind', async (outcome) => {
    const submit = installRouteRuntime(vi.fn(async () => outcome));
    const messageId = `om_current_no_fallback_${outcome.kind}`;

    await expect(handleNewTopic(
      event(messageId, ANCHOR_A, CHAT_A, 'ordinary'),
      newTopicContext(messageId, ANCHOR_A, CHAT_A),
    )).resolves.toBeUndefined();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(activeSessions.size).toBe(0);
    expect(mocks.downloadResources).toHaveBeenCalledTimes(0);
    expect(mocks.resolveSender).toHaveBeenCalledTimes(0);
    expect(legacyCalls()).toEqual([]);
  });
});

describe('daemon Current ordinary opening adapter', () => {
  it('resolves the pinned, oncall, auto-worktree, picker, and zero-project matrix after enqueue', async () => {
    const creator = await acquireOpeningCreator();
    const cfg = getBot(APP).config;

    cfg.workingDir = mocks.dataDir;
    cfg.defaultWorkingDir = mocks.dataDir;
    cfg.defaultWorkingDirAutoWorktree = false;
    cfg.oncallChats = [];
    const pinned = await resolveOpeningPolicy(
      creator,
      neutralOpeningTurn({ messageKey: 'om_policy_pinned' }),
    );
    expect(pinned).toMatchObject({
      kind: 'resolved',
      facts: { repository: { kind: 'pinned', workingDir: mocks.dataDir } },
    });

    cfg.defaultWorkingDir = undefined;
    cfg.oncallChats = [{ chatId: CHAT_A, workingDir: mocks.dataDir }];
    const oncall = await resolveOpeningPolicy(
      creator,
      neutralOpeningTurn({ messageKey: 'om_policy_oncall' }),
    );
    expect(oncall).toMatchObject({
      kind: 'resolved',
      facts: { repository: { kind: 'pinned', workingDir: mocks.dataDir } },
    });

    cfg.oncallChats = [];
    cfg.defaultWorkingDir = mocks.dataDir;
    cfg.defaultWorkingDirAutoWorktree = true;
    const autoWorktree = await resolveOpeningPolicy(
      creator,
      neutralOpeningTurn({ messageKey: 'om_policy_auto_worktree' }),
    );
    expect(autoWorktree).toMatchObject({
      kind: 'resolved',
      facts: { repository: { kind: 'autoWorktree', baseDir: mocks.dataDir } },
    });

    cfg.defaultWorkingDir = undefined;
    cfg.defaultWorkingDirAutoWorktree = false;
    const projectDir = join(mocks.dataDir, 'project-with-git');
    mkdirSync(join(projectDir, '.git'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const picker = await resolveOpeningPolicy(
      creator,
      neutralOpeningTurn({ messageKey: 'om_policy_picker' }),
    );
    expect(picker).toMatchObject({
      kind: 'resolved',
      facts: { repository: { kind: 'picker' } },
    });

    rmSync(projectDir, { recursive: true, force: true });
    const zeroProjects = await resolveOpeningPolicy(
      creator,
      neutralOpeningTurn({ messageKey: 'om_policy_zero_projects' }),
    );
    expect(zeroProjects).toMatchObject({
      kind: 'resolved',
      facts: { repository: { kind: 'pinned', workingDir: mocks.dataDir } },
    });
  });

  it('uses listener workingDir/title facts without rendering them into neutral content', async () => {
    const creator = await acquireOpeningCreator();
    const listener = {
      name: 'Alert listener',
      replyCardTitle: 'Production alert',
      prompt: 'Investigate safely.',
      workingDir: mocks.dataDir,
      messageText: 'raw alert body',
      messageTitle: 'Disk pressure',
      msgType: 'interactive',
      senderOpenId: 'ou_alert_bot',
      senderName: 'Alert Bot',
      senderType: 'bot' as const,
    };
    const resolved = await resolveOpeningPolicy(
      creator,
      neutralOpeningTurn({
        messageKey: 'om_policy_listener',
        content: 'raw alert body',
        messageListener: listener,
      }),
    );

    expect(resolved).toMatchObject({
      kind: 'resolved',
      facts: {
        repository: { kind: 'pinned', workingDir: mocks.dataDir },
        title: { sessionTitle: 'Production alert' },
        ownership: {
          ownerOpenId: OWNER,
          ownerUnionId: `on_${OWNER}`,
          creatorOpenId: OWNER,
        },
      },
    });
  });

  it('turns a zero-project opening into an immediate pinned cold fork with one I/O pass', async () => {
    const cfg = getBot(APP).config;
    cfg.workingDir = mocks.dataDir;
    cfg.defaultWorkingDir = undefined;
    cfg.defaultWorkingDirAutoWorktree = false;
    cfg.oncallChats = [];
    mocks.useActualCurrentHost = true;
    mocks.forkWorker.mockReturnValue(true);
    const messageId = 'om_current_zero_project_cold_fork';

    await expect(handleNewTopic(
      event(messageId, ANCHOR_A, CHAT_A, 'cold fork without picker projects'),
      {
        ...newTopicContext(messageId, ANCHOR_A, CHAT_A),
        forwardSeedData: postEvent(
          'om_current_zero_project_seed',
          ANCHOR_A,
          CHAT_A,
          'seed diagnostic context',
          'img_current_zero_project_seed',
        ),
      },
    )).resolves.toBeUndefined();

    expect(activeSessions.size).toBe(1);
    const [current] = [...activeSessions.values()];
    expect(current).toMatchObject({
      workingDir: mocks.dataDir,
      session: {
        workingDir: mocks.dataDir,
      },
    });
    expect(current.pendingRepo).toBeUndefined();
    expect(current.session.pendingRepoSetup).toBeUndefined();
    expect(mocks.sessionActivationEnsure).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: current.session.sessionId,
      cause: 'ordinary',
      promptInput: expect.objectContaining({ content: expect.any(String) }),
    }));
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(mocks.downloadResources).toHaveBeenCalledTimes(1);
    expect(mocks.resolveSender).toHaveBeenCalledTimes(1);
    expect(mocks.getAvailableBots).toHaveBeenCalledTimes(1);
    expect(mocks.forkAdoptWorker).toHaveBeenCalledTimes(0);
    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(0);
  });

  it('stages auto-worktree and completes it through the Current pending port', async () => {
    const autoWorktreeBase = join(mocks.dataDir, 'auto-worktree-base');
    mkdirSync(autoWorktreeBase, { recursive: true });
    execFileSync('git', ['init', '--quiet', autoWorktreeBase]);
    const cfg = getBot(APP).config;
    cfg.workingDir = autoWorktreeBase;
    cfg.defaultWorkingDir = autoWorktreeBase;
    cfg.defaultWorkingDirAutoWorktree = true;
    cfg.oncallChats = [];
    mocks.useActualCurrentHost = true;
    mocks.forkWorker.mockReturnValue(true);
    const anchor = 'om_current_auto_worktree_root';
    const messageId = 'om_current_auto_worktree_opening';

    await handleNewTopic(
      event(messageId, anchor, CHAT_B, 'open an isolated worktree'),
      newTopicContext(messageId, anchor, CHAT_B),
    );

    await vi.waitFor(() => {
      expect(mocks.createRepoWorktree).toHaveBeenCalledWith(
        autoWorktreeBase,
        { slug: 'open-an-isolated-worktree' },
      );
      expect(mocks.sessionActivationEnsure).toHaveBeenCalledTimes(1);
      expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    }, { timeout: 1_000 });
    const current = activeSessions.get(sessionKey(anchor, APP));
    expect(current).toBeDefined();
    expect(current?.pendingRepo).toBe(false);
    expect(current?.workingDir).toBe(`${autoWorktreeBase}/.botmux-test-worktree`);
    expect(current?.session.pendingRepoSetup).toMatchObject({
      mode: 'auto_worktree',
      turnId: messageId,
    });
    expect(mocks.downloadResources).toHaveBeenCalledTimes(0);
    expect(mocks.resolveSender).toHaveBeenCalledTimes(1);
    expect(mocks.getAvailableBots).toHaveBeenCalledTimes(1);
  });

  it('shows a picker card when projects exist and does not fork before selection', async () => {
    const cfg = getBot(APP).config;
    cfg.workingDir = mocks.dataDir;
    cfg.defaultWorkingDir = undefined;
    cfg.defaultWorkingDirAutoWorktree = false;
    cfg.oncallChats = [];
    const projectDir = join(mocks.dataDir, 'picker-project');
    mkdirSync(join(projectDir, '.git'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mocks.useActualCurrentHost = true;
    mocks.forkWorker.mockReturnValue(true);
    const anchor = 'om_current_picker_root';
    const messageId = 'om_current_picker_opening';

    await handleNewTopic(
      event(messageId, anchor, CHAT_B, 'pick a project'),
      newTopicContext(messageId, anchor, CHAT_B),
    );

    await vi.waitFor(() => {
      const current = activeSessions.get(sessionKey(anchor, APP));
      expect(current?.repoCardMessageId).toBe('om_reply');
    }, { timeout: 1_000 });
    const current = activeSessions.get(sessionKey(anchor, APP));
    expect(current?.pendingRepo).toBe(true);
    expect(current?.session.pendingRepoSetup).toMatchObject({
      mode: 'picker',
      turnId: messageId,
    });
    expect(mocks.replyMessage.mock.calls[0]?.slice(0, 4)).toEqual([
      APP,
      anchor,
      expect.any(String),
      'interactive',
    ]);
    expect(mocks.persistPendingRepoCardMessageId).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(0);
    expect(mocks.downloadResources).toHaveBeenCalledTimes(0);
    expect(mocks.resolveSender).toHaveBeenCalledTimes(1);
    expect(mocks.getAvailableBots).toHaveBeenCalledTimes(1);
  });

  it('exact-fences a picker card reply that settles after DS replacement', async () => {
    const cfg = getBot(APP).config;
    cfg.workingDir = mocks.dataDir;
    cfg.defaultWorkingDir = undefined;
    cfg.defaultWorkingDirAutoWorktree = false;
    cfg.oncallChats = [];
    const projectDir = join(mocks.dataDir, 'stale-picker-project');
    mkdirSync(join(projectDir, '.git'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const cardReply = deferred<string>();
    mocks.replyMessage.mockImplementationOnce(() => cardReply.promise);
    mocks.useActualCurrentHost = true;
    mocks.forkWorker.mockReturnValue(true);
    const anchor = 'om_current_stale_picker_root';
    const messageId = 'om_current_stale_picker_opening';

    await handleNewTopic(
      event(messageId, anchor, CHAT_B, 'pick after replacement'),
      newTopicContext(messageId, anchor, CHAT_B),
    );
    await vi.waitFor(() => expect(mocks.replyMessage).toHaveBeenCalledTimes(1), {
      timeout: 1_000,
    });
    const original = activeSessions.get(sessionKey(anchor, APP));
    if (!original) throw new Error('expected Current picker opening');
    const replacement = daemonSession(original.session.sessionId, anchor, CHAT_B);
    activeSessions.set(activeSessionKey(original), replacement);
    mocks.persistPendingRepoCardMessageId.mockClear();

    cardReply.resolve('om_stale_picker_card');
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(original.repoCardMessageId).toBeUndefined();
    expect(mocks.persistPendingRepoCardMessageId).toHaveBeenCalledTimes(0);
  });
});
