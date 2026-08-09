import { describe, expect, it, vi } from 'vitest';
import {
  createSessionRuntimeHost,
  type ExecutorAddress,
  type ExecutorObservationPort,
  type KeyedTriggerAuthority,
  type KeyedTriggerTurnPort,
  type OrdinaryIngressPort,
  type SessionAddress,
  type SessionCommandValue,
  type SessionDirectory,
} from '../src/core/session-runtime.js';
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

async function addressFor(host: ReturnType<typeof createSessionRuntimeHost>): Promise<SessionAddress> {
  const result = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-1' });
  if (result.kind !== 'one') throw new Error('expected Session projection');
  return result.session.address;
}

describe('SessionRuntime ordinary ingress policy', () => {
  it('records only process-local input commitment and joins a same-payload duplicate', async () => {
    const commit = vi.fn(() => ({ kind: 'committed' as const }));
    const ordinaryIngress: OrdinaryIngressPort = { commit };
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
        input: { semantic: { text: 'hello' } },
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

  it('reports a re-entrant same-Session duplicate as received before commitment', async () => {
    let nested: ReturnType<ReturnType<typeof createSessionRuntimeHost>['runtime']['submit']> | undefined;
    let host!: ReturnType<typeof createSessionRuntimeHost>;
    let request!: {
      target: { kind: 'session'; address: SessionAddress };
      idempotencyKey: string;
      command: { kind: 'ordinary.ingress'; input: { semantic: SessionCommandValue } };
    };
    const commit = vi.fn(() => {
      nested = host.runtime.submit(request);
      return { kind: 'committed' as const };
    });
    host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress: { commit },
    });
    const address = await addressFor(host);
    request = {
      target: { kind: 'session', address },
      idempotencyKey: 'event-reentrant',
      command: { kind: 'ordinary.ingress', input: { semantic: { text: 'hello' } } },
    };

    const first = await host.runtime.submit(request);
    const received = await nested!;

    expect(first).toMatchObject({ kind: 'applied', action: 'ordinary.inputCommitted' });
    expect(received).toMatchObject({
      kind: 'duplicate',
      state: 'received',
      policy: 'ordinary-replayable',
      durability: 'processLocal',
    });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('keeps an unknown input commitment sticky and never turns it into a blind replay', async () => {
    const commit = vi.fn()
      .mockReturnValueOnce({ kind: 'unknown' as const, message: 'input hand-off response lost' })
      .mockReturnValue({ kind: 'committed' as const });
    const host = createSessionRuntimeHost({
      directory: new OneSessionDirectory(),
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      ordinaryIngress: { commit },
    });
    const address = await addressFor(host);
    const request = {
      target: { kind: 'session' as const, address },
      idempotencyKey: 'event-unknown',
      command: { kind: 'ordinary.ingress' as const, input: { semantic: { text: 'hello' } } },
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
      ordinaryIngress: { commit },
    });
    const firstHost = makeHost();
    const firstAddress = await addressFor(firstHost);
    const first = await firstHost.runtime.submit({
      target: { kind: 'session', address: firstAddress },
      idempotencyKey: 'event-process-local',
      command: { kind: 'ordinary.ingress', input: { semantic: { text: 'hello' } } },
    });
    const nextHost = makeHost();
    const nextAddress = await addressFor(nextHost);
    const afterRestart = await nextHost.runtime.submit({
      target: { kind: 'session', address: nextAddress },
      idempotencyKey: 'event-process-local',
      command: { kind: 'ordinary.ingress', input: { semantic: { text: 'hello' } } },
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
      ordinaryIngress: { commit },
    });
    const firstProjection = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-1' });
    const secondProjection = await host.projection.read({ kind: 'byExternalSession', sessionId: 'session-2' });
    if (firstProjection.kind !== 'one' || secondProjection.kind !== 'one') {
      throw new Error('expected both Session projections');
    }
    const command = { kind: 'ordinary.ingress' as const, input: { semantic: { text: 'same event key' } } };

    const first = await host.runtime.submit({
      target: { kind: 'session', address: firstProjection.session.address },
      idempotencyKey: 'provider-event-1',
      command,
    });
    const second = await host.runtime.submit({
      target: { kind: 'session', address: secondProjection.session.address },
      idempotencyKey: 'provider-event-1',
      command,
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
    });
    expect(duplicate).toEqual({
      kind: 'duplicate',
      state: 'controlApplied',
      policy: 'control-semantic-transition',
      sessionId: 'session-1',
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
      ordinaryIngress: { commit: () => ({ kind: 'committed' }) },
      sessionStore: {
        load: () => ({ kind: 'loaded', state: storedState(), version: storeVersion() }),
        apply,
      },
    });
    const address = await addressFor(host);

    await host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'shared-command-key',
      command: { kind: 'ordinary.ingress', input: { semantic: { text: 'hello' } } },
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
      command: { kind: 'ordinary.ingress', input: { semantic: { text: 'hello' } } },
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
      ordinaryIngress: { commit: ordinaryCommit },
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
      command: { kind: 'ordinary.ingress' as const, input: { semantic: { text: 'ordinary' } } },
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
