import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledTask } from '../src/types.js';

const task: ScheduledTask = {
  id: 'daily:ops',
  definitionRevision: 3,
  name: 'ops',
  schedule: 'every 30m',
  parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
  prompt: 'check services',
  workingDir: '/workspace',
  chatId: 'oc_chat',
  scope: 'chat',
  executionPosition: 'top-level',
  larkAppId: 'cli_owner',
  enabled: true,
  createdAt: '2026-08-10T00:00:00.000Z',
  nextRunAt: '2026-08-11T01:29:00.000Z',
};

const updateTask = vi.fn((id: string, patch: Partial<ScheduledTask>) => {
  if (id === task.id) Object.assign(task, patch);
});
const markRun = vi.fn<(...args: unknown[]) => 'applied' | 'superseded' | 'missing'>(() => 'applied');
const publish = vi.fn();
const emitHookEvent = vi.fn();

vi.mock('../src/services/schedule-store.js', () => ({
  listTasks: vi.fn(() => [task]),
  getTask: vi.fn((id: string) => id === task.id ? task : undefined),
  updateTask: (...args: unknown[]) => updateTask(...args as [string, Partial<ScheduledTask>]),
  markRun: (...args: unknown[]) => markRun(...args),
}));
vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: (...args: unknown[]) => publish(...args) },
}));
vi.mock('../src/services/hook-runner.js', () => ({
  emitHookEvent: (...args: unknown[]) => emitHookEvent(...args),
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-11T01:30:00.000Z'));
  task.definitionRevision = 3;
  task.nextRunAt = '2026-08-11T01:29:00.000Z';
  task.lastRunAt = undefined;
  task.lastStatus = undefined;
  task.pendingManualRun = undefined;
  updateTask.mockClear();
  markRun.mockClear();
  markRun.mockImplementation(() => 'applied');
  publish.mockClear();
  emitHookEvent.mockClear();
});

afterEach(async () => {
  const scheduler = await import('../src/core/scheduler.js');
  scheduler.stopScheduler();
  scheduler.setSubmitCallback(null);
  vi.useRealTimers();
});

describe('scheduler firing producer', () => {
  it('submits the original logical due and stable run id unchanged', async () => {
    const scheduler = await import('../src/core/scheduler.js');
    const submit = vi.fn(async () => ({
      kind: 'applied' as const,
      sessionId: 'session-1',
    }));
    scheduler.setSubmitCallback(submit);
    scheduler.setOwnerFilter('cli_owner', true);

    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(submit).toHaveBeenCalledTimes(1);
    const fire = submit.mock.calls[0][0];
    expect(fire.identity).toEqual({
      version: 1,
      kind: 'deadline',
      scheduleId: 'daily:ops',
      definitionRevision: 3,
      scheduledFor: '2026-08-11T01:29:00.000Z',
    });
    expect(fire.runId).toBe(
      'schedule-run:v1:deadline:daily%3Aops:3:2026-08-11T01%3A29%3A00.000Z',
    );
    expect(markRun).toHaveBeenCalledWith('daily:ops', true, undefined, undefined, 3);
  });

  it('uses an explicit manual identity and does not settle a duplicate twice', async () => {
    const scheduler = await import('../src/core/scheduler.js');
    const submit = vi.fn(async () => ({
      kind: 'duplicate' as const,
      state: 'inputAccepted' as const,
      sessionId: 'session-1',
    }));
    scheduler.setSubmitCallback(submit);

    expect(scheduler.runNow(task.id)).toEqual({ ok: true });
    await vi.runAllTicks();
    await Promise.resolve();

    expect(submit).toHaveBeenCalledTimes(1);
    const fire = submit.mock.calls[0][0];
    expect(fire.identity).toMatchObject({
      version: 1,
      kind: 'manual',
      scheduleId: task.id,
      definitionRevision: 3,
    });
    expect(fire.runId).toMatch(/^schedule-run:v1:manual:daily%3Aops:3:/);
    expect(markRun).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'schedule.fired',
    }));
  });

  it('persists an offline manual identity and consumes it without aliasing the due deadline', async () => {
    const scheduler = await import('../src/core/scheduler.js');
    scheduler.setSubmitCallback(null);

    expect(scheduler.runTaskNow(task.id)).toBe(true);
    expect(task.pendingManualRun).toMatchObject({
      version: 1,
      definitionRevision: 3,
    });
    const manualRequestId = task.pendingManualRun!.manualRequestId;
    expect(task.nextRunAt).toBe('2026-08-11T01:29:00.000Z');

    const submit = vi.fn(async () => ({
      kind: 'applied' as const,
      sessionId: 'session-manual',
    }));
    scheduler.setSubmitCallback(submit);
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({
      identity: {
        version: 1,
        kind: 'manual',
        scheduleId: task.id,
        definitionRevision: 3,
        manualRequestId,
      },
    });
    expect(task.pendingManualRun).toBeUndefined();
  });

  it('cancels an offline manual request when an edit wins the definition fence', async () => {
    const scheduler = await import('../src/core/scheduler.js');
    task.pendingManualRun = {
      version: 1,
      manualRequestId: 'manual-before-edit',
      definitionRevision: 2,
      requestedAt: '2026-08-11T01:20:00.000Z',
    };
    const submit = vi.fn(async () => ({
      kind: 'applied' as const,
      sessionId: 'should-not-run',
    }));
    scheduler.setSubmitCallback(submit);
    scheduler.setOwnerFilter('cli_owner', true);

    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(submit).not.toHaveBeenCalled();
    expect(task.pendingManualRun).toBeUndefined();
    expect(publish).toHaveBeenCalledWith({
      type: 'schedule.fired',
      body: expect.objectContaining({
        id: task.id,
        status: 'error',
        error: 'definition_superseded',
      }),
    });
    expect(markRun).not.toHaveBeenCalled();
  });

  it('suppresses the fired event and hook when the store fences the settlement as superseded', async () => {
    const scheduler = await import('../src/core/scheduler.js');
    // The task was edited while its fire was in flight: markRun's
    // definitionRevision fence refuses to write anything.
    markRun.mockImplementation(() => 'superseded');
    const submit = vi.fn(async () => ({
      kind: 'applied' as const,
      sessionId: 'session-superseded',
    }));
    scheduler.setSubmitCallback(submit);
    scheduler.setOwnerFilter('cli_owner', true);

    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(markRun).toHaveBeenCalledWith('daily:ops', true, undefined, undefined, 3);
    // The store recorded nothing, so nothing may become observable: no
    // schedule.fired ledger entry, no hook emission.
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'schedule.fired',
    }));
    expect(emitHookEvent).not.toHaveBeenCalledWith('schedule.fired', expect.anything());
  });
});
