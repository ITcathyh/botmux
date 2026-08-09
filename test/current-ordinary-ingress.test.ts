import { describe, expect, it, vi } from 'vitest';

import {
  createCurrentOrdinaryImTurnPreparationPort,
  type CurrentOrdinaryImTurnPreparationPort,
} from '../src/core/current-ordinary-im-turn.js';
import type {
  CurrentOrdinaryIngressCommand,
  CurrentOrdinaryIngressCommandAdapter,
  CurrentOrdinaryIngressCommandKind,
  CurrentOrdinaryIngressCommandResult,
  CurrentOrdinaryIngressExternalEffect,
  CurrentOrdinaryIngressExternalEffectExecutor,
  CurrentOrdinaryIngressExternalEffectResult,
} from '../src/core/current-ordinary-ingress.js';
import type { OrdinaryImTransportEnvelope } from '../src/core/ordinary-im-turn.js';
import {
  createSessionRuntimeHost,
  type KeyedTriggerAuthority,
  type KeyedTriggerTurnPort,
  type OrdinaryIngressEffectSettlement,
  type OrdinaryIngressPort,
  type OrdinaryIngressTransitionResult,
  type SessionAddress,
  type SessionDirectory,
  type SessionDirectoryRow,
} from '../src/core/session-runtime.js';
import type {
  SessionStore,
  SessionStoreVersion,
  StoredSessionState,
} from '../src/core/session-store.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';

const OWNER = 'app-owner';

const sessionStoreMocks = vi.hoisted(() => ({
  updateSession: vi.fn(),
}));

vi.mock('../src/services/session-store.js', () => ({
  updateSession: sessionStoreMocks.updateSession,
}));

const unusedKeyedAuthority: KeyedTriggerAuthority = {
  inspect: () => ({ kind: 'unreadable', message: 'not used' }),
  reserve: () => ({ kind: 'unreadable', message: 'not used' }),
  begin: () => ({ kind: 'unreadable', message: 'not used' }),
  settleDispatchUnknown: () => ({ kind: 'unreadable', message: 'not used' }),
};

const unusedKeyedTurns: KeyedTriggerTurnPort = {
  prepare: () => ({ kind: 'unreadable', message: 'not used' }),
  acceptAtMostOnce: () => ({ kind: 'refused', message: 'not used' }),
  failClose: async () => ({ kind: 'unreadable', message: 'not used' }),
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function envelope(
  messageKey: string,
  content: string,
  anchor = 'om_root_1',
  chatId = 'oc_chat_1',
): OrdinaryImTransportEnvelope {
  return {
    route: {
      scope: 'thread',
      canonicalAnchor: anchor,
      chatId,
      chatType: 'group',
    },
    source: 'lark.im',
    messageKey,
    content,
    sender: { kind: 'human', openId: 'ou_sender', unionId: 'on_sender' },
    mentions: [],
    postParticipantMentions: [],
    resources: [],
    messageListener: false,
    vc: { contextMayLag: false },
  };
}

function makeSession(
  sessionId = 'session-1',
  anchor = 'om_root_1',
  chatId = 'oc_chat_1',
): Session {
  return {
    sessionId,
    larkAppId: OWNER,
    rootMessageId: anchor,
    chatId,
    chatType: 'group',
    scope: 'thread',
    status: 'active',
    title: sessionId,
    createdAt: '2026-08-10T00:00:00.000Z',
  } as Session;
}

function makeDaemonSession(
  sessionId = 'session-1',
  anchor = 'om_root_1',
  chatId = 'oc_chat_1',
): DaemonSession {
  return {
    session: makeSession(sessionId, anchor, chatId),
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: OWNER,
    chatId,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.parse('2026-08-10T00:00:00.000Z'),
    cliVersion: 'test',
    lastMessageAt: Date.parse('2026-08-10T00:00:00.000Z'),
    hasHistory: false,
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
      canonicalAnchor: ds.scope === 'chat' ? ds.chatId : ds.session.rootMessageId,
      chatId: ds.chatId,
      chatType: ds.chatType,
    },
    recordStatus: ds.session.status === 'active' ? 'active' : 'closed',
    executorStatus: ds.worker && !ds.worker.killed ? 'working' : 'dormant',
  };
}

class RegistryDirectory implements SessionDirectory {
  constructor(private readonly registry: Map<string, DaemonSession>) {}

  async read(query: Parameters<SessionDirectory['read']>[0]) {
    const rows = [...this.registry.values()].map(rowFor);
    if (query.kind === 'list') return { kind: 'list' as const, rows };
    const row = query.kind === 'byExternalSession'
      ? rows.find(candidate => candidate.sessionId === query.sessionId)
      : rows.find(candidate => (
          candidate.route.kind === query.route.kind
          && (candidate.route.kind === 'thread'
            ? candidate.route.anchorId === (query.route as { kind: 'thread'; anchorId: string }).anchorId
            : candidate.route.chatId === (query.route as { kind: 'chat'; chatId: string }).chatId)
        ));
    return row ? { kind: 'one' as const, row } : { kind: 'notFound' as const };
  }
}

function register(registry: Map<string, DaemonSession>, ds: DaemonSession): void {
  registry.set(activeSessionKey(ds), ds);
}

function hostWith(
  registry: Map<string, DaemonSession>,
  ordinaryIngress: OrdinaryIngressPort,
  sessionStore?: SessionStore,
) {
  return createSessionRuntimeHost({
    directory: new RegistryDirectory(registry),
    keyedTriggers: unusedKeyedAuthority,
    keyedTriggerTurns: unusedKeyedTurns,
    ordinaryIngress,
    sessionStore,
  });
}

async function addressFor(
  host: ReturnType<typeof createSessionRuntimeHost>,
  turn: OrdinaryImTransportEnvelope,
): Promise<SessionAddress> {
  const projected = await host.projection.read({
    kind: 'byRoute',
    route: turn.route.scope === 'chat'
      ? { kind: 'chat', chatId: turn.route.chatId }
      : { kind: 'thread', anchorId: turn.route.canonicalAnchor },
  });
  if (projected.kind !== 'one') throw new Error('expected one existing Session route');
  return projected.session.address;
}

async function submitOrdinary(
  host: ReturnType<typeof createSessionRuntimeHost>,
  turn: OrdinaryImTransportEnvelope,
  idempotencyKey = turn.messageKey,
) {
  const address = await addressFor(host, turn);
  return host.runtime.submit({
    target: { kind: 'session', address },
    idempotencyKey,
    command: {
      kind: 'ordinary.ingress',
      input: { turn },
    },
  });
}

function effect(
  intent: unknown,
  continuation: unknown,
): OrdinaryIngressTransitionResult {
  return { kind: 'effect', intent, continuation };
}

describe('SessionRuntime staged ordinary ingress protocol', () => {
  it('rejects a transport-key mismatch before calling the Current port', async () => {
    const registry = new Map<string, DaemonSession>();
    register(registry, makeDaemonSession());
    const begin = vi.fn(() => ({ kind: 'committed' as const }));
    const port = {
      begin,
      execute: vi.fn(async () => undefined),
      resume: vi.fn(() => ({ kind: 'committed' as const })),
    } as OrdinaryIngressPort;
    const host = hostWith(registry, port);

    const result = await submitOrdinary(
      host,
      envelope('om_message_1', 'hello'),
      'om_fabricated_key',
    );

    expect(result).toEqual({
      kind: 'rejected',
      reason: 'invalidCommand',
      message: 'ordinary ingress idempotency key must equal the transport message key',
    });
    expect(begin).not.toHaveBeenCalled();
  });

  it('hashes and passes the normalized turn so an unfolded resource source is one semantic input', async () => {
    const registry = new Map<string, DaemonSession>();
    register(registry, makeDaemonSession());
    const begin = vi.fn(() => ({ kind: 'committed' as const }));
    const host = hostWith(registry, {
      begin,
      execute: vi.fn(async () => undefined),
      resume: vi.fn(() => ({ kind: 'committed' as const })),
    } as OrdinaryIngressPort);
    const base = envelope('om_normalized_hash', 'same resource');
    const omitted: OrdinaryImTransportEnvelope = {
      ...base,
      resources: [{
        type: 'image',
        resourceKey: 'img_1',
        name: 'image.png',
      }],
    };
    const explicit: OrdinaryImTransportEnvelope = {
      ...base,
      resources: [{
        type: 'image',
        resourceKey: 'img_1',
        sourceMessageKey: base.messageKey,
        name: 'image.png',
      }],
    };

    await expect(submitOrdinary(host, omitted)).resolves.toMatchObject({ kind: 'applied' });
    await expect(submitOrdinary(host, explicit)).resolves.toMatchObject({
      kind: 'duplicate',
      state: 'inputCommitted',
    });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(begin.mock.calls[0]?.[0]).toMatchObject({
      turn: {
        resources: [{ sourceMessageKey: base.messageKey }],
      },
    });
  });

  it('rejects unsafe transport fields before they can poison the idempotency ledger', async () => {
    const registry = new Map<string, DaemonSession>();
    register(registry, makeDaemonSession());
    const begin = vi.fn(() => ({ kind: 'committed' as const }));
    const host = hostWith(registry, {
      begin,
      execute: vi.fn(async () => undefined),
      resume: vi.fn(() => ({ kind: 'committed' as const })),
    } as OrdinaryIngressPort);
    const correct = envelope('om_unsafe_then_correct', 'safe input');
    const unsafe = { ...correct, generation: 99 } as OrdinaryImTransportEnvelope;

    await expect(submitOrdinary(host, unsafe)).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'invalidCommand',
      message: expect.stringContaining('unsupported field: generation'),
    });
    expect(begin).not.toHaveBeenCalled();

    await expect(submitOrdinary(host, correct)).resolves.toMatchObject({ kind: 'applied' });
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it('rejects a turn whose route does not match the projected Session address', async () => {
    const registry = new Map<string, DaemonSession>();
    register(registry, makeDaemonSession());
    const begin = vi.fn(() => ({ kind: 'committed' as const }));
    const host = hostWith(registry, {
      begin,
      execute: vi.fn(async () => undefined),
      resume: vi.fn(() => ({ kind: 'committed' as const })),
    } as OrdinaryIngressPort);
    const correct = envelope('om_wrong_route', 'wrong route');
    const address = await addressFor(host, correct);
    const wrongRoute: OrdinaryImTransportEnvelope = {
      ...correct,
      route: { ...correct.route, canonicalAnchor: 'om_other_root' },
    };

    await expect(host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: wrongRoute.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: wrongRoute } },
    })).resolves.toEqual({
      kind: 'rejected',
      reason: 'invalidCommand',
      message: 'ordinary ingress turn route does not match the target Session address',
    });
    expect(begin).not.toHaveBeenCalled();
  });

  it('runs only begin/resume in the Session lane while one async effect is pending', async () => {
    const registry = new Map<string, DaemonSession>();
    const ds = makeDaemonSession();
    register(registry, ds);
    const gate = deferred<{ kind: 'accepted' }>();
    const effectStarted = deferred<void>();
    const intent = Object.freeze({});
    const continuation = Object.freeze({});
    const order: string[] = [];
    const begin = vi.fn(() => {
      order.push('ordinary:begin');
      return effect(intent, continuation);
    });
    const execute = vi.fn(async (received: unknown) => {
      expect(received).toBe(intent);
      order.push('effect:start');
      effectStarted.resolve();
      return gate.promise;
    });
    const resume = vi.fn((received: unknown, settlement: OrdinaryIngressEffectSettlement) => {
      expect(received).toBe(continuation);
      expect(settlement).toEqual({ kind: 'returned', value: { kind: 'accepted' } });
      order.push('ordinary:resume');
      return { kind: 'committed' as const };
    });
    let state: StoredSessionState = {
      sessionId: ds.session.sessionId,
      route: { kind: 'thread', anchorId: ds.session.rootMessageId },
      recordStatus: 'active',
      title: 'Before',
      executorGeneration: 1,
    };
    let version = Object.freeze({}) as SessionStoreVersion;
    const store: SessionStore = {
      load: () => ({ kind: 'loaded', state, version }),
      apply: ({ transition }) => {
        if (transition.kind !== 'rename') throw new Error('expected rename transition');
        order.push('control:rename');
        state = {
          ...state,
          title: transition.title,
          titleUpdatedAt: transition.updatedAt,
          titleSource: transition.source,
        };
        version = Object.freeze({}) as SessionStoreVersion;
        return { kind: 'applied', state, nextVersion: version };
      },
    };
    const host = hostWith(registry, { begin, execute, resume } as OrdinaryIngressPort, store);
    const turn = envelope('om_message_2', 'slow delivery');
    const address = await addressFor(host, turn);

    const first = host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: turn.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn } },
    });
    await effectStarted.promise;

    let duplicateSettled = false;
    const duplicate = host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: turn.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn } },
    });
    duplicate.then(() => { duplicateSettled = true; });
    const control = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'rename-during-effect',
      command: {
        kind: 'control.rename',
        input: {
          title: 'During effect',
          updatedAt: '2026-08-10T00:01:00.000Z',
          source: 'user',
        },
      },
    });

    await Promise.resolve();
    expect(duplicateSettled).toBe(false);
    expect(control).toMatchObject({ kind: 'applied', action: 'control.renamed' });
    expect(order).toEqual(['ordinary:begin', 'effect:start', 'control:rename']);

    gate.resolve({ kind: 'accepted' });
    await expect(first).resolves.toMatchObject({
      kind: 'applied',
      action: 'ordinary.inputCommitted',
      durability: 'processLocal',
    });
    await expect(duplicate).resolves.toMatchObject({
      kind: 'duplicate',
      state: 'inputCommitted',
      policy: 'ordinary-replayable',
    });
    expect(order).toEqual([
      'ordinary:begin',
      'effect:start',
      'control:rename',
      'ordinary:resume',
    ]);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('loops opaque effects without exposing intent or continuation to the caller', async () => {
    const registry = new Map<string, DaemonSession>();
    register(registry, makeDaemonSession());
    const firstIntent = Object.freeze({});
    const firstContinuation = Object.freeze({});
    const secondIntent = Object.freeze({});
    const secondContinuation = Object.freeze({});
    const execute = vi.fn(async (intent: unknown) => (
      intent === firstIntent ? { kind: 'stateChanged' } : { kind: 'accepted' }
    ));
    const resume = vi.fn((continuation: unknown) => (
      continuation === firstContinuation
        ? effect(secondIntent, secondContinuation)
        : { kind: 'committed' as const }
    ));
    const host = hostWith(registry, {
      begin: () => effect(firstIntent, firstContinuation),
      execute,
      resume,
    } as OrdinaryIngressPort);

    const result = await submitOrdinary(
      host,
      envelope('om_message_loop', 'worker changed while delivering'),
    );

    expect(result).toMatchObject({ kind: 'applied', action: 'ordinary.inputCommitted' });
    expect(execute.mock.calls.map(call => call[0])).toEqual([firstIntent, secondIntent]);
    expect(resume.mock.calls.map(call => call[0])).toEqual([
      firstContinuation,
      secondContinuation,
    ]);
    for (const privateField of ['intent', 'continuation', 'effect', 'disposition']) {
      expect(privateField in result).toBe(false);
    }
  });

  it('passes an execute throw back to adapter resume instead of inventing a retry policy', async () => {
    const registry = new Map<string, DaemonSession>();
    register(registry, makeDaemonSession());
    const continuation = Object.freeze({});
    const resume = vi.fn((received: unknown, settlement: OrdinaryIngressEffectSettlement) => {
      expect(received).toBe(continuation);
      expect(settlement.kind).toBe('threw');
      if (settlement.kind !== 'threw') throw new Error('expected execute failure');
      expect(settlement.error).toBeInstanceOf(Error);
      return { kind: 'unknown' as const, message: 'adapter classified worker response loss' };
    });
    const host = hostWith(registry, {
      begin: () => effect(Object.freeze({}), continuation),
      execute: async () => { throw new Error('IPC response lost'); },
      resume,
    } as OrdinaryIngressPort);
    const turn = envelope('om_message_throw', 'response loss');

    const first = await submitOrdinary(host, turn);
    const duplicate = await submitOrdinary(host, turn);

    expect(first).toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      message: 'adapter classified worker response loss',
      idempotent: false,
    });
    expect(duplicate).toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      idempotent: true,
    });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('quarantines thenable begin and resume implementations', async () => {
    const registry = new Map<string, DaemonSession>();
    register(registry, makeDaemonSession());
    const turn = envelope('om_message_thenable', 'strict transition');
    const asyncBegin = vi.fn(async () => effect(Object.freeze({}), Object.freeze({})));
    const beginHost = hostWith(registry, {
      begin: asyncBegin,
      execute: vi.fn(async () => undefined),
      resume: vi.fn(() => ({ kind: 'committed' as const })),
    } as unknown as OrdinaryIngressPort);

    await expect(submitOrdinary(beginHost, turn)).resolves.toEqual({
      kind: 'quarantined',
      message: 'OrdinaryIngressPort.begin must return synchronously',
    });

    const asyncResume = vi.fn(async () => ({ kind: 'committed' as const }));
    const resumeHost = hostWith(registry, {
      begin: () => effect(Object.freeze({}), Object.freeze({})),
      execute: async () => ({ kind: 'accepted' }),
      resume: asyncResume,
    } as unknown as OrdinaryIngressPort);

    await expect(submitOrdinary(
      resumeHost,
      envelope('om_message_thenable_resume', 'strict resume'),
    )).resolves.toEqual({
      kind: 'quarantined',
      message: 'OrdinaryIngressPort.resume must return synchronously',
    });
    expect(asyncResume).toHaveBeenCalledTimes(1);
  });
});

interface CurrentAdapters {
  readonly externalEffects: CurrentOrdinaryIngressExternalEffectExecutor;
  readonly commands: CurrentOrdinaryIngressCommandAdapter;
}

function currentAdapters(): CurrentAdapters {
  return {
    externalEffects: {
      execute: vi.fn(async (): Promise<CurrentOrdinaryIngressExternalEffectResult> => (
        { kind: 'materialized' }
      )),
    },
    commands: {
      apply: vi.fn((): CurrentOrdinaryIngressCommandResult => ({ kind: 'accepted' })),
    },
  };
}

async function currentHost(
  registry: Map<string, DaemonSession>,
  adapters: CurrentAdapters,
  turnPreparation: CurrentOrdinaryImTurnPreparationPort = createCurrentOrdinaryImTurnPreparationPort(),
) {
  const { createCurrentOrdinaryIngressPort } = await import(
    '../src/core/current-ordinary-ingress.js'
  );
  const ordinaryIngress = createCurrentOrdinaryIngressPort({
    ownerLarkAppId: OWNER,
    activeSessions: registry,
    turnPreparation,
    ...adapters,
  });
  return hostWith(registry, ordinaryIngress);
}

function callsByMethod(
  adapters: CurrentAdapters,
): Record<CurrentOrdinaryIngressCommandKind, number> {
  const kinds = vi.mocked(adapters.commands.apply).mock.calls
    .map(([command]) => command.kind);
  const count = (kind: CurrentOrdinaryIngressCommandKind) => (
    kinds.filter(candidate => candidate === kind).length
  );
  return {
    sendLive: count('sendLive'),
    parkOpeningFollower: count('parkOpeningFollower'),
    parkPendingRepoFollower: count('parkPendingRepoFollower'),
    startColdReplacement: count('startColdReplacement'),
    startQueuedActivation: count('startQueuedActivation'),
    recoverParkedActivation: count('recoverParkedActivation'),
  };
}

function commandCalls(
  adapters: CurrentAdapters,
  kind: CurrentOrdinaryIngressCommandKind,
): CurrentOrdinaryIngressCommand[] {
  return vi.mocked(adapters.commands.apply).mock.calls
    .map(([command]) => command)
    .filter(command => command.kind === kind);
}

describe('Current ordinary ingress existing-route policy', () => {
  const matrix: Array<{
    name: string;
    expected: CurrentOrdinaryIngressCommandKind;
    arrange(ds: DaemonSession): void;
  }> = [
    {
      name: 'live worker',
      expected: 'sendLive',
      arrange(ds) {
        ds.worker = { killed: false } as DaemonSession['worker'];
      },
    },
    {
      name: 'opening follower',
      expected: 'parkOpeningFollower',
      arrange(ds) {
        ds.initialStartPending = true;
        ds.initialStartClaimToken = 'another-turn-owns-opening';
      },
    },
    {
      name: 'cold replacement',
      expected: 'startColdReplacement',
      arrange(ds) {
        ds.worker = { killed: true } as DaemonSession['worker'];
        ds.hasHistory = true;
      },
    },
    {
      name: 'queued activation',
      expected: 'startQueuedActivation',
      arrange(ds) {
        ds.session.queued = true;
        ds.session.queuedPrompt = 'queued opening';
      },
    },
    {
      name: 'parked activation recovery',
      expected: 'recoverParkedActivation',
      arrange(ds) {
        ds.session.queuedActivationPending = true;
        ds.session.queuedActivationInput = { content: 'retained head' };
        ds.session.queuedActivationTurnId = 'om_retained_head';
      },
    },
    {
      name: 'pending-repo follower',
      expected: 'parkPendingRepoFollower',
      arrange(ds) {
        ds.pendingRepo = true;
        ds.pendingPrompt = 'opening waits for repo';
      },
    },
  ];

  it.each(matrix)('classifies $name behind one public submit', async ({ expected, arrange }) => {
    const registry = new Map<string, DaemonSession>();
    const ds = makeDaemonSession();
    arrange(ds);
    register(registry, ds);
    const adapters = currentAdapters();
    const host = await currentHost(registry, adapters);

    const result = await submitOrdinary(
      host,
      envelope(`om_${expected}`, `turn for ${expected}`),
    );

    expect(result).toEqual({
      kind: 'applied',
      action: 'ordinary.inputCommitted',
      policy: 'ordinary-replayable',
      durability: 'processLocal',
      sessionId: ds.session.sessionId,
    });
    expect(callsByMethod(adapters)).toEqual({
      sendLive: expected === 'sendLive' ? 1 : 0,
      parkOpeningFollower: expected === 'parkOpeningFollower' ? 1 : 0,
      parkPendingRepoFollower: expected === 'parkPendingRepoFollower' ? 1 : 0,
      startColdReplacement: expected === 'startColdReplacement' ? 1 : 0,
      startQueuedActivation: expected === 'startQueuedActivation' ? 1 : 0,
      recoverParkedActivation: expected === 'recoverParkedActivation' ? 1 : 0,
    });
    for (const privateField of ['routeState', 'disposition', 'intent', 'continuation', 'effect']) {
      expect(privateField in result).toBe(false);
    }
  });

  it.each([
    {
      id: 'queued-pending',
      name: 'queued activation pending',
      arrange(ds: DaemonSession) {
        ds.session.queuedActivationPending = true;
      },
    },
    {
      id: 'retained-tail',
      name: 'a retained queued activation tail',
      arrange(ds: DaemonSession) {
        ds.session.queuedActivationTail = [{ turnId: 'om_old_tail' }] as NonNullable<Session['queuedActivationTail']>;
      },
    },
    {
      id: 'outstanding-admission',
      name: 'an outstanding tail admission',
      arrange(ds: DaemonSession) {
        ds.queuedActivationTailAdmissionsOutstanding = 1;
      },
    },
    {
      id: 'pending-release',
      name: 'a pending tail release',
      arrange(ds: DaemonSession) {
        ds.queuedActivationTailReleasePending = {};
      },
    },
    {
      id: 'initial-claim',
      name: 'an exact initial-start claimant',
      arrange(ds: DaemonSession) {
        ds.initialStartClaimToken = 'opening-owner';
      },
    },
  ])('parks a live worker behind $name instead of sending ordinary IPC', async ({ id, arrange }) => {
    const registry = new Map<string, DaemonSession>();
    const ds = makeDaemonSession();
    ds.worker = { killed: false } as DaemonSession['worker'];
    arrange(ds);
    register(registry, ds);
    const adapters = currentAdapters();
    const host = await currentHost(registry, adapters);

    await expect(submitOrdinary(
      host,
      envelope(`om_park_${id}`, 'preserve activation order'),
    )).resolves.toMatchObject({ kind: 'applied' });
    expect(commandCalls(adapters, 'sendLive')).toHaveLength(0);
    expect(commandCalls(adapters, 'parkOpeningFollower')).toHaveLength(1);
  });

  it('compiles only after Runtime accepts the exact transport key', async () => {
    const registry = new Map<string, DaemonSession>();
    register(registry, makeDaemonSession());
    const realPreparation = createCurrentOrdinaryImTurnPreparationPort();
    const prepare = vi.fn(realPreparation.prepare.bind(realPreparation));
    const adapters = currentAdapters();
    const host = await currentHost(registry, adapters, { prepare });
    const turn = envelope('om_exact_key', 'exact key');

    const mismatch = await submitOrdinary(host, turn, 'om_wrong_key');

    expect(mismatch).toMatchObject({ kind: 'rejected', reason: 'invalidCommand' });
    expect(prepare).not.toHaveBeenCalled();
    expect(callsByMethod(adapters)).toEqual({
      sendLive: 0,
      parkOpeningFollower: 0,
      parkPendingRepoFollower: 0,
      startColdReplacement: 0,
      startQueuedActivation: 0,
      recoverParkedActivation: 0,
    });
  });

  it.each([
    {
      name: 'content',
      mutate: (turn: Record<string, unknown>) => ({ ...turn, content: 'compiler rewrite' }),
    },
    {
      name: 'sender',
      mutate: (turn: Record<string, unknown>) => ({
        ...turn,
        sender: { kind: 'bot', openId: 'ou_rewritten' },
      }),
    },
  ])('fails closed when an injected compiler changes $name semantics', async ({ mutate }) => {
    const registry = new Map<string, DaemonSession>();
    register(registry, makeDaemonSession());
    const realPreparation = createCurrentOrdinaryImTurnPreparationPort();
    const turnPreparation: CurrentOrdinaryImTurnPreparationPort = {
      prepare(input) {
        const result = realPreparation.prepare(input);
        if (result.kind !== 'prepared') return result;
        return {
          kind: 'prepared',
          turn: Object.freeze(mutate(result.turn as unknown as Record<string, unknown>)),
        } as unknown as ReturnType<CurrentOrdinaryImTurnPreparationPort['prepare']>;
      },
    };
    const adapters = currentAdapters();
    const host = await currentHost(registry, adapters, turnPreparation);

    const result = await submitOrdinary(
      host,
      envelope(`om_tampered_${String(mutate)}`, 'original content'),
    );

    expect(result).toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      idempotent: false,
    });
    expect(Object.values(callsByMethod(adapters))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(adapters.externalEffects.execute).not.toHaveBeenCalled();
  });

  it('joins an in-flight same-key duplicate without a second effect', async () => {
    const registry = new Map<string, DaemonSession>();
    const ds = makeDaemonSession();
    ds.worker = { killed: false } as DaemonSession['worker'];
    register(registry, ds);
    const adapters = currentAdapters();
    const gate = deferred<CurrentOrdinaryIngressExternalEffectResult>();
    const started = deferred<void>();
    vi.mocked(adapters.externalEffects.execute).mockImplementationOnce(async () => {
      started.resolve();
      return gate.promise;
    });
    const host = await currentHost(registry, adapters);
    const turn = envelope('om_duplicate', 'deliver once');

    const first = submitOrdinary(host, turn);
    await started.promise;
    let duplicateSettled = false;
    const duplicate = submitOrdinary(host, turn);
    duplicate.then(() => { duplicateSettled = true; });

    await Promise.resolve();
    expect(duplicateSettled).toBe(false);
    expect(adapters.externalEffects.execute).toHaveBeenCalledTimes(1);
    expect(adapters.commands.apply).not.toHaveBeenCalled();
    gate.resolve({ kind: 'materialized' });
    await expect(first).resolves.toMatchObject({ kind: 'applied' });
    await expect(duplicate).resolves.toMatchObject({
      kind: 'duplicate',
      state: 'inputCommitted',
    });

    const afterCommit = await submitOrdinary(host, turn);
    expect(afterCommit).toMatchObject({ kind: 'duplicate', state: 'inputCommitted' });
    expect(adapters.externalEffects.execute).toHaveBeenCalledTimes(1);
    expect(commandCalls(adapters, 'sendLive')).toHaveLength(1);
  });

  it('reclassifies live-to-dead and cold-to-live races inside the same submit', async () => {
    const liveRegistry = new Map<string, DaemonSession>();
    const live = makeDaemonSession();
    live.worker = { killed: false } as DaemonSession['worker'];
    register(liveRegistry, live);
    const liveAdapters = currentAdapters();
    vi.mocked(liveAdapters.commands.apply).mockImplementationOnce(() => {
      live.worker = null;
      return { kind: 'stateChanged' };
    });
    const liveHost = await currentHost(liveRegistry, liveAdapters);

    await expect(submitOrdinary(
      liveHost,
      envelope('om_live_to_dead', 'survive live to dead'),
    )).resolves.toMatchObject({ kind: 'applied' });
    expect(commandCalls(liveAdapters, 'sendLive')).toHaveLength(1);
    expect(commandCalls(liveAdapters, 'startColdReplacement')).toHaveLength(1);
    expect(liveAdapters.externalEffects.execute).toHaveBeenCalledTimes(1);

    const coldRegistry = new Map<string, DaemonSession>();
    const cold = makeDaemonSession('session-2', 'om_root_2', 'oc_chat_2');
    register(coldRegistry, cold);
    const coldAdapters = currentAdapters();
    vi.mocked(coldAdapters.commands.apply).mockImplementationOnce(() => {
      cold.worker = { killed: false } as DaemonSession['worker'];
      return { kind: 'stateChanged' };
    });
    const coldHost = await currentHost(coldRegistry, coldAdapters);

    await expect(submitOrdinary(
      coldHost,
      envelope('om_cold_to_live', 'survive cold to live', 'om_root_2', 'oc_chat_2'),
    )).resolves.toMatchObject({ kind: 'applied' });
    expect(commandCalls(coldAdapters, 'startColdReplacement')).toHaveLength(1);
    expect(commandCalls(coldAdapters, 'sendLive')).toHaveLength(1);
    expect(coldAdapters.externalEffects.execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the delivery boundary never reaches a stable state', async () => {
    const registry = new Map<string, DaemonSession>();
    const ds = makeDaemonSession();
    ds.worker = { killed: false } as DaemonSession['worker'];
    register(registry, ds);
    const adapters = currentAdapters();
    let changes = 0;
    vi.mocked(adapters.commands.apply).mockImplementation(() => {
      changes += 1;
      return changes <= 5
        ? { kind: 'stateChanged' }
        : { kind: 'accepted' };
    });
    const host = await currentHost(registry, adapters);

    await expect(submitOrdinary(
      host,
      envelope('om_unstable_boundary', 'never stable'),
    )).resolves.toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      message: expect.stringContaining('did not stabilize'),
    });
    expect(commandCalls(adapters, 'sendLive')).toHaveLength(4);
    expect(adapters.externalEffects.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'resolved Promise carrying a fabricated accepted kind',
      result: () => Object.assign(
        Promise.resolve({ kind: 'accepted' as const }),
        { kind: 'accepted' as const },
      ),
    },
    {
      name: 'rejected Promise carrying a fabricated accepted kind',
      result: () => Object.assign(
        Promise.reject(new Error('async command rejection')),
        { kind: 'accepted' as const },
      ),
    },
  ])('fails closed and absorbs a $name', async ({ result }) => {
    const registry = new Map<string, DaemonSession>();
    const ds = makeDaemonSession();
    ds.worker = { killed: false } as DaemonSession['worker'];
    register(registry, ds);
    const adapters = currentAdapters();
    vi.mocked(adapters.commands.apply).mockImplementationOnce(() => (
      result() as unknown as CurrentOrdinaryIngressCommandResult
    ));
    const host = await currentHost(registry, adapters);
    const input = envelope(
      `om_thenable_command_${result.name}`,
      'a command Adapter must settle synchronously',
    );

    const first = await submitOrdinary(host, input);
    const duplicate = await submitOrdinary(host, input);

    expect(first).toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      idempotent: false,
      message: expect.stringContaining('must return synchronously'),
    });
    expect(duplicate).toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      idempotent: true,
    });
    expect(adapters.commands.apply).toHaveBeenCalledTimes(1);
  });

  it('absorbs a rejected thenable before reporting a binding replacement', async () => {
    const registry = new Map<string, DaemonSession>();
    const ds = makeDaemonSession();
    ds.worker = { killed: false } as DaemonSession['worker'];
    register(registry, ds);
    const adapters = currentAdapters();
    vi.mocked(adapters.commands.apply).mockImplementationOnce(() => {
      register(registry, makeDaemonSession());
      return Object.assign(
        Promise.reject(new Error('async command rejection after replacement')),
        { kind: 'accepted' as const },
      ) as unknown as CurrentOrdinaryIngressCommandResult;
    });
    const host = await currentHost(registry, adapters);

    await expect(submitOrdinary(
      host,
      envelope('om_thenable_replacement', 'replace while returning a thenable'),
    )).resolves.toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      message: expect.stringContaining('must return synchronously'),
    });
  });

  it('snapshots a command result before accepting it across a binding-changing accessor', async () => {
    const registry = new Map<string, DaemonSession>();
    const ds = makeDaemonSession();
    ds.worker = { killed: false } as DaemonSession['worker'];
    register(registry, ds);
    const adapters = currentAdapters();
    vi.mocked(adapters.commands.apply).mockImplementationOnce(() => {
      const result = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(result, 'kind', {
        enumerable: true,
        get() {
          register(registry, makeDaemonSession());
          return 'accepted';
        },
      });
      return result as CurrentOrdinaryIngressCommandResult;
    });
    const host = await currentHost(registry, adapters);

    await expect(submitOrdinary(
      host,
      envelope('om_accessor_replacement', 'replace while reading command result'),
    )).resolves.toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      message: expect.stringContaining('identity changed'),
    });
  });

  it('restores the opening marker after a live send refusal and permits an exact retry', async () => {
    const registry = new Map<string, DaemonSession>();
    const ds = makeDaemonSession();
    ds.worker = { killed: false } as DaemonSession['worker'];
    ds.session.initialUserTurnPending = true;
    register(registry, ds);
    const adapters = currentAdapters();
    const persistedOpeningStates: Array<boolean | undefined> = [];
    sessionStoreMocks.updateSession.mockImplementation((session: Session) => {
      persistedOpeningStates.push(session.initialUserTurnPending);
    });
    sessionStoreMocks.updateSession.mockClear();
    const firstGate = deferred<void>();
    const firstStarted = deferred<void>();
    vi.mocked(adapters.externalEffects.execute)
      .mockImplementationOnce(async () => {
        firstStarted.resolve();
        await firstGate.promise;
        return { kind: 'materialized' };
      });
    vi.mocked(adapters.commands.apply)
      .mockReturnValueOnce({
        kind: 'refused',
        message: 'worker refused current ordinary turn',
      })
      .mockReturnValueOnce({ kind: 'accepted' });
    const host = await currentHost(registry, adapters);
    const turn = envelope('om_refused', 'opening delivery');

    const owner = submitOrdinary(host, turn);
    await firstStarted.promise;
    let followerSettled = false;
    const follower = submitOrdinary(host, turn);
    follower.then(() => { followerSettled = true; });
    await Promise.resolve();
    expect(followerSettled).toBe(false);
    expect(adapters.externalEffects.execute).toHaveBeenCalledTimes(1);
    expect(adapters.commands.apply).not.toHaveBeenCalled();

    firstGate.resolve();
    const refused = await owner;

    expect(refused).toEqual({
      kind: 'retryable',
      message: 'worker refused current ordinary turn',
    });
    await expect(follower).resolves.toEqual(refused);
    expect(ds.session.initialUserTurnPending).toBe(true);
    expect(ds.lastCliInput).toBeUndefined();
    expect(ds.session.lastCliInput).toBeUndefined();
    expect(persistedOpeningStates).toEqual([undefined, true]);

    // Only a submit that arrives after the joined owner settled may retry.
    await expect(submitOrdinary(host, turn)).resolves.toMatchObject({ kind: 'applied' });
    expect(adapters.externalEffects.execute).toHaveBeenCalledTimes(2);
    expect(commandCalls(adapters, 'sendLive')).toHaveLength(2);
    expect(ds.session.initialUserTurnPending).not.toBe(true);
    expect(persistedOpeningStates).toEqual([undefined, true, undefined]);
    sessionStoreMocks.updateSession.mockReset();
  });

  it('keeps an unknown synchronous command sticky instead of restoring and blindly retrying', async () => {
    const registry = new Map<string, DaemonSession>();
    const ds = makeDaemonSession();
    ds.worker = { killed: false } as DaemonSession['worker'];
    ds.session.initialUserTurnPending = true;
    register(registry, ds);
    const adapters = currentAdapters();
    const firstGate = deferred<void>();
    const firstStarted = deferred<void>();
    vi.mocked(adapters.externalEffects.execute).mockImplementationOnce(async () => {
      firstStarted.resolve();
      await firstGate.promise;
      return { kind: 'materialized' };
    });
    vi.mocked(adapters.commands.apply).mockReturnValueOnce({
      kind: 'unknown',
      message: 'worker acceptance response lost',
    });
    const host = await currentHost(registry, adapters);
    const turn = envelope('om_unknown', 'unknown delivery');

    const owner = submitOrdinary(host, turn);
    await firstStarted.promise;
    const follower = submitOrdinary(host, turn);
    expect(adapters.externalEffects.execute).toHaveBeenCalledTimes(1);
    expect(adapters.commands.apply).not.toHaveBeenCalled();

    firstGate.resolve();
    const first = await owner;

    expect(first).toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      idempotent: false,
    });
    await expect(follower).resolves.toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      idempotent: true,
    });
    const retry = await submitOrdinary(host, turn);
    expect(retry).toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      idempotent: true,
    });
    expect(adapters.externalEffects.execute).toHaveBeenCalledTimes(1);
    expect(commandCalls(adapters, 'sendLive')).toHaveLength(1);
    expect(commandCalls(adapters, 'sendLive')[0]?.input.opening).toBe(true);
    expect(ds.session.initialUserTurnPending).not.toBe(true);
  });

  it('keeps an accepted effect sticky-unknown when its exact Session binding is replaced', async () => {
    const registry = new Map<string, DaemonSession>();
    const original = makeDaemonSession();
    original.worker = { killed: false } as DaemonSession['worker'];
    register(registry, original);
    const adapters = currentAdapters();
    vi.mocked(adapters.commands.apply).mockImplementationOnce(() => {
      const replacement = makeDaemonSession();
      replacement.worker = { killed: false } as DaemonSession['worker'];
      register(registry, replacement);
      return { kind: 'accepted' };
    });
    const host = await currentHost(registry, adapters);
    const turn = envelope('om_replaced_binding', 'effect raced Session replacement');

    const first = await submitOrdinary(host, turn);
    const duplicate = await submitOrdinary(host, turn);

    expect(first).toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      idempotent: false,
    });
    expect(duplicate).toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      idempotent: true,
    });
    expect(commandCalls(adapters, 'sendLive')).toHaveLength(1);
    expect(adapters.externalEffects.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects an in-place Session record replacement behind the same daemon container', async () => {
    const registry = new Map<string, DaemonSession>();
    const ds = makeDaemonSession();
    ds.worker = { killed: false } as DaemonSession['worker'];
    register(registry, ds);
    const adapters = currentAdapters();
    vi.mocked(adapters.commands.apply).mockImplementationOnce(() => {
      ds.session = makeSession();
      return { kind: 'accepted' };
    });
    const host = await currentHost(registry, adapters);

    await expect(submitOrdinary(
      host,
      envelope('om_replaced_session_record', 'same container, different Session record'),
    )).resolves.toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      idempotent: false,
    });
    expect(commandCalls(adapters, 'sendLive')).toHaveLength(1);
  });

  it('lets a different Session complete while one boundary effect is slow', async () => {
    const registry = new Map<string, DaemonSession>();
    const firstDs = makeDaemonSession('session-1', 'om_root_1', 'oc_chat_1');
    const secondDs = makeDaemonSession('session-2', 'om_root_2', 'oc_chat_2');
    firstDs.worker = { killed: false } as DaemonSession['worker'];
    secondDs.worker = { killed: false } as DaemonSession['worker'];
    register(registry, firstDs);
    register(registry, secondDs);
    const adapters = currentAdapters();
    const firstGate = deferred<void>();
    const firstStarted = deferred<void>();
    const order: string[] = [];
    vi.mocked(adapters.externalEffects.execute).mockImplementation(async (
      effect: CurrentOrdinaryIngressExternalEffect,
    ) => {
      const { sessionId } = effect.input;
      order.push(`${sessionId}:start`);
      if (sessionId === firstDs.session.sessionId) {
        firstStarted.resolve();
        await firstGate.promise;
        order.push(`${sessionId}:done`);
        return { kind: 'materialized' };
      }
      order.push(`${sessionId}:done`);
      return { kind: 'materialized' };
    });
    const host = await currentHost(registry, adapters);

    const first = submitOrdinary(
      host,
      envelope('om_slow', 'slow', 'om_root_1', 'oc_chat_1'),
    );
    await firstStarted.promise;
    const second = await submitOrdinary(
      host,
      envelope('om_fast', 'fast', 'om_root_2', 'oc_chat_2'),
    );

    expect(second).toMatchObject({ kind: 'applied', sessionId: 'session-2' });
    expect(order).toEqual(['session-1:start', 'session-2:start', 'session-2:done']);

    firstGate.resolve();
    await expect(first).resolves.toMatchObject({ kind: 'applied', sessionId: 'session-1' });
    expect(order).toEqual([
      'session-1:start',
      'session-2:start',
      'session-2:done',
      'session-1:done',
    ]);
  });
});
