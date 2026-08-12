/**
 * 普通消息处理链终态失败的可行动提示（ingress failure notice）。
 *
 * transport 已 ACK（用户看到消息发出去了）之后，异常把 handleThreadReply /
 * handleNewTopic 整条投递链掀翻时，此前只剩 event-dispatcher 的 log-only
 * catch——用户视角就是机器人吞消息。本文件驱动真实路由入口断言：
 *   - 投递链异常 → 话题里收到一条可行动提示，且原错误原样重抛（dispatcher
 *     既有日志语义不变）；
 *   - 提示本身发送失败 → 只降级为 warn，原错误仍然重抛，不被通知错误顶掉；
 *   - 正常投递 → 不发提示（无误报）。
 *
 * Run:  pnpm vitest run test/daemon-ordinary-ingress-failure-notice.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-ingress-notice-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  const sessions = new Map<string, any>();
  return {
    dataDir,
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_top'),
    addReaction: vi.fn(async () => 'reaction_received'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined, senderType: string | undefined) => (
      openId
        ? { openId, type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const }
        : undefined
    )),
    sessions,
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') => {
      const session = {
        sessionId: `sess-fake-${++seq}`,
        chatId,
        rootMessageId,
        title,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        chatType,
      };
      sessions.set(session.sessionId, session);
      return session;
    }),
    updateSession: vi.fn((session: any) => { sessions.set(session.sessionId, session); }),
    getSession: vi.fn((sessionId: string) => sessions.get(sessionId)),
    closeSession: vi.fn((sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) session.status = 'closed';
    }),
    forkWorker: vi.fn((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    }),
    scanMultipleProjects: vi.fn(() => [] as any[]),
    getAvailableBots: vi.fn(async () => [] as any[]),
    downloadResources: vi.fn(async () => ({ attachments: [], needLogin: false })),
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

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return {
    ...actual,
    createSession: mocks.createSession,
    updateSession: mocks.updateSession,
    getSession: mocks.getSession,
    closeSession: mocks.closeSession,
  };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return { ...actual, forkWorker: mocks.forkWorker };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return {
    ...actual,
    getAvailableBots: mocks.getAvailableBots,
    downloadResources: mocks.downloadResources,
  };
});

vi.mock('../src/services/project-scanner.js', async () => {
  const actual = await vi.importActual<any>('../src/services/project-scanner.js');
  return { ...actual, scanMultipleProjects: mocks.scanMultipleProjects };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

import { registerBot } from '../src/bot-registry.js';
import { sessionKey } from '../src/core/types.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
} from '../src/daemon.js';
import { t as tr, localeForBot } from '../src/i18n/index.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'ingress_notice_app';
const CHAT = 'oc_ingress_notice_chat';
const OWNER = 'ou_owner';
const NOW = new Date().toISOString();

function makeEventData(messageId: string, text: string, rootId?: string): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: messageId,
      root_id: rootId,
      chat_id: CHAT,
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  };
}

function makeCtx(anchor: string, messageId: string): any {
  return {
    chatId: CHAT,
    messageId,
    chatType: 'group' as const,
    scope: 'thread' as const,
    anchor,
    larkAppId: APP,
  };
}

function seedThreadSession(anchor: string, title: string): DaemonSession {
  const ds = {
    scope: 'thread',
    chatId: CHAT,
    chatType: 'group',
    larkAppId: APP,
    worker: null,
    workerPort: null,
    workerToken: null,
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    ownerOpenId: OWNER,
    session: {
      sessionId: 'sess-seeded-' + Math.random().toString(36).slice(2),
      chatId: CHAT,
      rootMessageId: anchor,
      title,
      status: 'active',
      createdAt: NOW,
      larkAppId: APP,
    },
  } as unknown as DaemonSession;
  activeSessions.set(sessionKey(anchor, APP), ds);
  return ds;
}

/** All text replied through the mocked Lark client in this test, joined. */
function repliedText(): string {
  return [...mocks.replyMessage.mock.calls, ...mocks.sendMessage.mock.calls]
    .map(call => String(call[2] ?? ''))
    .join('\n');
}

function expectedNotice(): string {
  return tr('daemon.ordinary_ingress_failed', undefined, localeForBot(APP));
}

describe('ordinary ingress terminal failure → actionable notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.getChatMode.mockResolvedValue('group');
    mocks.getChatNameAndMode.mockResolvedValue({ name: null, mode: 'group' });
    mocks.sessions.clear();
    mocks.forkWorker.mockImplementation((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    });
    mocks.scanMultipleProjects.mockReturnValue([]);
    mocks.getAvailableBots.mockResolvedValue([]);
    mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
    activeSessions.clear();
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
    });
    bot.resolvedAllowedUsers = [OWNER];
  });

  it('thread reply delivery failure replies with the notice and rethrows the original error', async () => {
    const anchor = 'om_thread_root';
    seedThreadSession(anchor, 'seeded');
    mocks.downloadResources.mockRejectedValue(new Error('boom: durable store offline'));

    await expect(
      handleThreadReply(makeEventData('om_msg_1', 'hello world', anchor), makeCtx(anchor, 'om_msg_1')),
    ).rejects.toThrow('boom: durable store offline');

    expect(repliedText()).toContain(expectedNotice());
  });

  it('a failing notice never masks the original delivery error', async () => {
    const anchor = 'om_thread_root_2';
    seedThreadSession(anchor, 'seeded');
    mocks.downloadResources.mockRejectedValue(new Error('boom: original failure'));
    mocks.replyMessage.mockRejectedValue(new Error('lark transport down'));
    mocks.sendMessage.mockRejectedValue(new Error('lark transport down'));

    await expect(
      handleThreadReply(makeEventData('om_msg_2', 'hello again', anchor), makeCtx(anchor, 'om_msg_2')),
    ).rejects.toThrow('boom: original failure');
  });

  it('new topic delivery failure replies with the notice and rethrows', async () => {
    mocks.downloadResources.mockRejectedValue(new Error('boom: new topic ingest'));

    await expect(
      handleNewTopic(makeEventData('om_msg_3', 'start a task'), makeCtx('om_msg_3', 'om_msg_3')),
    ).rejects.toThrow('boom: new topic ingest');

    expect(repliedText()).toContain(expectedNotice());
  });

  it('successful delivery sends no failure notice', async () => {
    const anchor = 'om_thread_root_3';
    const ds = seedThreadSession(anchor, 'seeded');
    (ds as any).worker = { killed: false, send: vi.fn() };

    await handleThreadReply(makeEventData('om_msg_4', 'all good'), makeCtx(anchor, 'om_msg_4'));

    expect(repliedText()).not.toContain(expectedNotice());
  });
});
