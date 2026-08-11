import type { ScheduledTask } from '../types.js';

export interface DeadlineScheduledFireIdentity {
  readonly version: 1;
  readonly kind: 'deadline';
  readonly scheduleId: string;
  readonly definitionRevision: number;
  readonly scheduledFor: string;
}

export interface ManualScheduledFireIdentity {
  readonly version: 1;
  readonly kind: 'manual';
  readonly scheduleId: string;
  readonly definitionRevision: number;
  readonly manualRequestId: string;
}

export type ScheduledFireIdentity =
  | DeadlineScheduledFireIdentity
  | ManualScheduledFireIdentity;

export type ScheduledTaskBusinessSnapshot = Readonly<Pick<ScheduledTask,
  | 'id'
  | 'name'
  | 'schedule'
  | 'parsed'
  | 'prompt'
  | 'workingDir'
  | 'chatId'
  | 'rootMessageId'
  | 'chatType'
  | 'scope'
  | 'executionPosition'
  | 'topicTitle'
  | 'larkAppId'
  | 'creatorChatId'
  | 'creatorRootMessageId'
  | 'creatorLarkAppId'
  | 'deliver'
  | 'silent'
>>;

export interface ScheduledFireEnvelope {
  readonly runId: string;
  readonly identity: ScheduledFireIdentity;
  readonly task: ScheduledTaskBusinessSnapshot;
}

/** Target-A submission result. `applied` is only a process-local Executor
 * hand-off; it is deliberately not a durable firing settlement receipt. */
export type ScheduledFireSubmitOutcome =
  | { readonly kind: 'applied'; readonly sessionId: string }
  | {
      readonly kind: 'duplicate';
      readonly state: 'inFlight' | 'inputAccepted';
      readonly sessionId: string;
    }
  | { readonly kind: 'rejected'; readonly message: string }
  | { readonly kind: 'retryable'; readonly message: string }
  | { readonly kind: 'ambiguous'; readonly message: string }
  | { readonly kind: 'quarantined'; readonly message: string };

function nonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be blank`);
  return value;
}

function revision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('definition revision must be a positive safe integer');
  }
  return value;
}

export function createDeadlineScheduledFireIdentity(input: {
  readonly scheduleId: string;
  readonly definitionRevision: number;
  readonly scheduledFor: string;
}): DeadlineScheduledFireIdentity {
  const scheduledFor = nonEmpty(input.scheduledFor, 'scheduledFor');
  if (!Number.isFinite(Date.parse(scheduledFor))) {
    throw new Error('scheduledFor must be a valid timestamp');
  }
  return Object.freeze({
    version: 1,
    kind: 'deadline',
    scheduleId: nonEmpty(input.scheduleId, 'schedule id'),
    definitionRevision: revision(input.definitionRevision),
    scheduledFor,
  });
}

export function createManualScheduledFireIdentity(input: {
  readonly scheduleId: string;
  readonly definitionRevision: number;
  readonly manualRequestId: string;
}): ManualScheduledFireIdentity {
  return Object.freeze({
    version: 1,
    kind: 'manual',
    scheduleId: nonEmpty(input.scheduleId, 'schedule id'),
    definitionRevision: revision(input.definitionRevision),
    manualRequestId: nonEmpty(input.manualRequestId, 'manual request id'),
  });
}

export function scheduledRunId(identity: ScheduledFireIdentity): string {
  if (!identity || typeof identity !== 'object' || identity.version !== 1) {
    throw new Error('scheduled identity version must be 1');
  }
  const normalized = identity.kind === 'deadline'
    ? createDeadlineScheduledFireIdentity(identity)
    : identity.kind === 'manual'
      ? createManualScheduledFireIdentity(identity)
      : undefined;
  if (!normalized) throw new Error('scheduled identity kind is invalid');
  const prefix = `schedule-run:v1:${normalized.kind}:${encodeURIComponent(normalized.scheduleId)}`
    + `:${normalized.definitionRevision}:`;
  return prefix + encodeURIComponent(
    normalized.kind === 'deadline' ? normalized.scheduledFor : normalized.manualRequestId,
  );
}

export function snapshotScheduledTask(task: ScheduledTask): ScheduledTaskBusinessSnapshot {
  return Object.freeze({
    id: task.id,
    name: task.name,
    schedule: task.schedule,
    parsed: Object.freeze({ ...task.parsed }),
    prompt: task.prompt,
    workingDir: task.workingDir,
    chatId: task.chatId,
    rootMessageId: task.rootMessageId,
    chatType: task.chatType,
    scope: task.scope,
    executionPosition: task.executionPosition,
    topicTitle: task.topicTitle,
    larkAppId: task.larkAppId,
    creatorChatId: task.creatorChatId,
    creatorRootMessageId: task.creatorRootMessageId,
    creatorLarkAppId: task.creatorLarkAppId,
    deliver: task.deliver,
    silent: task.silent,
  });
}

export function createScheduledFireEnvelope(
  identity: ScheduledFireIdentity,
  task: ScheduledTask,
): ScheduledFireEnvelope {
  return Object.freeze({
    runId: scheduledRunId(identity),
    identity,
    task: snapshotScheduledTask(task),
  });
}
