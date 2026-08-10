import { describe, expect, it, vi } from 'vitest';

import {
  createCurrentOrdinaryIngressProductionPort,
  type CurrentOrdinaryIngressProductionExternalEffect,
  type CurrentOrdinaryIngressProductionExternalEffectResult,
  type CurrentOrdinaryIngressProductionMaterial,
  type CurrentOrdinaryIngressWorkerProcessCommand,
} from '../src/core/current-ordinary-ingress-production.js';
import type { OrdinaryImTransportEnvelope } from '../src/core/ordinary-im-turn.js';
import {
  createSessionRuntimeHost,
  type KeyedTriggerAuthority,
  type KeyedTriggerTurnPort,
  type SessionDirectory,
  type SessionDirectoryRow,
} from '../src/core/session-runtime.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type { CliTurnPayload, Session } from '../src/types.js';

vi.mock('../src/services/session-store.js', () => ({ updateSession: vi.fn() }));

const OWNER = 'app-production-materialization';
const SESSION_ID = 'session-production-materialization';
const ANCHOR = 'om_production_materialization_root';
const CHAT_ID = 'oc_production_materialization_chat';
const MESSAGE_ID = 'om_live_becomes_opening';

const FOLLOW_UP_INPUT = Object.freeze({
  content: `cli:follow-up:${MESSAGE_ID}`,
});
const NEW_TOPIC_INPUT = Object.freeze({
  content: `cli:new-topic:${MESSAGE_ID}`,
});
const ADOPT_INPUT = Object.freeze({
  content: `bridge:adopt:${MESSAGE_ID}`,
});

/** The smallest material extension needed for command-time prompt selection. */
type PromptSelectableMaterial = CurrentOrdinaryIngressProductionMaterial & {
  readonly adoptCliInput: CliTurnPayload;
};

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

function envelope(): OrdinaryImTransportEnvelope {
  return {
    route: {
      scope: 'thread',
      canonicalAnchor: ANCHOR,
      chatId: CHAT_ID,
      chatType: 'group',
    },
    source: 'lark.im',
    messageKey: MESSAGE_ID,
    content: 'turn that becomes the opening while materialization is pending',
    sender: { kind: 'human', openId: 'ou_sender', unionId: 'on_sender' },
    mentions: [],
    postParticipantMentions: [],
    resources: [],
    foldedForwardContext: false,
    vc: { contextMayLag: false },
  };
}

function daemonSession(): DaemonSession {
  const session = {
    sessionId: SESSION_ID,
    larkAppId: OWNER,
    rootMessageId: ANCHOR,
    chatId: CHAT_ID,
    chatType: 'group',
    scope: 'thread',
    status: 'active',
    title: 'production materialization',
    initialUserTurnPending: true,
    createdAt: '2026-08-10T00:00:00.000Z',
  } as Session;
  return {
    session,
    worker: { killed: false } as DaemonSession['worker'],
    workerPort: null,
    workerToken: null,
    workerGeneration: 17,
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

function rowFor(ds: DaemonSession): SessionDirectoryRow {
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

function expectDetached(value: object): void {
  for (const forbidden of [
    'current',
    'daemonSession',
    'session',
    'worker',
    'opening',
    'disposition',
  ]) {
    expect(forbidden in value).toBe(false);
  }
}

function materialFor(
  effect: CurrentOrdinaryIngressProductionExternalEffect,
): PromptSelectableMaterial {
  return {
    userPrompt: effect.input.turn.content,
    newTopicUserPrompt: effect.input.turn.content,
    // The external effect materializes every state-neutral candidate. It does
    // not know which one the Current command will own after its await.
    cliInput: FOLLOW_UP_INPUT,
    newTopicCliInput: NEW_TOPIC_INPUT,
    adoptCliInput: ADOPT_INPUT,
    turnId: effect.input.turn.messageKey,
  };
}

async function submitImmediately(ds: DaemonSession): Promise<{
  readonly outcome: Awaited<ReturnType<ReturnType<
    typeof createSessionRuntimeHost
  >['runtime']['submit']>>;
  readonly workerCommands: CurrentOrdinaryIngressWorkerProcessCommand[];
}> {
  const registry = new Map<string, DaemonSession>([[activeSessionKey(ds), ds]]);
  const workerCommands: CurrentOrdinaryIngressWorkerProcessCommand[] = [];
  const ordinaryIngress = createCurrentOrdinaryIngressProductionPort({
    ownerLarkAppId: OWNER,
    activeSessions: registry,
    metadata: {
      apply(_current, input) {
        return { kind: 'committed', sessionId: input.binding.sessionId, turnId: input.turn.messageKey };
      },
    },
    clock: () => Date.parse('2026-08-10T00:00:01.000Z'),
    substituteReplyMode: 'thread',
    externalEffects: {
      async execute(
        effect: CurrentOrdinaryIngressProductionExternalEffect,
      ): Promise<CurrentOrdinaryIngressProductionExternalEffectResult> {
        expectDetached(effect);
        expectDetached(effect.input);
        return { kind: 'materialized', material: materialFor(effect) };
      },
    },
    workerProcesses: {
      dispatch(command) {
        expectDetached(command);
        workerCommands.push(command);
        return { kind: 'accepted' };
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
    sessionId: SESSION_ID,
  });
  if (projection.kind !== 'one') throw new Error('expected existing Session projection');
  const outcome = await host.runtime.submit({
    target: { kind: 'session', address: projection.session.address },
    idempotencyKey: MESSAGE_ID,
    command: { kind: 'ordinary.ingress', input: { turn: envelope() } },
  });
  return { outcome, workerCommands };
}

describe('Current ordinary ingress production prompt selection', () => {
  it('selects new-topic material when a live route becomes an empty-start cold route', async () => {
    const materializationStarted = deferred<void>();
    const releaseMaterialization = deferred<void>();
    const ds = daemonSession();
    const registry = new Map<string, DaemonSession>([[activeSessionKey(ds), ds]]);
    const workerCommands: CurrentOrdinaryIngressWorkerProcessCommand[] = [];
    const ordinaryIngress = createCurrentOrdinaryIngressProductionPort({
      ownerLarkAppId: OWNER,
      activeSessions: registry,
      metadata: {
        apply(_current, input) {
          return { kind: 'committed', sessionId: input.binding.sessionId, turnId: input.turn.messageKey };
        },
      },
      clock: () => Date.parse('2026-08-10T00:00:01.000Z'),
      substituteReplyMode: 'thread',
      externalEffects: {
        async execute(
          effect: CurrentOrdinaryIngressProductionExternalEffect,
        ): Promise<CurrentOrdinaryIngressProductionExternalEffectResult> {
          expectDetached(effect);
          expectDetached(effect.input);
          materializationStarted.resolve();
          await releaseMaterialization.promise;
          return { kind: 'materialized', material: materialFor(effect) };
        },
      },
      workerProcesses: {
        dispatch(command) {
          expectDetached(command);
          workerCommands.push(command);
          return { kind: 'accepted' };
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
      sessionId: SESSION_ID,
    });
    if (projection.kind !== 'one') throw new Error('expected existing Session projection');

    const pending = host.runtime.submit({
      target: { kind: 'session', address: projection.session.address },
      idempotencyKey: MESSAGE_ID,
      command: { kind: 'ordinary.ingress', input: { turn: envelope() } },
    });
    await materializationStarted.promise;

    expect(ds.worker).not.toBeNull();
    expect(ds.session.initialUserTurnPending).toBe(true);
    ds.worker = null;
    releaseMaterialization.resolve();

    const outcome = await pending;
    expect(workerCommands).toEqual([{
      kind: 'forkWorker',
      sessionId: SESSION_ID,
      turnId: MESSAGE_ID,
      input: NEW_TOPIC_INPUT,
      resume: false,
    }]);
    expect(outcome).toMatchObject({
      kind: 'applied',
      action: 'ordinary.inputCommitted',
    });
    expect(ds.session.initialUserTurnPending).not.toBe(true);
  });

  it('uses the bridge candidate and detached adopt fork for a worker-null adopted Session', async () => {
    const ds = daemonSession();
    ds.worker = null;
    ds.session.initialUserTurnPending = undefined;
    ds.adoptedFrom = {
      source: 'tmux',
      tmuxTarget: 'developer:0.1',
      cwd: '/repo',
    };

    const { outcome, workerCommands } = await submitImmediately(ds);

    expect(workerCommands).toEqual([{
      kind: 'forkAdoptWorker',
      sessionId: SESSION_ID,
      turnId: MESSAGE_ID,
      input: ADOPT_INPUT,
    }]);
    expect(workerCommands.some(command => (
      command.kind === 'forkWorker' || 'resume' in command
    ))).toBe(false);
    expect(outcome).toMatchObject({
      kind: 'applied',
      action: 'ordinary.inputCommitted',
    });
  });

  it('keeps the follow-up candidate for a live-ready Session', async () => {
    const ds = daemonSession();
    ds.session.initialUserTurnPending = undefined;
    ds.hasHistory = true;

    const { outcome, workerCommands } = await submitImmediately(ds);

    expect(workerCommands).toEqual([{
      kind: 'sendWorkerInput',
      sessionId: SESSION_ID,
      turnId: MESSAGE_ID,
      input: FOLLOW_UP_INPUT,
      workerGeneration: 17,
    }]);
    expect(outcome).toMatchObject({
      kind: 'applied',
      action: 'ordinary.inputCommitted',
    });
  });
});
