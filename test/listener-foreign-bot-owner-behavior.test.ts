/**
 * Behavioral route-level guard for upstream PR #723 review blocker P1-2.
 *
 * This file drives the REAL handleNewTopic route with a bot-typed sender
 * (sender_type='app', as a third-party alert bot / message-listener match
 * arrives) and asserts on the session the route actually opened:
 *   - session.ownerOpenId / ownerUnionId are undefined (foreign-bot senders
 *     own nothing → daemon footers never --mention-back the alert bot, no
 *     self-poke loop, no owner-gated surface leak);
 *   - session.creatorOpenId keeps the raw bot sender (botmux report resolves);
 *   - session.quoteTargetSenderOpenId keeps the raw sender and
 *     quoteTargetSenderIsBot is true (first-turn quote still resolves, but is
 *     flagged as a bot).
 * Control: a human sender (sender_type='user') on the same route DOES become
 * the owner — so the suppression is scoped to bot senders only.
 *
 * The Current ordinary route opens sessions itself (mints the sessionId and
 * publishes one complete row through `sessionStore.updateSession`), so the
 * assertions read the live DaemonSession plus the durable owner-file row
 * instead of a `createSession` spy — there is no such call any more.
 *
 * Run:  pnpm vitest run test/listener-foreign-bot-owner-behavior.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.SESSION_DATA_DIR = `${process.env.TMPDIR ?? '/tmp'}/botmux-listener-owner-behavior-${process.pid}`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  return {
    addReaction: vi.fn(async () => 'reaction_1'),
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_top'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined, senderType: string | undefined) => (
      openId
        ? { openId, type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const }
        : undefined
    )),
    forkWorker: vi.fn(),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    addReaction: mocks.addReaction,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
    getChatMode: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
  };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return { ...actual, forkWorker: (...args: any[]) => mocks.forkWorker(...args) };
});

import { randomUUID } from 'node:crypto';
import { registerBot as registerBotWithIdentity } from '../src/bot-registry.js';
import { parseBotId } from '../src/core/bot-identity.js';

// Bind a stable BotId exactly like daemon startup does: the Current runtime
// host fails closed (requireBotId) for identity-less bots.
function registerBot(config: Parameters<typeof registerBotWithIdentity>[0]) {
  return registerBotWithIdentity(
    config,
    parseBotId(`bot_${randomUUID().replaceAll('-', '')}`),
  );
}
import { sessionKey } from '../src/core/types.js';
import { getSessionForOwnerStrict, init as initSessionStore } from '../src/services/session-store.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
} from '../src/daemon.js';

const APP = 'listener_owner_behavior_app';
const BOT_CHAT = 'oc_listener_owner_behavior_bot_chat';
const HUMAN_CHAT = 'oc_listener_owner_behavior_human_chat';
const OWNER = 'ou_human_owner';
const ALERT_BOT = 'ou_alert_bot_via_this_app';

function makeEventData(
  chatId: string,
  messageId: string,
  senderOpenId: string,
  senderType: 'user' | 'app',
): any {
  return {
    sender: { sender_id: { open_id: senderOpenId, union_id: `on_${senderOpenId}` }, sender_type: senderType },
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'alert fired: disk 95%' }),
      create_time: String(Date.now()),
    },
  };
}

// 普通群 chat-scope routing: the canonical anchor IS the chat id (a message id
// can never anchor a chat-scope route on a live daemon).
function makeCtx(chatId: string, messageId: string, listener: boolean): any {
  return {
    chatId,
    messageId,
    chatType: 'group' as const,
    scope: 'chat' as const,
    anchor: chatId,
    replyRootId: messageId,
    larkAppId: APP,
    ...(listener
      ? {
          // message-listener authorized path: bypasses the allowedUsers quota
          // gate so a third-party bot's card actually spawns a session.
          messageListener: {
            name: 'Argos',
            prompt: 'analyze this alert',
            messageText: 'alert fired: disk 95%',
            msgType: 'text',
            senderType: 'bot',
            senderOpenId: ALERT_BOT,
          },
        }
      : {}),
  };
}

function openedSession(chatId: string) {
  const ds = activeSessions.get(sessionKey(chatId, APP));
  expect(ds, 'the route did not open a session').toBeDefined();
  // The published row must be the exact durable one the runtime is bound to.
  const durable = getSessionForOwnerStrict(APP, ds!.session.sessionId);
  expect(durable, 'the opening was not published to the owner file').toBeDefined();
  return { ds: ds!, session: ds!.session, durable: durable! };
}

describe('handleNewTopic — foreign-bot sender never owns the session (review P1-2, behavioral)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.addReaction.mockResolvedValue('reaction_1');
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.getChatMode.mockResolvedValue('group');
    mocks.getChatNameAndMode.mockResolvedValue({ name: null, mode: 'group' });
    // The fork primitive proves acceptance with `true` and reserves a worker
    // generation on both the DaemonSession and its Session row.
    mocks.forkWorker.mockImplementation((ds: any) => {
      const generation = Math.max(ds.workerGeneration ?? 0, ds.session?.workerGeneration ?? 0) + 1;
      ds.worker = { killed: false, send: vi.fn() };
      ds.workerGeneration = generation;
      if (ds.session) ds.session.workerGeneration = generation;
      return true;
    });
    activeSessions.clear();
    // The Current route reads/writes openings through the owner file
    // `sessions-<appId>.json`; an owner-less init() would write the legacy
    // sessions.json and every publication readback would miss.
    initSessionStore(APP);
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
      // Pin a real dir so the opening policy resolves a workingDir instead of
      // parking on a repo-select card (forkWorker is mocked).
      workingDir: '/tmp',
      oncallChats: [
        { chatId: BOT_CHAT, workingDir: '/tmp' },
        { chatId: HUMAN_CHAT, workingDir: '/tmp' },
      ],
    });
    bot.resolvedAllowedUsers = [OWNER];
  });

  it('bot sender: session opened, but owner suppressed while creator/quoteTarget keep the raw sender', async () => {
    await handleNewTopic(
      makeEventData(BOT_CHAT, 'om_alert_1', ALERT_BOT, 'app'),
      makeCtx(BOT_CHAT, 'om_alert_1', true),
    );

    const { ds, session, durable } = openedSession(BOT_CHAT);
    // The whole point: a bot must NOT be the owner.
    expect(session.ownerOpenId).toBeUndefined();
    expect(session.ownerUnionId).toBeUndefined();
    expect(ds.ownerOpenId).toBeUndefined();
    expect(durable.ownerOpenId).toBeUndefined();
    expect(durable.ownerUnionId).toBeUndefined();
    // …but the raw bot sender is retained for report + first-turn quote.
    expect(session.creatorOpenId).toBe(ALERT_BOT);
    expect(session.quoteTargetSenderOpenId).toBe(ALERT_BOT);
    expect(session.quoteTargetSenderIsBot).toBe(true);
    expect(durable.creatorOpenId).toBe(ALERT_BOT);
  });

  it('control — human sender on the same route DOES become the owner', async () => {
    await handleNewTopic(
      makeEventData(HUMAN_CHAT, 'om_human_1', OWNER, 'user'),
      // human path: no messageListener, normal allowedUsers gate applies.
      makeCtx(HUMAN_CHAT, 'om_human_1', false),
    );

    const { ds, session, durable } = openedSession(HUMAN_CHAT);
    expect(session.ownerOpenId).toBe(OWNER);
    expect(session.ownerUnionId).toBe(`on_${OWNER}`);
    expect(ds.ownerOpenId).toBe(OWNER);
    expect(session.creatorOpenId).toBe(OWNER);
    expect(session.quoteTargetSenderIsBot).toBe(false);
    expect(durable.ownerOpenId).toBe(OWNER);
  });
});
