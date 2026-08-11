import { describe, expect, it, vi } from 'vitest';

import {
  createSessionRuntimeHost,
  type KeyedTriggerAuthority,
  type KeyedTriggerTurnPort,
  type ScheduledFirePort,
  type SessionDirectory,
} from '../src/core/session-runtime.js';
import {
  createDeadlineScheduledFireIdentity,
  createScheduledFireEnvelope,
} from '../src/core/scheduled-fire.js';
import type { ScheduledTask } from '../src/types.js';

const directory: SessionDirectory = {
  async read(query) {
    if (query.kind === 'list') return { kind: 'list', rows: [] };
    if (query.kind === 'byExternalSession' && query.sessionId !== 'session-1') {
      return { kind: 'notFound' };
    }
    if (query.kind === 'byRoute'
        && (query.route.kind !== 'thread' || query.route.anchorId !== 'om_root')) {
      return { kind: 'notFound' };
    }
    return {
      kind: 'one',
      row: {
        key: 'session-1',
        sessionId: 'session-1',
        route: { kind: 'thread', anchorId: 'om_root' },
        ordinaryIngressBinding: {
          scope: 'thread', canonicalAnchor: 'om_root', chatId: 'oc_chat', chatType: 'group',
        },
        recordStatus: 'active',
        executorStatus: 'idle',
      },
    };
  },
};

const keyedTriggers: KeyedTriggerAuthority = {
  inspect: key => ({ kind: 'absent', token: key }),
  reserve: () => ({ kind: 'retryable', message: 'unused' }),
  begin: () => ({ kind: 'retryable', message: 'unused' }),
  settleDispatchUnknown: () => ({ kind: 'failed' }),
};

const keyedTriggerTurns: KeyedTriggerTurnPort = {
  prepare: () => ({ kind: 'retryable', message: 'unused' }),
  acceptAtMostOnce: () => ({ kind: 'refused', message: 'unused' }),
  failClose: async () => ({ kind: 'closed' }),
};

function task(): ScheduledTask {
  return {
    id: 'daily', definitionRevision: 2, name: 'daily', schedule: 'every 30m',
    parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
    prompt: 'check', workingDir: '/work', chatId: 'oc_chat', rootMessageId: 'om_root',
    scope: 'thread', executionPosition: 'topic', larkAppId: 'cli_owner',
    enabled: true, createdAt: '2026-08-10T00:00:00.000Z',
  };
}

function fire() {
  return createScheduledFireEnvelope(createDeadlineScheduledFireIdentity({
    scheduleId: 'daily',
    definitionRevision: 2,
    scheduledFor: '2026-08-11T01:30:00.000Z',
  }), task());
}

describe('SessionRuntime scheduled.fire', () => {
  it('joins duplicate submissions and crosses the effect barrier only once', async () => {
    let release!: () => void;
    const effect = new Promise<void>((resolve) => { release = resolve; });
    const port: ScheduledFirePort = {
      begin: vi.fn(() => ({ kind: 'effect', intent: {}, continuation: {} })),
      execute: vi.fn(async () => { await effect; return { accepted: true }; }),
      resume: vi.fn(() => ({ kind: 'committed' })),
    };
    const host = createSessionRuntimeHost({
      directory, keyedTriggers, keyedTriggerTurns, scheduledFire: port,
    });
    const projected = await host.projection.read({
      kind: 'byRoute', route: { kind: 'thread', anchorId: 'om_root' },
    });
    if (projected.kind !== 'one') throw new Error('expected Session');
    const envelope = fire();
    const request = {
      target: { kind: 'session' as const, address: projected.session.address },
      idempotencyKey: envelope.runId,
      command: { kind: 'scheduled.fire' as const, input: envelope },
    };

    const first = host.runtime.submit(request);
    const duplicate = host.runtime.submit(request);
    await vi.waitFor(() => expect(port.execute).toHaveBeenCalledTimes(1));
    release();

    await expect(first).resolves.toMatchObject({
      kind: 'applied',
      action: 'scheduled.inputAccepted',
      policy: 'scheduled-process-local',
      durability: 'processLocal',
      sessionId: 'session-1',
    });
    await expect(duplicate).resolves.toMatchObject({
      kind: 'duplicate', state: 'inputAccepted', sessionId: 'session-1',
    });
    expect(port.begin).toHaveBeenCalledTimes(1);
    expect(port.execute).toHaveBeenCalledTimes(1);
    expect(port.resume).toHaveBeenCalledTimes(1);
  });

  it('rejects a transport key that differs from the unchanged logical run id', async () => {
    const port: ScheduledFirePort = {
      begin: vi.fn(() => ({ kind: 'committed' })),
      execute: vi.fn(),
      resume: vi.fn(() => ({ kind: 'committed' })),
    };
    const host = createSessionRuntimeHost({
      directory, keyedTriggers, keyedTriggerTurns, scheduledFire: port,
    });
    const projected = await host.projection.read({
      kind: 'byRoute', route: { kind: 'thread', anchorId: 'om_root' },
    });
    if (projected.kind !== 'one') throw new Error('expected Session');

    await expect(host.runtime.submit({
      target: { kind: 'session', address: projected.session.address },
      idempotencyKey: 'different',
      command: { kind: 'scheduled.fire', input: fire() },
    })).resolves.toMatchObject({
      kind: 'rejected', reason: 'invalidCommand',
    });
    expect(port.begin).not.toHaveBeenCalled();
  });
});
