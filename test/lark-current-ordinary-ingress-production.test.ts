import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliId } from '../src/adapters/cli/types.js';
import type { CurrentOrdinaryIngressWorkerProcessCommand } from '../src/core/current-ordinary-ingress-production.js';
import { normalizeOrdinaryImTurn, type OrdinaryImTransportEnvelope } from '../src/core/ordinary-im-turn.js';
import type { OrdinaryIngressPort, OrdinaryIngressTransitionResult } from '../src/core/session-runtime.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import {
  createLarkCurrentOrdinaryIngressProductionPort,
  type LarkOrdinaryIngressMaterializationEffects,
} from '../src/im/lark/current-ordinary-ingress-production.js';
import { __testOnly_resetBotRegistry, registerBot } from '../src/bot-registry.js';
import type { Session } from '../src/types.js';

vi.mock('../src/services/session-store.js', () => ({ updateSession: vi.fn() }));

const whiteboardStore = vi.hoisted(() => ({
  archived: false,
  getWhiteboard: vi.fn((id: string) => ({
    id,
    title: 'Current whiteboard',
    scope: 'project' as const,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...(whiteboardStore.archived ? { archived: true } : {}),
  })),
}));

vi.mock('../src/services/whiteboard-store.js', () => ({
  ensureDefaultWhiteboard: vi.fn(),
  getWhiteboard: whiteboardStore.getWhiteboard,
  whiteboardBoardPath: vi.fn((id: string) => `/tmp/whiteboards/${id}/board.md`),
  whiteboardEnabled: vi.fn(() => true),
}));

const OWNER = 'cli_lark_materializer_owner';
const SESSION_ID = 'session-lark-materializer';
const ANCHOR = 'om_lark_materializer_root';
const CHAT_ID = 'oc_lark_materializer_chat';
const MESSAGE_ID = 'om_lark_materializer_turn';

beforeEach(() => {
  whiteboardStore.archived = false;
  whiteboardStore.getWhiteboard.mockClear();
  __testOnly_resetBotRegistry();
  registerBot({
    larkAppId: OWNER,
    larkAppSecret: 'secret',
    cliId: 'codex',
    botName: 'Owner Bot',
  });
});

function daemonSession(cliId: CliId): DaemonSession {
  const session = {
    sessionId: SESSION_ID,
    larkAppId: OWNER,
    rootMessageId: ANCHOR,
    chatId: CHAT_ID,
    chatType: 'group',
    scope: 'thread',
    status: 'active',
    title: 'materializer',
    cliId,
    initialUserTurnPending: true,
    createdAt: '2026-08-10T00:00:00.000Z',
  } as Session;
  return {
    session,
    worker: { killed: false } as DaemonSession['worker'],
    workerPort: null,
    workerToken: null,
    workerGeneration: 9,
    larkAppId: OWNER,
    chatId: CHAT_ID,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.parse('2026-08-10T00:00:00.000Z'),
    cliVersion: 'test',
    lastMessageAt: Date.parse('2026-08-10T00:00:00.000Z'),
    hasHistory: false,
  } as DaemonSession;
}

function semanticTurn(): OrdinaryImTransportEnvelope {
  return {
    route: {
      scope: 'thread',
      canonicalAnchor: ANCHOR,
      chatId: CHAT_ID,
      chatType: 'group',
    },
    source: 'lark.im',
    messageKey: MESSAGE_ID,
    content: 'raw Lark-authored request',
    quotedMessageKey: 'om_quoted_evidence',
    sender: { kind: 'bot', openId: 'ou_peer_bot', unionId: 'on_peer_bot' },
    mentions: [{ key: '@_user_1', name: 'Reviewer', openId: 'ou_reviewer' }],
    postParticipantMentions: [],
    resources: [{
      type: 'image',
      resourceKey: 'img_resource_key',
      sourceMessageKey: 'om_resource_source',
      name: 'diagram.png',
    }],
    rewrite: { kind: 'workflowGrill', goal: 'ship the exact workflow' },
    substitute: {
      target: { name: 'Primary', openId: 'ou_primary' },
      observedMention: { name: 'Observed', openId: 'ou_observed' },
      disclosure: 'prefix',
    },
    foldedForwardContext: false,
    vc: { contextMayLag: true, lifecycle: 'sealed' },
  };
}

function assertDetached(value: object): void {
  for (const field of ['current', 'daemonSession', 'session', 'worker', 'disposition']) {
    expect(field in value).toBe(false);
  }
  expect(Object.isFrozen(value)).toBe(true);
}

function metadataPolicy() {
  return {
    metadata: {
      apply(_current: DaemonSession, input: { binding: { sessionId: string }; turn: { messageKey: string } }) {
        return {
          kind: 'committed' as const,
          sessionId: input.binding.sessionId,
          turnId: input.turn.messageKey,
        };
      },
    },
    clock: () => Date.parse('2026-08-10T00:00:01.000Z'),
    substituteReplyMode: 'thread' as const,
  };
}

async function runOneTurn(
  port: OrdinaryIngressPort,
  input: OrdinaryImTransportEnvelope = semanticTurn(),
): Promise<OrdinaryIngressTransitionResult> {
  const normalized = normalizeOrdinaryImTurn(input);
  if (normalized.kind !== 'normalized') throw new Error(normalized.message);
  const begun = port.begin({ sessionId: SESSION_ID, turn: normalized.turn });
  if (begun.kind !== 'effect') throw new Error(`expected materialization, got ${begun.kind}`);
  try {
    const value = await port.execute(begun.intent);
    return port.resume(begun.continuation, { kind: 'returned', value });
  } catch (error) {
    return port.resume(begun.continuation, { kind: 'threw', error });
  }
}

async function deliver(
  cliId: CliId,
  mode: 'opening' | 'follow-up' | 'adopt' = 'opening',
): Promise<{
  command: CurrentOrdinaryIngressWorkerProcessCommand;
  input: Record<string, unknown>;
  effectKinds: string[];
}> {
  const ds = daemonSession(cliId);
  if (mode !== 'opening') ds.session.initialUserTurnPending = undefined;
  if (mode === 'adopt') {
    ds.worker = null;
    ds.adoptedFrom = {
      source: 'tmux',
      tmuxTarget: 'developer:0.1',
      cwd: '/repo',
    };
  }
  const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(ds), ds]]);
  const effectKinds: string[] = [];
  const effects: LarkOrdinaryIngressMaterializationEffects = {
    async checkQuota(input) {
      assertDetached(input);
      effectKinds.push('quota');
      expect(input).toMatchObject({
        ownerLarkAppId: OWNER,
        sessionId: SESSION_ID,
        turnId: MESSAGE_ID,
        sender: { kind: 'bot', openId: 'ou_peer_bot', unionId: 'on_peer_bot' },
      });
      return { kind: 'ok', value: null };
    },
    async downloadResources(input) {
      assertDetached(input);
      effectKinds.push('resources');
      expect(input.resources).toEqual([{
        type: 'image',
        resourceKey: 'img_resource_key',
        sourceMessageKey: 'om_resource_source',
        name: 'diagram.png',
      }]);
      return {
        kind: 'ok',
        value: [{ type: 'image', path: '/detached/diagram.png', name: 'diagram.png' }],
      };
    },
    async resolveSender(input) {
      assertDetached(input);
      effectKinds.push('sender');
      return {
        kind: 'ok',
        value: { openId: input.sender.openId!, type: 'bot', name: 'Peer Bot' },
      };
    },
    async listAvailableBots(input) {
      assertDetached(input);
      effectKinds.push('bots');
      return {
        kind: 'ok',
        value: [{ name: 'helper', displayName: 'Helper Bot', openId: 'ou_helper' }],
      };
    },
  };
  const workerCommands: CurrentOrdinaryIngressWorkerProcessCommand[] = [];
  const port = createLarkCurrentOrdinaryIngressProductionPort({
    ownerLarkAppId: OWNER,
    activeSessions,
    ...metadataPolicy(),
    bot: {
      defaultCliId: 'codex',
      name: 'Owner Bot',
      openId: 'ou_owner_bot',
      locale: 'en',
    },
    effects,
    workerProcesses: {
      dispatch(command) {
        assertDetached(command);
        workerCommands.push(command);
        return { kind: 'accepted' };
      },
    },
  });
  const resumed = await runOneTurn(port);

  expect(resumed).toEqual({ kind: 'committed' });
  expect(workerCommands).toHaveLength(1);
  const command = workerCommands[0]!;
  return {
    command,
    input: command.input as unknown as Record<string, unknown>,
    effectKinds,
  };
}

function plainHumanTurn(): OrdinaryImTransportEnvelope {
  return {
    route: {
      scope: 'thread',
      canonicalAnchor: ANCHOR,
      chatId: CHAT_ID,
      chatType: 'group',
    },
    source: 'lark.im',
    messageKey: MESSAGE_ID,
    content: 'plain human request',
    sender: { kind: 'human', openId: 'ou_human' },
    mentions: [],
    postParticipantMentions: [],
    resources: [],
    foldedForwardContext: false,
    vc: { contextMayLag: false },
  };
}

async function deliverSteerPolicyCase(input: {
  turn?: OrdinaryImTransportEnvelope;
  mode?: 'opening' | 'follow-up' | 'adopt';
  configureSession?: (ds: DaemonSession) => void;
} = {}): Promise<CurrentOrdinaryIngressWorkerProcessCommand> {
  const ds = daemonSession('codex-app');
  const mode = input.mode ?? 'follow-up';
  if (mode !== 'opening') ds.session.initialUserTurnPending = undefined;
  if (mode === 'adopt') {
    ds.worker = null;
    ds.adoptedFrom = {
      source: 'tmux',
      tmuxTarget: 'developer:0.1',
      cwd: '/repo',
    };
  }
  input.configureSession?.(ds);
  const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(ds), ds]]);
  const workerCommands: CurrentOrdinaryIngressWorkerProcessCommand[] = [];
  const port = createLarkCurrentOrdinaryIngressProductionPort({
    ownerLarkAppId: OWNER,
    activeSessions,
    ...metadataPolicy(),
    bot: { defaultCliId: 'codex-app', locale: 'en' },
    effects: {
      async checkQuota() {
        return { kind: 'ok', value: null };
      },
      async downloadResources() {
        return { kind: 'ok', value: [] };
      },
      async resolveSender(senderInput) {
        return {
          kind: 'ok',
          value: senderInput.sender.openId
            ? {
                openId: senderInput.sender.openId,
                type: senderInput.sender.kind === 'bot' ? 'bot' : 'user',
              }
            : undefined,
        };
      },
      async listAvailableBots() {
        return { kind: 'ok', value: [] };
      },
    },
    workerProcesses: {
      dispatch(command) {
        workerCommands.push(command);
        return { kind: 'accepted' };
      },
    },
  });

  const outcome = await runOneTurn(port, input.turn ?? plainHumanTurn());
  expect(outcome).toEqual({ kind: 'committed' });
  expect(workerCommands).toHaveLength(1);
  return workerCommands[0]!;
}

describe('Lark Current ordinary ingress production composition', () => {
  it.each(['opening', 'follow-up'] as const)(
    'authorizes an ordinary human %s through the live Current materializer',
    async (mode) => {
      const command = await deliverSteerPolicyCase({ mode });

      expect(command.input.codexAppSteerable).toBe(true);
    },
  );

  it.each([
    {
      source: 'unknown sender',
      turn: { ...plainHumanTurn(), sender: { kind: 'unknown' as const } },
    },
    {
      source: 'peer Bot sender',
      turn: {
        ...plainHumanTurn(),
        sender: { kind: 'bot' as const, openId: 'ou_peer_bot' },
      },
    },
    {
      source: 'workflow rewrite',
      turn: {
        ...plainHumanTurn(),
        rewrite: { kind: 'workflowGrill' as const, goal: 'review this plan' },
      },
    },
    {
      source: 'substitute trigger',
      turn: {
        ...plainHumanTurn(),
        substitute: {
          target: { name: 'Primary', openId: 'ou_primary' },
          disclosure: 'prefix' as const,
        },
      },
    },
    {
      source: 'message listener',
      turn: {
        ...plainHumanTurn(),
        messageListener: {
          prompt: 'listener prompt',
          messageText: 'plain human request',
          msgType: 'text',
          senderType: 'user' as const,
        },
      },
    },
    {
      source: 'VC IM origin',
      turn: {
        ...plainHumanTurn(),
        vc: {
          contextMayLag: false,
          imTurnOrigin: {
            listenerAppId: OWNER,
            meetingId: 'meeting-policy',
            memberId: 'member-policy',
            memberEpoch: 1,
            agentAppId: OWNER,
            ownerBootId: 'boot-policy',
            ownerEpoch: 1,
            membershipGeneration: 1,
            sinkOwnerGeneration: 1,
            receiverSessionId: SESSION_ID,
            larkMessageId: MESSAGE_ID,
          },
        },
      },
    },
  ])('keeps $source forced-serial through the live Current materializer', async ({ turn }) => {
    const command = await deliverSteerPolicyCase({ turn });

    expect(command.input.codexAppSteerable).toBeUndefined();
  });

  it('keeps adopted and dedicated VC-receiver Sessions forced-serial', async () => {
    const adopted = await deliverSteerPolicyCase({ mode: 'adopt' });
    const vcReceiver = await deliverSteerPolicyCase({
      turn: {
        ...plainHumanTurn(),
        route: {
          ...plainHumanTurn().route,
          canonicalAnchor: `vc-receiver:${SESSION_ID}`,
        },
      },
      configureSession(ds) {
        ds.session.vcMeetingReceiver = {
          listenerAppId: OWNER,
          meetingId: 'meeting-policy',
          memberId: 'member-policy',
          memberEpoch: 1,
        };
      },
    });

    expect(adopted.input.codexAppSteerable).toBeUndefined();
    expect(vcReceiver.input.codexAppSteerable).toBeUndefined();
  });

  it('freezes one whiteboard prompt snapshot before async materialization', async () => {
    const ds = daemonSession('codex-app');
    ds.session.whiteboardId = 'wb_snapshot_before_io';
    const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(ds), ds]]);
    const quota = vi.fn(async () => {
      whiteboardStore.archived = true;
      return { kind: 'ok' as const, value: null };
    });
    const workerCommands: CurrentOrdinaryIngressWorkerProcessCommand[] = [];
    const port = createLarkCurrentOrdinaryIngressProductionPort({
      ownerLarkAppId: OWNER,
      activeSessions,
      ...metadataPolicy(),
      bot: { defaultCliId: 'codex-app', locale: 'en' },
      effects: {
        checkQuota: quota,
        async downloadResources() {
          return { kind: 'ok', value: [] };
        },
        async resolveSender() {
          return { kind: 'ok', value: undefined };
        },
        async listAvailableBots() {
          return { kind: 'ok', value: [] };
        },
      },
      workerProcesses: {
        dispatch(command) {
          workerCommands.push(command);
          return { kind: 'accepted' };
        },
      },
    });

    const outcome = await runOneTurn(port, {
      ...semanticTurn(),
      sender: { kind: 'human' },
      resources: [],
    });

    expect(outcome).toEqual({ kind: 'committed' });
    expect(whiteboardStore.getWhiteboard).toHaveBeenCalledTimes(1);
    expect(whiteboardStore.getWhiteboard.mock.invocationCallOrder[0])
      .toBeLessThan(quota.mock.invocationCallOrder[0]!);
    expect(workerCommands).toHaveLength(1);
    const delivered = workerCommands[0]!.input;
    expect(delivered.content).toContain('<whiteboard id="wb_snapshot_before_io">');
    expect(delivered.codexAppInput).toMatchObject({
      additionalContext: {
        botmux_whiteboard: {
          kind: 'application',
          value: expect.stringContaining('<whiteboard id="wb_snapshot_before_io">'),
        },
      },
    });
  });

  it.each(['codex-app', 'codex'] as const)(
    'renders one exact opening with the same Lark semantics for %s',
    async (cliId) => {
      const { input, effectKinds } = await deliver(cliId);

      expect(effectKinds).toEqual(['quota', 'resources', 'sender', 'bots']);
      expect(input.content).toEqual(expect.stringContaining('om_quoted_evidence'));
      expect(input.content).toEqual(expect.stringContaining('Peer Bot'));
      expect(input.content).toEqual(expect.stringContaining('ship the exact workflow'));
      expect(input.content).toEqual(expect.stringContaining('会议上下文状态'));
      expect(input.content).toEqual(expect.stringContaining('Primary'));
      expect(input.content).toEqual(expect.stringContaining('/detached/diagram.png'));
      expect(input.content).toEqual(expect.stringContaining('Reviewer'));
      expect(input.content).toEqual(expect.stringContaining('Helper Bot'));
      expect(input.codexAppSteerable).toBeUndefined();

      if (cliId === 'codex-app') {
        expect(input.codexAppInput).toMatchObject({
          text: 'raw Lark-authored request',
          additionalContext: {
            botmux_message_context: {
              kind: 'untrusted',
              value: expect.stringContaining('ship the exact workflow'),
            },
            botmux_application_context: {
              kind: 'application',
              value: expect.stringContaining('会议上下文状态'),
            },
            botmux_substitute_target: {
              kind: 'untrusted',
              value: expect.stringContaining('Observed'),
            },
          },
          localImages: [{ path: '/detached/diagram.png', detail: 'original' }],
        });
      } else {
        expect(input.codexAppInput).toBeUndefined();
      }
    },
  );

  it.each([
    { mode: 'follow-up' as const, commandKind: 'sendWorkerInput' },
    { mode: 'adopt' as const, commandKind: 'forkAdoptWorker' },
  ])('selects the detached $mode candidate only at command time', async ({
    mode,
    commandKind,
  }) => {
    const { command, input, effectKinds } = await deliver('codex-app', mode);

    expect(effectKinds).toEqual(['quota', 'resources', 'sender', 'bots']);
    expect(command.kind).toBe(commandKind);
    expect(input.content).toEqual(expect.stringContaining('ship the exact workflow'));
    expect(input.content).toEqual(expect.stringContaining('/detached/diagram.png'));
    if (mode === 'follow-up') {
      expect(input.content).toEqual(expect.stringContaining('<botmux_reminder>'));
      expect(input.content).not.toEqual(expect.stringContaining('Helper Bot'));
      expect(input.codexAppInput).toMatchObject({ text: 'raw Lark-authored request' });
    } else {
      expect(input.content).not.toEqual(expect.stringContaining('<session_id>'));
      expect(input.content).not.toEqual(expect.stringContaining('<botmux_reminder>'));
      expect(input.codexAppInput).toBeUndefined();
    }
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.input)).toBe(true);
  });

  it.each([
    {
      stage: 'quota',
      expectedCalls: ['quota'],
      mutate(ds: DaemonSession, registry: Map<string, DaemonSession>) {
        registry.set(activeSessionKey(ds), daemonSession('codex'));
      },
    },
    {
      stage: 'resources',
      expectedCalls: ['quota', 'resources'],
      mutate(ds: DaemonSession) {
        ds.session = { ...ds.session };
      },
    },
    {
      stage: 'sender',
      expectedCalls: ['quota', 'resources', 'sender'],
      mutate(ds: DaemonSession) {
        ds.chatId = 'oc_rebound_elsewhere';
      },
    },
    {
      stage: 'bots',
      expectedCalls: ['quota', 'resources', 'sender', 'bots'],
      mutate(ds: DaemonSession) {
        ds.session.cliId = 'gemini';
      },
    },
  ])('fails closed when exact binding changes during $stage I/O', async ({
    stage,
    expectedCalls,
    mutate,
  }) => {
    const ds = daemonSession('codex');
    const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(ds), ds]]);
    const calls: string[] = [];
    const workerCommands: CurrentOrdinaryIngressWorkerProcessCommand[] = [];
    const change = (kind: string): void => {
      calls.push(kind);
      if (kind === stage) mutate(ds, activeSessions);
    };
    const effects: LarkOrdinaryIngressMaterializationEffects = {
      async checkQuota() {
        change('quota');
        return { kind: 'ok', value: null };
      },
      async downloadResources() {
        change('resources');
        return {
          kind: 'ok',
          value: [{ type: 'image', path: '/detached/diagram.png', name: 'diagram.png' }],
        };
      },
      async resolveSender() {
        change('sender');
        return {
          kind: 'ok',
          value: { openId: 'ou_peer_bot', type: 'bot', name: 'Peer Bot' },
        };
      },
      async listAvailableBots() {
        change('bots');
        return { kind: 'ok', value: [] };
      },
    };
    const port = createLarkCurrentOrdinaryIngressProductionPort({
      ownerLarkAppId: OWNER,
      activeSessions,
      ...metadataPolicy(),
      bot: { defaultCliId: 'codex', locale: 'en' },
      effects,
      workerProcesses: {
        dispatch(command) {
          workerCommands.push(command);
          return { kind: 'accepted' };
        },
      },
    });

    const outcome = await runOneTurn(port);

    expect(outcome).toMatchObject({
      kind: 'unknown',
      message: expect.stringContaining('identity changed'),
    });
    expect(calls).toEqual(expectedCalls);
    expect(workerCommands).toEqual([]);
  });

  it.each([
    {
      failure: 'quota refusal',
      expectedKind: 'notCommitted',
      expectedCalls: ['quota'],
      quota: { kind: 'refused' as const, message: 'quota denied this turn' },
      downloadThrows: false,
    },
    {
      failure: 'resource response loss',
      expectedKind: 'unknown',
      expectedCalls: ['quota', 'resources'],
      quota: { kind: 'ok' as const, value: null },
      downloadThrows: true,
    },
  ])('never dispatches after $failure', async ({
    expectedKind,
    expectedCalls,
    quota,
    downloadThrows,
  }) => {
    const ds = daemonSession('codex');
    const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(ds), ds]]);
    const calls: string[] = [];
    const workerCommands: CurrentOrdinaryIngressWorkerProcessCommand[] = [];
    const port = createLarkCurrentOrdinaryIngressProductionPort({
      ownerLarkAppId: OWNER,
      activeSessions,
      ...metadataPolicy(),
      bot: { defaultCliId: 'codex', locale: 'en' },
      effects: {
        async checkQuota() {
          calls.push('quota');
          return quota;
        },
        async downloadResources() {
          calls.push('resources');
          if (downloadThrows) throw new Error('download response was lost');
          return { kind: 'ok', value: [] };
        },
        async resolveSender() {
          calls.push('sender');
          return { kind: 'ok', value: undefined };
        },
        async listAvailableBots() {
          calls.push('bots');
          return { kind: 'ok', value: [] };
        },
      },
      workerProcesses: {
        dispatch(command) {
          workerCommands.push(command);
          return { kind: 'accepted' };
        },
      },
    });

    const outcome = await runOneTurn(port);

    expect(outcome.kind).toBe(expectedKind);
    expect(calls).toEqual(expectedCalls);
    expect(workerCommands).toEqual([]);
  });
});
