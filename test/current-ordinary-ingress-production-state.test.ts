import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerBot } from '../src/bot-registry.js';
import {
  createCurrentOrdinaryIngressProductionPort,
  type CurrentOrdinaryIngressProductionExternalEffect,
  type CurrentOrdinaryIngressProductionExternalEffectResult,
  type CurrentOrdinaryIngressWorkerProcessCommand,
  type CurrentOrdinaryIngressWorkerProcessResult,
} from '../src/core/current-ordinary-ingress-production.js';
import type { OrdinaryImTransportEnvelope } from '../src/core/ordinary-im-turn.js';
import type { CurrentOrdinaryIngressMetadataModule } from '../src/core/current-ordinary-ingress-metadata.js';
import {
  createSessionRuntimeHost,
  type KeyedTriggerAuthority,
  type KeyedTriggerTurnPort,
  type OrdinaryIngressCommandOutcome,
  type SessionDirectory,
  type SessionDirectoryRow,
} from '../src/core/session-runtime.js';
import {
  activeSessionAnchorId,
  activeSessionKey,
  type DaemonSession,
} from '../src/core/types.js';
import { promoteQueuedActivationTail } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import type { Session } from '../src/types.js';

vi.mock('../src/services/session-store.js', () => ({
  getSessionFresh: vi.fn(),
  updateSession: vi.fn(),
}));

const getSessionFresh = vi.mocked(sessionStore.getSessionFresh);
const updateSession = vi.mocked(sessionStore.updateSession);

beforeEach(() => {
  registerBot({
    larkAppId: OWNER,
    larkAppSecret: '',
    cliId: 'claude-code',
    apiOnly: true,
  });
  getSessionFresh.mockReset();
  updateSession.mockReset();
});

const OWNER = 'app-production-state';
const SESSION_ID = 'session-production-state';
const ANCHOR = 'om_production_state_root';
const CHAT_ID = 'oc_production_state_chat';

const unusedKeyedAuthority: KeyedTriggerAuthority = {
  inspect: () => ({ kind: 'unreadable', message: 'not used by ordinary ingress' }),
  reserve: () => ({ kind: 'unreadable', message: 'not used by ordinary ingress' }),
  begin: () => ({ kind: 'unreadable', message: 'not used by ordinary ingress' }),
  settleDispatchUnknown: () => ({
    kind: 'unreadable',
    message: 'not used by ordinary ingress',
  }),
};

const unusedKeyedTurns: KeyedTriggerTurnPort = {
  prepare: () => ({ kind: 'unreadable', message: 'not used by ordinary ingress' }),
  acceptAtMostOnce: () => ({ kind: 'refused', message: 'not used by ordinary ingress' }),
  failClose: async () => ({ kind: 'unreadable', message: 'not used by ordinary ingress' }),
};

function envelope(messageKey: string): OrdinaryImTransportEnvelope {
  return {
    route: {
      scope: 'thread',
      canonicalAnchor: ANCHOR,
      chatId: CHAT_ID,
      chatType: 'group',
    },
    source: 'lark.im',
    messageKey,
    content: `user:${messageKey}`,
    sender: { kind: 'human', openId: 'ou_sender', unionId: 'on_sender' },
    mentions: [],
    postParticipantMentions: [],
    resources: [],
    foldedForwardContext: false,
    vc: { contextMayLag: false },
  };
}

function session(): Session {
  return {
    sessionId: SESSION_ID,
    larkAppId: OWNER,
    rootMessageId: ANCHOR,
    chatId: CHAT_ID,
    chatType: 'group',
    scope: 'thread',
    status: 'active',
    title: 'production state',
    createdAt: '2026-08-10T00:00:00.000Z',
  } as Session;
}

function daemonSession(options: {
  worker?: 'live' | 'killed' | 'none';
  hasHistory?: boolean;
} = {}): DaemonSession {
  const workerState = options.worker ?? 'none';
  return {
    session: session(),
    worker: workerState === 'none'
      ? null
      : { killed: workerState === 'killed' } as DaemonSession['worker'],
    workerPort: null,
    workerToken: null,
    workerGeneration: 7,
    larkAppId: OWNER,
    chatId: CHAT_ID,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.parse('2026-08-10T00:00:00.000Z'),
    cliVersion: 'test',
    lastMessageAt: Date.parse('2026-08-10T00:00:00.000Z'),
    hasHistory: options.hasHistory ?? false,
  } as DaemonSession;
}

function rowFor(ds: DaemonSession): SessionDirectoryRow {
  return {
    key: ds.session.sessionId,
    sessionId: ds.session.sessionId,
    route: ds.scope === 'chat'
      ? { kind: 'chat', chatId: ds.chatId }
      : { kind: 'thread', anchorId: ds.session.rootMessageId },
    ordinaryIngressBinding: {
      scope: ds.scope,
      canonicalAnchor: activeSessionAnchorId(ds),
      chatId: ds.chatId,
      chatType: ds.chatType,
    },
    recordStatus: 'active',
    executorStatus: ds.worker && !ds.worker.killed ? 'working' : 'dormant',
  };
}

class RegistryDirectory implements SessionDirectory {
  constructor(private readonly registry: ReadonlyMap<string, DaemonSession>) {}

  async read(query: Parameters<SessionDirectory['read']>[0]) {
    const rows = [...this.registry.values()].map(rowFor);
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

function assertDetached(value: object): void {
  for (const forbidden of ['current', 'daemonSession', 'session', 'worker']) {
    expect(forbidden in value).toBe(false);
  }
}

function materializedFor(
  effect: Extract<CurrentOrdinaryIngressProductionExternalEffect, { kind: 'materialize' }>,
): Extract<CurrentOrdinaryIngressProductionExternalEffectResult, { kind: 'materialized' }> {
  return {
    kind: 'materialized',
    material: {
      userPrompt: effect.input.turn.content,
      newTopicUserPrompt: effect.input.turn.content,
      cliInput: { content: `cli:${effect.input.turn.messageKey}` },
      newTopicCliInput: { content: `new-topic:${effect.input.turn.messageKey}` },
      adoptCliInput: { content: `adopt:${effect.input.turn.messageKey}` },
      turnId: effect.input.turn.messageKey,
    },
  };
}

interface Harness {
  readonly ds: DaemonSession;
  readonly externalEffects: CurrentOrdinaryIngressProductionExternalEffect[];
  readonly workerCommands: CurrentOrdinaryIngressWorkerProcessCommand[];
  submit(turn: OrdinaryImTransportEnvelope): Promise<OrdinaryIngressCommandOutcome>;
}

async function harnessFor(
  ds: DaemonSession,
  options: {
    readonly dispatch?: (
      command: CurrentOrdinaryIngressWorkerProcessCommand,
    ) => CurrentOrdinaryIngressWorkerProcessResult;
    readonly metadata?: CurrentOrdinaryIngressMetadataModule;
  } = {},
): Promise<Harness> {
  const registry = new Map<string, DaemonSession>([[activeSessionKey(ds), ds]]);
  const externalEffects: CurrentOrdinaryIngressProductionExternalEffect[] = [];
  const workerCommands: CurrentOrdinaryIngressWorkerProcessCommand[] = [];
  const ordinaryIngress = createCurrentOrdinaryIngressProductionPort({
    ownerLarkAppId: OWNER,
    activeSessions: registry,
    metadata: options.metadata ?? {
      apply(_current, input) {
        return {
          kind: 'committed',
          sessionId: input.binding.sessionId,
          turnId: input.turn.messageKey,
        };
      },
    },
    clock: () => Date.parse('2026-08-10T00:00:01.000Z'),
    substituteReplyMode: 'thread',
    externalEffects: {
      async execute(
        effect: CurrentOrdinaryIngressProductionExternalEffect,
      ): Promise<CurrentOrdinaryIngressProductionExternalEffectResult> {
        assertDetached(effect);
        externalEffects.push(effect);
        if (effect.kind === 'materialize') return materializedFor(effect);
        return { kind: 'completed' };
      },
    },
    workerProcesses: {
      dispatch(
        command: CurrentOrdinaryIngressWorkerProcessCommand,
      ): CurrentOrdinaryIngressWorkerProcessResult {
        assertDetached(command);
        workerCommands.push(command);
        return options.dispatch?.(command) ?? { kind: 'accepted' };
      },
    },
  });
  const host = createSessionRuntimeHost({
    directory: new RegistryDirectory(registry),
    keyedTriggers: unusedKeyedAuthority,
    keyedTriggerTurns: unusedKeyedTurns,
    ordinaryIngress,
  });
  const projection = await host.projection.read({
    kind: 'byExternalSession',
    sessionId: ds.session.sessionId,
  });
  if (projection.kind !== 'one') throw new Error('expected existing Session projection');

  return {
    ds,
    externalEffects,
    workerCommands,
    submit(turn) {
      return host.runtime.submit({
        target: { kind: 'session', address: projection.session.address },
        idempotencyKey: turn.messageKey,
        command: { kind: 'ordinary.ingress', input: { turn } },
      });
    },
  };
}

function expectApplied(outcome: OrdinaryIngressCommandOutcome): void {
  expect(outcome).toEqual({
    kind: 'applied',
    action: 'ordinary.inputCommitted',
    policy: 'ordinary-replayable',
    durability: 'processLocal',
    sessionId: SESSION_ID,
  });
  for (const privateField of ['state', 'routeState', 'disposition', 'command']) {
    expect(privateField in outcome).toBe(false);
  }
}

function expectOneMaterialization(
  harness: Harness,
  turn: OrdinaryImTransportEnvelope,
): void {
  const materializations = harness.externalEffects.filter(effect => effect.kind === 'materialize');
  expect(materializations).toHaveLength(1);
  expect(materializations[0]).toMatchObject({
    kind: 'materialize',
    input: {
      sessionId: SESSION_ID,
      turn: { messageKey: turn.messageKey, content: turn.content },
    },
  });
}

function currentTailEntry(ds: DaemonSession, turnId: string) {
  return ds.session.queuedActivationTail?.filter(entry => entry.turnId === turnId) ?? [];
}

function oldTailEntry(turnId = 'om_old_tail', order = 1) {
  return {
    id: `tail-${order}`,
    order,
    userPrompt: `user:${turnId}`,
    cliInput: { content: `cli:${turnId}` },
    turnId,
  };
}

describe('Current ordinary ingress production state precedence', () => {
  it('does not cross the worker boundary when authoritative turn metadata is unknown', async () => {
    const ds = daemonSession({ worker: 'live', hasHistory: true });
    const metadata = {
      apply: vi.fn(() => ({
        kind: 'unknown' as const,
        message: 'metadata store response lost',
      })),
    };
    const harness = await harnessFor(ds, { metadata });

    const outcome = await harness.submit(envelope('om_metadata_unknown'));

    expect(outcome).toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      message: 'metadata store response lost',
    });
    expect(metadata.apply).toHaveBeenCalledTimes(1);
    expect(harness.workerCommands).toEqual([]);
  });

  it('resolves an exact VC receiver through its isolated active-session anchor', async () => {
    const ds = daemonSession({ worker: 'live', hasHistory: true });
    ds.scope = 'chat';
    ds.session.scope = 'chat';
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'cli_listener',
      meetingId: 'meeting_1',
      memberId: 'minutes',
      memberEpoch: 3,
    };
    const receiverAnchor = activeSessionAnchorId(ds);
    const harness = await harnessFor(ds);
    const turn: OrdinaryImTransportEnvelope = {
      ...envelope('om_vc_receiver_turn'),
      route: {
        scope: 'chat',
        canonicalAnchor: receiverAnchor,
        chatId: CHAT_ID,
        chatType: 'group',
      },
    };

    const outcome = await harness.submit(turn);

    expectApplied(outcome);
    expect(harness.workerCommands).toEqual([
      expect.objectContaining({
        kind: 'sendWorkerInput',
        turnId: turn.messageKey,
      }),
    ]);
  });

  it('sends one exact input to a live worker', async () => {
    const harness = await harnessFor(daemonSession({ worker: 'live', hasHistory: true }));
    const turn = envelope('om_live');

    const outcome = await harness.submit(turn);

    expectApplied(outcome);
    expectOneMaterialization(harness, turn);
    expect(harness.workerCommands).toEqual([{
      kind: 'sendWorkerInput',
      sessionId: SESSION_ID,
      turnId: turn.messageKey,
      input: { content: `cli:${turn.messageKey}` },
      workerGeneration: 7,
    }]);
    expect(currentTailEntry(harness.ds, turn.messageKey)).toEqual([]);
  });

  it.each([
    {
      name: 'queued activation pending',
      arrange(ds: DaemonSession) {
        ds.session.queuedActivationPending = true;
        ds.session.queuedActivationInput = { content: 'cli:retained-head' };
        ds.session.queuedActivationTurnId = 'om_retained_head';
      },
    },
    {
      name: 'retained activation tail',
      arrange(ds: DaemonSession) {
        ds.session.queuedActivationTail = [oldTailEntry()] as NonNullable<Session['queuedActivationTail']>;
      },
    },
    {
      name: 'exact initial-start claimant',
      arrange(ds: DaemonSession) {
        ds.initialStartClaimToken = 'opening-owner';
      },
    },
  ])('parks behind $name instead of sending to a live worker', async ({ name, arrange }) => {
    const ds = daemonSession({ worker: 'live', hasHistory: true });
    arrange(ds);
    const priorTailLength = ds.session.queuedActivationTail?.length ?? 0;
    const harness = await harnessFor(ds);
    const turn = envelope(`om_gate_${name.replaceAll(' ', '_')}`);

    const outcome = await harness.submit(turn);

    expectApplied(outcome);
    expectOneMaterialization(harness, turn);
    expect(harness.workerCommands).toEqual([]);
    expect(currentTailEntry(ds, turn.messageKey)).toEqual([
      expect.objectContaining({
        userPrompt: turn.content,
        cliInput: { content: `cli:${turn.messageKey}` },
        turnId: turn.messageKey,
      }),
    ]);
    expect(ds.session.queuedActivationTail).toHaveLength(priorTailLength + 1);
  });

  it('uses a bare pending-repo placeholder as the exact opening even above live gates', async () => {
    const ds = daemonSession({ worker: 'live', hasHistory: true });
    ds.pendingRepo = true;
    ds.pendingPrompt = '';
    ds.session.queuedActivationPending = true;
    ds.session.queuedActivationInput = { content: 'cli:older-gated-head' };
    const harness = await harnessFor(ds);
    const turn = envelope('om_pending_repo_opening');

    const outcome = await harness.submit(turn);

    expectApplied(outcome);
    expectOneMaterialization(harness, turn);
    expect(harness.workerCommands).toEqual([]);
    expect(ds.pendingPrompt).toBe(turn.content);
    expect(ds.pendingTurnId).toBe(turn.messageKey);
    expect(ds.session.queued).toBe(true);
    expect(ds.session.pendingRepoSetup?.cliInput).toEqual({
      content: `new-topic:${turn.messageKey}`,
    });
    expect(currentTailEntry(ds, turn.messageKey)).toEqual([]);
  });

  it('admits one pending-repo follower behind its existing opening without worker IPC', async () => {
    const ds = daemonSession({ worker: 'live', hasHistory: true });
    ds.pendingRepo = true;
    ds.pendingPrompt = 'user:existing-opening';
    ds.pendingTurnId = 'om_existing_opening';
    ds.session.queuedActivationPending = true;
    const harness = await harnessFor(ds);
    const turn = envelope('om_pending_repo_follower');

    const outcome = await harness.submit(turn);

    expectApplied(outcome);
    expectOneMaterialization(harness, turn);
    expect(harness.workerCommands).toEqual([]);
    expect(ds.pendingPrompt).toBe('user:existing-opening');
    expect(ds.pendingTurnId).toBe('om_existing_opening');
    expect(currentTailEntry(ds, turn.messageKey)).toEqual([
      expect.objectContaining({
        userPrompt: turn.content,
        cliInput: { content: `cli:${turn.messageKey}` },
        turnId: turn.messageKey,
      }),
    ]);
  });

  it('keeps an existing pending-repo tail head ahead after a completion claim is released', async () => {
    const ds = daemonSession({ worker: 'none', hasHistory: false });
    ds.pendingRepo = true;
    ds.pendingPrompt = '';
    ds.pendingRepoCommitInFlight = false;
    ds.session.pendingRepoSetup = {
      mode: 'picker',
      prompt: '',
      turnId: 'om_empty_placeholder',
    };
    ds.session.queuedActivationTail = [
      oldTailEntry('om_oldest_pending_tail', 1),
    ] as NonNullable<Session['queuedActivationTail']>;
    ds.session.queuedActivationTailNextOrder = 1;
    const harness = await harnessFor(ds);
    const successor = envelope('om_pending_tail_successor');

    const outcome = await harness.submit(successor);

    expectApplied(outcome);
    expect(ds.session.pendingRepoSetup).toMatchObject({
      turnId: 'om_empty_placeholder',
    });
    expect(ds.session.queuedActivationTail).toEqual([
      expect.objectContaining({ turnId: 'om_oldest_pending_tail', order: 1 }),
      expect.objectContaining({
        turnId: successor.messageKey,
        userPrompt: successor.content,
        cliInput: { content: `cli:${successor.messageKey}` },
        order: 2,
      }),
    ]);
  });

  it('keeps an empty-text rich pending opening and parks its successor in the tail', async () => {
    const ds = daemonSession({ worker: 'none', hasHistory: false });
    ds.pendingRepo = true;
    ds.pendingPrompt = '';
    ds.session.pendingRepoSetup = {
      mode: 'picker',
      prompt: '',
      turnId: 'om_image_only_opening',
      cliInput: {
        content: '<user_message><attachments><image path="/tmp/image.png" /></attachments></user_message>',
      },
    };
    const harness = await harnessFor(ds);
    const turn = envelope('om_after_image_only_opening');

    const outcome = await harness.submit(turn);

    expectApplied(outcome);
    expect(ds.session.pendingRepoSetup).toMatchObject({
      turnId: 'om_image_only_opening',
      cliInput: { content: expect.stringContaining('/tmp/image.png') },
    });
    expect(currentTailEntry(ds, turn.messageKey)).toEqual([
      expect.objectContaining({
        userPrompt: turn.content,
        turnId: turn.messageKey,
      }),
    ]);
  });

  it('parks current input and recovers the retained queued-activation head first', async () => {
    const ds = daemonSession({ worker: 'none', hasHistory: true });
    ds.session.queuedActivationPending = true;
    ds.session.queuedActivationToken = 'activation-token-retained-head';
    ds.session.queuedActivationInput = { content: 'cli:retained-head' };
    ds.session.queuedActivationTurnId = 'om_retained_head';
    ds.session.queuedActivationResume = true;
    const harness = await harnessFor(ds);
    const turn = envelope('om_after_retained_head');

    const outcome = await harness.submit(turn);

    expectApplied(outcome);
    expectOneMaterialization(harness, turn);
    expect(currentTailEntry(ds, turn.messageKey)).toHaveLength(1);
    expect(harness.workerCommands).toEqual([{
      kind: 'forkWorker',
      sessionId: SESSION_ID,
      turnId: 'om_retained_head',
      input: { content: 'cli:retained-head' },
      resume: true,
      queuedActivationToken: 'activation-token-retained-head',
    }]);
  });

  it('parks behind a quarantined tail and recovers the old head, never current input', async () => {
    const ds = daemonSession({ worker: 'none', hasHistory: true });
    ds.initialStartPending = true;
    ds.quarantinedActivationTailPromotion = true;
    ds.session.queuedActivationTail = [
      oldTailEntry('om_quarantined_old_head'),
    ] as NonNullable<Session['queuedActivationTail']>;
    const harness = await harnessFor(ds);
    const turn = envelope('om_after_quarantined_head');

    const outcome = await harness.submit(turn);

    expectApplied(outcome);
    expectOneMaterialization(harness, turn);
    expect(currentTailEntry(ds, turn.messageKey)).toHaveLength(1);
    expect(ds.quarantinedActivationTailPromotion).toBeUndefined();
    expect(harness.workerCommands).toEqual([{
      kind: 'forkWorker',
      sessionId: SESSION_ID,
      turnId: 'om_quarantined_old_head',
      input: { content: 'cli:om_quarantined_old_head' },
      resume: true,
      queuedActivationToken: ds.session.queuedActivationToken,
    }]);
  });

  it('recovers a published quarantined journal before its successor and the next ordinary turn', async () => {
    const ds = daemonSession({ worker: 'none', hasHistory: true });
    ds.session.cliId = 'claude-code';
    ds.session.queuedActivationTail = [
      oldTailEntry('om_published_head', 1),
      oldTailEntry('om_existing_successor', 2),
    ] as NonNullable<Session['queuedActivationTail']>;
    ds.session.queuedActivationTailNextOrder = 2;
    let durable: Session | undefined;
    updateSession.mockImplementationOnce(candidate => {
      durable = structuredClone(candidate);
      throw new Error('promotion response lost after publish');
    });

    expect(promoteQueuedActivationTail(ds, { send: false })).toBe(false);
    expect(ds).toMatchObject({
      quarantinedActivationTailPromotion: true,
      session: {
        queuedActivationPending: true,
        queuedActivationTurnId: 'om_published_head',
        queuedActivationTail: [expect.objectContaining({ turnId: 'om_existing_successor' })],
      },
    });

    updateSession.mockImplementation(candidate => {
      durable = structuredClone(candidate);
    });
    getSessionFresh.mockImplementation(() => structuredClone(durable));
    const harness = await harnessFor(ds);
    const follower = envelope('om_after_published_head');

    await expect(harness.submit(follower)).resolves.toMatchObject({ kind: 'applied' });

    expect(getSessionFresh).toHaveBeenCalledWith(SESSION_ID);
    expect(ds.quarantinedActivationTailPromotion).toBeUndefined();
    expect(ds.session.queuedActivationTurnId).toBe('om_published_head');
    expect(ds.session.queuedActivationTail?.map(entry => entry.turnId)).toEqual([
      'om_existing_successor',
      follower.messageKey,
    ]);
    expect(harness.workerCommands).toEqual([expect.objectContaining({
      kind: 'forkWorker',
      turnId: 'om_published_head',
      input: { content: 'cli:om_published_head' },
      queuedActivationToken: ds.session.queuedActivationToken,
    })]);
  });

  it('keeps an unproven published journal sticky while later ordinary turns remain FIFO', async () => {
    const ds = daemonSession({ worker: 'none', hasHistory: true });
    ds.session.cliId = 'claude-code';
    ds.session.queuedActivationTail = [
      oldTailEntry('om_unproven_published_head', 1),
    ] as NonNullable<Session['queuedActivationTail']>;
    ds.session.queuedActivationTailNextOrder = 1;
    updateSession.mockImplementationOnce(() => {
      throw new Error('promotion response lost after publish');
    });

    expect(promoteQueuedActivationTail(ds, { send: false })).toBe(false);
    expect(ds.session.queuedActivationTail).toBeUndefined();
    updateSession.mockImplementation(() => undefined);
    getSessionFresh.mockReturnValue(undefined);
    const harness = await harnessFor(ds);
    const firstFollower = envelope('om_first_after_unproven_head');

    const first = await harness.submit(firstFollower);

    expect(first).toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      idempotent: false,
      message: expect.stringContaining('exact durable candidate proof'),
    });
    expect(getSessionFresh).toHaveBeenCalledWith(SESSION_ID);
    expect(ds.quarantinedActivationTailPromotion).toBe(true);
    expect(ds.session.queuedActivationTurnId).toBe('om_unproven_published_head');
    expect(ds.session.queuedActivationTail?.map(entry => entry.turnId)).toEqual([
      firstFollower.messageKey,
    ]);
    expect(harness.workerCommands).toEqual([]);
    const writesAfterFirst = updateSession.mock.calls.length;

    await expect(harness.submit(firstFollower)).resolves.toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      idempotent: true,
    });
    expect(updateSession).toHaveBeenCalledTimes(writesAfterFirst);
    expect(ds.session.queuedActivationTail?.map(entry => entry.turnId)).toEqual([
      firstFollower.messageKey,
    ]);

    const secondFollower = envelope('om_second_after_unproven_head');
    await expect(harness.submit(secondFollower)).resolves.toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      idempotent: false,
    });
    expect(ds.quarantinedActivationTailPromotion).toBe(true);
    expect(ds.session.queuedActivationTurnId).toBe('om_unproven_published_head');
    expect(ds.session.queuedActivationTail?.map(entry => entry.turnId)).toEqual([
      firstFollower.messageKey,
      secondFollower.messageKey,
    ]);
    expect(harness.workerCommands).toEqual([]);
  });

  it('activates queued dashboard input before treating a worker-null Session as cold', async () => {
    const ds = daemonSession({ worker: 'none', hasHistory: false });
    ds.session.queued = true;
    ds.session.queuedPrompt = 'cli:dashboard-backlog';
    const harness = await harnessFor(ds);
    const turn = envelope('om_activate_dashboard');

    const outcome = await harness.submit(turn);

    expectApplied(outcome);
    expectOneMaterialization(harness, turn);
    expect(harness.workerCommands).toEqual([{
      kind: 'forkWorker',
      sessionId: SESSION_ID,
      turnId: turn.messageKey,
      input: {
        content: `cli:dashboard-backlog\n\ncli:${turn.messageKey}`,
      },
      resume: false,
      queuedActivationToken: ds.session.queuedActivationToken,
    }]);
    expect(ds.session.queued).not.toBe(true);
    expect(ds.session.queuedPrompt).toBeUndefined();
  });

  it('keeps an existing activation tail ahead of the current queued-dashboard trigger', async () => {
    const ds = daemonSession({ worker: 'none', hasHistory: false });
    ds.session.queued = true;
    ds.session.queuedPrompt = 'cli:dashboard-backlog';
    ds.session.queuedActivationTail = [
      oldTailEntry('om_existing_successor', 1),
    ] as NonNullable<Session['queuedActivationTail']>;
    ds.session.queuedActivationTailNextOrder = 1;
    const harness = await harnessFor(ds);
    const turn = envelope('om_current_after_existing_successor');

    const outcome = await harness.submit(turn);

    expectApplied(outcome);
    expect(harness.workerCommands).toEqual([
      expect.objectContaining({
        kind: 'forkWorker',
        turnId: `queued-opening:${SESSION_ID}`,
        input: { content: 'cli:dashboard-backlog' },
      }),
    ]);
    expect(ds.session.queuedActivationTail?.map(entry => entry.turnId)).toEqual([
      'om_existing_successor',
      turn.messageKey,
    ]);
  });

  it('carries the exact retained activation token and dispatch attempt across the worker seam', async () => {
    const ds = daemonSession({ worker: 'none', hasHistory: true });
    ds.session.queuedActivationPending = true;
    ds.session.queuedActivationToken = 'activation-token-retained';
    ds.session.queuedActivationInput = { content: 'cli:retained-head' };
    ds.session.queuedActivationTurnId = 'om_retained_head';
    ds.session.queuedActivationDispatchAttempt = 4;
    const harness = await harnessFor(ds);

    const outcome = await harness.submit(envelope('om_after_retained_identity'));

    expectApplied(outcome);
    expect(harness.workerCommands).toEqual([
      expect.objectContaining({
        kind: 'forkWorker',
        turnId: 'om_retained_head',
        queuedActivationToken: 'activation-token-retained',
        dispatchAttempt: 4,
      }),
    ]);
  });

  it('preserves a quarantined tail head dispatch attempt in its promoted journal and command', async () => {
    const ds = daemonSession({ worker: 'none', hasHistory: true });
    ds.initialStartPending = true;
    ds.quarantinedActivationTailPromotion = true;
    ds.session.queuedActivationTail = [{
      ...oldTailEntry('om_quarantined_attempt', 1),
      dispatchAttempt: 6,
    }] as NonNullable<Session['queuedActivationTail']>;
    ds.session.queuedActivationTailNextOrder = 1;
    const harness = await harnessFor(ds);

    const outcome = await harness.submit(envelope('om_after_quarantined_attempt'));

    expectApplied(outcome);
    expect(ds.session.queuedActivationDispatchAttempt).toBe(6);
    expect(harness.workerCommands).toEqual([
      expect.objectContaining({
        kind: 'forkWorker',
        turnId: 'om_quarantined_attempt',
        queuedActivationToken: ds.session.queuedActivationToken,
        dispatchAttempt: 6,
      }),
    ]);
  });

  it('retries a promoted quarantined head after a proven worker refusal', async () => {
    const ds = daemonSession({ worker: 'none', hasHistory: true });
    ds.initialStartPending = true;
    ds.quarantinedActivationTailPromotion = true;
    ds.session.queuedActivationTail = [
      oldTailEntry('om_quarantined_retry', 1),
    ] as NonNullable<Session['queuedActivationTail']>;
    ds.session.queuedActivationTailNextOrder = 1;
    let dispatches = 0;
    const harness = await harnessFor(ds, {
      dispatch() {
        dispatches += 1;
        return dispatches === 1
          ? { kind: 'refused', message: 'worker was not started' }
          : { kind: 'accepted' };
      },
    });

    await expect(harness.submit(envelope('om_parked_behind_retry')))
      .resolves.toMatchObject({ kind: 'applied' });
    expect(ds.initialStartPending).toBe(false);

    await expect(harness.submit(envelope('om_triggers_retry')))
      .resolves.toMatchObject({ kind: 'applied' });
    expect(harness.workerCommands.map(command => command.turnId)).toEqual([
      'om_quarantined_retry',
      'om_quarantined_retry',
    ]);
  });

  it('cold-spawns an empty-start opening even when restore marked the Session as historical', async () => {
    const ds = daemonSession({ worker: 'none', hasHistory: true });
    ds.session.initialUserTurnPending = true;
    const harness = await harnessFor(ds);

    const outcome = await harness.submit(envelope('om_empty_start_opening'));

    expectApplied(outcome);
    expect(harness.workerCommands).toEqual([
      expect.objectContaining({
        kind: 'forkWorker',
        input: { content: 'new-topic:om_empty_start_opening' },
        resume: false,
      }),
    ]);
  });

  it.each([
    { name: 'live delivery', worker: 'live' as const, hasHistory: true },
    { name: 'cold replacement', worker: 'none' as const, hasHistory: true },
  ])('remembers the exact accepted input after $name', async ({ worker, hasHistory }) => {
    const ds = daemonSession({ worker, hasHistory });
    ds.suppressRecoveryCard = true;
    ds.lastUserPrompt = 'stale user prompt';
    ds.lastCliInput = 'stale cli input';
    ds.session.lastUserPrompt = 'stale user prompt';
    ds.session.lastCliInput = 'stale cli input';
    const harness = await harnessFor(ds);
    const turn = envelope(`om_remember_${worker}`);

    const outcome = await harness.submit(turn);

    expectApplied(outcome);
    expect(ds.suppressRecoveryCard).toBeUndefined();
    expect({
      runtimeUserPrompt: ds.lastUserPrompt,
      runtimeCliInput: ds.lastCliInput,
      sessionUserPrompt: ds.session.lastUserPrompt,
      sessionCliInput: ds.session.lastCliInput,
    }).toEqual({
      runtimeUserPrompt: turn.content,
      runtimeCliInput: `cli:${turn.messageKey}`,
      sessionUserPrompt: turn.content,
      sessionCliInput: `cli:${turn.messageKey}`,
    });
    expect(updateSession).toHaveBeenCalledWith(ds.session);
  });

  it.each([
    {
      name: 'activation-tail admission',
      arrange(ds: DaemonSession) {
        ds.session.queuedActivationPending = true;
        ds.session.queuedActivationToken = 'retained-token';
        ds.session.queuedActivationInput = { content: 'cli:retained' };
        ds.session.queuedActivationTurnId = 'om_retained';
      },
    },
    {
      name: 'activation-journal staging',
      arrange(ds: DaemonSession) {
        ds.session.queued = true;
        ds.session.queuedPrompt = 'queued dashboard prompt';
      },
    },
    {
      name: 'pending-repo opening staging',
      arrange(ds: DaemonSession) {
        ds.pendingRepo = true;
        ds.pendingPrompt = '';
      },
    },
    {
      name: 'accepted-input metadata persistence',
      arrange(_ds: DaemonSession) {},
    },
  ])('fails closed as unknown when $name loses its store response', async ({ name, arrange }) => {
    const ds = daemonSession({
      worker: 'none',
      hasHistory: false,
    });
    if (name === 'activation-tail admission') ds.worker = { killed: false } as DaemonSession['worker'];
    if (name === 'accepted-input metadata persistence') {
      ds.worker = { killed: false } as DaemonSession['worker'];
    }
    arrange(ds);
    let published: Session | undefined;
    updateSession.mockImplementationOnce((next) => {
      published = structuredClone(next);
      throw new Error('store response lost after publish');
    });
    const harness = await harnessFor(ds);
    const turn = envelope(`om_response_loss_${name.replaceAll(' ', '_')}`);

    const outcome = await harness.submit(turn);

    expect(published).toBeDefined();
    expect(outcome).toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      message: expect.stringContaining('store response lost after publish'),
    });
    expect(ds.session).toEqual(published);
  });

  it.each([
    {
      name: 'no worker and no history',
      worker: 'none' as const,
      hasHistory: false,
      resume: false,
    },
    {
      name: 'a killed prior worker with history',
      worker: 'killed' as const,
      hasHistory: true,
      resume: true,
    },
  ])('cold-starts exact current input for $name', async ({ worker, hasHistory, resume }) => {
    const ds = daemonSession({ worker, hasHistory });
    const harness = await harnessFor(ds);
    const turn = envelope(`om_cold_${worker}`);

    const outcome = await harness.submit(turn);

    expectApplied(outcome);
    expectOneMaterialization(harness, turn);
    expect(harness.workerCommands).toEqual([{
      kind: 'forkWorker',
      sessionId: SESSION_ID,
      turnId: turn.messageKey,
      input: { content: `cli:${turn.messageKey}` },
      resume,
    }]);
    expect(currentTailEntry(ds, turn.messageKey)).toEqual([]);
  });
});
