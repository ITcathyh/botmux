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

const settleRetirement: SessionActivationPort['settleRetirement'] = request => (
  request.disposition === 'unknown'
    ? { kind: 'quarantined', message: 'provider outcome is unknown' }
    : { kind: 'settled', disposition: request.disposition }
);

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
      settleRetirement,
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

    await expect(runtime.ensure(request)).resolves.toEqual({
      kind: 'duplicate',
      state: 'completed',
      outcome: { kind: 'active', action: 'activated' },
    });
  });

  it('retries a transient terminal with the same request identity', async () => {
    let begins = 0;
    const port: SessionActivationPort = {
      begin: () => {
        begins += 1;
        return begins === 1
          ? { kind: 'retryable', message: 'worker admission is temporarily unavailable' }
          : { kind: 'active', action: 'activated' };
      },
      execute: async () => undefined,
      resume: () => ({ kind: 'quarantined', message: 'unreachable' }),
      retire: () => ({ kind: 'retired', action: 'alreadyRetired' }),
      settleRetirement,
    };
    const { runtime } = harness(port);
    const request = {
      sessionId: 's1',
      requestIdentity: 'terminal:s1:7',
      goal: { kind: 'ensure' as const, cause: 'terminal' as const },
    };

    await expect(runtime.ensure(request)).resolves.toEqual({
      kind: 'retryable',
      message: 'worker admission is temporarily unavailable',
    });
    await expect(runtime.ensure(request)).resolves.toEqual({
      kind: 'active',
      action: 'activated',
    });
    expect(begins).toBe(2);
  });

  it('reserves the request hash while a retryable activation may be re-driven', async () => {
    let begins = 0;
    const port: SessionActivationPort = {
      begin: () => {
        begins += 1;
        return begins === 1
          ? { kind: 'retryable', message: 'worker admission is temporarily unavailable' }
          : { kind: 'active', action: 'activated' };
      },
      execute: async () => undefined,
      resume: () => ({ kind: 'quarantined', message: 'unreachable' }),
      retire: () => ({ kind: 'retired', action: 'alreadyRetired' }),
      settleRetirement,
    };
    const { runtime } = harness(port);
    const original = {
      sessionId: 's1',
      requestIdentity: 'terminal:s1:8',
      goal: {
        kind: 'ensure' as const,
        cause: 'terminal' as const,
        input: { promptInput: 'original' },
      },
    };

    await expect(runtime.ensure(original)).resolves.toMatchObject({ kind: 'retryable' });
    await expect(runtime.ensure({
      ...original,
      goal: { ...original.goal, input: { promptInput: 'different' } },
    })).resolves.toEqual({
      kind: 'rejected',
      reason: 'conflict',
      message: 'activation request identity already belongs to a different goal',
    });
    expect(begins).toBe(1);
    await expect(runtime.ensure(original)).resolves.toEqual({
      kind: 'active',
      action: 'activated',
    });
    expect(begins).toBe(2);
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
      settleRetirement,
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
      settleRetirement,
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

  it('does not start an activation effect after retirement wins before effect invocation', async () => {
    let executes = 0;
    const port: SessionActivationPort = {
      begin: () => ({ kind: 'effect', intent: Object.freeze({}), continuation: Object.freeze({}) }),
      execute: async () => {
        executes += 1;
        return undefined;
      },
      resume: () => ({ kind: 'active', action: 'activated' }),
      retire: () => ({ kind: 'retired', action: 'retired' }),
      settleRetirement,
    };
    const { runtime } = harness(port);

    const activating = runtime.ensure({
      sessionId: 's1',
      requestIdentity: 'activate-before-effect',
      goal: { kind: 'ensure', cause: 'ordinary' },
    });
    await expect(runtime.retire({
      sessionId: 's1',
      requestIdentity: 'retire-before-effect',
      reason: 'explicitClose',
    })).resolves.toEqual({ kind: 'retired', action: 'retired' });

    await expect(activating).resolves.toEqual({
      kind: 'staleBeforeEffect',
      message: 'activation attempt was superseded before effect invocation',
    });
    expect(executes).toBe(0);
  });

  it('starts the effect synchronously in the lifecycle-check lane segment', async () => {
    const effect = deferred<unknown>();
    const effectStarted = deferred<void>();
    const events: string[] = [];
    let runtime!: ReturnType<typeof harness>['runtime'];
    let retirement!: ReturnType<typeof runtime.retire>;
    const port: SessionActivationPort = {
      begin: () => ({ kind: 'effect', intent: Object.freeze({}), continuation: Object.freeze({}) }),
      execute: () => {
        events.push('effect-start');
        retirement = runtime.retire({
          sessionId: 's1',
          requestIdentity: 'retire-during-effect-start',
          reason: 'explicitClose',
        });
        events.push('effect-return');
        effectStarted.resolve();
        return effect.promise;
      },
      resume: () => ({ kind: 'active', action: 'activated' }),
      retire: () => {
        events.push('retire');
        return { kind: 'retired', action: 'retired' };
      },
      settleRetirement,
    };
    ({ runtime } = harness(port));

    const activating = runtime.ensure({
      sessionId: 's1',
      requestIdentity: 'activate-with-reentrant-retire',
      goal: { kind: 'ensure', cause: 'ordinary' },
    });
    await effectStarted.promise;

    expect(events).toEqual(['effect-start', 'effect-return', 'retire']);
    await expect(retirement).resolves.toEqual({ kind: 'retired', action: 'retired' });
    effect.resolve(undefined);
    await expect(activating).resolves.toMatchObject({ kind: 'unknownAfterEffect' });
  });

  it('quarantines an in-flight activation when retirement wins after its effect started', async () => {
    const effect = deferred<unknown>();
    let begins = 0;
    const port: SessionActivationPort = {
      begin: () => {
        begins += 1;
        return begins === 1
          ? { kind: 'effect', intent: Object.freeze({}), continuation: Object.freeze({}) }
          : { kind: 'active', action: 'reattached' };
      },
      execute: () => effect.promise,
      resume: () => ({ kind: 'active', action: 'activated' }),
      retire: () => ({ kind: 'retired', action: 'retired' }),
      settleRetirement,
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
      kind: 'unknownAfterEffect',
      message: 'activation effect outcome was superseded by a lifecycle transition',
    });
    await expect(runtime.ensure({
      sessionId: 's1',
      requestIdentity: 'activate',
      goal: { kind: 'ensure', cause: 'dashboard' },
    })).resolves.toEqual({
      kind: 'quarantined',
      message: 'activation effect outcome is quarantined pending an explicit re-probe',
    });
    expect(begins).toBe(1);
    await expect(runtime.ensure({
      sessionId: 's1',
      requestIdentity: 'reprobe-after-unknown-effect',
      goal: { kind: 'reconcile', cause: 'restore', observation: 'exists' },
    })).resolves.toEqual({ kind: 'active', action: 'reattached' });
    expect(begins).toBe(2);
  });

  it('keeps an Adapter-reported unknown-after-effect outcome quarantined until a typed re-probe', async () => {
    let begins = 0;
    const port: SessionActivationPort = {
      begin: () => {
        begins += 1;
        return begins === 1
          ? { kind: 'effect', intent: Object.freeze({}), continuation: Object.freeze({}) }
          : { kind: 'active', action: 'reattached' };
      },
      execute: async () => undefined,
      resume: () => ({
        kind: 'unknownAfterEffect',
        message: 'Adapter binding changed after the effect started',
      }),
      retire: () => ({ kind: 'retired', action: 'retired' }),
      settleRetirement,
    };
    const { runtime } = harness(port);

    await expect(runtime.ensure({
      sessionId: 's1',
      requestIdentity: 'adapter-unknown-after-effect',
      goal: { kind: 'ensure', cause: 'dashboard' },
    })).resolves.toEqual({
      kind: 'unknownAfterEffect',
      message: 'Adapter binding changed after the effect started',
    });
    await expect(runtime.ensure({
      sessionId: 's1',
      requestIdentity: 'ordinary-after-adapter-unknown',
      goal: { kind: 'ensure', cause: 'ordinary' },
    })).resolves.toEqual({
      kind: 'quarantined',
      message: 'activation effect outcome is quarantined pending an explicit re-probe',
    });
    expect(begins).toBe(1);
    await expect(runtime.ensure({
      sessionId: 's1',
      requestIdentity: 'reprobe-after-adapter-unknown',
      goal: { kind: 'reconcile', cause: 'restore', observation: 'exists' },
    })).resolves.toEqual({ kind: 'active', action: 'reattached' });
    expect(begins).toBe(2);
  });

  it('does not admit a queued pre-retirement identity into the replacement lifecycle', async () => {
    const firstEffect = deferred<unknown>();
    const begins: string[] = [];
    let replacementEffects = 0;
    const port: SessionActivationPort = {
      begin: ({ requestIdentity }) => {
        begins.push(requestIdentity);
        return {
          kind: 'effect',
          intent: requestIdentity,
          continuation: requestIdentity,
        };
      },
      execute: async (intent) => {
        if (intent === 'activation-before-retire') return firstEffect.promise;
        replacementEffects += 1;
        return undefined;
      },
      resume: () => ({ kind: 'active', action: 'activated' }),
      retire: () => ({ kind: 'retired', action: 'retired' }),
      settleRetirement,
    };
    const { runtime } = harness(port);
    const first = runtime.ensure({
      sessionId: 's1',
      requestIdentity: 'activation-before-retire',
      goal: { kind: 'ensure', cause: 'ordinary' },
    });
    await Promise.resolve();
    const queuedRequest = {
      sessionId: 's1',
      requestIdentity: 'replacement-identity',
      goal: { kind: 'ensure' as const, cause: 'replacement' as const },
    };
    const queuedBeforeRetire = runtime.ensure(queuedRequest);
    const retirement = {
      sessionId: 's1',
      requestIdentity: 'retire-between-attempts',
      reason: 'replacement' as const,
    };
    await expect(runtime.retire(retirement)).resolves.toEqual({ kind: 'retired', action: 'retired' });

    firstEffect.resolve(undefined);
    await expect(first).resolves.toMatchObject({ kind: 'unknownAfterEffect' });
    await expect(queuedBeforeRetire).resolves.toMatchObject({ kind: 'staleBeforeEffect' });
    await expect(runtime.settleRetirement({
      ...retirement,
      disposition: 'applied',
    })).resolves.toEqual({ kind: 'settled', disposition: 'applied' });
    const replacement = runtime.ensure(queuedRequest);
    await expect(replacement).resolves.toEqual({ kind: 'active', action: 'activated' });
    expect(begins).toEqual(['activation-before-retire', 'replacement-identity']);
    expect(replacementEffects).toBe(1);
  });

  it('starts a new lifecycle attempt after retirement even when the identity is reused', async () => {
    let begins = 0;
    const port: SessionActivationPort = {
      begin: () => {
        begins += 1;
        return { kind: 'active', action: 'activated' };
      },
      execute: async () => undefined,
      resume: () => ({ kind: 'quarantined', message: 'unreachable' }),
      retire: () => ({ kind: 'retired', action: 'retired' }),
      settleRetirement,
    };
    const { runtime } = harness(port);
    const request = {
      sessionId: 's1',
      requestIdentity: 'operation-1',
      goal: { kind: 'ensure' as const, cause: 'dashboard' as const },
    };

    await expect(runtime.ensure(request)).resolves.toEqual({ kind: 'active', action: 'activated' });
    await expect(runtime.retire({
      sessionId: 's1',
      requestIdentity: 'close-1',
      reason: 'explicitClose',
    })).resolves.toEqual({ kind: 'retired', action: 'retired' });
    await expect(runtime.ensure(request)).resolves.toEqual({ kind: 'active', action: 'activated' });
    expect(begins).toBe(2);
  });

  it('does not advance the lifecycle when retirement is proven retryable', async () => {
    let begins = 0;
    let retirements = 0;
    const port: SessionActivationPort = {
      begin: () => {
        begins += 1;
        return { kind: 'active', action: 'activated' };
      },
      execute: async () => undefined,
      resume: () => ({ kind: 'quarantined', message: 'unreachable' }),
      retire: () => {
        retirements += 1;
        return retirements === 1
          ? { kind: 'retryable', message: 'passivation not published' }
          : { kind: 'retired', action: 'retired' };
      },
      settleRetirement,
    };
    const { runtime } = harness(port);
    const activation = {
      sessionId: 's1',
      requestIdentity: 'activate-1',
      goal: { kind: 'ensure' as const, cause: 'dashboard' as const },
    };
    await expect(runtime.ensure(activation)).resolves.toMatchObject({ kind: 'active' });

    const retirement = {
      sessionId: 's1',
      requestIdentity: 'suspend-1',
      reason: 'passivation' as const,
    };
    await expect(runtime.retire(retirement)).resolves.toEqual({
      kind: 'retryable',
      message: 'passivation not published',
    });
    await expect(runtime.retire({
      ...retirement,
      reason: 'replacement',
    })).resolves.toEqual({
      kind: 'quarantined',
      message: 'retirement request identity already belongs to a different reason',
    });
    expect(retirements).toBe(1);
    // The failed fence did not supersede or evict the completed activation.
    await expect(runtime.ensure(activation)).resolves.toMatchObject({
      kind: 'duplicate',
      state: 'completed',
    });

    await expect(runtime.retire(retirement)).resolves.toEqual({
      kind: 'retired',
      action: 'retired',
    });
    await expect(runtime.ensure(activation)).resolves.toMatchObject({ kind: 'active' });
    expect(begins).toBe(2);
    expect(retirements).toBe(2);
  });

  it('keeps an ambiguous retirement sticky for the same operation identity', async () => {
    let retirements = 0;
    const port: SessionActivationPort = {
      begin: () => ({ kind: 'active', action: 'activated' }),
      execute: async () => undefined,
      resume: () => ({ kind: 'quarantined', message: 'unreachable' }),
      retire: () => {
        retirements += 1;
        return { kind: 'quarantined', message: 'passivation outcome unknown' };
      },
      settleRetirement,
    };
    const { runtime } = harness(port);
    const request = {
      sessionId: 's1',
      requestIdentity: 'suspend-unknown',
      reason: 'passivation' as const,
    };

    await expect(runtime.retire(request)).resolves.toEqual({
      kind: 'quarantined',
      message: 'passivation outcome unknown',
    });
    await expect(runtime.retire(request)).resolves.toEqual({
      kind: 'quarantined',
      message: 'passivation outcome unknown',
    });
    expect(retirements).toBe(1);
  });

  it('keeps retirement settlement evidence sticky for one operation identity', async () => {
    let settlements = 0;
    const port: SessionActivationPort = {
      begin: () => ({ kind: 'active', action: 'activated' }),
      execute: async () => undefined,
      resume: () => ({ kind: 'quarantined', message: 'unreachable' }),
      retire: () => ({ kind: 'retired', action: 'retired' }),
      settleRetirement: request => {
        settlements += 1;
        return request.disposition === 'unknown'
          ? { kind: 'quarantined', message: 'provider outcome is unknown' }
          : { kind: 'settled', disposition: request.disposition };
      },
    };
    const { runtime } = harness(port);
    const retirement = {
      sessionId: 's1',
      requestIdentity: 'close-settlement',
      reason: 'explicitClose' as const,
    };
    await expect(runtime.retire(retirement)).resolves.toMatchObject({ kind: 'retired' });

    const applied = { ...retirement, disposition: 'applied' as const };
    await expect(runtime.settleRetirement(applied)).resolves.toEqual({
      kind: 'settled',
      disposition: 'applied',
    });
    await expect(runtime.settleRetirement(applied)).resolves.toEqual({
      kind: 'settled',
      disposition: 'applied',
    });
    await expect(runtime.settleRetirement({
      ...retirement,
      disposition: 'unknown',
    })).resolves.toEqual({
      kind: 'quarantined',
      message: 'retirement settlement identity already belongs to different evidence',
    });
    expect(settlements).toBe(1);
  });

  it('fails closed when an Adapter reports an unknown backend observation', async () => {
    const port: SessionActivationPort = {
      begin: () => ({ kind: 'quarantined', message: 'backend probe unknown' }),
      execute: async () => undefined,
      resume: () => ({ kind: 'quarantined', message: 'unreachable' }),
      retire: () => ({ kind: 'retired', action: 'alreadyRetired' }),
      settleRetirement,
    };
    const { runtime } = harness(port);

    await expect(runtime.ensure({
      sessionId: 's1',
      requestIdentity: 'restore-1',
      goal: { kind: 'reconcile', cause: 'restore', observation: 'unknown' },
    })).resolves.toEqual({ kind: 'quarantined', message: 'backend probe unknown' });
  });
});
