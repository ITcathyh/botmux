import { describe, expect, it, vi } from 'vitest';
import {
  createSessionExecutorRuntime,
  type ExecutorGenerationAuthority,
} from '../src/core/session-executor-runtime.js';

function authority() {
  const sessionKey = 'app-owner\0sid-runtime';
  const sessionId = 'sid-runtime';
  let generation = 0;
  let currentIdentity: object | undefined;
  const committed = new Set<object>();
  const port: ExecutorGenerationAuthority = {
    sessionKey,
    sessionId,
    commitNext() {
      generation += 1;
      const token = Object.freeze({ generation });
      committed.add(token);
      return { token, generation };
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
  const sessionKey = input.sessionKey ?? 'app-owner\0sid-runtime';
  const sessionId = input.sessionId ?? 'sid-runtime';
  const token = Object.freeze({ generation: input.generation });
  return {
    sessionKey,
    sessionId,
    commitNext: () => ({
      token,
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
  it('revokes an old lease as soon as a newer generation is committed', async () => {
    const runtime = createSessionExecutorRuntime();
    const first = runtime.commitGeneration(fixedAuthority({ generation: 1 }));
    const firstLease = runtime.activate(first, {});
    expect(runtime.isCurrent(firstLease)).toBe(true);

    const second = runtime.commitGeneration(fixedAuthority({ generation: 2 }));
    expect(runtime.isCurrent(firstLease)).toBe(false);
    expect((await runtime.report(
      firstLease,
      { kind: 'inputReceived', turnId: 'turn-1' },
      decision => decision,
    )).kind).toBe('stale');

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

  it('keeps one current lease even when distinct authorities both claim ownership', async () => {
    const runtime = createSessionExecutorRuntime();
    const firstLease = runtime.activate(
      runtime.commitGeneration(fixedAuthority({ generation: 1 })),
      {},
    );
    const secondLease = runtime.activate(
      runtime.commitGeneration(fixedAuthority({ generation: 2 })),
      {},
    );

    expect((await runtime.report(
      firstLease,
      { kind: 'inputCommitted', turnId: 'turn-1' },
      decision => decision,
    )).kind).toBe('stale');
    expect((await runtime.report(
      secondLease,
      { kind: 'inputCommitted', turnId: 'turn-1' },
      decision => decision,
    )).kind).toBe('current');
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

  it('keeps the exit fence as the generation floor', async () => {
    const runtime = createSessionExecutorRuntime();
    const lease = runtime.activate(
      runtime.commitGeneration(fixedAuthority({ generation: 1, fencedGeneration: 2 })),
      {},
    );
    expect((await runtime.report(lease, { kind: 'workerExit' }, decision => decision)).kind)
      .toBe('currentExit');

    expect(() => runtime.commitGeneration(fixedAuthority({ generation: 2 })))
      .toThrow('non-monotonic commitment');
    expect(() => runtime.activate(
      runtime.commitGeneration(fixedAuthority({ generation: 3 })),
      {},
    )).not.toThrow();
  });

  it.each([1, Number.NaN])('fails closed on invalid exit fence generation %s', async (fencedGeneration) => {
    const runtime = createSessionExecutorRuntime();
    const lease = runtime.activate(runtime.commitGeneration(fixedAuthority({
      generation: 1,
      fencedGeneration,
    })), {});

    expect(await runtime.report(lease, { kind: 'workerExit' }, decision => decision)).toMatchObject({
      kind: 'unreadable',
      current: true,
      message: expect.stringContaining('invalid exit fence'),
    });
  });

  it('commits a generation before minting one opaque activation lease', async () => {
    const runtime = createSessionExecutorRuntime();
    const current = authority();
    const worker = {};

    const commit = runtime.commitGeneration(current.port);
    current.activate(worker);
    const lease = runtime.activate(commit, worker);

    expect(commit.generation).toBe(1);
    expect(await runtime.report(
      lease,
      { kind: 'inputReceived', turnId: 'turn-1' },
      decision => decision,
    )).toEqual({
      kind: 'current',
      sessionId: 'sid-runtime',
      executorGeneration: 1,
    });
    expect(() => runtime.activate(commit, {})).toThrow('already activated');
  });

  it('rejects received, committed, and terminal reports after replacement', async () => {
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
      expect(await runtime.report(lease, observation, decision => decision)).toEqual({
        kind: 'stale',
        sessionId: 'sid-runtime',
        executorGeneration: 1,
      });
    }
  });

  it('rechecks an async terminal continuation after generation replacement', async () => {
    const runtime = createSessionExecutorRuntime();
    const current = authority();
    const worker = {};
    const commit = runtime.commitGeneration(current.port);
    current.activate(worker);
    const lease = runtime.activate(commit, worker);

    const accepted = await runtime.report(
      lease,
      { kind: 'turnTerminal', turnId: 'turn-1' },
      decision => decision,
    );
    expect(accepted.kind).toBe('current');
    expect(accepted.kind === 'current' ? accepted.continuation : undefined).toBeDefined();

    current.replace({});
    expect(await runtime.resume(
      accepted.kind === 'current' ? accepted.continuation! : undefined as never,
      decision => decision,
    )).toEqual({
      kind: 'stale',
      sessionId: 'sid-runtime',
      executorGeneration: 1,
    });
  });

  it('fences a current worker exit before returning authority for external effects', async () => {
    const runtime = createSessionExecutorRuntime();
    const current = authority();
    const worker = {};
    const commit = runtime.commitGeneration(current.port);
    current.activate(worker);
    const lease = runtime.activate(commit, worker);
    const fence = vi.spyOn(current.port, 'fenceExit');

    expect(await runtime.report(lease, { kind: 'workerExit' }, decision => decision)).toEqual({
      kind: 'currentExit',
      sessionId: 'sid-runtime',
      executorGeneration: 1,
      fencedGeneration: 2,
    });
    expect(fence).toHaveBeenCalledTimes(1);
    expect(current.generation()).toBe(2);
    expect(await runtime.report(lease, { kind: 'workerExit' }, decision => decision)).toEqual({
      kind: 'stale',
      sessionId: 'sid-runtime',
      executorGeneration: 1,
    });
  });

  it('allows one authentic retiring exit reconciliation without current effects', async () => {
    const runtime = createSessionExecutorRuntime();
    const current = authority();
    const oldWorker = {};
    const commit = runtime.commitGeneration(current.port);
    current.activate(oldWorker);
    const lease = runtime.activate(commit, oldWorker);
    current.replace({});
    const fence = vi.spyOn(current.port, 'fenceExit');

    expect(await runtime.report(lease, { kind: 'workerExit' }, decision => decision)).toEqual({
      kind: 'retiringExit',
      sessionId: 'sid-runtime',
      executorGeneration: 1,
    });
    expect(fence).not.toHaveBeenCalled();
    expect((await runtime.report(lease, { kind: 'workerExit' }, decision => decision)).kind)
      .toBe('stale');
  });

  it('fails closed when the current exit fence is unreadable', async () => {
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

    expect(await runtime.report(lease, { kind: 'workerExit' }, decision => decision)).toEqual({
      kind: 'unreadable',
      sessionId: 'sid-runtime',
      executorGeneration: 1,
      current: true,
      message: 'disk unavailable',
    });
    expect((await runtime.report(
      lease,
      { kind: 'inputCommitted', turnId: 'turn-1' },
      decision => decision,
    )).kind).toBe('stale');
  });

  it('consumes one continuation only once when two resumes queue in the same Session lane', async () => {
    const runtime = createSessionExecutorRuntime();
    const current = authority();
    const worker = {};
    const commit = runtime.commitGeneration(current.port);
    current.activate(worker);
    const lease = runtime.activate(commit, worker);
    const accepted = await runtime.report(
      lease,
      { kind: 'turnTerminal', turnId: 'turn-once' },
      decision => decision,
    );
    if (accepted.kind !== 'current' || !accepted.continuation) {
      throw new Error('expected a current terminal continuation');
    }

    let firstResume!: ReturnType<typeof runtime.resume>;
    let secondResume!: ReturnType<typeof runtime.resume>;
    await runtime.report(
      lease,
      { kind: 'inputReceived', turnId: 'turn-queue-owner' },
      decision => {
        firstResume = runtime.resume(accepted.continuation!, resumed => resumed);
        secondResume = runtime.resume(accepted.continuation!, resumed => resumed);
        void secondResume.catch(() => undefined);
        return decision;
      },
    );

    await expect(firstResume).resolves.toMatchObject({ kind: 'current' });
    await expect(secondResume).rejects.toThrow('already consumed');
  });

  it('rejects an async authority ownership proof and never treats it as current', async () => {
    const runtime = createSessionExecutorRuntime();
    const current = authority();
    const worker = {};
    const commit = runtime.commitGeneration(current.port);
    current.activate(worker);
    const lease = runtime.activate(commit, worker);
    vi.spyOn(current.port, 'owns').mockImplementation((async () => true) as never);
    const transition = vi.fn((decision) => decision);

    expect(runtime.isCurrent(lease)).toBe(false);
    await expect(runtime.report(
      lease,
      { kind: 'inputReceived', turnId: 'turn-async-owner' },
      transition,
    )).rejects.toThrow('ExecutorGenerationAuthority.owns must return synchronously');
    expect(transition).not.toHaveBeenCalled();
  });

  it('invalidates a terminal continuation when its short transition fails', async () => {
    const runtime = createSessionExecutorRuntime();
    const current = authority();
    const worker = {};
    const commit = runtime.commitGeneration(current.port);
    current.activate(worker);
    const lease = runtime.activate(commit, worker);
    let leakedContinuation: Parameters<typeof runtime.resume>[0] | undefined;

    await expect(runtime.report(
      lease,
      { kind: 'turnTerminal', turnId: 'turn-failed-transition' },
      decision => {
        leakedContinuation = decision.kind === 'current' ? decision.continuation : undefined;
        throw new Error('terminal transition failed');
      },
    )).rejects.toThrow('terminal transition failed');
    expect(leakedContinuation).toBeDefined();
    await expect(runtime.resume(leakedContinuation!, decision => decision))
      .rejects.toThrow('belongs to another Runtime epoch');
  });

  it('retries one continuation when its first short transition fails', async () => {
    const runtime = createSessionExecutorRuntime();
    const current = authority();
    const worker = {};
    const commit = runtime.commitGeneration(current.port);
    current.activate(worker);
    const lease = runtime.activate(commit, worker);
    const accepted = await runtime.report(
      lease,
      { kind: 'cliExit' },
      decision => decision,
    );
    if (accepted.kind !== 'current' || !accepted.continuation) {
      throw new Error('expected current CLI-exit continuation');
    }

    await expect(runtime.resume(accepted.continuation, () => {
      throw new Error('continuation transition failed');
    })).rejects.toThrow('continuation transition failed');
    await expect(runtime.resume(accepted.continuation, decision => decision))
      .resolves.toMatchObject({ kind: 'current' });
  });

  it('retries worker-exit cleanup without fencing the generation twice', async () => {
    const runtime = createSessionExecutorRuntime();
    const current = authority();
    const worker = {};
    const commit = runtime.commitGeneration(current.port);
    current.activate(worker);
    const lease = runtime.activate(commit, worker);
    const fence = vi.spyOn(current.port, 'fenceExit');

    await expect(runtime.report(lease, { kind: 'workerExit' }, () => {
      throw new Error('exit cleanup failed');
    })).rejects.toThrow('exit cleanup failed');
    await expect(runtime.report(lease, { kind: 'workerExit' }, decision => decision))
      .resolves.toMatchObject({ kind: 'currentExit', fencedGeneration: 2 });
    expect(fence).toHaveBeenCalledTimes(1);
    await expect(runtime.report(lease, { kind: 'workerExit' }, decision => decision))
      .resolves.toMatchObject({ kind: 'stale' });
  });

  it('downgrades a failed current-exit cleanup retry after replacement commits', async () => {
    const runtime = createSessionExecutorRuntime();
    const first = authority();
    const firstWorker = {};
    const firstCommit = runtime.commitGeneration(first.port);
    first.activate(firstWorker);
    const firstLease = runtime.activate(firstCommit, firstWorker);
    const fence = vi.spyOn(first.port, 'fenceExit');

    await expect(runtime.report(firstLease, { kind: 'workerExit' }, () => {
      throw new Error('current cleanup interrupted');
    })).rejects.toThrow('current cleanup interrupted');

    const replacementLease = runtime.activate(
      runtime.commitGeneration(fixedAuthority({ generation: 3 })),
      {},
    );
    await expect(runtime.report(firstLease, { kind: 'workerExit' }, decision => decision))
      .resolves.toMatchObject({ kind: 'retiringExit', executorGeneration: 1 });
    expect(runtime.isCurrent(replacementLease)).toBe(true);
    expect(fence).toHaveBeenCalledTimes(1);
  });
});
