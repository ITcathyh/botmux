import { describe, expect, it, vi } from 'vitest';

import { createCurrentOrdinaryImTurnPreparationPort } from '../src/core/current-ordinary-im-turn.js';
import {
  createCurrentOrdinaryIngressPort,
  type CurrentOrdinaryIngressCommandAdapter,
  type CurrentOrdinaryIngressExternalEffectExecutor,
  type CurrentOrdinaryIngressExternalEffectResult,
} from '../src/core/current-ordinary-ingress.js';
import type { OrdinaryImTransportEnvelope } from '../src/core/ordinary-im-turn.js';
import {
  createSessionRuntimeHost,
  type KeyedTriggerAuthority,
  type KeyedTriggerTurnPort,
  type SessionDirectory,
  type SessionDirectoryRow,
} from '../src/core/session-runtime.js';
import { activeSessionKey, sessionKey, type DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';

vi.mock('../src/services/session-store.js', () => ({ updateSession: vi.fn() }));

const OWNER = 'app-owner';
const SESSION_ID = 'session-arrival-order';
const ANCHOR = 'om_arrival_order_root';
const CHAT_ID = 'oc_arrival_order_chat';
const FIRST_MESSAGE = 'om_arrival_n';
const SECOND_MESSAGE = 'om_arrival_n_plus_1';

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function turn(messageKey: string): OrdinaryImTransportEnvelope {
  return {
    route: {
      scope: 'thread',
      canonicalAnchor: ANCHOR,
      chatId: CHAT_ID,
      chatType: 'group',
    },
    source: 'lark.im',
    messageKey,
    content: messageKey === FIRST_MESSAGE ? 'turn N' : 'turn N+1',
    sender: { kind: 'human', openId: 'ou_sender', unionId: 'on_sender' },
    mentions: [],
    postParticipantMentions: [],
    resources: [],
    foldedForwardContext: false,
    vc: { contextMayLag: false },
  };
}

function sessionRow(ds: DaemonSession): SessionDirectoryRow {
  return {
    key: ds.session.sessionId,
    sessionId: ds.session.sessionId,
    route: { kind: 'thread', anchorId: ANCHOR },
    ordinaryIngressBinding: {
      scope: 'thread',
      canonicalAnchor: ANCHOR,
      chatId: CHAT_ID,
      chatType: 'group',
    },
    recordStatus: 'active',
    executorStatus: 'working',
  };
}

function registryDirectory(ds: DaemonSession): SessionDirectory {
  const row = sessionRow(ds);
  return {
    async read(query) {
      if (query.kind === 'list') return { kind: 'list', rows: [row] };
      if (query.kind === 'byExternalSession') {
        return query.sessionId === SESSION_ID
          ? { kind: 'one', row }
          : { kind: 'notFound' };
      }
      return query.route.kind === 'thread' && query.route.anchorId === ANCHOR
        ? { kind: 'one', row }
        : { kind: 'notFound' };
    },
  };
}

function daemonSession(workerDeliveryOrder: string[]): DaemonSession {
  const session = {
    sessionId: SESSION_ID,
    larkAppId: OWNER,
    rootMessageId: ANCHOR,
    chatId: CHAT_ID,
    chatType: 'group',
    scope: 'thread',
    status: 'active',
    title: 'arrival order',
    createdAt: '2026-08-10T00:00:00.000Z',
  } as Session;
  return {
    session,
    worker: {
      killed: false,
      send(message: { turnId?: string }) {
        if (!message.turnId) throw new Error('worker delivery must carry the exact message key');
        workerDeliveryOrder.push(message.turnId);
      },
    } as DaemonSession['worker'],
    workerPort: null,
    workerToken: null,
    workerGeneration: 1,
    larkAppId: OWNER,
    chatId: CHAT_ID,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.parse('2026-08-10T00:00:00.000Z'),
    cliVersion: 'test',
    lastMessageAt: Date.parse('2026-08-10T00:00:00.000Z'),
    hasHistory: true,
  } as DaemonSession;
}

function controlledExternalBoundary(
  firstMaterializationStarted: ReturnType<typeof deferred<void>>,
  releaseFirstMaterialization: ReturnType<typeof deferred<void>>,
  secondMaterialized: ReturnType<typeof deferred<void>>,
  materializationOrder: string[],
): CurrentOrdinaryIngressExternalEffectExecutor {
  return {
    async execute(effect) {
      const { input } = effect;
      if ('opening' in input) {
        throw new Error('materialization must not receive the opening authority marker');
      }
      if (input.turn.messageKey === FIRST_MESSAGE) {
        firstMaterializationStarted.resolve();
        await releaseFirstMaterialization.promise;
      } else if (input.turn.messageKey === SECOND_MESSAGE) {
        materializationOrder.push(SECOND_MESSAGE);
        secondMaterialized.resolve();
      } else {
        throw new Error(`unexpected message key: ${input.turn.messageKey}`);
      }
      if (input.turn.messageKey === FIRST_MESSAGE) {
        materializationOrder.push(FIRST_MESSAGE);
      }
      return { kind: 'materialized' };
    },
  };
}

function synchronousWorkerCommands(
  registry: ReadonlyMap<string, DaemonSession>,
): CurrentOrdinaryIngressCommandAdapter {
  return {
    apply(command) {
      if ('current' in command) {
        throw new Error('synchronous commands must not expose mutable Current state');
      }
      if (command.kind !== 'sendLive') {
        throw new Error('live-ready tracer must not select a non-live delivery path');
      }
      const current = registry.get(sessionKey(
        command.input.turn.route.canonicalAnchor,
        OWNER,
      ));
      if (!current
        || current.session.sessionId !== command.input.sessionId
        || current.workerGeneration !== command.guard.workerGeneration) {
        return { kind: 'stateChanged' };
      }
      current.worker!.send({
        type: 'message',
        content: command.input.turn.content,
        turnId: command.input.turn.messageKey,
      });
      return { kind: 'accepted' };
    },
  };
}

describe('Current ordinary ingress production ordering', () => {
  it('delivers distinct turns in arrival order when N+1 materializes first', async () => {
    const firstMaterializationStarted = deferred<void>();
    const releaseFirstMaterialization = deferred<void>();
    const secondMaterialized = deferred<void>();
    const materializationOrder: string[] = [];
    const workerDeliveryOrder: string[] = [];
    const ds = daemonSession(workerDeliveryOrder);
    const boundary = controlledExternalBoundary(
      firstMaterializationStarted,
      releaseFirstMaterialization,
      secondMaterialized,
      materializationOrder,
    );
    const registry = new Map<string, DaemonSession>([[activeSessionKey(ds), ds]]);
    const ordinaryIngress = createCurrentOrdinaryIngressPort({
      ownerLarkAppId: OWNER,
      activeSessions: registry,
      turnPreparation: createCurrentOrdinaryImTurnPreparationPort(),
      externalEffects: boundary,
      commands: synchronousWorkerCommands(registry),
    });
    const host = createSessionRuntimeHost({
      directory: registryDirectory(ds),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress,
    });
    const projection = await host.projection.read({
      kind: 'byExternalSession',
      sessionId: SESSION_ID,
    });
    if (projection.kind !== 'one') throw new Error('expected existing Session projection');
    const submit = (input: OrdinaryImTransportEnvelope) => host.runtime.submit({
      target: { kind: 'session', address: projection.session.address },
      idempotencyKey: input.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: input } },
    });

    const first = submit(turn(FIRST_MESSAGE));
    await firstMaterializationStarted.promise;
    const second = submit(turn(SECOND_MESSAGE));
    await secondMaterialized.promise;
    releaseFirstMaterialization.resolve();

    await expect(first).resolves.toMatchObject({
      kind: 'applied',
      action: 'ordinary.inputCommitted',
    });
    await expect(second).resolves.toMatchObject({
      kind: 'applied',
      action: 'ordinary.inputCommitted',
    });
    expect(materializationOrder).toEqual([SECOND_MESSAGE, FIRST_MESSAGE]);
    expect(workerDeliveryOrder).toEqual([FIRST_MESSAGE, SECOND_MESSAGE]);
  });

  it('settles a synchronous N+1 materializer failure only after N delivers', async () => {
    const firstMaterializationStarted = deferred<void>();
    const releaseFirstMaterialization = deferred<void>();
    const secondMaterializationStarted = deferred<void>();
    const workerDeliveryOrder: string[] = [];
    const ds = daemonSession(workerDeliveryOrder);
    const registry = new Map<string, DaemonSession>([[activeSessionKey(ds), ds]]);
    const externalEffects: CurrentOrdinaryIngressExternalEffectExecutor = {
      execute(effect) {
        if (effect.input.turn.messageKey === FIRST_MESSAGE) {
          firstMaterializationStarted.resolve();
          return releaseFirstMaterialization.promise.then(() => ({ kind: 'materialized' }));
        }
        secondMaterializationStarted.resolve();
        throw new Error('materializer configuration is unavailable');
      },
    };
    const ordinaryIngress = createCurrentOrdinaryIngressPort({
      ownerLarkAppId: OWNER,
      activeSessions: registry,
      turnPreparation: createCurrentOrdinaryImTurnPreparationPort(),
      externalEffects,
      commands: synchronousWorkerCommands(registry),
    });
    const host = createSessionRuntimeHost({
      directory: registryDirectory(ds),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress,
    });
    const projection = await host.projection.read({
      kind: 'byExternalSession',
      sessionId: SESSION_ID,
    });
    if (projection.kind !== 'one') throw new Error('expected existing Session projection');
    const submit = (input: OrdinaryImTransportEnvelope) => host.runtime.submit({
      target: { kind: 'session', address: projection.session.address },
      idempotencyKey: input.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: input } },
    });

    const first = submit(turn(FIRST_MESSAGE));
    await firstMaterializationStarted.promise;
    let secondSettled = false;
    const second = submit(turn(SECOND_MESSAGE));
    second.then(() => { secondSettled = true; });
    await secondMaterializationStarted.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(secondSettled).toBe(false);
    releaseFirstMaterialization.resolve();
    await expect(first).resolves.toMatchObject({ kind: 'applied' });
    await expect(second).resolves.toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      message: expect.stringContaining('materializer configuration is unavailable'),
    });
    expect(workerDeliveryOrder).toEqual([FIRST_MESSAGE]);
  });

  it('lets queued N+1 reclaim an opening restored by N refusal', async () => {
    const firstMaterializationStarted = deferred<void>();
    const releaseFirstMaterialization = deferred<void>();
    const secondMaterialized = deferred<void>();
    const ds = daemonSession([]);
    ds.session.initialUserTurnPending = true;
    const registry = new Map<string, DaemonSession>([[activeSessionKey(ds), ds]]);
    const externalEffects: CurrentOrdinaryIngressExternalEffectExecutor = {
      async execute(effect) {
        if (effect.input.turn.messageKey === FIRST_MESSAGE) {
          firstMaterializationStarted.resolve();
          await releaseFirstMaterialization.promise;
        } else {
          secondMaterialized.resolve();
        }
        return { kind: 'materialized' };
      },
    };
    const delivered: Array<{ messageKey: string; opening: boolean }> = [];
    const commands: CurrentOrdinaryIngressCommandAdapter = {
      apply(command) {
        delivered.push({
          messageKey: command.input.turn.messageKey,
          opening: command.input.opening,
        });
        return command.input.turn.messageKey === FIRST_MESSAGE
          ? { kind: 'refused', message: 'N was not accepted' }
          : { kind: 'accepted' };
      },
    };
    const ordinaryIngress = createCurrentOrdinaryIngressPort({
      ownerLarkAppId: OWNER,
      activeSessions: registry,
      turnPreparation: createCurrentOrdinaryImTurnPreparationPort(),
      externalEffects,
      commands,
    });
    const host = createSessionRuntimeHost({
      directory: registryDirectory(ds),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress,
    });
    const projection = await host.projection.read({
      kind: 'byExternalSession',
      sessionId: SESSION_ID,
    });
    if (projection.kind !== 'one') throw new Error('expected existing Session projection');
    const submit = (input: OrdinaryImTransportEnvelope) => host.runtime.submit({
      target: { kind: 'session', address: projection.session.address },
      idempotencyKey: input.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: input } },
    });

    const first = submit(turn(FIRST_MESSAGE));
    await firstMaterializationStarted.promise;
    const second = submit(turn(SECOND_MESSAGE));
    await secondMaterialized.promise;
    releaseFirstMaterialization.resolve();

    await expect(first).resolves.toEqual({ kind: 'retryable', message: 'N was not accepted' });
    await expect(second).resolves.toMatchObject({ kind: 'applied' });
    expect(delivered).toEqual([
      { messageKey: FIRST_MESSAGE, opening: true },
      { messageKey: SECOND_MESSAGE, opening: true },
    ]);
    expect(ds.session.initialUserTurnPending).not.toBe(true);
  });

  it('does not claim opening while a long materialization is pending', async () => {
    const materializationStarted = deferred<void>();
    const releaseMaterialization = deferred<void>();
    const ds = daemonSession([]);
    ds.session.initialUserTurnPending = true;
    const registry = new Map<string, DaemonSession>([[activeSessionKey(ds), ds]]);
    const openings: boolean[] = [];
    const ordinaryIngress = createCurrentOrdinaryIngressPort({
      ownerLarkAppId: OWNER,
      activeSessions: registry,
      turnPreparation: createCurrentOrdinaryImTurnPreparationPort(),
      externalEffects: {
        async execute() {
          materializationStarted.resolve();
          await releaseMaterialization.promise;
          return { kind: 'materialized' };
        },
      },
      commands: {
        apply(command) {
          openings.push(command.input.opening);
          return { kind: 'accepted' };
        },
      },
    });
    const host = createSessionRuntimeHost({
      directory: registryDirectory(ds),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress,
    });
    const projection = await host.projection.read({
      kind: 'byExternalSession',
      sessionId: SESSION_ID,
    });
    if (projection.kind !== 'one') throw new Error('expected existing Session projection');

    const pending = host.runtime.submit({
      target: { kind: 'session', address: projection.session.address },
      idempotencyKey: FIRST_MESSAGE,
      command: { kind: 'ordinary.ingress', input: { turn: turn(FIRST_MESSAGE) } },
    });
    await materializationStarted.promise;

    expect(ds.session.initialUserTurnPending).toBe(true);
    releaseMaterialization.resolve();
    await expect(pending).resolves.toMatchObject({ kind: 'applied' });
    expect(openings).toEqual([true]);
    expect(ds.session.initialUserTurnPending).not.toBe(true);
  });

  it.each(['throw', 'unknown', 'invalid'] as const)(
    'preserves opening when materialization ends as %s before any command',
    async (failure) => {
      const ds = daemonSession([]);
      ds.session.initialUserTurnPending = true;
      const registry = new Map<string, DaemonSession>([[activeSessionKey(ds), ds]]);
      const commandOpenings: boolean[] = [];
      const externalEffects: CurrentOrdinaryIngressExternalEffectExecutor = {
        async execute(effect) {
          if (effect.input.turn.messageKey !== FIRST_MESSAGE) {
            return { kind: 'materialized' };
          }
          if (failure === 'throw') {
            throw new Error('materialization threw before command');
          }
          if (failure === 'unknown') {
            return { kind: 'unknown', message: 'materialization outcome is unknown' };
          }
          return {
            kind: 'fabricated',
          } as unknown as CurrentOrdinaryIngressExternalEffectResult;
        },
      };
      const commands: CurrentOrdinaryIngressCommandAdapter = {
        apply(command) {
          commandOpenings.push(command.input.opening);
          return { kind: 'accepted' };
        },
      };
      const ordinaryIngress = createCurrentOrdinaryIngressPort({
        ownerLarkAppId: OWNER,
        activeSessions: registry,
        turnPreparation: createCurrentOrdinaryImTurnPreparationPort(),
        externalEffects,
        commands,
      });
      const host = createSessionRuntimeHost({
        directory: registryDirectory(ds),
        keyedTriggers: unusedKeyedAuthority,
        keyedTriggerTurns: unusedKeyedTurns,
        ordinaryIngress,
      });
      const projection = await host.projection.read({
        kind: 'byExternalSession',
        sessionId: SESSION_ID,
      });
      if (projection.kind !== 'one') throw new Error('expected existing Session projection');
      const submit = (input: OrdinaryImTransportEnvelope) => host.runtime.submit({
        target: { kind: 'session', address: projection.session.address },
        idempotencyKey: input.messageKey,
        command: { kind: 'ordinary.ingress', input: { turn: input } },
      });

      await expect(submit(turn(FIRST_MESSAGE))).resolves.toMatchObject({
        kind: 'ambiguous',
        state: 'commitUnknown',
      });
      expect(commandOpenings).toEqual([]);
      expect(ds.session.initialUserTurnPending).toBe(true);

      await expect(submit(turn(SECOND_MESSAGE))).resolves.toMatchObject({ kind: 'applied' });
      expect(commandOpenings).toEqual([true]);
      expect(ds.session.initialUserTurnPending).not.toBe(true);
    },
  );
});
