import { describe, expect, it, vi } from 'vitest';

import {
  createSessionRuntimeHost,
  type ControlMutationPort,
  type KeyedTriggerAuthority,
  type KeyedTriggerTurnPort,
  type OrdinaryIngressPort,
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

const twoSessionDirectory: SessionDirectory = {
  async read(query) {
    const rows = ['session-1', 'session-2'].map((sessionId, index) => ({
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
      executorStatus: 'idle' as const,
    }));
    if (query.kind === 'list') return { kind: 'list' as const, rows };
    if (query.kind === 'dashboardSnapshot') {
      throw new Error('dashboard snapshot is not used by this test');
    }
    const row = query.kind === 'byExternalSession'
      ? rows.find(candidate => candidate.sessionId === query.sessionId)
      : rows.find(candidate => (
          query.route.kind === 'thread'
          && candidate.route.anchorId === query.route.anchorId
        ));
    return row ? { kind: 'one' as const, row } : { kind: 'notFound' as const };
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

function fireFor(sessionNumber: 1 | 2, suffix: string) {
  const scheduledTask = {
    ...task(),
    id: `daily-${suffix}`,
    chatId: `oc_chat_${sessionNumber}`,
    rootMessageId: `om_root_${sessionNumber}`,
  };
  return createScheduledFireEnvelope(createDeadlineScheduledFireIdentity({
    scheduleId: scheduledTask.id,
    definitionRevision: 2,
    scheduledFor: '2026-08-11T01:30:00.000Z',
  }), scheduledTask);
}

function ordinaryFor(sessionNumber: 1 | 2, messageKey: string) {
  return {
    route: {
      scope: 'thread' as const,
      canonicalAnchor: `om_root_${sessionNumber}`,
      chatId: `oc_chat_${sessionNumber}`,
      chatType: 'group' as const,
    },
    source: 'lark.im' as const,
    messageKey,
    content: 'after schedule',
    sender: { kind: 'human' as const, openId: 'ou_sender' },
    mentions: [],
    postParticipantMentions: [],
    resources: [],
    foldedForwardContext: false,
    vc: { contextMayLag: false },
  };
}

async function addressFor(host: ReturnType<typeof createSessionRuntimeHost>) {
  const projected = await host.projection.read({
    kind: 'byExternalSession', sessionId: 'session-1',
  });
  if (projected.kind !== 'one') throw new Error('expected Session');
  return projected.session.address;
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

  it('orders scheduled effect then control then ordinary on one Session without blocking another Session', async () => {
    const events: string[] = [];
    let releaseScheduled!: () => void;
    const scheduledGate = new Promise<void>((resolve) => { releaseScheduled = resolve; });
    const scheduledPort: ScheduledFirePort = {
      begin: ({ sessionId }) => {
        events.push(`scheduled:${sessionId}:begin`);
        return { kind: 'effect', intent: sessionId, continuation: sessionId };
      },
      execute: async (intent) => {
        const sessionId = String(intent);
        events.push(`scheduled:${sessionId}:execute`);
        if (sessionId === 'session-1') await scheduledGate;
        return { accepted: true };
      },
      resume: (continuation) => {
        events.push(`scheduled:${String(continuation)}:resume`);
        return { kind: 'committed' };
      },
    };
    const controlBegin = vi.fn<ControlMutationPort['begin']>(({ sessionId }) => {
      events.push(`control:${sessionId}:begin`);
      return {
        kind: 'committed',
        result: { kind: 'lockUpdated', locked: true },
      };
    });
    const controlPort: ControlMutationPort = {
      begin: controlBegin,
      execute: async () => { throw new Error('control effect is not expected'); },
      resume: () => ({ kind: 'unknown', message: 'control continuation is not expected' }),
    };
    const ordinaryPort: OrdinaryIngressPort = {
      begin: ({ sessionId }) => {
        events.push(`ordinary:${sessionId}:begin`);
        return { kind: 'committed' };
      },
      execute: async () => { throw new Error('ordinary effect is not expected'); },
      resume: () => ({ kind: 'unknown', message: 'ordinary continuation is not expected' }),
    };
    const host = createSessionRuntimeHost({
      directory: twoSessionDirectory,
      keyedTriggers,
      keyedTriggerTurns,
      scheduledFire: scheduledPort,
      controlMutation: controlPort,
      ordinaryIngress: ordinaryPort,
    });
    const first = await host.projection.read({
      kind: 'byExternalSession', sessionId: 'session-1',
    });
    const second = await host.projection.read({
      kind: 'byExternalSession', sessionId: 'session-2',
    });
    if (first.kind !== 'one' || second.kind !== 'one') throw new Error('expected Sessions');
    const scheduled = fireFor(1, 'ordered');
    const scheduledResult = host.runtime.submit({
      target: { kind: 'session', address: first.session.address },
      idempotencyKey: scheduled.runId,
      command: { kind: 'scheduled.fire', input: scheduled },
    });
    await vi.waitFor(() => expect(events).toContain('scheduled:session-1:execute'));

    const controlResult = host.runtime.submit({
      target: { kind: 'session', address: first.session.address },
      idempotencyKey: 'control-after-scheduled',
      command: { kind: 'control.mutate', input: { kind: 'setLocked', locked: true } },
    });
    const ordinaryResult = host.runtime.submit({
      target: { kind: 'session', address: first.session.address },
      idempotencyKey: 'ordinary-after-control',
      command: {
        kind: 'ordinary.ingress',
        input: { turn: ordinaryFor(1, 'ordinary-after-control') },
      },
    });
    const otherSessionControl = host.runtime.submit({
      target: { kind: 'session', address: second.session.address },
      idempotencyKey: 'other-session-control',
      command: { kind: 'control.mutate', input: { kind: 'setLocked', locked: true } },
    });

    await expect(otherSessionControl).resolves.toMatchObject({
      kind: 'applied', sessionId: 'session-2',
    });
    expect(events).not.toContain('control:session-1:begin');
    expect(events).not.toContain('ordinary:session-1:begin');

    releaseScheduled();
    await expect(scheduledResult).resolves.toMatchObject({ kind: 'applied' });
    await expect(controlResult).resolves.toMatchObject({ kind: 'applied' });
    await expect(ordinaryResult).resolves.toMatchObject({ kind: 'applied' });
    expect(events.indexOf('scheduled:session-1:resume'))
      .toBeLessThan(events.indexOf('control:session-1:begin'));
    expect(events.indexOf('control:session-1:begin'))
      .toBeLessThan(events.indexOf('ordinary:session-1:begin'));
  });

  it('keeps an unknown control as a sticky barrier for later scheduled input', async () => {
    const controlExecute = vi.fn(async () => ({ maybeApplied: true }));
    const scheduledBegin = vi.fn<ScheduledFirePort['begin']>(() => ({ kind: 'committed' }));
    const host = createSessionRuntimeHost({
      directory,
      keyedTriggers,
      keyedTriggerTurns,
      scheduledFire: {
        begin: scheduledBegin,
        execute: async () => ({ accepted: true }),
        resume: () => ({ kind: 'committed' }),
      },
      controlMutation: {
        begin: ({ command }) => ({ kind: 'effect', intent: command, continuation: command }),
        execute: controlExecute,
        resume: () => ({ kind: 'unknown', message: 'control publication is unknown' }),
      },
    });
    const address = await addressFor(host);

    await expect(host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'control-unknown-before-schedule',
      command: { kind: 'control.mutate', input: { kind: 'setLocked', locked: true } },
    })).resolves.toMatchObject({ kind: 'ambiguous' });
    const scheduled = fire();
    await expect(host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: scheduled.runId,
      command: { kind: 'scheduled.fire', input: scheduled },
    })).resolves.toMatchObject({
      kind: 'quarantined',
      message: expect.stringContaining('unreconciled control mutation'),
    });
    expect(controlExecute).toHaveBeenCalledOnce();
    expect(scheduledBegin).not.toHaveBeenCalled();
  });

  it('settles an unknown scheduled effect and lets a later control continue', async () => {
    const scheduledExecute = vi.fn(async () => ({ maybeAccepted: true }));
    const controlBegin = vi.fn<ControlMutationPort['begin']>(() => ({
      kind: 'committed',
      result: { kind: 'lockUpdated', locked: true },
    }));
    const host = createSessionRuntimeHost({
      directory,
      keyedTriggers,
      keyedTriggerTurns,
      scheduledFire: {
        begin: () => ({ kind: 'effect', intent: {}, continuation: {} }),
        execute: scheduledExecute,
        resume: () => ({ kind: 'unknown', message: 'scheduled dispatch is unknown' }),
      },
      controlMutation: {
        begin: controlBegin,
        execute: async () => { throw new Error('control effect is not expected'); },
        resume: () => ({ kind: 'unknown', message: 'control continuation is not expected' }),
      },
    });
    const address = await addressFor(host);
    const scheduled = fire();
    const request = {
      target: { kind: 'session' as const, address },
      idempotencyKey: scheduled.runId,
      command: { kind: 'scheduled.fire' as const, input: scheduled },
    };

    await expect(host.runtime.submit(request)).resolves.toMatchObject({
      kind: 'ambiguous', idempotent: false,
    });
    await expect(host.runtime.submit({
      target: { kind: 'session', address },
      idempotencyKey: 'control-after-scheduled-unknown',
      command: { kind: 'control.mutate', input: { kind: 'setLocked', locked: true } },
    })).resolves.toMatchObject({ kind: 'applied' });
    await expect(host.runtime.submit(request)).resolves.toMatchObject({
      kind: 'ambiguous', idempotent: true,
    });
    expect(scheduledExecute).toHaveBeenCalledOnce();
    expect(controlBegin).toHaveBeenCalledOnce();
  });
});
