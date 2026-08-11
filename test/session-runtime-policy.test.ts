import { describe, expect, it, vi } from 'vitest';
import {
  createSessionRuntimeHost,
  type ControlRenameEffectPort,
  type ControlMutationPort,
  type ExecutorAddress,
  type ExecutorObservationPort,
  type KeyedTriggerAuthority,
  type KeyedTriggerTurnPort,
  type OrdinaryIngressPort,
  type PendingRepoCompletionPort,
  type SessionAddress,
  type SessionDirectory,
  type SessionDirectoryRow,
} from '../src/core/session-runtime.js';
import type { OrdinaryImTransportEnvelope } from '../src/core/ordinary-im-turn.js';
import type {
  SessionStore,
  SessionStoreVersion,
  StoredSessionState,
} from '../src/core/session-store.js';
import type {
  DispatchInputCommitEvidence,
  DispatchInputCommitEvidencePort,
} from '../src/core/dispatch-input-commit-evidence.js';
import { computeInputHash } from '../src/utils/canonical-input-hash.js';

class OneSessionDirectory implements SessionDirectory {
  async read(query: Parameters<SessionDirectory['read']>[0]) {
    if (query.kind === 'list') {
      return {
        kind: 'list' as const,
        rows: [{
          key: 'session-1',
          sessionId: 'session-1',
          route: { kind: 'thread' as const, anchorId: 'om_root' },
          ordinaryIngressBinding: {
            scope: 'thread' as const,
            canonicalAnchor: 'om_root',
            chatId: 'oc_chat',
            chatType: 'group' as const,
          },
          recordStatus: 'active' as const,
          executorStatus: 'working' as const,
        }],
      };
    }
    return {
      kind: 'one' as const,
      row: {
        key: 'session-1',
        sessionId: 'session-1',
        route: { kind: 'thread' as const, anchorId: 'om_root' },
        ordinaryIngressBinding: {
          scope: 'thread' as const,
          canonicalAnchor: 'om_root',
          chatId: 'oc_chat',
          chatType: 'group' as const,
        },
        recordStatus: 'active' as const,
        executorStatus: 'working' as const,
      },
    };
  }
}

class TwoSessionDirectory implements SessionDirectory {
  private readonly rows = ['session-1', 'session-2'].map((sessionId, index) => ({
    key: sessionId,
    sessionId,
    route: { kind: 'thread' as const, anchorId: `om_root_${index + 1}` },
    ordinaryIngressBinding: {
      scope: 'thread' as const,
      canonicalAnchor: `om_root_${index + 1}`,
      chatId: `oc_chat_${index + 1}`,
      chatType: 'group' as const,
    },
    recordStatus: 'active' as const,
    executorStatus: 'working' as const,
  }));

  async read(query: Parameters<SessionDirectory['read']>[0]) {
    if (query.kind === 'list') return { kind: 'list' as const, rows: this.rows };
    const row = query.kind === 'byExternalSession'
      ? this.rows.find(candidate => candidate.sessionId === query.sessionId)
      : this.rows.find(candidate => candidate.route.anchorId === query.route.anchorId);
    return row ? { kind: 'one' as const, row } : { kind: 'notFound' as const };
  }
}

class MutableSessionDirectory implements SessionDirectory {
  constructor(public row: SessionDirectoryRow) {}

  async read(query: Parameters<SessionDirectory['read']>[0]) {
    if (query.kind === 'list') return { kind: 'list' as const, rows: [this.row] };
    return { kind: 'one' as const, row: this.row };
  }
}

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

function ordinaryTurn(messageKey: string, content = 'hello'): OrdinaryImTransportEnvelope {
  return {
    route: {
      scope: 'thread',
      canonicalAnchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
    },
    source: 'lark.im',
    messageKey,
    content,
    sender: { kind: 'human', openId: 'ou_sender', unionId: 'on_sender' },
    mentions: [],
    postParticipantMentions: [],
    resources: [],
    foldedForwardContext: false,
    vc: { contextMayLag: false },
  };
}

function ordinaryPort(begin: OrdinaryIngressPort['begin']): OrdinaryIngressPort {
  return {
    begin,
    execute: async () => { throw new Error('ordinary test port has no effect'); },
    resume: () => { throw new Error('ordinary test port has no continuation'); },
  };
}

function mutableRow(overrides: Partial<SessionDirectoryRow> = {}): SessionDirectoryRow {
  return {
    key: 'stable-row-key',
    sessionId: 'session-1',
    route: { kind: 'thread', anchorId: 'om_root' },
    ordinaryIngressBinding: {
      scope: 'thread',
      canonicalAnchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
    },
    recordStatus: 'active',
    executorStatus: 'working',
    ...overrides,
  } as SessionDirectoryRow;
}

async function onlyProjectedAddress(
  host: ReturnType<typeof createSessionRuntimeHost>,
): Promise<SessionAddress> {
  const projected = await host.projection.read({ kind: 'list' });
  if (projected.kind !== 'list' || projected.sessions.length !== 1) {
    throw new Error('expected one projected Session');
  }
  return projected.sessions[0]!.address;
}

async function addressFor(host: ReturnType<typeof createSessionRuntimeHost>): Promise<SessionAddress> {
  const result = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-1' });
  if (result.kind !== 'one') throw new Error('expected Session projection');
  return result.session.address;
}

describe('SessionRuntime ordinary ingress policy', () => {
  it.each([
    {
      label: 'scope',
      mutate: (turn: OrdinaryImTransportEnvelope): OrdinaryImTransportEnvelope => ({
        ...turn,
        route: { ...turn.route, scope: 'chat' },
      }),
    },
    {
      label: 'canonical anchor',
      mutate: (turn: OrdinaryImTransportEnvelope): OrdinaryImTransportEnvelope => ({
        ...turn,
        route: { ...turn.route, canonicalAnchor: 'om_other' },
      }),
    },
    {
      label: 'chat id',
      mutate: (turn: OrdinaryImTransportEnvelope): OrdinaryImTransportEnvelope => ({
        ...turn,
        route: { ...turn.route, chatId: 'oc_other' },
      }),
    },
    {
      label: 'chat type',
      mutate: (turn: OrdinaryImTransportEnvelope): OrdinaryImTransportEnvelope => ({
        ...turn,
        route: { ...turn.route, chatType: 'p2p' },
      }),
    },
  ])('rejects a mismatched ordinary $label before ledger/port mutation', async ({ mutate }) => {
    const begin = vi.fn(() => ({ kind: 'committed' as const }));
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress: ordinaryPort(begin),
    });
    const address = await addressFor(host);
    const correct = ordinaryTurn('route-fence');

    const invalid = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: correct.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: mutate(correct) } },
    });
    expect(invalid).toEqual({
      kind: 'rejected',
      reason: 'invalidCommand',
      message: 'ordinary ingress turn route does not match the target Session address',
    });
    expect(begin).not.toHaveBeenCalled();

    await expect(host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: correct.messageKey,
      command: { kind: 'ordinary.ingress', input: { turn: correct } },
    })).resolves.toMatchObject({ kind: 'applied' });
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'Session id',
      replace: () => mutableRow({ sessionId: 'session-2' }),
      nextTurn: () => ordinaryTurn('binding-rotation'),
    },
    {
      label: 'full route binding',
      replace: () => mutableRow({
        route: { kind: 'thread', anchorId: 'om_next' },
        ordinaryIngressBinding: {
          scope: 'thread',
          canonicalAnchor: 'om_next',
          chatId: 'oc_next',
          chatType: 'p2p',
        },
      }),
      nextTurn: () => ({
        ...ordinaryTurn('binding-rotation'),
        route: {
          scope: 'thread' as const,
          canonicalAnchor: 'om_next',
          chatId: 'oc_next',
          chatType: 'p2p' as const,
        },
      }),
    },
  ])('rotates an address when one row key changes its $label binding', async ({ replace, nextTurn }) => {
    const directory = new MutableSessionDirectory(mutableRow());
    const begin = vi.fn(() => ({ kind: 'committed' as const }));
    const host = createSessionRuntimeHost({
      directory,
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress: ordinaryPort(begin),
    });
    const oldAddress = await onlyProjectedAddress(host);

    directory.row = replace();
    const nextAddress = await onlyProjectedAddress(host);

    expect(nextAddress).not.toBe(oldAddress);
    await expect(host.runtime.submit({
      target: { kind: 'session', address: oldAddress },
      idempotencyKey: 'binding-rotation',
      command: {
        kind: 'ordinary.ingress',
        input: { turn: ordinaryTurn('binding-rotation') },
      },
    })).resolves.toEqual({ kind: 'staleAddress' });
    await expect(host.runtime.submit({
      target: { kind: 'session', address: nextAddress },
      idempotencyKey: 'binding-rotation',
      command: { kind: 'ordinary.ingress', input: { turn: nextTurn() } },
    })).resolves.toMatchObject({ kind: 'applied' });
  });

  it('records only process-local input commitment and joins a same-payload duplicate', async () => {
    const commit = vi.fn(() => ({ kind: 'committed' as const }));
    const ordinaryIngress = ordinaryPort(commit);
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress,
    });
    const address = await addressFor(host);
    const request = {
      target: { kind: 'session' as const, address },
      idempotencyKey: 'event-1',
      command: {
        kind: 'ordinary.ingress' as const,
        input: { turn: ordinaryTurn('event-1') },
      },
    };

    const first = await host.runtime.submit(request);
    const duplicate = await host.runtime.submit(request);

    expect(first).toEqual({
      kind: 'applied',
      action: 'ordinary.inputCommitted',
      policy: 'ordinary-replayable',
      durability: 'processLocal',
      sessionId: 'session-1',
    });
    expect(duplicate).toEqual({
      kind: 'duplicate',
      state: 'inputCommitted',
      policy: 'ordinary-replayable',
      durability: 'processLocal',
      sessionId: 'session-1',
      message: 'ordinary input was already committed in this runtime epoch',
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect('receipt' in first).toBe(false);
    expect('receipt' in duplicate).toBe(false);
  });

  it('queues a re-entrant same-Session duplicate until the first commitment finishes', async () => {
    const order: string[] = [];
    let nested: ReturnType<ReturnType<typeof createSessionRuntimeHost>['runtime']['submit']> | undefined;
    let host!: ReturnType<typeof createSessionRuntimeHost>;
    let request!: {
      target: { kind: 'session'; address: SessionAddress };
      idempotencyKey: string;
      command: { kind: 'ordinary.ingress'; input: { turn: OrdinaryImTransportEnvelope } };
    };
    const commit = vi.fn(() => {
      order.push('outer:commit:start');
      nested = host.runtime.submit(request);
      order.push('outer:commit:end');
      return { kind: 'committed' as const };
    });
    host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress: ordinaryPort(commit),
    });
    const address = await addressFor(host);
    request = {
      target: { kind: 'session', address },
      idempotencyKey: 'event-reentrant',
      command: { kind: 'ordinary.ingress', input: { turn: ordinaryTurn('event-reentrant') } },
    };

    const first = await host.runtime.submit(request);
    const committed = await nested!;

    expect(first).toMatchObject({ kind: 'applied', action: 'ordinary.inputCommitted' });
    expect(committed).toMatchObject({
      kind: 'duplicate',
      state: 'inputCommitted',
      policy: 'ordinary-replayable',
      durability: 'processLocal',
    });
    expect(order).toEqual(['outer:commit:start', 'outer:commit:end']);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a sync-only ordinary Adapter returns a Promise', async () => {
    const asyncBegin = vi.fn(async () => ({ kind: 'committed' as const }));
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress: {
        ...ordinaryPort(() => ({ kind: 'committed' })),
        begin: asyncBegin as unknown as OrdinaryIngressPort['begin'],
      },
    });
    const address = await addressFor(host);

    const result = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'event-async-adapter',
      command: { kind: 'ordinary.ingress', input: { turn: ordinaryTurn('event-async-adapter') } },
    });

    expect(result).toEqual({
      kind: 'quarantined',
      message: 'OrdinaryIngressPort.begin must return synchronously',
    });
    expect(asyncBegin).toHaveBeenCalledTimes(1);
  });

  it('keeps an unknown input commitment sticky and never turns it into a blind replay', async () => {
    const commit = vi.fn()
      .mockReturnValueOnce({ kind: 'unknown' as const, message: 'input hand-off response lost' })
      .mockReturnValue({ kind: 'committed' as const });
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress: ordinaryPort(commit),
    });
    const address = await addressFor(host);
    const request = {
      target: { kind: 'session' as const, address },
      idempotencyKey: 'event-unknown',
      command: { kind: 'ordinary.ingress' as const, input: { turn: ordinaryTurn('event-unknown') } },
    };

    const first = await host.runtime.submit(request);
    const retry = await host.runtime.submit(request);

    expect(first).toEqual({
      kind: 'ambiguous',
      state: 'commitUnknown',
      policy: 'ordinary-replayable',
      durability: 'processLocal',
      sessionId: 'session-1',
      message: 'input hand-off response lost',
      idempotent: false,
    });
    expect(retry).toMatchObject({
      kind: 'ambiguous',
      state: 'commitUnknown',
      policy: 'ordinary-replayable',
      idempotent: true,
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect('receipt' in first).toBe(false);
  });

  it('does not imply a durable mailbox across Runtime epochs', async () => {
    const commit = vi.fn(() => ({ kind: 'committed' as const }));
    const makeHost = () => createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress: ordinaryPort(commit),
    });
    const firstHost = makeHost();
    const firstAddress = await addressFor(firstHost);
    const first = await firstHost.runtime.submit({
      target: { kind: 'session', address: firstAddress },
      idempotencyKey: 'event-process-local',
      command: { kind: 'ordinary.ingress', input: { turn: ordinaryTurn('event-process-local') } },
    });
    const nextHost = makeHost();
    const nextAddress = await addressFor(nextHost);
    const afterRestart = await nextHost.runtime.submit({
      target: { kind: 'session', address: nextAddress },
      idempotencyKey: 'event-process-local',
      command: { kind: 'ordinary.ingress', input: { turn: ordinaryTurn('event-process-local') } },
    });

    expect(first).toMatchObject({ kind: 'applied', durability: 'processLocal' });
    expect(afterRestart).toMatchObject({ kind: 'applied', durability: 'processLocal' });
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('partitions ordinary idempotency identity by logical Session', async () => {
    const commit = vi.fn(() => ({ kind: 'committed' as const }));
    const host = createSessionRuntimeHost({
      directory: new TwoSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress: ordinaryPort(commit),
    });
    const firstProjection = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-1' });
    const secondProjection = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-2' });
    if (firstProjection.kind !== 'one' || secondProjection.kind !== 'one') {
      throw new Error('expected both Session projections');
    }
    const baseTurn = ordinaryTurn('provider-event-1', 'same event key');

    const first = await host.runtime.submit({
      target: { kind: 'session', address: firstProjection.session.address },
      idempotencyKey: 'provider-event-1',
      command: {
        kind: 'ordinary.ingress',
        input: {
          turn: {
            ...baseTurn,
            route: {
              ...baseTurn.route,
              canonicalAnchor: 'om_root_1',
              chatId: 'oc_chat_1',
            },
          },
        },
      },
    });
    const second = await host.runtime.submit({
      target: { kind: 'session', address: secondProjection.session.address },
      idempotencyKey: 'provider-event-1',
      command: {
        kind: 'ordinary.ingress',
        input: {
          turn: {
            ...baseTurn,
            route: {
              ...baseTurn.route,
              canonicalAnchor: 'om_root_2',
              chatId: 'oc_chat_2',
            },
          },
        },
      },
    });

    expect(first).toMatchObject({ kind: 'applied', sessionId: 'session-1' });
    expect(second).toMatchObject({ kind: 'applied', sessionId: 'session-2' });
    expect(commit).toHaveBeenCalledTimes(2);
  });
});

function storeVersion(): SessionStoreVersion {
  return Object.freeze({}) as SessionStoreVersion;
}

function storedState(overrides: Partial<StoredSessionState> = {}): StoredSessionState {
  return {
    sessionId: 'session-1',
    route: { kind: 'thread', anchorId: 'om_root' },
    recordStatus: 'active',
    title: 'Before',
    executorGeneration: 7,
    ...overrides,
  };
}

describe('SessionRuntime control policy', () => {
  it('holds the Session barrier through native rename settlement and replays the exact effect once', async () => {
    const states = new Map([
      ['session-1', storedState({ sessionId: 'session-1' })],
      ['session-2', storedState({
        sessionId: 'session-2',
        route: { kind: 'thread', anchorId: 'om_root_2' },
      })],
    ]);
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
    const executeRename = vi.fn<ControlRenameEffectPort['execute']>(async (intent) => {
      if ((intent as { sessionId: string }).sessionId === 'session-1') await renameGate;
      return { status: 'requested', cliId: 'codex' };
    });
    const beginRename = vi.fn<ControlRenameEffectPort['begin']>((input) => ({
      kind: 'effect',
      intent: { sessionId: input.sessionId, title: input.title },
    }));
    const controlBegin = vi.fn<ControlMutationPort['begin']>(({ command }) => ({
      kind: 'committed',
      result: command.kind === 'close'
        ? { kind: 'closed', alreadyClosed: false, known: true }
        : { kind: 'lockUpdated', locked: false },
    }));
    const ordinaryBegin = vi.fn<OrdinaryIngressPort['begin']>(() => ({ kind: 'committed' }));
    const host = createSessionRuntimeHost({
      directory: new TwoSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore: {
        load: sessionId => ({
          kind: 'loaded',
          state: states.get(sessionId)!,
          version: storeVersion(),
        }),
        apply: input => {
          if (input.transition.kind !== 'rename') throw new Error('expected rename');
          const next = {
            ...states.get(input.sessionId)!,
            title: input.transition.title,
            titleUpdatedAt: input.transition.updatedAt,
            titleSource: input.transition.source,
          };
          states.set(input.sessionId, next);
          return { kind: 'applied', state: next, nextVersion: storeVersion() };
        },
      },
      controlRenameEffect: { begin: beginRename, execute: executeRename },
      controlMutation: {
        begin: controlBegin,
        execute: async () => { throw new Error('control effect not expected'); },
        resume: () => ({ kind: 'unknown', message: 'control continuation not expected' }),
      },
      ordinaryIngress: ordinaryPort(ordinaryBegin),
    });
    const first = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-1' });
    const second = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-2' });
    if (first.kind !== 'one' || second.kind !== 'one') throw new Error('expected both Sessions');
    const request = {
      target: { kind: 'session' as const, address: first.session.address },
      idempotencyKey: 'rename-staged-effect',
      command: {
        kind: 'control.rename' as const,
        input: {
          title: 'After',
          updatedAt: '2026-08-12T01:00:00.000Z',
          source: 'dashboard' as const,
        },
      },
    };

    const rename = host.runtime.submit(request);
    await vi.waitFor(() => expect(executeRename).toHaveBeenCalledTimes(1));
    const renameFollower = host.runtime.submit(request);
    const close = host.runtime.submit({
      target: request.target,
      idempotencyKey: 'close-after-rename',
      command: { kind: 'control.mutate', input: { kind: 'close', reason: 'dashboard' } },
    });
    const sameSessionOrdinary = host.runtime.submit({
      target: request.target,
      idempotencyKey: 'ordinary-after-rename',
      command: {
        kind: 'ordinary.ingress',
        input: {
          turn: {
            ...ordinaryTurn('ordinary-after-rename'),
            route: {
              scope: 'thread',
              canonicalAnchor: 'om_root_1',
              chatId: 'oc_chat_1',
              chatType: 'group',
            },
          },
        },
      },
    });
    const otherSessionOrdinary = host.runtime.submit({
      target: { kind: 'session', address: second.session.address },
      idempotencyKey: 'ordinary-other-session',
      command: {
        kind: 'ordinary.ingress',
        input: {
          turn: {
            ...ordinaryTurn('ordinary-other-session'),
            route: {
              scope: 'thread',
              canonicalAnchor: 'om_root_2',
              chatId: 'oc_chat_2',
              chatType: 'group',
            },
          },
        },
      },
    });

    await expect(otherSessionOrdinary).resolves.toMatchObject({
      kind: 'applied',
      sessionId: 'session-2',
    });
    let closeSettled = false;
    let ordinarySettled = false;
    close.then(() => { closeSettled = true; });
    sameSessionOrdinary.then(() => { ordinarySettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(ordinarySettled).toBe(false);
    expect(controlBegin).not.toHaveBeenCalled();
    expect(ordinaryBegin).toHaveBeenCalledTimes(1);

    releaseRename();
    const renamed = await rename;
    await expect(renameFollower).resolves.toMatchObject({
      kind: 'duplicate',
      result: { agentSync: { status: 'requested', cliId: 'codex' } },
    });
    await expect(close).resolves.toMatchObject({ kind: 'applied', sessionId: 'session-1' });
    await expect(sameSessionOrdinary).resolves.toMatchObject({ kind: 'applied', sessionId: 'session-1' });
    expect(renamed).toMatchObject({
      kind: 'applied',
      action: 'control.renamed',
      agentSync: { status: 'requested', cliId: 'codex' },
    });
    await expect(host.runtime.submit(request)).resolves.toMatchObject({
      kind: 'duplicate',
      result: { agentSync: { status: 'requested', cliId: 'codex' } },
    });
    expect(beginRename).toHaveBeenCalledTimes(1);
    expect(executeRename).toHaveBeenCalledTimes(1);
  });

  it('keeps a thrown native rename outcome sticky without sending it twice', async () => {
    const states = new Map([
      ['session-1', storedState({ sessionId: 'session-1' })],
      ['session-2', storedState({
        sessionId: 'session-2',
        route: { kind: 'thread', anchorId: 'om_root_2' },
      })],
    ]);
    const execute = vi.fn(async (intent: unknown) => {
      if ((intent as { sessionId: string }).sessionId === 'session-1') {
        throw new Error('worker acknowledgement lost');
      }
      return { status: 'requested' as const, cliId: 'codex' as const };
    });
    const begin = vi.fn<ControlRenameEffectPort['begin']>((input) => ({
      kind: 'effect',
      intent: { sessionId: input.sessionId },
    }));
    const host = createSessionRuntimeHost({
      directory: new TwoSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore: {
        load: sessionId => ({
          kind: 'loaded',
          state: states.get(sessionId)!,
          version: storeVersion(),
        }),
        apply: input => {
          if (input.transition.kind !== 'rename') throw new Error('expected rename');
          const state = {
            ...states.get(input.sessionId)!,
            title: input.transition.title,
            titleUpdatedAt: input.transition.updatedAt,
            titleSource: input.transition.source,
          };
          states.set(input.sessionId, state);
          return { kind: 'applied', state, nextVersion: storeVersion() };
        },
      },
      controlRenameEffect: {
        begin,
        execute,
      },
    });
    const firstProjection = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-1' });
    const secondProjection = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-2' });
    if (firstProjection.kind !== 'one' || secondProjection.kind !== 'one') {
      throw new Error('expected both Session projections');
    }
    const request = {
      target: { kind: 'session' as const, address: firstProjection.session.address },
      idempotencyKey: 'rename-effect-unknown',
      command: {
        kind: 'control.rename' as const,
        input: { title: 'After', source: 'dashboard' as const },
      },
    };

    const first = await host.runtime.submit(request);
    const replay = await host.runtime.submit(request);
    const differentKey = await host.runtime.submit({
      ...request,
      idempotencyKey: 'rename-effect-after-unknown',
    });
    const closeAfterUnknown = await host.runtime.submit({
      target: request.target,
      idempotencyKey: 'close-after-rename-unknown',
      command: { kind: 'control.mutate', input: { kind: 'close', reason: 'dashboard' } },
    });
    const otherSession = await host.runtime.submit({
      target: { kind: 'session', address: secondProjection.session.address },
      idempotencyKey: 'rename-other-after-unknown',
      command: {
        kind: 'control.rename',
        input: { title: 'Other after', source: 'dashboard' },
      },
    });

    expect(first).toMatchObject({ kind: 'ambiguous', policy: 'control-semantic-transition' });
    expect(replay).toEqual(first);
    expect(differentKey).toMatchObject({ kind: 'quarantined' });
    expect(closeAfterUnknown).toMatchObject({ kind: 'quarantined' });
    expect(otherSession).toMatchObject({ kind: 'applied', sessionId: 'session-2' });
    expect(begin.mock.calls.filter(([input]) => input.sessionId === 'session-1')).toHaveLength(1);
    expect(execute.mock.calls.filter(([intent]) => (
      intent as { sessionId: string }
    ).sessionId === 'session-1')).toHaveLength(1);
    expect(states.get('session-1')?.title).toBe('After');
  });

  it.each([
    { label: 'not running', agentSync: { status: 'not_running' as const, cliId: 'codex' as const } },
    { label: 'unsupported', agentSync: { status: 'unsupported' as const, cliId: 'codex' as const } },
    {
      label: 'known failure',
      agentSync: { status: 'failed' as const, cliId: 'codex' as const, error: 'worker channel closed' },
    },
  ])('keeps the title commit applied when native rename is $label', async ({ agentSync }) => {
    let state = storedState();
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore: {
        load: () => ({ kind: 'loaded', state, version: storeVersion() }),
        apply: input => {
          if (input.transition.kind !== 'rename') throw new Error('expected rename');
          state = {
            ...state,
            title: input.transition.title,
            titleUpdatedAt: input.transition.updatedAt,
            titleSource: input.transition.source,
          };
          return { kind: 'applied', state, nextVersion: storeVersion() };
        },
      },
      controlRenameEffect: {
        begin: () => ({ kind: 'effect', intent: Object.freeze({}) }),
        execute: async () => agentSync,
      },
    });
    const address = await addressFor(host);

    await expect(host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: `rename-known-${agentSync.status}`,
      command: {
        kind: 'control.rename',
        input: { title: 'Committed title', source: 'dashboard' },
      },
    })).resolves.toMatchObject({
      kind: 'applied',
      title: 'Committed title',
      agentSync,
    });
    expect(state.title).toBe('Committed title');
  });

  it('renames only through a semantic Store transition and reads the desired state as a duplicate', async () => {
    let state = storedState();
    let version = storeVersion();
    const apply = vi.fn<SessionStore['apply']>((input) => {
      if (input.transition.kind !== 'rename') throw new Error('expected rename');
      state = {
        ...state,
        title: input.transition.title,
        titleUpdatedAt: input.transition.updatedAt,
        titleSource: input.transition.source,
      };
      version = storeVersion();
      return { kind: 'applied', state, nextVersion: version };
    });
    const sessionStore: SessionStore = {
      load: vi.fn(() => ({ kind: 'loaded', state, version })),
      apply,
    };
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore,
    });
    const address = await addressFor(host);
    const request = {
      target: { kind: 'session' as const, address },
      idempotencyKey: 'rename-1',
      command: {
        kind: 'control.rename' as const,
        input: {
          title: 'After',
          updatedAt: '2026-08-10T01:00:00.000Z',
          source: 'dashboard' as const,
        },
      },
    };

    const first = await host.runtime.submit(request);
    const duplicate = await host.runtime.submit(request);

    expect(first).toEqual({
      kind: 'applied',
      action: 'control.renamed',
      policy: 'control-semantic-transition',
      sessionId: 'session-1',
      title: 'After',
      updatedAt: '2026-08-10T01:00:00.000Z',
      source: 'dashboard',
      agentSync: { status: 'not_running' },
    });
    expect(duplicate).toEqual({
      kind: 'duplicate',
      state: 'controlApplied',
      policy: 'control-semantic-transition',
      sessionId: 'session-1',
      result: {
        title: 'After',
        updatedAt: '2026-08-10T01:00:00.000Z',
        source: 'dashboard',
        agentSync: { status: 'not_running' },
      },
      message: 'rename transition is already reflected by the Current Store',
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-1',
      transition: request.command.input,
    });
    expect('receipt' in first).toBe(false);
    expect('receipt' in duplicate).toBe(false);
  });

  it('read-backs an unknown Store apply and reports applied only when the desired rename is visible', async () => {
    let state = storedState();
    let version = storeVersion();
    const sessionStore: SessionStore = {
      load: vi.fn(() => ({ kind: 'loaded', state, version })),
      apply: vi.fn((input) => {
        if (input.transition.kind !== 'rename') throw new Error('expected rename');
        state = {
          ...state,
          title: input.transition.title,
          titleUpdatedAt: input.transition.updatedAt,
          titleSource: input.transition.source,
        };
        version = storeVersion();
        return { kind: 'unknown', message: 'rename response was lost after publication' };
      }),
    };
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore,
    });
    const address = await addressFor(host);

    const result = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'rename-response-loss',
      command: {
        kind: 'control.rename',
        input: {
          title: 'Published',
          updatedAt: '2026-08-10T01:01:00.000Z',
          source: 'dashboard',
        },
      },
    });

    expect(result).toEqual({
      kind: 'applied',
      action: 'control.renamed',
      policy: 'control-semantic-transition',
      sessionId: 'session-1',
      title: 'Published',
      updatedAt: '2026-08-10T01:01:00.000Z',
      source: 'dashboard',
      agentSync: { status: 'not_running' },
    });
    expect(sessionStore.load).toHaveBeenCalledTimes(2);
    expect('receipt' in result).toBe(false);
  });

  it('rejects reusing one control idempotency key for a different semantic rename', async () => {
    let state = storedState();
    let version = storeVersion();
    const apply = vi.fn<SessionStore['apply']>((input) => {
      if (input.transition.kind !== 'rename') throw new Error('expected rename');
      state = {
        ...state,
        title: input.transition.title,
        titleUpdatedAt: input.transition.updatedAt,
        titleSource: input.transition.source,
      };
      version = storeVersion();
      return { kind: 'applied', state, nextVersion: version };
    });
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore: {
        load: () => ({ kind: 'loaded', state, version }),
        apply,
      },
    });
    const address = await addressFor(host);

    await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'rename-conflict',
      command: {
        kind: 'control.rename',
        input: { title: 'First', updatedAt: '2026-08-10T01:03:00.000Z', source: 'dashboard' },
      },
    });
    const conflict = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'rename-conflict',
      command: {
        kind: 'control.rename',
        input: { title: 'Second', updatedAt: '2026-08-10T01:04:00.000Z', source: 'dashboard' },
      },
    });

    expect(conflict).toEqual({
      kind: 'rejected',
      reason: 'idempotencyConflict',
      message: 'idempotency key already used with a different control command',
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('partitions control idempotency keys by logical Session', async () => {
    const states = new Map([
      ['session-1', storedState({ sessionId: 'session-1' })],
      ['session-2', storedState({ sessionId: 'session-2', route: { kind: 'thread', anchorId: 'om_root_2' } })],
    ]);
    const apply = vi.fn<SessionStore['apply']>((input) => {
      const state = states.get(input.sessionId)!;
      const next = {
        ...state,
        title: input.transition.title,
        titleUpdatedAt: input.transition.updatedAt,
        titleSource: input.transition.source,
      };
      states.set(input.sessionId, next);
      return { kind: 'applied', state: next, nextVersion: storeVersion() };
    });
    const host = createSessionRuntimeHost({
      directory: new TwoSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore: {
        load: (sessionId) => ({ kind: 'loaded', state: states.get(sessionId)!, version: storeVersion() }),
        apply,
      },
    });
    const first = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-1' });
    const second = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-2' });
    if (first.kind !== 'one' || second.kind !== 'one') throw new Error('expected both Session projections');
    const command = {
      kind: 'control.rename' as const,
      input: { title: 'Shared title', updatedAt: '2026-08-10T01:06:30.000Z', source: 'dashboard' as const },
    };

    const firstResult = await host.runtime.submit({
      target: { kind: 'session', address: first.session.address },
      idempotencyKey: 'same-provider-key',
      command,
    });
    const secondResult = await host.runtime.submit({
      target: { kind: 'session', address: second.session.address },
      idempotencyKey: 'same-provider-key',
      command,
    });

    expect(firstResult).toMatchObject({ kind: 'applied', sessionId: 'session-1' });
    expect(secondResult).toMatchObject({ kind: 'applied', sessionId: 'session-2' });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('rejects reusing one Session-scoped key for a different command kind', async () => {
    const apply = vi.fn<SessionStore['apply']>();
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress: ordinaryPort(() => ({ kind: 'committed' })),
      sessionStore: {
        load: () => ({ kind: 'loaded', state: storedState(), version: storeVersion() }),
        apply,
      },
    });
    const address = await addressFor(host);

    await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'shared-command-key',
      command: {
        kind: 'ordinary.ingress',
        input: { turn: ordinaryTurn('shared-command-key') },
      },
    });
    const result = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'shared-command-key',
      command: {
        kind: 'control.rename',
        input: { title: 'Different command', updatedAt: '2026-08-10T01:06:45.000Z', source: 'dashboard' },
      },
    });

    expect(result).toMatchObject({ kind: 'rejected', reason: 'idempotencyConflict' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('retries only a Store apply proven not applied', async () => {
    let state = storedState();
    let version = storeVersion();
    const apply = vi.fn<SessionStore['apply']>()
      .mockReturnValueOnce({ kind: 'notApplied', message: 'prewrite failed before publication' })
      .mockImplementationOnce((input) => {
        if (input.transition.kind !== 'rename') throw new Error('expected rename');
        state = {
          ...state,
          title: input.transition.title,
          titleUpdatedAt: input.transition.updatedAt,
          titleSource: input.transition.source,
        };
        version = storeVersion();
        return { kind: 'applied', state, nextVersion: version };
      });
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore: { load: () => ({ kind: 'loaded', state, version }), apply },
    });
    const address = await addressFor(host);
    const request = {
      target: { kind: 'session' as const, address },
      idempotencyKey: 'rename-prewrite',
      command: {
        kind: 'control.rename' as const,
        input: { title: 'After', updatedAt: '2026-08-10T01:07:00.000Z', source: 'dashboard' as const },
      },
    };

    await expect(host.runtime.submit(request)).resolves.toEqual({
      kind: 'retryable',
      message: 'prewrite failed before publication',
    });
    await expect(host.runtime.submit(request)).resolves.toMatchObject({
      kind: 'applied',
      action: 'control.renamed',
    });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('keeps an unproved Store publication ambiguous and does not apply it twice', async () => {
    const state = storedState();
    const version = storeVersion();
    const apply = vi.fn<SessionStore['apply']>(() => ({
      kind: 'unknown',
      message: 'publication and readback are both unknown',
    }));
    const sessionStore: SessionStore = {
      load: vi.fn(() => ({ kind: 'loaded', state, version })),
      apply,
    };
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore,
    });
    const address = await addressFor(host);
    const request = {
      target: { kind: 'session' as const, address },
      idempotencyKey: 'rename-unknown',
      command: {
        kind: 'control.rename' as const,
        input: { title: 'Maybe', updatedAt: '2026-08-10T01:08:00.000Z', source: 'dashboard' as const },
      },
    };

    const first = await host.runtime.submit(request);
    const retry = await host.runtime.submit(request);

    expect(first).toMatchObject({ kind: 'ambiguous', policy: 'control-semantic-transition' });
    expect(retry).toMatchObject({ kind: 'ambiguous', policy: 'control-semantic-transition' });
    expect(apply).toHaveBeenCalledTimes(1);
    expect('receipt' in first).toBe(false);
  });

  it('never downgrades a commit-unknown rename to retryable when readback becomes unavailable', async () => {
    const state = storedState();
    const version = storeVersion();
    const load = vi.fn<SessionStore['load']>()
      .mockReturnValueOnce({ kind: 'loaded', state, version })
      .mockReturnValueOnce({ kind: 'loaded', state, version })
      .mockReturnValue({ kind: 'unavailable', message: 'owner file temporarily unreadable' });
    const apply = vi.fn<SessionStore['apply']>(() => ({
      kind: 'unknown',
      message: 'publication and readback are both unknown',
    }));
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore: { load, apply },
    });
    const address = await addressFor(host);
    const request = {
      target: { kind: 'session' as const, address },
      idempotencyKey: 'rename-unknown-unavailable',
      command: {
        kind: 'control.rename' as const,
        input: { title: 'Maybe', updatedAt: '2026-08-10T01:08:30.000Z', source: 'dashboard' as const },
      },
    };

    const first = await host.runtime.submit(request);
    const retry = await host.runtime.submit(request);

    expect(first).toMatchObject({ kind: 'ambiguous', policy: 'control-semantic-transition' });
    expect(retry).toMatchObject({ kind: 'ambiguous', policy: 'control-semantic-transition' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('uses conflict readback as duplicate only when it contains the exact desired rename', async () => {
    const before = storedState();
    const desired = storedState({
      title: 'Concurrent',
      titleUpdatedAt: '2026-08-10T01:09:00.000Z',
      titleSource: 'dashboard',
    });
    const sessionStore: SessionStore = {
      load: () => ({ kind: 'loaded', state: before, version: storeVersion() }),
      apply: () => ({ kind: 'conflict', current: { state: desired, version: storeVersion() } }),
    };
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore,
    });
    const address = await addressFor(host);

    const result = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'rename-conflict-readback',
      command: {
        kind: 'control.rename',
        input: { title: 'Concurrent', updatedAt: '2026-08-10T01:09:00.000Z', source: 'dashboard' },
      },
    });

    expect(result).toMatchObject({
      kind: 'duplicate',
      state: 'controlApplied',
      policy: 'control-semantic-transition',
    });
    expect('receipt' in result).toBe(false);
  });
});

describe('SessionRuntime staged control policy', () => {
  it('keeps a later control behind an earlier ordinary effect on the same Session', async () => {
    let releaseOrdinary!: () => void;
    const ordinaryEffect = new Promise<void>((resolve) => { releaseOrdinary = resolve; });
    const ordinaryExecute = vi.fn(async () => {
      await ordinaryEffect;
      return { kind: 'materialized' };
    });
    const ordinaryIngress: OrdinaryIngressPort = {
      begin: () => ({ kind: 'effect', intent: {}, continuation: {} }),
      execute: ordinaryExecute,
      resume: (_continuation, settlement) => settlement.kind === 'returned'
        ? { kind: 'committed' }
        : { kind: 'unknown', message: 'ordinary effect threw' },
    };
    const controlBegin = vi.fn<ControlMutationPort['begin']>(({ command }) => ({
      kind: 'committed',
      result: command.kind === 'setLocked'
        ? { kind: 'lockUpdated', locked: command.locked }
        : { kind: 'lockUpdated', locked: false },
    }));
    const controlMutation: ControlMutationPort = {
      begin: controlBegin,
      execute: async () => { throw new Error('control effect not expected'); },
      resume: () => ({ kind: 'unknown', message: 'control continuation not expected' }),
    };
    const host = createSessionRuntimeHost({
      directory: new TwoSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress,
      controlMutation,
    });
    const first = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-1' });
    const second = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-2' });
    if (first.kind !== 'one' || second.kind !== 'one') throw new Error('expected Sessions');

    const ordinary = host.runtime.submit({
      target: { kind: 'session', address: first.session.address },
      idempotencyKey: 'ordinary-before-control',
      command: {
        kind: 'ordinary.ingress',
        input: {
          turn: {
            ...ordinaryTurn('ordinary-before-control'),
            route: {
              scope: 'thread',
              canonicalAnchor: 'om_root_1',
              chatId: 'oc_chat_1',
              chatType: 'group',
            },
          },
        },
      },
    });
    await vi.waitFor(() => expect(ordinaryExecute).toHaveBeenCalledTimes(1));

    let sameSessionSettled = false;
    const sameSessionControl = host.runtime.submit({
      target: { kind: 'session', address: first.session.address },
      idempotencyKey: 'control-after-ordinary',
      command: {
        kind: 'control.mutate',
        input: { kind: 'setLocked', locked: true },
      },
    }).then((outcome) => {
      sameSessionSettled = true;
      return outcome;
    });
    const otherSessionControl = host.runtime.submit({
      target: { kind: 'session', address: second.session.address },
      idempotencyKey: 'control-other-session',
      command: {
        kind: 'control.mutate',
        input: { kind: 'setLocked', locked: true },
      },
    });

    await expect(otherSessionControl).resolves.toMatchObject({
      kind: 'applied',
      sessionId: 'session-2',
    });
    expect(sameSessionSettled).toBe(false);
    expect(controlBegin).toHaveBeenCalledTimes(1);

    releaseOrdinary();
    await expect(ordinary).resolves.toMatchObject({
      kind: 'applied',
      sessionId: 'session-1',
    });
    await expect(sameSessionControl).resolves.toMatchObject({
      kind: 'applied',
      sessionId: 'session-1',
    });
    expect(controlBegin).toHaveBeenCalledTimes(2);
  });

  it('reserves a waiting control ahead of later ordinary input', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstEffect = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondEffect = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const ordinaryExecute = vi.fn(async (intent: unknown) => {
      await (intent === 'ordinary-first' ? firstEffect : secondEffect);
      return { kind: 'materialized' };
    });
    const controlBegin = vi.fn<ControlMutationPort['begin']>(({ command }) => ({
      kind: 'committed',
      result: command.kind === 'setLocked'
        ? { kind: 'lockUpdated', locked: command.locked }
        : { kind: 'lockUpdated', locked: false },
    }));
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress: {
        begin: ({ turn }) => ({
          kind: 'effect',
          intent: turn.messageKey,
          continuation: {},
        }),
        execute: ordinaryExecute,
        resume: () => ({ kind: 'committed' }),
      },
      controlMutation: {
        begin: controlBegin,
        execute: async () => { throw new Error('control effect not expected'); },
        resume: () => ({ kind: 'unknown', message: 'control continuation not expected' }),
      },
    });
    const address = await addressFor(host);

    const firstOrdinary = host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'ordinary-first',
      command: {
        kind: 'ordinary.ingress',
        input: { turn: ordinaryTurn('ordinary-first') },
      },
    });
    await vi.waitFor(() => expect(ordinaryExecute).toHaveBeenCalledTimes(1));

    const controlRequest = {
      target: { kind: 'session', address },
      idempotencyKey: 'control-between-ordinary-effects',
      command: {
        kind: 'control.mutate' as const,
        input: { kind: 'setLocked', locked: true },
      },
    };
    const control = host.runtime.submit(controlRequest);
    const controlFollower = host.runtime.submit(controlRequest);
    const secondOrdinary = host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'ordinary-second',
      command: {
        kind: 'ordinary.ingress',
        input: { turn: ordinaryTurn('ordinary-second') },
      },
    });
    await Promise.resolve();
    expect(ordinaryExecute).toHaveBeenCalledTimes(1);

    let secondSettled = false;
    secondOrdinary.then(() => { secondSettled = true; });
    releaseFirst();
    await expect(firstOrdinary).resolves.toMatchObject({ kind: 'applied' });
    await expect(control).resolves.toMatchObject({ kind: 'applied' });
    await expect(controlFollower).resolves.toMatchObject({ kind: 'duplicate' });
    expect(secondSettled).toBe(false);
    expect(controlBegin).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(ordinaryExecute).toHaveBeenCalledTimes(2));
    releaseSecond();
    await expect(secondOrdinary).resolves.toMatchObject({ kind: 'applied' });
  });

  it('keeps a later control behind an earlier pending-repo effect on the same Session', async () => {
    let releasePendingRepo!: () => void;
    const pendingRepoEffect = new Promise<void>((resolve) => { releasePendingRepo = resolve; });
    const pendingRepoExecute = vi.fn(async () => {
      await pendingRepoEffect;
      return { kind: 'materialized' };
    });
    const pendingRepoCompletion: PendingRepoCompletionPort = {
      begin: () => ({ kind: 'effect', intent: {}, continuation: {} }),
      execute: pendingRepoExecute,
      resume: (_continuation, settlement) => settlement.kind === 'returned'
        ? { kind: 'committed' }
        : { kind: 'unknown', message: 'pending-repo effect threw' },
    };
    const controlBegin = vi.fn<ControlMutationPort['begin']>(({ command }) => ({
      kind: 'committed',
      result: command.kind === 'setLocked'
        ? { kind: 'lockUpdated', locked: command.locked }
        : { kind: 'lockUpdated', locked: false },
    }));
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      pendingRepoCompletion,
      controlMutation: {
        begin: controlBegin,
        execute: async () => { throw new Error('control effect not expected'); },
        resume: () => ({ kind: 'unknown', message: 'control continuation not expected' }),
      },
    });
    const address = await addressFor(host);

    const pendingRepo = host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'pending-repo-before-control',
      command: {
        kind: 'pendingRepo.complete',
        input: {
          selection: { kind: 'directory', path: '/repo', pinWorkingDir: false },
        },
      },
    });
    await vi.waitFor(() => expect(pendingRepoExecute).toHaveBeenCalledTimes(1));

    let controlSettled = false;
    const control = host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'control-after-pending-repo',
      command: {
        kind: 'control.mutate',
        input: { kind: 'setLocked', locked: true },
      },
    }).then((outcome) => {
      controlSettled = true;
      return outcome;
    });

    await Promise.resolve();
    expect(controlSettled).toBe(false);
    expect(controlBegin).not.toHaveBeenCalled();

    releasePendingRepo();
    await expect(pendingRepo).resolves.toMatchObject({
      kind: 'applied',
      sessionId: 'session-1',
    });
    await expect(control).resolves.toMatchObject({
      kind: 'applied',
      sessionId: 'session-1',
    });
    expect(controlBegin).toHaveBeenCalledTimes(1);
  });

  it('singleflights duplicate control effects and blocks only the same Session lane', async () => {
    let release!: (value: unknown) => void;
    const effect = new Promise<unknown>((resolve) => { release = resolve; });
    const execute = vi.fn(() => effect);
    const port: ControlMutationPort = {
      begin: ({ command }) => ({
        kind: 'effect',
        intent: command,
        continuation: command,
      }),
      execute,
      resume: (continuation, settlement) => {
        if (settlement.kind === 'threw') return { kind: 'unknown', message: 'effect threw' };
        const command = continuation as { kind: 'setLocked'; locked: boolean };
        return {
          kind: 'committed',
          result: { kind: 'lockUpdated', locked: command.locked },
        };
      },
    };
    const ordinaryBegin = vi.fn(() => ({ kind: 'committed' as const }));
    const host = createSessionRuntimeHost({
      directory: new TwoSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      controlMutation: port,
      ordinaryIngress: ordinaryPort(ordinaryBegin),
    });
    const first = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-1' });
    const second = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-2' });
    if (first.kind !== 'one' || second.kind !== 'one') throw new Error('expected Sessions');
    const controlRequest = {
      target: { kind: 'session' as const, address: first.session.address },
      idempotencyKey: 'lock-1',
      command: {
        kind: 'control.mutate' as const,
        input: { kind: 'setLocked' as const, locked: true },
      },
    };

    const winning = host.runtime.submit(controlRequest);
    const duplicate = host.runtime.submit(controlRequest);
    let sameSessionSettled = false;
    const sameSession = host.runtime.submit({
      target: { kind: 'session', address: first.session.address },
      idempotencyKey: 'ordinary-after-control',
      command: {
        kind: 'ordinary.ingress',
        input: {
          turn: {
            ...ordinaryTurn('ordinary-after-control'),
            route: {
              scope: 'thread',
              canonicalAnchor: 'om_root_1',
              chatId: 'oc_chat_1',
              chatType: 'group',
            },
          },
        },
      },
    }).then((value) => {
      sameSessionSettled = true;
      return value;
    });
    const otherSession = host.runtime.submit({
      target: { kind: 'session', address: second.session.address },
      idempotencyKey: 'ordinary-other-session',
      command: {
        kind: 'ordinary.ingress',
        input: {
          turn: {
            ...ordinaryTurn('ordinary-other-session'),
            route: {
              scope: 'thread',
              canonicalAnchor: 'om_root_2',
              chatId: 'oc_chat_2',
              chatType: 'group',
            },
          },
        },
      },
    });

    await expect(otherSession).resolves.toMatchObject({ kind: 'applied', sessionId: 'session-2' });
    expect(sameSessionSettled).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    release({ ok: true });

    await expect(winning).resolves.toMatchObject({
      kind: 'applied',
      action: 'control.mutated',
      result: { kind: 'lockUpdated', locked: true },
    });
    await expect(duplicate).resolves.toMatchObject({
      kind: 'duplicate',
      state: 'inFlight',
    });
    expect(await sameSession).toEqual({
      kind: 'applied',
      action: 'ordinary.inputCommitted',
      policy: 'ordinary-replayable',
      durability: 'processLocal',
      sessionId: 'session-1',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps trigger-result consumption behind an in-flight worker command on the same Session', async () => {
    let release!: () => void;
    const workerEffect = new Promise<void>((resolve) => { release = resolve; });
    const begin = vi.fn<ControlMutationPort['begin']>(({ command }) => (
      command.kind === 'injectCommand'
        ? { kind: 'effect', intent: command, continuation: command }
        : {
            kind: 'committed',
            result: {
              kind: 'asyncTriggerFaultConverged',
              state: 'failed',
              triggerId: command.kind === 'convergeAsyncTriggerFault'
                ? command.triggerId
                : 'unexpected',
            },
          }
    ));
    const port: ControlMutationPort = {
      begin,
      execute: vi.fn(async () => {
        await workerEffect;
        return { accepted: true };
      }),
      resume: (continuation) => ({
        kind: 'committed',
        result: {
          kind: 'commandInjected',
          command: (continuation as { command: string }).command,
        },
      }),
    };
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      controlMutation: port,
    });
    const address = await addressFor(host);

    const injection = host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'slash-before-trigger-result',
      command: {
        kind: 'control.mutate',
        input: { kind: 'injectCommand', command: '/status' },
      },
    });
    await vi.waitFor(() => expect(port.execute).toHaveBeenCalledOnce());
    const convergence = host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'trigger-result-fault:trigger-one',
      command: {
        kind: 'control.mutate',
        input: { kind: 'convergeAsyncTriggerFault', triggerId: 'trigger-one' },
      },
    });
    await Promise.resolve();
    expect(begin).toHaveBeenCalledOnce();

    release();
    await expect(injection).resolves.toMatchObject({
      kind: 'applied',
      result: { kind: 'commandInjected' },
    });
    await expect(convergence).resolves.toMatchObject({
      kind: 'applied',
      result: { kind: 'asyncTriggerFaultConverged', state: 'failed' },
    });
    expect(begin).toHaveBeenCalledTimes(2);
  });

  it('retains an unknown control outcome and never repeats its effect', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const port: ControlMutationPort = {
      begin: () => ({ kind: 'effect', intent: {}, continuation: {} }),
      execute,
      resume: () => ({ kind: 'unknown', message: 'publication outcome is unknown' }),
    };
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      controlMutation: port,
    });
    const address = await addressFor(host);
    const request = {
      target: { kind: 'session' as const, address },
      idempotencyKey: 'close-unknown',
      command: {
        kind: 'control.mutate' as const,
        input: { kind: 'close' as const, reason: 'dashboard' as const },
      },
    };

    await expect(host.runtime.submit(request)).resolves.toMatchObject({
      kind: 'ambiguous',
      policy: 'control-staged-transition',
    });
    await expect(host.runtime.submit(request)).resolves.toMatchObject({
      kind: 'ambiguous',
      policy: 'control-staged-transition',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('retains applied control outcomes for the whole Runtime epoch', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const port: ControlMutationPort = {
      begin: ({ command }) => ({ kind: 'effect', intent: command, continuation: command }),
      execute,
      resume: (continuation) => {
        const command = continuation as { kind: 'setLocked'; locked: boolean };
        return {
          kind: 'committed',
          result: { kind: 'lockUpdated', locked: command.locked },
        };
      },
    };
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      controlMutation: port,
    });
    const address = await addressFor(host);
    const command = {
      kind: 'control.mutate' as const,
      input: { kind: 'setLocked' as const, locked: true },
    };
    for (let index = 0; index < 1_025; index += 1) {
      await expect(host.runtime.submit({
        target: { kind: 'session', address },
        idempotencyKey: `lock-${index}`,
        command,
      })).resolves.toMatchObject({ kind: 'applied' });
    }

    await expect(host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'lock-0',
      command,
    })).resolves.toMatchObject({ kind: 'duplicate', state: 'controlApplied' });
    expect(execute).toHaveBeenCalledTimes(1_025);
  });

  it('does not repeat the cwd driver for a completed operation identity', async () => {
    const execute = vi.fn(async () => ({ mode: 'respawn-resume' as const }));
    const port: ControlMutationPort = {
      begin: ({ command }) => ({ kind: 'effect', intent: command, continuation: command }),
      execute,
      resume: (continuation) => {
        const command = continuation as { kind: 'changeWorkingDirectory'; resolvedPath: string };
        return {
          kind: 'committed',
          result: {
            kind: 'workingDirectoryChanged',
            mode: 'respawn-resume',
            workingDir: command.resolvedPath,
          },
        };
      },
    };
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      controlMutation: port,
    });
    const address = await addressFor(host);
    const request = {
      target: { kind: 'session' as const, address },
      idempotencyKey: 'cwd-operation-one',
      command: {
        kind: 'control.mutate' as const,
        input: {
          kind: 'changeWorkingDirectory' as const,
          resolvedPath: '/roles/new',
        },
      },
    };

    await expect(host.runtime.submit(request)).resolves.toMatchObject({
      kind: 'applied',
      result: { kind: 'workingDirectoryChanged', mode: 'respawn-resume' },
    });
    await expect(host.runtime.submit(request)).resolves.toMatchObject({
      kind: 'duplicate',
      state: 'controlApplied',
      result: { kind: 'workingDirectoryChanged', mode: 'respawn-resume' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a relocate effect and preserves its opaque route reservation', async () => {
    const reservation = Object.freeze({ route: 'target' });
    const begin = vi.fn(({ command, routeReservation }) => ({
      kind: 'effect' as const,
      intent: { command, routeReservation },
      continuation: command,
    }));
    const execute = vi.fn(async (intent: unknown) => {
      expect((intent as { routeReservation: unknown }).routeReservation).toBe(reservation);
      return { ok: true };
    });
    const port: ControlMutationPort = {
      begin,
      execute,
      resume: (continuation) => {
        const command = continuation as Extract<
          Parameters<ControlMutationPort['begin']>[0]['command'],
          { kind: 'relocate' }
        >;
        return {
          kind: 'committed',
          result: {
            kind: 'relocated',
            targetChatId: command.targetChatId,
            targetRootMessageId: command.targetRootMessageId,
          },
        };
      },
    };
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      controlMutation: port,
    });
    const address = await addressFor(host);
    const request = {
      target: {
        kind: 'session' as const,
        address,
        controlRouteReservation: reservation,
      },
      idempotencyKey: 'relocate-operation-one',
      command: {
        kind: 'control.mutate' as const,
        input: {
          kind: 'relocate' as const,
          sourceAnchor: 'om_root',
          targetChatId: 'oc_target',
          targetRootMessageId: 'om_target_audit',
          requester: { larkAppId: 'app_leader', openId: 'ou_owner' },
        },
      },
    };

    await expect(host.runtime.submit(request)).resolves.toMatchObject({
      kind: 'applied',
      result: { kind: 'relocated', targetChatId: 'oc_target' },
    });
    await expect(host.runtime.submit(request)).resolves.toMatchObject({
      kind: 'duplicate',
      state: 'controlApplied',
      result: { kind: 'relocated', targetChatId: 'oc_target' },
    });
    expect(begin).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });
});

class TestExecutorObservations implements ExecutorObservationPort, DispatchInputCommitEvidencePort {
  readonly events: string[] = [];
  readonly reconcileResult = vi.fn(() => ({ kind: 'committed' as const }));
  readonly recordResult = vi.fn((evidence: DispatchInputCommitEvidence) => {
    this.events.push('evidence.record');
    this.evidence.set(`${evidence.sessionId}\u0000${evidence.turnId}`, evidence);
    return { kind: 'recorded' as const };
  });
  private readonly bindings = new WeakMap<object, { sessionId: string; generation: number; token: object }>();
  private readonly evidence = new Map<string, DispatchInputCommitEvidence>();

  mint(sessionId: string, generation: number): ExecutorAddress {
    const address = Object.freeze({}) as ExecutorAddress;
    this.bindings.set(address, { sessionId, generation, token: Object.freeze({}) });
    return address;
  }

  inspect(address: ExecutorAddress) {
    this.events.push('inspect');
    const binding = this.bindings.get(address);
    return binding
      ? { kind: 'current' as const, ...binding }
      : { kind: 'staleAddress' as const, message: 'unknown Executor address' };
  }

  reconcileInputCommit(input: { token: unknown; turnId: string; executorGeneration: number }) {
    this.events.push('reconcile');
    return this.reconcileResult(input);
  }

  read(input: { sessionId: string; turnId: string }) {
    this.events.push('evidence.read');
    const evidence = this.evidence.get(`${input.sessionId}\u0000${input.turnId}`);
    return evidence
      ? { kind: 'committed' as const, evidence }
      : { kind: 'absent' as const };
  }

  record(evidence: DispatchInputCommitEvidence) {
    return this.recordResult(evidence);
  }

  seedEvidence(evidence: DispatchInputCommitEvidence): void {
    this.evidence.set(`${evidence.sessionId}\u0000${evidence.turnId}`, evidence);
  }
}

describe('SessionRuntime executor observation policy', () => {
  it('records input commitment through its named evidence port, never generic SessionStore apply', async () => {
    const executorObservations = new TestExecutorObservations();
    const executor = executorObservations.mint('session-1', 7);
    const record = vi.fn(() => ({ kind: 'recorded' as const }));
    const apply = vi.fn<SessionStore['apply']>();
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore: {
        load: () => ({ kind: 'loaded', state: storedState(), version: storeVersion() }),
        apply,
      },
      executorObservations,
      dispatchInputCommits: {
        read: () => ({ kind: 'absent' }),
        record,
      },
    } as Parameters<typeof createSessionRuntimeHost>[0] & Record<string, unknown>);
    const address = await addressFor(host);

    const result = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'named-input-commit-evidence',
      command: {
        kind: 'executor.inputCommitted',
        input: { executor, turnId: 'turn-named', committedAt: '2026-08-10T01:01:30.000Z' },
      },
    });

    expect(result).toMatchObject({ kind: 'applied', action: 'executor.inputCommitRecorded' });
    expect(record).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it('reconciles an exact opaque Executor generation before recording input commitment', async () => {
    const executorObservations = new TestExecutorObservations();
    const executor = executorObservations.mint('session-1', 7);
    const apply = vi.fn<SessionStore['apply']>();
    const sessionStore: SessionStore = {
      load: vi.fn(() => ({ kind: 'loaded', state: storedState(), version: storeVersion() })),
      apply,
    };
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore,
      executorObservations,
      dispatchInputCommits: executorObservations,
    });
    const address = await addressFor(host);

    const result = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'executor-report-1',
      command: {
        kind: 'executor.inputCommitted',
        input: {
          executor,
          turnId: 'turn-1',
          committedAt: '2026-08-10T01:02:00.000Z',
        },
      },
    });

    expect(result).toEqual({
      kind: 'applied',
      action: 'executor.inputCommitRecorded',
      policy: 'executor-reconcile-first',
      sessionId: 'session-1',
      turnId: 'turn-1',
      executorGeneration: 7,
    });
    expect(executorObservations.events).toEqual([
      'inspect',
      'evidence.read',
      'reconcile',
      'evidence.record',
    ]);
    expect(executorObservations.recordResult).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'turn-1',
      executorGeneration: 7,
      committedAt: '2026-08-10T01:02:00.000Z',
    });
    expect(apply).not.toHaveBeenCalled();
    expect('receipt' in result).toBe(false);
  });

  it('rejects reusing one Executor-report idempotency key for another turn', async () => {
    const executorObservations = new TestExecutorObservations();
    const executor = executorObservations.mint('session-1', 7);
    const apply = vi.fn<SessionStore['apply']>();
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore: { load: () => ({ kind: 'loaded', state: storedState(), version: storeVersion() }), apply },
      executorObservations,
      dispatchInputCommits: executorObservations,
    });
    const address = await addressFor(host);
    const base = {
      target: { kind: 'session' as const, address },
      idempotencyKey: 'executor-key-conflict',
    };

    await host.runtime.submit({
      ...base,
      command: {
        kind: 'executor.inputCommitted',
        input: { executor, turnId: 'turn-a', committedAt: '2026-08-10T01:05:00.000Z' },
      },
    });
    const conflict = await host.runtime.submit({
      ...base,
      command: {
        kind: 'executor.inputCommitted',
        input: { executor, turnId: 'turn-b', committedAt: '2026-08-10T01:06:00.000Z' },
      },
    });

    expect(conflict).toEqual({
      kind: 'rejected',
      reason: 'idempotencyConflict',
      message: 'idempotency key already used with a different Executor observation',
    });
    expect(executorObservations.recordResult).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it('partitions Executor-report idempotency keys by logical Session', async () => {
    const executorObservations = new TestExecutorObservations();
    const firstExecutor = executorObservations.mint('session-1', 7);
    const secondExecutor = executorObservations.mint('session-2', 7);
    const apply = vi.fn<SessionStore['apply']>();
    const host = createSessionRuntimeHost({
      directory: new TwoSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore: {
        load: (sessionId) => ({
          kind: 'loaded',
          state: storedState({ sessionId }),
          version: storeVersion(),
        }),
        apply,
      },
      executorObservations,
      dispatchInputCommits: executorObservations,
    });
    const first = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-1' });
    const second = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-2' });
    if (first.kind !== 'one' || second.kind !== 'one') throw new Error('expected both Session projections');

    const firstResult = await host.runtime.submit({
      target: { kind: 'session', address: first.session.address },
      idempotencyKey: 'same-executor-report-key',
      command: {
        kind: 'executor.inputCommitted',
        input: { executor: firstExecutor, turnId: 'turn-shared', committedAt: '2026-08-10T01:09:00.000Z' },
      },
    });
    const secondResult = await host.runtime.submit({
      target: { kind: 'session', address: second.session.address },
      idempotencyKey: 'same-executor-report-key',
      command: {
        kind: 'executor.inputCommitted',
        input: { executor: secondExecutor, turnId: 'turn-shared', committedAt: '2026-08-10T01:09:00.000Z' },
      },
    });

    expect(firstResult).toMatchObject({ kind: 'applied', sessionId: 'session-1' });
    expect(secondResult).toMatchObject({ kind: 'applied', sessionId: 'session-2' });
    expect(executorObservations.recordResult).toHaveBeenCalledTimes(2);
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects stale Executor identity and generation before reconcile or Store mutation', async () => {
    const executorObservations = new TestExecutorObservations();
    const staleExecutor = executorObservations.mint('session-1', 6);
    const apply = vi.fn<SessionStore['apply']>();
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore: {
        load: () => ({ kind: 'loaded', state: storedState(), version: storeVersion() }),
        apply,
      },
      executorObservations,
      dispatchInputCommits: executorObservations,
    });
    const address = await addressFor(host);
    const foreignExecutor = Object.freeze({}) as ExecutorAddress;

    const staleAddress = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'stale-executor-address',
      command: {
        kind: 'executor.inputCommitted',
        input: {
          executor: foreignExecutor,
          turnId: 'turn-stale-address',
          committedAt: '2026-08-10T01:10:00.000Z',
        },
      },
    });
    const staleGeneration = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'stale-executor-generation',
      command: {
        kind: 'executor.inputCommitted',
        input: {
          executor: staleExecutor,
          turnId: 'turn-stale-generation',
          committedAt: '2026-08-10T01:11:00.000Z',
        },
      },
    });

    expect(staleAddress).toMatchObject({ kind: 'staleExecutor', turnId: 'turn-stale-address' });
    expect(staleGeneration).toMatchObject({ kind: 'staleExecutor', turnId: 'turn-stale-generation' });
    expect(executorObservations.reconcileResult).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects a Session address minted by another Runtime epoch before inspecting Executor state', async () => {
    const first = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
    });
    const oldAddress = await addressFor(first);
    const executorObservations = new TestExecutorObservations();
    const executor = executorObservations.mint('session-1', 7);
    const current = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore: {
        load: () => ({ kind: 'loaded', state: storedState(), version: storeVersion() }),
        apply: vi.fn(),
      },
      executorObservations,
      dispatchInputCommits: executorObservations,
    });

    const result = await current.runtime.submit({
      target: { kind: 'session', address: oldAddress },
      idempotencyKey: 'stale-session-address',
      command: {
        kind: 'executor.inputCommitted',
        input: {
          executor,
          turnId: 'turn-old-epoch',
          committedAt: '2026-08-10T01:12:00.000Z',
        },
      },
    });

    expect(result).toEqual({ kind: 'staleAddress' });
    expect(executorObservations.events).toEqual([]);
  });

  it('reconciles an unknown Executor report on retry instead of replaying or terminalizing it', async () => {
    const executorObservations = new TestExecutorObservations();
    executorObservations.reconcileResult
      .mockReturnValueOnce({ kind: 'unknown', message: 'transcript probe timed out' })
      .mockReturnValue({ kind: 'committed' });
    const executor = executorObservations.mint('session-1', 7);
    const apply = vi.fn<SessionStore['apply']>();
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore: { load: () => ({ kind: 'loaded', state: storedState(), version: storeVersion() }), apply },
      executorObservations,
      dispatchInputCommits: executorObservations,
    });
    const address = await addressFor(host);
    const request = {
      target: { kind: 'session' as const, address },
      idempotencyKey: 'executor-reconcile-retry',
      command: {
        kind: 'executor.inputCommitted' as const,
        input: {
          executor,
          turnId: 'turn-reconcile',
          committedAt: '2026-08-10T01:13:00.000Z',
        },
      },
    };

    const first = await host.runtime.submit(request);
    const retry = await host.runtime.submit(request);

    expect(first).toMatchObject({ kind: 'ambiguous', policy: 'executor-reconcile-first' });
    expect(retry).toMatchObject({ kind: 'applied', action: 'executor.inputCommitRecorded' });
    expect(executorObservations.reconcileResult).toHaveBeenCalledTimes(2);
    expect(executorObservations.recordResult).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect('receipt' in retry).toBe(false);
  });

  it('joins exact named input-commit evidence without probing the Executor again', async () => {
    const committedAt = '2026-08-10T01:14:00.000Z';
    const executorObservations = new TestExecutorObservations();
    const executor = executorObservations.mint('session-1', 7);
    executorObservations.seedEvidence({
      sessionId: 'session-1',
      turnId: 'turn-recorded',
      committedAt,
      executorGeneration: 7,
    });
    const apply = vi.fn<SessionStore['apply']>();
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore: {
        load: () => ({ kind: 'loaded', state: storedState(), version: storeVersion() }),
        apply,
      },
      executorObservations,
      dispatchInputCommits: executorObservations,
    });
    const address = await addressFor(host);

    const result = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'executor-recorded',
      command: {
        kind: 'executor.inputCommitted',
        input: {
          executor,
          turnId: 'turn-recorded',
          committedAt: '2026-08-10T01:14:01.000Z',
        },
      },
    });

    expect(result).toMatchObject({
      kind: 'duplicate',
      state: 'inputCommitted',
      policy: 'executor-reconcile-first',
    });
    expect(executorObservations.reconcileResult).not.toHaveBeenCalled();
    expect(executorObservations.recordResult).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    ['published', true, 'applied'],
    ['not visible', false, 'ambiguous'],
  ] as const)('classifies unknown named-evidence write with strict readback: %s', async (_label, publish, expectedKind) => {
    const executorObservations = new TestExecutorObservations();
    const executor = executorObservations.mint('session-1', 7);
    executorObservations.recordResult.mockImplementationOnce((evidence) => {
      executorObservations.events.push('evidence.record');
      if (publish) {
        executorObservations.seedEvidence(evidence);
      }
      return { kind: 'unknown', message: 'evidence response lost after write attempt' };
    });
    const apply = vi.fn<SessionStore['apply']>();
    const sessionStore: SessionStore = {
      load: vi.fn(() => ({ kind: 'loaded', state: storedState(), version: storeVersion() })),
      apply,
    };
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore,
      executorObservations,
      dispatchInputCommits: executorObservations,
    });
    const address = await addressFor(host);

    const result = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: `executor-store-unknown-${_label}`,
      command: {
        kind: 'executor.inputCommitted',
        input: {
          executor,
          turnId: `turn-${_label}`,
          committedAt: '2026-08-10T01:15:00.000Z',
        },
      },
    });

    expect(result.kind).toBe(expectedKind);
    if (result.kind === 'applied') expect(result.action).toBe('executor.inputCommitRecorded');
    if (result.kind === 'ambiguous') expect(result.policy).toBe('executor-reconcile-first');
    expect(sessionStore.load).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect('receipt' in result).toBe(false);
  });
});

describe('SessionRuntime unwired Current policy ports', () => {
  it('returns typed notWired outcomes instead of pretending production cutover', async () => {
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
    });
    const address = await addressFor(host);

    const ordinary = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'unwired-ordinary',
      command: {
        kind: 'ordinary.ingress',
        input: { turn: ordinaryTurn('unwired-ordinary') },
      },
    });
    const control = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'unwired-control',
      command: {
        kind: 'control.rename',
        input: { title: 'No Store', updatedAt: '2026-08-10T01:17:00.000Z', source: 'dashboard' },
      },
    });
    const executor = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'unwired-executor',
      command: {
        kind: 'executor.inputCommitted',
        input: {
          executor: Object.freeze({}) as ExecutorAddress,
          turnId: 'turn-unwired',
          committedAt: '2026-08-10T01:17:00.000Z',
        },
      },
    });

    expect(ordinary).toMatchObject({ kind: 'notWired', command: 'ordinary.ingress' });
    expect(control).toMatchObject({ kind: 'notWired', command: 'control.rename' });
    expect(executor).toMatchObject({ kind: 'notWired', command: 'executor.inputCommitted' });
  });
});

describe('SessionRuntime epoch re-resolution', () => {
  it('accepts a semantic transition only after a stale address is re-resolved by stable route', async () => {
    const oldHost = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
    });
    const oldAddress = await addressFor(oldHost);
    let state = storedState();
    let version = storeVersion();
    const apply = vi.fn<SessionStore['apply']>((input) => {
      if (input.transition.kind !== 'rename') throw new Error('expected rename');
      state = storedState({
        title: input.transition.title,
        titleUpdatedAt: input.transition.updatedAt,
        titleSource: input.transition.source,
      });
      version = storeVersion();
      return { kind: 'applied', state, nextVersion: version };
    });
    const current = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore: { load: () => ({ kind: 'loaded', state, version }), apply },
    });
    const command = {
      kind: 'control.rename' as const,
      input: { title: 'Rebound', updatedAt: '2026-08-10T01:19:00.000Z', source: 'dashboard' as const },
    };

    const stale = await current.runtime.submit({
      target: { kind: 'session', address: oldAddress },
      idempotencyKey: 'rename-old-address',
      command,
    });
    const rebound = await current.projection.read({
      kind: 'byRoute',
      route: { kind: 'thread', anchorId: 'om_root' },
    });
    if (rebound.kind !== 'one') throw new Error('expected stable-route re-resolution');
    const applied = await current.runtime.submit({
      target: { kind: 'session', address: rebound.session.address },
      idempotencyKey: 'rename-rebound-address',
      command,
    });

    expect(stale).toEqual({ kind: 'staleAddress' });
    expect(applied).toMatchObject({ kind: 'applied', action: 'control.renamed' });
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe('FI-P1 command-policy separation', () => {
  it('does not flatten keyed at-most-once, ordinary replay, and Executor reconcile retry', async () => {
    const keyedInput = {
      business: {
        instruction: 'keyed work',
        envelope: { format: 'text', sourceName: 'test', trusted: false as const },
        source: { type: 'webhook' as const },
        presentation: null,
        options: { asyncReturnSessionId: true },
      },
      persistInputHistory: true,
    };
    const keyedPrepare = vi.fn(() => ({ kind: 'unreadable' as const, message: 'must not prepare' }));
    const settleDispatchUnknown = vi.fn(() => ({ kind: 'failed' as const }));
    const keyedAuthority: KeyedTriggerAuthority = {
      inspect: () => ({
        kind: 'present',
        token: Object.freeze({}),
        requestHash: computeInputHash({ business: keyedInput.business, persistInputHistory: true }),
        sessionId: 'old-keyed-session',
        triggerId: 'trigger-old',
        chatId: 'http_async_old',
        leaseState: 'attempting',
        ownerBoot: 'other',
        terminal: 'pending',
        executorLive: false,
      }),
      reserve: () => ({ kind: 'unreadable', message: 'must not reserve' }),
      begin: () => ({ kind: 'unreadable', message: 'must not begin' }),
      settleDispatchUnknown,
    };
    const keyedTurns: KeyedTriggerTurnPort = {
      prepare: keyedPrepare,
      acceptAtMostOnce: () => ({ kind: 'refused', message: 'must not dispatch' }),
      failClose: async () => ({ kind: 'unreadable', message: 'must not close' }),
    };
    const ordinaryCommit = vi.fn(() => ({ kind: 'committed' as const }));
    const executorObservations = new TestExecutorObservations();
    const executor = executorObservations.mint('session-1', 7);
    const committedAt = '2026-08-10T01:18:00.000Z';
    executorObservations.seedEvidence({
      sessionId: 'session-1',
      turnId: 'turn-existing',
      executorGeneration: 7,
      committedAt,
    });
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: keyedAuthority,
      keyedTriggerTurns: keyedTurns,
      ordinaryIngress: ordinaryPort(ordinaryCommit),
      sessionStore: {
        load: () => ({
          kind: 'loaded',
          state: storedState(),
          version: storeVersion(),
        }),
        apply: vi.fn(),
      },
      executorObservations,
      dispatchInputCommits: executorObservations,
    });
    const address = await addressFor(host);

    const keyed = await host.runtime.submit({
      target: { kind: 'route', route: { kind: 'idempotency', key: 'keyed-old' } },
      idempotencyKey: 'keyed-old',
      command: { kind: 'keyedTrigger.start', input: keyedInput },
    });
    const ordinaryRequest = {
      target: { kind: 'session' as const, address },
      idempotencyKey: 'ordinary-duplicate',
      command: {
        kind: 'ordinary.ingress' as const,
        input: { turn: ordinaryTurn('ordinary-duplicate', 'ordinary') },
      },
    };
    await host.runtime.submit(ordinaryRequest);
    const ordinaryDuplicate = await host.runtime.submit(ordinaryRequest);
    const executorRetry = await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'executor-retry',
      command: {
        kind: 'executor.inputCommitted',
        input: { executor, turnId: 'turn-existing', committedAt },
      },
    });

    expect(keyed).toMatchObject({
      kind: 'ambiguous',
      sessionId: 'old-keyed-session',
      durable: true,
      idempotent: true,
    });
    expect(ordinaryDuplicate).toMatchObject({
      kind: 'duplicate',
      policy: 'ordinary-replayable',
      state: 'inputCommitted',
    });
    expect(executorRetry).toMatchObject({
      kind: 'duplicate',
      policy: 'executor-reconcile-first',
      state: 'inputCommitted',
    });
    expect(keyedPrepare).not.toHaveBeenCalled();
    expect(settleDispatchUnknown).toHaveBeenCalledTimes(1);
    expect(ordinaryCommit).toHaveBeenCalledTimes(1);
    expect(executorObservations.reconcileResult).not.toHaveBeenCalled();
    expect('receipt' in keyed).toBe(false);
    expect('receipt' in ordinaryDuplicate).toBe(false);
    expect('receipt' in executorRetry).toBe(false);
  });
});
