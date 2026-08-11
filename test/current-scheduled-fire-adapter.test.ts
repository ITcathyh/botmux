import { describe, expect, it, vi } from 'vitest';

import { createCurrentScheduledFireAdapter } from '../src/core/current-scheduled-fire.js';
import {
  createDeadlineScheduledFireIdentity,
  createScheduledFireEnvelope,
} from '../src/core/scheduled-fire.js';
import type { SessionRuntime } from '../src/core/session-runtime.js';
import type { ScheduledTask } from '../src/types.js';

function task(): ScheduledTask {
  return {
    id: 'daily', definitionRevision: 2, name: 'daily', schedule: 'every 30m',
    parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
    prompt: 'old definition', workingDir: '/work', chatId: 'oc_chat',
    scope: 'chat', executionPosition: 'top-level', larkAppId: 'cli_owner',
    enabled: true, createdAt: '2026-08-10T00:00:00.000Z',
  };
}

describe('Current scheduled route adapter', () => {
  it('linearizes against definition edits before any route or Session effect', async () => {
    const adapter = createCurrentScheduledFireAdapter({
      ownerLarkAppId: 'cli_owner',
      activeSessions: new Map(),
      refreshCliVersion: vi.fn(),
      readDefinitionRevision: () => 3,
    });
    const downstream: SessionRuntime = { submit: vi.fn() };
    const runtime = adapter.wrapRuntime({
      runtime: downstream,
      projection: { read: vi.fn() },
    });
    const fire = createScheduledFireEnvelope(createDeadlineScheduledFireIdentity({
      scheduleId: 'daily', definitionRevision: 2,
      scheduledFor: '2026-08-11T01:30:00.000Z',
    }), task());

    await expect(runtime.submit({
      target: { kind: 'route', route: { kind: 'schedule', runId: fire.runId } },
      idempotencyKey: fire.runId,
      command: { kind: 'scheduled.fire', input: fire },
    })).resolves.toMatchObject({
      kind: 'rejected', reason: 'definitionSuperseded',
    });
    expect(downstream.submit).not.toHaveBeenCalled();
  });
});
