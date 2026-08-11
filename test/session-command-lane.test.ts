import { describe, expect, it, vi } from 'vitest';
import {
  currentSessionCommandLane,
  currentSessionLaneAddress,
  currentSessionLaneAddressForKey,
} from '../src/core/current-session-command-lane.js';
import { createSessionCommandLaneHost } from '../src/core/session-command-lane.js';
import { parseBotId } from '../src/core/bot-identity.js';
import {
  createSessionExecutorRuntime,
  type ExecutorGenerationAuthority,
} from '../src/core/session-executor-runtime.js';
import {
  createSessionRuntimeHost,
  type KeyedTriggerAuthority,
  type KeyedTriggerTurnPort,
  type SessionAddress,
  type SessionDirectory,
} from '../src/core/session-runtime.js';
import type {
  SessionStore,
  SessionStoreVersion,
  StoredSessionState,
} from '../src/core/session-store.js';

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

const oneSessionDirectory: SessionDirectory = {
  async read() {
    return {
      kind: 'one',
      row: {
        key: 'session-1',
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
      },
    };
  },
};

describe('SessionCommandLane', () => {
  it('starts an idle head before submit returns', async () => {
    const host = createSessionCommandLaneHost();
    const address = host.addressFor('owner-a\0session-sync');
    let entered = false;

    const pending = host.lane.submit(address, () => {
      entered = true;
      return 'done';
    });

    expect(entered).toBe(true);
    await expect(pending).resolves.toBe('done');
  });

  it('drains re-entrant work for one logical Session in FIFO order', async () => {
    const host = createSessionCommandLaneHost();
    const { lane } = host;
    const address = host.addressFor('owner-a\0session-1');
    const order: string[] = [];
    let nested!: Promise<number>;

    const first = lane.submit(address, () => {
      order.push('first:start');
      nested = lane.submit(address, () => {
        order.push('second');
        return 2;
      });
      order.push('first:end');
      return 1;
    });

    await expect(first).resolves.toBe(1);
    await expect(nested).resolves.toBe(2);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('does not let a queued Session stall another logical Session', async () => {
    const host = createSessionCommandLaneHost();
    const { lane } = host;
    const firstAddress = host.addressFor('owner-a\0session-1');
    const secondAddress = host.addressFor('owner-a\0session-2');
    const order: string[] = [];
    let sameSession!: Promise<string>;
    let otherSession!: Promise<string>;

    const first = lane.submit(firstAddress, () => {
      order.push('s1:first');
      sameSession = lane.submit(firstAddress, () => {
        order.push('s1:second');
        return 'second';
      });
      otherSession = lane.submit(secondAddress, () => {
        order.push('s2:first');
        return 'other';
      });
      return 'first';
    });

    await expect(first).resolves.toBe('first');
    await expect(otherSession).resolves.toBe('other');
    await expect(sameSession).resolves.toBe('second');
    expect(order).toEqual(['s1:first', 's2:first', 's1:second']);
  });

  it('rejects a thenable reducer and continues draining later commands', async () => {
    const host = createSessionCommandLaneHost();
    const { lane } = host;
    const address = host.addressFor('owner-a\0session-1');
    const after = vi.fn(() => 'after');

    await expect(lane.submit(
      address,
      (() => Promise.resolve('not-short')) as () => string,
    )).rejects.toThrow('must be synchronous');

    await expect(lane.submit(address, after)).resolves.toBe('after');
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('does not poison a Session lane when one reducer throws', async () => {
    const host = createSessionCommandLaneHost();
    const { lane } = host;
    const address = host.addressFor('owner-a\0session-1');

    await expect(lane.submit(address, () => {
      throw new Error('transition failed');
    })).rejects.toThrow('transition failed');

    await expect(lane.submit(address, () => 'recovered')).resolves.toBe('recovered');
  });

  it('drains work queued by a reducer even when that reducer throws', async () => {
    const host = createSessionCommandLaneHost();
    const address = host.addressFor('owner-a\0session-throw-queue');
    let nested!: Promise<string>;

    const failed = host.lane.submit(address, () => {
      nested = host.lane.submit(address, () => 'nested survived');
      throw new Error('outer failed');
    });

    await expect(failed).rejects.toThrow('outer failed');
    await expect(nested).resolves.toBe('nested survived');
  });

  it('shares one FIFO address between Session commands and Executor reports', async () => {
    const laneHost = createSessionCommandLaneHost();
    const logicalSessionKey = 'owner-a\0session-1';
    const order: string[] = [];
    let report!: Promise<unknown>;
    let control!: Promise<unknown>;
    let session!: ReturnType<typeof createSessionRuntimeHost>;
    let sessionAddress!: SessionAddress;
    let storedState: StoredSessionState = {
      sessionId: 'session-1',
      route: { kind: 'thread', anchorId: 'om_root' },
      recordStatus: 'active',
      title: 'Before',
      executorGeneration: 1,
    };
    let storeVersion = Object.freeze({}) as SessionStoreVersion;
    const sessionStore: SessionStore = {
      load: () => ({ kind: 'loaded', state: storedState, version: storeVersion }),
      apply: ({ transition }) => {
        order.push('control:rename');
        storedState = {
          ...storedState,
          title: transition.title,
          titleUpdatedAt: transition.updatedAt,
          titleSource: transition.source,
        };
        storeVersion = Object.freeze({}) as SessionStoreVersion;
        return { kind: 'applied', state: storedState, nextVersion: storeVersion };
      },
    };
    const authority: ExecutorGenerationAuthority = {
      sessionKey: logicalSessionKey,
      sessionId: 'session-1',
      commitNext: () => ({
        token: Object.freeze({}),
        generation: 1,
      }),
      owns: () => true,
      fenceExit: () => ({ kind: 'fenced', generation: 2 }),
    };
    const executor = createSessionExecutorRuntime({
      commandLane: laneHost.lane,
      laneAddressForSessionKey: laneHost.addressFor,
    });
    const lease = executor.activate(executor.commitGeneration(authority), {});
    session = createSessionRuntimeHost({
      directory: oneSessionDirectory,
      keyedTriggers: unusedKeyedAuthority,
      keyedTriggerTurns: unusedKeyedTurns,
      sessionStore,
      commandLane: laneHost.lane,
      sessionLaneAddress: sessionId => laneHost.addressFor(`owner-a\0${sessionId}`),
      ordinaryIngress: {
        begin: () => {
          order.push('ordinary:start');
          control = session.runtime.submit({
            target: { kind: 'session', address: sessionAddress },
            idempotencyKey: 'control-1',
            command: {
              kind: 'control.rename',
              input: {
                title: 'After',
                updatedAt: '2026-08-10T00:00:00.000Z',
                source: 'user',
              },
            },
          });
          report = executor.report(
            lease,
            { kind: 'inputReceived', turnId: 'turn-1' },
            decision => {
              order.push(`report:${decision.kind}`);
              return decision;
            },
          );
          order.push('ordinary:end');
          return { kind: 'committed' };
        },
        execute: async () => { throw new Error('no ordinary effect expected'); },
        resume: () => { throw new Error('no ordinary continuation expected'); },
      },
    });
    const projected = await session.projection.read({
      kind: 'byExternalSession',
      sessionId: 'session-1',
    });
    if (projected.kind !== 'one') throw new Error('expected projected Session');
    sessionAddress = projected.session.address;

    await expect(session.runtime.submit({
      target: { kind: 'session', address: projected.session.address },
      idempotencyKey: 'ordinary-1',
      command: {
        kind: 'ordinary.ingress',
        input: {
          turn: {
            route: {
              scope: 'thread',
              canonicalAnchor: 'om_root',
              chatId: 'oc_chat',
              chatType: 'group',
            },
            source: 'lark.im',
            messageKey: 'ordinary-1',
            content: 'hello',
            sender: { kind: 'human', openId: 'ou_sender' },
            mentions: [],
            postParticipantMentions: [],
            resources: [],
            foldedForwardContext: false,
            vc: { contextMayLag: false },
          },
        },
      },
    })).resolves.toMatchObject({ kind: 'applied' });
    await expect(control).resolves.toMatchObject({ kind: 'applied', action: 'control.renamed' });
    await expect(report).resolves.toMatchObject({ kind: 'current' });
    expect(order).toEqual([
      'ordinary:start',
      'ordinary:end',
      'control:rename',
      'report:current',
    ]);
  });

  it('binds Current Session and Executor modules to one behavioral owner/epoch lane', async () => {
    const ownerA = parseBotId('bot_lane_owner_a');
    const ownerB = parseBotId('bot_lane_owner_b');
    const sessionAddress = currentSessionLaneAddress('boot-binding', ownerA, 'session-1');
    const executorAddress = currentSessionLaneAddressForKey(
      'boot-binding',
      `${ownerA}\0session-1`,
    );
    const foreignOwner = currentSessionLaneAddress('boot-binding', ownerB, 'session-1');
    const foreignEpoch = currentSessionLaneAddress('boot-binding-2', ownerA, 'session-1');
    expect(sessionAddress).toBe(executorAddress);
    expect(sessionAddress).not.toBe(foreignOwner);
    expect(sessionAddress).not.toBe(foreignEpoch);

    const order: string[] = [];
    let sameSession!: Promise<string>;
    let otherOwner!: Promise<string>;
    const first = currentSessionCommandLane.submit(sessionAddress, () => {
      order.push('current:first');
      sameSession = currentSessionCommandLane.submit(executorAddress, () => {
        order.push('current:same-session');
        return 'same';
      });
      otherOwner = currentSessionCommandLane.submit(foreignOwner, () => {
        order.push('current:other-owner');
        return 'other';
      });
      return 'first';
    });

    await expect(first).resolves.toBe('first');
    await expect(sameSession).resolves.toBe('same');
    await expect(otherOwner).resolves.toBe('other');
    expect(order).toEqual([
      'current:first',
      'current:other-owner',
      'current:same-session',
    ]);
  });
});
