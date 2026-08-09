import { describe, expect, it, vi } from 'vitest';
import {
  createSessionExecutorRuntime,
  type ExecutorGenerationAuthority,
} from '../src/core/session-executor-runtime.js';

function authority() {
  let generation = 0;
  let currentIdentity: object | undefined;
  const committed = new Set<object>();
  const port: ExecutorGenerationAuthority = {
    commitNext() {
      generation += 1;
      const token = Object.freeze({ generation });
      committed.add(token);
      return { token, sessionKey: 'app-owner\0sid-runtime', sessionId: 'sid-runtime', generation };
    },
    owns(token, identity) {
      return committed.has(token)
        && currentIdentity === identity
        && (token as { generation: number }).generation === generation;
    },
    fenceExit(token, identity) {
      if (!port.owns(token, identity)) {
        return { kind: 'stale' as const };
      }
      generation += 1;
      currentIdentity = undefined;
      return { kind: 'fenced' as const, generation };
    },
  };
  return {
    port,
    activate(identity: object) { currentIdentity = identity; },
    replace(identity: object) { currentIdentity = identity; generation += 1; },
    generation: () => generation,
  };
}

function fixedAuthority(input: {
  sessionKey?: string;
  sessionId?: string;
  generation: number;
  fencedGeneration?: number;
}): ExecutorGenerationAuthority {
  const token = Object.freeze({ generation: input.generation });
  return {
    commitNext: () => ({
      token,
      sessionKey: input.sessionKey ?? 'app-owner\0sid-runtime',
      sessionId: input.sessionId ?? 'sid-runtime',
      generation: input.generation,
    }),
    owns: () => true,
    fenceExit: () => ({
      kind: 'fenced',
      generation: input.fencedGeneration ?? input.generation + 1,
    }),
  };
}

describe('SessionExecutorRuntime generation authority', () => {
  it('revokes an old lease as soon as a newer generation is committed', () => {
    const runtime = createSessionExecutorRuntime();
    const first = runtime.commitGeneration(fixedAuthority({ generation: 1 }));
    const firstLease = runtime.activate(first, {});
    expect(runtime.isCurrent(firstLease)).toBe(true);

    const second = runtime.commitGeneration(fixedAuthority({ generation: 2 }));
    expect(runtime.isCurrent(firstLease)).toBe(false);
    expect(runtime.report(firstLease, { kind: 'inputReceived', turnId: 'turn-1' }).kind).toBe('stale');

    const secondLease = runtime.activate(second, {});
    expect(runtime.isCurrent(secondLease)).toBe(true);
  });

  it('does not activate a commitment superseded before spawn', () => {
    const runtime = createSessionExecutorRuntime();
    const first = runtime.commitGeneration(fixedAuthority({ generation: 1 }));
    const second = runtime.commitGeneration(fixedAuthority({ generation: 2 }));

    expect(() => runtime.activate(first, {})).toThrow('superseded before activation');
    expect(runtime.isCurrent(runtime.activate(second, {}))).toBe(true);
  });

  it('keeps one current lease even when distinct authorities both claim ownership', () => {
    const runtime = createSessionExecutorRuntime();
    const firstLease = runtime.activate(
      runtime.commitGeneration(fixedAuthority({ generation: 1 })),
      {},
    );
    const secondLease = runtime.activate(
      runtime.commitGeneration(fixedAuthority({ generation: 2 })),
      {},
    );

    expect(runtime.report(firstLease, { kind: 'inputCommitted', turnId: 'turn-1' }).kind).toBe('stale');
    expect(runtime.report(secondLease, { kind: 'inputCommitted', turnId: 'turn-1' }).kind).toBe('current');
  });

  it('poisons the prior lease when an Adapter publishes a non-monotonic generation', () => {
    const runtime = createSessionExecutorRuntime();
    const lease = runtime.activate(
      runtime.commitGeneration(fixedAuthority({ generation: 2 })),
      {},
    );

    expect(() => runtime.commitGeneration(fixedAuthority({ generation: 2 })))
      .toThrow('non-monotonic commitment');
    expect(runtime.isCurrent(lease)).toBe(false);
  });

  it('tracks independent logical Sessions without cross-revocation', () => {
    const runtime = createSessionExecutorRuntime();
    const first = runtime.activate(runtime.commitGeneration(fixedAuthority({
      sessionKey: 'app-owner\0sid-a',
      sessionId: 'sid-a',
      generation: 1,
    })), {});
    const second = runtime.activate(runtime.commitGeneration(fixedAuthority({
      sessionKey: 'app-owner\0sid-b',
      sessionId: 'sid-b',
      generation: 1,
    })), {});

    expect(runtime.isCurrent(first)).toBe(true);
    expect(runtime.isCurrent(second)).toBe(true);
  });

  it('keeps the exit fence as the generation floor', () => {
    const runtime = createSessionExecutorRuntime();
    const lease = runtime.activate(
      runtime.commitGeneration(fixedAuthority({ generation: 1, fencedGeneration: 2 })),
      {},
    );
    expect(runtime.report(lease, { kind: 'workerExit' }).kind).toBe('currentExit');

    expect(() => runtime.commitGeneration(fixedAuthority({ generation: 2 })))
      .toThrow('non-monotonic commitment');
    expect(() => runtime.activate(
      runtime.commitGeneration(fixedAuthority({ generation: 3 })),
      {},
    )).not.toThrow();
  });

  it.each([1, Number.NaN])('fails closed on invalid exit fence generation %s', (fencedGeneration) => {
    const runtime = createSessionExecutorRuntime();
    const lease = runtime.activate(runtime.commitGeneration(fixedAuthority({
      generation: 1,
      fencedGeneration,
    })), {});

    expect(runtime.report(lease, { kind: 'workerExit' })).toMatchObject({
      kind: 'unreadable',
      current: true,
      message: expect.stringContaining('invalid exit fence'),
    });
  });

  it('commits a generation before minting one opaque activation lease', () => {
    const runtime = createSessionExecutorRuntime();
    const current = authority();
    const worker = {};

    const commit = runtime.commitGeneration(current.port);
    current.activate(worker);
    const lease = runtime.activate(commit, worker);

    expect(commit.generation).toBe(1);
    expect(runtime.report(lease, { kind: 'inputReceived', turnId: 'turn-1' })).toEqual({
      kind: 'current',
      sessionId: 'sid-runtime',
      executorGeneration: 1,
    });
    expect(() => runtime.activate(commit, {})).toThrow('already activated');
  });

  it('rejects received, committed, and terminal reports after replacement', () => {
    const runtime = createSessionExecutorRuntime();
    const current = authority();
    const oldWorker = {};
    const replacement = {};
    const commit = runtime.commitGeneration(current.port);
    current.activate(oldWorker);
    const lease = runtime.activate(commit, oldWorker);

    current.replace(replacement);

    for (const observation of [
      { kind: 'inputReceived' as const, turnId: 'turn-1' },
      { kind: 'inputCommitted' as const, turnId: 'turn-1' },
      { kind: 'turnTerminal' as const, turnId: 'turn-1' },
    ]) {
      expect(runtime.report(lease, observation)).toEqual({
        kind: 'stale',
        sessionId: 'sid-runtime',
        executorGeneration: 1,
      });
    }
  });

  it('rechecks an async terminal continuation after generation replacement', () => {
    const runtime = createSessionExecutorRuntime();
    const current = authority();
    const worker = {};
    const commit = runtime.commitGeneration(current.port);
    current.activate(worker);
    const lease = runtime.activate(commit, worker);

    const accepted = runtime.report(lease, { kind: 'turnTerminal', turnId: 'turn-1' });
    expect(accepted.kind).toBe('current');
    expect(accepted.kind === 'current' ? accepted.continuation : undefined).toBeDefined();

    current.replace({});
    expect(runtime.resume(accepted.kind === 'current' ? accepted.continuation! : undefined as never)).toEqual({
      kind: 'stale',
      sessionId: 'sid-runtime',
      executorGeneration: 1,
    });
  });

  it('fences a current worker exit before returning authority for external effects', () => {
    const runtime = createSessionExecutorRuntime();
    const current = authority();
    const worker = {};
    const commit = runtime.commitGeneration(current.port);
    current.activate(worker);
    const lease = runtime.activate(commit, worker);
    const fence = vi.spyOn(current.port, 'fenceExit');

    expect(runtime.report(lease, { kind: 'workerExit' })).toEqual({
      kind: 'currentExit',
      sessionId: 'sid-runtime',
      executorGeneration: 1,
      fencedGeneration: 2,
    });
    expect(fence).toHaveBeenCalledTimes(1);
    expect(current.generation()).toBe(2);
    expect(runtime.report(lease, { kind: 'workerExit' })).toEqual({
      kind: 'stale',
      sessionId: 'sid-runtime',
      executorGeneration: 1,
    });
  });

  it('allows one authentic retiring exit reconciliation without current effects', () => {
    const runtime = createSessionExecutorRuntime();
    const current = authority();
    const oldWorker = {};
    const commit = runtime.commitGeneration(current.port);
    current.activate(oldWorker);
    const lease = runtime.activate(commit, oldWorker);
    current.replace({});
    const fence = vi.spyOn(current.port, 'fenceExit');

    expect(runtime.report(lease, { kind: 'workerExit' })).toEqual({
      kind: 'retiringExit',
      sessionId: 'sid-runtime',
      executorGeneration: 1,
    });
    expect(fence).not.toHaveBeenCalled();
    expect(runtime.report(lease, { kind: 'workerExit' }).kind).toBe('stale');
  });

  it('fails closed when the current exit fence is unreadable', () => {
    const runtime = createSessionExecutorRuntime();
    const current = authority();
    const worker = {};
    const commit = runtime.commitGeneration(current.port);
    current.activate(worker);
    const lease = runtime.activate(commit, worker);
    vi.spyOn(current.port, 'fenceExit').mockReturnValue({
      kind: 'unreadable',
      message: 'disk unavailable',
    });

    expect(runtime.report(lease, { kind: 'workerExit' })).toEqual({
      kind: 'unreadable',
      sessionId: 'sid-runtime',
      executorGeneration: 1,
      current: true,
      message: 'disk unavailable',
    });
    expect(runtime.report(lease, { kind: 'inputCommitted', turnId: 'turn-1' }).kind).toBe('stale');
  });
});
