import { beforeEach, describe, expect, it, vi } from 'vitest';

const daemonHelpers = vi.hoisted(() => ({
  downloadResources: vi.fn(),
  ensureSessionWhiteboard: vi.fn(),
  getAvailableBots: vi.fn(),
  resolveSender: vi.fn(),
  sendWorkerInput: vi.fn(),
  forkWorker: vi.fn(),
  forkAdoptWorker: vi.fn(),
  validateVcOrigin: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../src/core/session-manager.js')>(
    '../src/core/session-manager.js',
  );
  return {
    ...actual,
    downloadResources: daemonHelpers.downloadResources,
    ensureSessionWhiteboard: daemonHelpers.ensureSessionWhiteboard,
    getAvailableBots: daemonHelpers.getAvailableBots,
  };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<typeof import('../src/im/lark/identity-cache.js')>(
    '../src/im/lark/identity-cache.js',
  );
  return { ...actual, resolveSender: daemonHelpers.resolveSender };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<typeof import('../src/core/worker-pool.js')>(
    '../src/core/worker-pool.js',
  );
  return {
    ...actual,
    sendWorkerInput: daemonHelpers.sendWorkerInput,
    forkWorker: daemonHelpers.forkWorker,
    forkAdoptWorker: daemonHelpers.forkAdoptWorker,
  };
});

vi.mock('../src/services/vc-meeting-send-policy.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/vc-meeting-send-policy.js')>(
    '../src/services/vc-meeting-send-policy.js',
  );
  return {
    ...actual,
    isCurrentVcMeetingImTurnOrigin: daemonHelpers.validateVcOrigin,
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/session-store.js')>(
    '../src/services/session-store.js',
  );
  return { ...actual, updateSession: daemonHelpers.updateSession };
});

import {
  __testOnly_resetBotRegistry,
  getBot,
  registerBot,
} from '../src/bot-registry.js';
import {
  normalizeOrdinaryImTurn,
  type OrdinaryImTransportEnvelope,
  type OrdinaryImVcTurnOrigin,
} from '../src/core/ordinary-im-turn.js';
import type {
  OrdinaryIngressPort,
  OrdinaryIngressTransitionResult,
} from '../src/core/session-runtime.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import {
  createCurrentOrdinaryIngressDaemonPort,
  type CurrentOrdinaryIngressDaemonOptions,
} from '../src/im/lark/current-ordinary-ingress-daemon.js';
import type { CliId } from '../src/adapters/cli/types.js';
import type { Session } from '../src/types.js';

const OWNER = 'cli_current_ordinary_daemon';
const SESSION_ID = 'session-current-ordinary-daemon';
const ANCHOR = 'om_current_ordinary_daemon_root';
const CHAT_ID = 'oc_current_ordinary_daemon_chat';
const MESSAGE_ID = 'om_current_ordinary_daemon_turn';
const CREATED_AT = '2026-08-10T00:00:00.000Z';

const VC_ORIGIN: OrdinaryImVcTurnOrigin = {
  listenerAppId: 'cli_vc_listener',
  meetingId: 'meeting-current-ordinary',
  memberId: 'member-current-ordinary',
  memberEpoch: 3,
  agentAppId: OWNER,
  ownerBootId: 'boot-current-ordinary',
  ownerEpoch: 5,
  membershipGeneration: 7,
  sinkOwnerGeneration: 11,
  receiverSessionId: SESSION_ID,
  larkMessageId: MESSAGE_ID,
};

function daemonSession(input: {
  cliId?: CliId;
  mode?: 'opening' | 'live' | 'adopt';
  vcReceiver?: boolean;
} = {}): DaemonSession {
  const mode = input.mode ?? 'opening';
  const session = {
    sessionId: SESSION_ID,
    larkAppId: OWNER,
    rootMessageId: ANCHOR,
    chatId: CHAT_ID,
    chatType: 'group',
    scope: 'thread',
    status: 'active',
    title: 'Current ordinary daemon composition',
    createdAt: CREATED_AT,
    ...(input.cliId === undefined ? {} : { cliId: input.cliId }),
    ...(mode === 'opening' ? { initialUserTurnPending: true } : {}),
    ...(input.vcReceiver
      ? {
          vcMeetingReceiver: {
            listenerAppId: VC_ORIGIN.listenerAppId,
            meetingId: VC_ORIGIN.meetingId,
            memberId: VC_ORIGIN.memberId,
            memberEpoch: VC_ORIGIN.memberEpoch,
          },
        }
      : {}),
  } as Session;
  const adoptedFrom = mode === 'adopt'
    ? {
        source: 'tmux' as const,
        tmuxTarget: 'current-daemon:0.1',
        cwd: '/repo/current-daemon',
      }
    : undefined;
  if (adoptedFrom) session.adoptedFrom = adoptedFrom;
  return {
    session,
    worker: mode === 'live'
      ? ({ killed: false } as DaemonSession['worker'])
      : null,
    workerPort: null,
    workerToken: null,
    workerGeneration: 13,
    larkAppId: OWNER,
    chatId: CHAT_ID,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.parse(CREATED_AT),
    cliVersion: 'test',
    lastMessageAt: Date.parse(CREATED_AT),
    hasHistory: mode !== 'opening',
    ...(adoptedFrom ? { adoptedFrom } : {}),
  } as DaemonSession;
}

function envelope(input: {
  canonicalAnchor?: string;
  sender?: OrdinaryImTransportEnvelope['sender'];
  resources?: OrdinaryImTransportEnvelope['resources'];
  mentions?: OrdinaryImTransportEnvelope['mentions'];
  vc?: OrdinaryImTransportEnvelope['vc'];
} = {}): OrdinaryImTransportEnvelope {
  return {
    route: {
      scope: 'thread',
      canonicalAnchor: input.canonicalAnchor ?? ANCHOR,
      chatId: CHAT_ID,
      chatType: 'group',
    },
    source: 'lark.im',
    messageKey: MESSAGE_ID,
    content: 'compose the exact Current ordinary daemon turn',
    sender: input.sender ?? { kind: 'human', openId: 'ou_current_sender' },
    mentions: input.mentions ?? [],
    postParticipantMentions: [],
    resources: input.resources ?? [],
    foldedForwardContext: false,
    vc: input.vc ?? { contextMayLag: false },
  };
}

function allowedQuota(): CurrentOrdinaryIngressDaemonOptions['checkQuota'] {
  return vi.fn(async () => ({ kind: 'ok', value: null }));
}

function createPort(
  current: DaemonSession,
  input: Partial<Pick<
    CurrentOrdinaryIngressDaemonOptions,
    'checkQuota' | 'notifyDownloadLoginRequired' | 'isPeerBot'
  >> = {},
): OrdinaryIngressPort {
  return createCurrentOrdinaryIngressDaemonPort({
    ownerLarkAppId: OWNER,
    activeSessions: new Map([[activeSessionKey(current), current]]),
    activation: {
      ensure: vi.fn(async (request) => {
        if (request.executor === 'adopt') {
          daemonHelpers.forkAdoptWorker(current, {
            prompt: typeof request.promptInput === 'string'
              ? request.promptInput
              : request.promptInput.content,
            turnId: typeof request.resumeOrTurnId === 'object'
              ? request.resumeOrTurnId.turnId
              : undefined,
          });
        } else {
          daemonHelpers.forkWorker(current, request.promptInput, request.resumeOrTurnId);
        }
        return { kind: 'active', action: 'activated' };
      }),
    },
    checkQuota: input.checkQuota ?? allowedQuota(),
    notifyDownloadLoginRequired: input.notifyDownloadLoginRequired ?? vi.fn(),
    ...(input.isPeerBot === undefined ? {} : { isPeerBot: input.isPeerBot }),
  });
}

async function runOneTurn(
  port: OrdinaryIngressPort,
  input: OrdinaryImTransportEnvelope = envelope(),
): Promise<OrdinaryIngressTransitionResult> {
  const normalized = normalizeOrdinaryImTurn(input);
  if (normalized.kind !== 'normalized') throw new Error(normalized.message);
  let transition = port.begin({ sessionId: SESSION_ID, turn: normalized.turn });
  if (transition.kind !== 'effect') throw new Error(`expected materialization, got ${transition.kind}`);
  while (transition.kind === 'effect') {
    const continuation = transition.continuation;
    try {
      const value = await port.execute(transition.intent);
      transition = port.resume(continuation, { kind: 'returned', value });
    } catch (error) {
      transition = port.resume(continuation, { kind: 'threw', error });
    }
  }
  return transition;
}

beforeEach(() => {
  vi.resetAllMocks();
  __testOnly_resetBotRegistry();
  const bot = registerBot({
    larkAppId: OWNER,
    larkAppSecret: 'test-secret',
    cliId: 'codex-app',
    cliPathOverride: '/opt/current-codex-app',
    displayName: 'Current Owner',
    lang: 'en',
    substituteMode: {
      enabled: true,
      targets: [],
      replyMode: 'quote',
    },
  });
  bot.botName = 'Resolved Owner';
  bot.botOpenId = 'ou_current_owner';

  daemonHelpers.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
  daemonHelpers.ensureSessionWhiteboard.mockImplementation((current: DaemonSession) => {
    current.session.whiteboardId = 'whiteboard-current-ordinary';
  });
  daemonHelpers.getAvailableBots.mockResolvedValue([]);
  daemonHelpers.resolveSender.mockImplementation(
    async (_owner: string, openId: string | undefined, senderType: string | undefined) => (
      openId
        ? {
            openId,
            type: senderType === 'bot' || senderType === 'app' ? 'bot' : 'user',
            name: 'Resolved Sender',
          }
        : undefined
    ),
  );
  daemonHelpers.sendWorkerInput.mockReturnValue(true);
  daemonHelpers.forkWorker.mockReturnValue(true);
  daemonHelpers.forkAdoptWorker.mockImplementation((current: DaemonSession) => {
    current.workerGeneration = (current.workerGeneration ?? 0) + 1;
    current.worker = { killed: false } as DaemonSession['worker'];
  });
  daemonHelpers.validateVcOrigin.mockReturnValue(true);
  daemonHelpers.updateSession.mockImplementation(() => undefined);
});

describe('Current ordinary ingress daemon composition Adapter', () => {
  it('maps detached materialization into the actual daemon helpers and returns one stable port', async () => {
    daemonHelpers.downloadResources.mockResolvedValue({
      attachments: [{ type: 'image', path: '/downloads/diagram.png', name: 'diagram.png' }],
      needLogin: false,
    });
    daemonHelpers.getAvailableBots.mockResolvedValue([
      { name: 'helper', displayName: 'Helper Bot', openId: 'ou_helper_bot' },
    ]);
    const checkQuota = allowedQuota();
    const isPeerBot = vi.fn((openId: string) => openId === 'ou_peer_bot');
    const current = daemonSession();
    const port = createPort(current, { checkQuota, isPeerBot });
    const stableMethods = {
      begin: port.begin,
      execute: port.execute,
      resume: port.resume,
    };

    // Bot identity and CLI selection are a factory-time snapshot, not mutable
    // registry state retained across the materialization awaits.
    getBot(OWNER).config.cliId = 'claude-code';
    getBot(OWNER).config.displayName = 'Changed Owner';
    getBot(OWNER).botOpenId = 'ou_changed_owner';

    const outcome = await runOneTurn(port, envelope({
      resources: [{
        type: 'image',
        resourceKey: 'img_exact_resource',
        sourceMessageKey: 'om_exact_resource_source',
        name: 'diagram.png',
      }],
      mentions: [
        { key: '@_self', name: 'Current Owner', openId: 'ou_current_owner' },
        { key: '@_peer', name: 'Peer Bot', openId: 'ou_peer_bot' },
      ],
    }));

    expect(outcome).toEqual({ kind: 'committed' });
    expect(port.begin).toBe(stableMethods.begin);
    expect(port.execute).toBe(stableMethods.execute);
    expect(port.resume).toBe(stableMethods.resume);
    expect(checkQuota).toHaveBeenCalledWith(expect.objectContaining({
      ownerLarkAppId: OWNER,
      sessionId: SESSION_ID,
      turnId: MESSAGE_ID,
      route: expect.objectContaining({ chatId: CHAT_ID, canonicalAnchor: ANCHOR }),
      sender: { kind: 'human', openId: 'ou_current_sender' },
      messageListener: false,
    }));
    expect(daemonHelpers.ensureSessionWhiteboard).toHaveBeenCalledWith(current);
    expect(daemonHelpers.ensureSessionWhiteboard.mock.invocationCallOrder[0])
      .toBeLessThan(checkQuota.mock.invocationCallOrder[0]!);
    expect(Object.isFrozen(checkQuota.mock.calls[0]![0])).toBe(true);
    expect(daemonHelpers.downloadResources).toHaveBeenCalledWith(
      OWNER,
      MESSAGE_ID,
      [{
        type: 'image',
        key: 'img_exact_resource',
        messageId: 'om_exact_resource_source',
        name: 'diagram.png',
      }],
    );
    expect(daemonHelpers.resolveSender).toHaveBeenCalledWith(
      OWNER,
      'ou_current_sender',
      'user',
      { type: 'user', messageId: MESSAGE_ID },
    );
    expect(daemonHelpers.getAvailableBots).toHaveBeenCalledWith(OWNER, CHAT_ID);
    expect(isPeerBot).toHaveBeenCalledWith('ou_peer_bot');
    expect(daemonHelpers.forkWorker).toHaveBeenCalledTimes(1);
    const forkInput = daemonHelpers.forkWorker.mock.calls[0]![1] as {
      content: string;
      codexAppInput?: unknown;
    };
    expect(forkInput.content).toContain('Helper Bot');
    expect(forkInput.content).toContain('/downloads/diagram.png');
    expect(forkInput.codexAppInput).toBeDefined();
    expect(daemonHelpers.sendWorkerInput).not.toHaveBeenCalled();
    expect(daemonHelpers.forkAdoptWorker).not.toHaveBeenCalled();
  });

  it.each([
    { cliId: 'codex-app' as const, hasStructuredInput: true },
    { cliId: 'claude-code' as const, hasStructuredInput: false },
  ])('preserves the real opening helper contract for $cliId', async ({
    cliId,
    hasStructuredInput,
  }) => {
    const outcome = await runOneTurn(createPort(daemonSession({ cliId })));

    expect(outcome).toEqual({ kind: 'committed' });
    expect(daemonHelpers.forkWorker).toHaveBeenCalledTimes(1);
    const payload = daemonHelpers.forkWorker.mock.calls[0]![1] as {
      content: string;
      codexAppInput?: unknown;
    };
    expect(payload.codexAppInput === undefined).toBe(!hasStructuredInput);
    expect(daemonHelpers.forkWorker.mock.calls[0]![2]).toEqual({
      resume: false,
      turnId: MESSAGE_ID,
    });
    expect(daemonHelpers.sendWorkerInput).not.toHaveBeenCalled();
    expect(daemonHelpers.forkAdoptWorker).not.toHaveBeenCalled();
  });

  it('maps an adopted Current binding only to the real adopt helper', async () => {
    const current = daemonSession({ cliId: 'codex-app', mode: 'adopt' });

    const outcome = await runOneTurn(createPort(current));

    expect(outcome).toEqual({ kind: 'committed' });
    expect(daemonHelpers.forkAdoptWorker).toHaveBeenCalledTimes(1);
    expect(daemonHelpers.ensureSessionWhiteboard).not.toHaveBeenCalled();
    expect(daemonHelpers.forkAdoptWorker.mock.calls[0]![0]).toBe(current);
    expect(daemonHelpers.forkAdoptWorker.mock.calls[0]![1]).toMatchObject({
      turnId: MESSAGE_ID,
      prompt: expect.stringContaining('compose the exact Current ordinary daemon turn'),
    });
    expect(daemonHelpers.forkWorker).not.toHaveBeenCalled();
    expect(daemonHelpers.sendWorkerInput).not.toHaveBeenCalled();
  });

  it('fails closed on quota refusal before any materialization or worker helper', async () => {
    const checkQuota: CurrentOrdinaryIngressDaemonOptions['checkQuota'] = vi.fn(
      async () => ({ kind: 'refused', message: 'quota refused exact turn' }),
    );

    const outcome = await runOneTurn(createPort(daemonSession(), { checkQuota }));

    expect(outcome).toEqual({ kind: 'notCommitted', message: 'quota refused exact turn' });
    expect(daemonHelpers.downloadResources).not.toHaveBeenCalled();
    expect(daemonHelpers.resolveSender).not.toHaveBeenCalled();
    expect(daemonHelpers.getAvailableBots).not.toHaveBeenCalled();
    expect(daemonHelpers.sendWorkerInput).not.toHaveBeenCalled();
    expect(daemonHelpers.forkWorker).not.toHaveBeenCalled();
    expect(daemonHelpers.forkAdoptWorker).not.toHaveBeenCalled();
  });

  it('revalidates the full VC origin and reaches no worker on a generation mismatch', async () => {
    daemonHelpers.validateVcOrigin.mockReturnValue(false);
    const current = daemonSession({ vcReceiver: true });

    const outcome = await runOneTurn(createPort(current), envelope({
      canonicalAnchor: `vc-receiver:${SESSION_ID}`,
      vc: { contextMayLag: false, imTurnOrigin: VC_ORIGIN },
    }));

    expect(outcome).toMatchObject({
      kind: 'notCommitted',
      message: expect.stringContaining('VC authority generation is stale'),
    });
    expect(daemonHelpers.validateVcOrigin).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        listenerAppId: VC_ORIGIN.listenerAppId,
        meetingId: VC_ORIGIN.meetingId,
        memberId: VC_ORIGIN.memberId,
        receiverSessionId: SESSION_ID,
      }),
      CHAT_ID,
    );
    expect(daemonHelpers.sendWorkerInput).not.toHaveBeenCalled();
    expect(daemonHelpers.forkWorker).not.toHaveBeenCalled();
    expect(daemonHelpers.forkAdoptWorker).not.toHaveBeenCalled();
  });

  it('keeps downloaded material when the detached login notification rejects', async () => {
    daemonHelpers.downloadResources.mockResolvedValue({
      attachments: [{ type: 'file', path: '/downloads/spec.pdf', name: 'spec.pdf' }],
      needLogin: true,
    });
    const notifyDownloadLoginRequired = vi.fn(async () => {
      throw new Error('auxiliary notification transport failed');
    });
    const port = createPort(daemonSession({ cliId: 'claude-code' }), {
      notifyDownloadLoginRequired,
    });

    const outcome = await runOneTurn(port, envelope({
      resources: [{
        type: 'file',
        resourceKey: 'file_exact_resource',
        name: 'spec.pdf',
      }],
    }));
    await Promise.resolve();

    expect(outcome).toEqual({ kind: 'committed' });
    expect(notifyDownloadLoginRequired).toHaveBeenCalledWith({
      ownerLarkAppId: OWNER,
      sessionId: SESSION_ID,
      turnId: MESSAGE_ID,
      route: {
        scope: 'thread',
        canonicalAnchor: ANCHOR,
        chatId: CHAT_ID,
        chatType: 'group',
      },
    });
    expect(Object.isFrozen(notifyDownloadLoginRequired.mock.calls[0]![0])).toBe(true);
    expect(daemonHelpers.forkWorker).toHaveBeenCalledTimes(1);
    expect(daemonHelpers.forkWorker.mock.calls[0]![1]).toMatchObject({
      content: expect.stringContaining('/downloads/spec.pdf'),
    });
  });
});
