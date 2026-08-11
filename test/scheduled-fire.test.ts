import { describe, expect, it } from 'vitest';

import {
  createDeadlineScheduledFireIdentity,
  createManualScheduledFireIdentity,
  scheduledRunId,
} from '../src/core/scheduled-fire.js';

describe('scheduled firing identity', () => {
  it('uses the logical deadline instead of the wall-clock tick time', () => {
    const identity = createDeadlineScheduledFireIdentity({
      scheduleId: 'daily:ops',
      definitionRevision: 7,
      scheduledFor: '2026-08-11T01:30:00.000Z',
    });

    expect(identity).toEqual({
      version: 1,
      kind: 'deadline',
      scheduleId: 'daily:ops',
      definitionRevision: 7,
      scheduledFor: '2026-08-11T01:30:00.000Z',
    });
    expect(scheduledRunId(identity)).toBe(
      'schedule-run:v1:deadline:daily%3Aops:7:2026-08-11T01%3A30%3A00.000Z',
    );
    expect(scheduledRunId(identity)).toBe(scheduledRunId({ ...identity }));
  });

  it('gives manual runs an explicit namespace that cannot alias a deadline', () => {
    const manual = createManualScheduledFireIdentity({
      scheduleId: 'daily:ops',
      definitionRevision: 7,
      manualRequestId: 'request:42',
    });

    expect(scheduledRunId(manual)).toBe(
      'schedule-run:v1:manual:daily%3Aops:7:request%3A42',
    );
    expect(scheduledRunId(manual)).not.toBe(scheduledRunId(
      createDeadlineScheduledFireIdentity({
        scheduleId: 'daily:ops',
        definitionRevision: 7,
        scheduledFor: 'request:42',
      }),
    ));
  });

  it('rejects malformed logical identities instead of minting unstable ids', () => {
    expect(() => createDeadlineScheduledFireIdentity({
      scheduleId: 'daily',
      definitionRevision: 0,
      scheduledFor: '2026-08-11T01:30:00.000Z',
    })).toThrow(/definition revision/i);
    expect(() => createDeadlineScheduledFireIdentity({
      scheduleId: 'daily',
      definitionRevision: 1,
      scheduledFor: 'not-a-timestamp',
    })).toThrow(/scheduledFor/i);
    expect(() => createManualScheduledFireIdentity({
      scheduleId: 'daily',
      definitionRevision: 1,
      manualRequestId: ' ',
    })).toThrow(/manual request/i);
    expect(() => scheduledRunId({
      version: 2,
      kind: 'manual',
      scheduleId: 'daily',
      definitionRevision: 1,
      manualRequestId: 'request',
    } as never)).toThrow(/version/i);
  });
});
