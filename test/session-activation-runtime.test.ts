import { describe, expect, it } from 'vitest';

import {
  createSessionActivationRuntime,
  type SessionActivationPort,
  type SessionActivationTransition,
} from '../src/core/session-activation-runtime.js';
import { createSessionCommandLaneHost } from '../src/core/session-command-lane.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(port: SessionActivationPort) {
  const lanes = createSessionCommandLaneHost();
  return {
    runtime: createSessionActivationRuntime({
      commandLane: lanes.lane,
      laneAddress: lanes.addressFor,
      port,
    }),
  };
}

describe('SessionActivation runtime', () => {
  it('singleflights equal concurrent activation goals for one Session', async () => {
    const effect = deferred<unknown>();
    let executes = 0;
    const continuation = Object.freeze({});
    const port: SessionActivationPort = {
      begin: () => ({ kind: 'effect', intent: Object.freeze({}), continuation }),
      async execute() {
        executes += 1;
        return effect.promise;
      },
      resume: (token, settlement) => {
        expect(token).toBe(continuation);
        expect(settlement.kind).toBe('returned');
        return { kind: 'active', action: 'activated' };
      },
      retire: () => ({ kind: 'retired', action: 'alreadyRetired' }),
    };
    const { runtime } = harness(port);
    const request = {
      sessionId: 's1',
      requestIdentity: 'activate-1',
      goal: { kind: 'ensure' as const, cause: 'ordinary' as const },
    };

    const first = runtime.ensure(request);
    const duplicate = runtime.ensure(request);
    await Promise.resolve();
    expect(executes).toBe(1);
    effect.resolve({ accepted: true });

    expect(await first).toEqual({ kind: 'active', action: 'activated' });
    expect(await duplicate).toEqual({
      kind: 'duplicate',
      state: 'joined',
      outcome: { kind: 'active', action: 'activated' },
    });
  });

  it('does not let a slow activation effect block another Session lane', async () => {
    const slow = deferred<unknown>();
    const began: string[] = [];
    const port: SessionActivationPort = {
      begin: ({ sessionId }): SessionActivationTransition => {
        began.push(sessionId);
        return { kind: 'effect', intent: sessionId, continuation: sessionId };
      },
      execute: intent => intent === 'slow' ? slow.promise : Promise.resolve('done'),
      resume: () => ({ kind: 'active', action: 'activated' }),
      retire: () => ({ kind: 'retired', action: 'alreadyRetired' }),
    };
    const { runtime } = harness(port);

    const first = runtime.ensure({
      sessionId: 'slow',
      requestIdentity: 'slow-1',
      goal: { kind: 'ensure', cause: 'restore' },
    });
    const fast = runtime.ensure({
      sessionId: 'fast',
      requestIdentity: 'fast-1',
      goal: { kind: 'ensure', cause: 'restore' },
    });

    await expect(fast).resolves.toEqual({ kind: 'active', action: 'activated' });
    expect(began).toEqual(['slow', 'fast']);
    slow.resolve('done');
    await first;
  });

  it('serializes a different goal behind the current activation without merging payloads', async () => {
    const firstEffect = deferred<unknown>();
    const begins: string[] = [];
    let executeCount = 0;
    const port: SessionActivationPort = {
      begin: ({ requestIdentity }) => {
        begins.push(requestIdentity);
        return { kind: 'effect', intent: requestIdentity, continuation: requestIdentity };
      },
      execute: async () => {
        executeCount += 1;
        if (executeCount === 1) await firstEffect.promise;
        return undefined;
      },
      resume: () => ({ kind: 'active', action: 'activated' }),
      retire: () => ({ kind: 'retired', action: 'alreadyRetired' }),
    };
    const { runtime } = harness(port);

    const first = runtime.ensure({
      sessionId: 's1',
      requestIdentity: 'first',
      goal: { kind: 'ensure', cause: 'restore' },
    });
    const second = runtime.ensure({
      sessionId: 's1',
      requestIdentity: 'second',
      goal: { kind: 'ensure', cause: 'dashboard' },
    });
    await Promise.resolve();
    expect(begins).toEqual(['first']);
    firstEffect.resolve(undefined);

    await expect(first).resolves.toEqual({ kind: 'active', action: 'activated' });
    await expect(second).resolves.toEqual({ kind: 'active', action: 'activated' });
    expect(begins).toEqual(['first', 'second']);
  });

  it('invalidates an in-flight activation when retirement wins the Session lane', async () => {
    const effect = deferred<unknown>();
    const port: SessionActivationPort = {
      begin: () => ({ kind: 'effect', intent: Object.freeze({}), continuation: Object.freeze({}) }),
      execute: () => effect.promise,
      resume: () => ({ kind: 'active', action: 'activated' }),
      retire: () => ({ kind: 'retired', action: 'retired' }),
    };
    const { runtime } = harness(port);
    const activating = runtime.ensure({
      sessionId: 's1',
      requestIdentity: 'activate',
      goal: { kind: 'ensure', cause: 'dashboard' },
    });
    await Promise.resolve();
    await expect(runtime.retire({
      sessionId: 's1',
      requestIdentity: 'close',
      reason: 'explicitClose',
    })).resolves.toEqual({ kind: 'retired', action: 'retired' });
    effect.resolve(undefined);

    await expect(activating).resolves.toEqual({
      kind: 'stale',
      message: 'activation continuation was superseded by a lifecycle transition',
    });
  });

  it('fails closed when an Adapter reports an unknown backend observation', async () => {
    const port: SessionActivationPort = {
      begin: () => ({ kind: 'quarantined', message: 'backend probe unknown' }),
      execute: async () => undefined,
      resume: () => ({ kind: 'quarantined', message: 'unreachable' }),
      retire: () => ({ kind: 'retired', action: 'alreadyRetired' }),
    };
    const { runtime } = harness(port);

    await expect(runtime.ensure({
      sessionId: 's1',
      requestIdentity: 'restore-1',
      goal: { kind: 'reconcile', cause: 'restore', observation: 'unknown' },
    })).resolves.toEqual({ kind: 'quarantined', message: 'backend probe unknown' });
  });
});
