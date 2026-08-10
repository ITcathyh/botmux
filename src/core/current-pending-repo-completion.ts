import { randomUUID } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

import type { CliTurnPayload, Session } from '../types.js';
import * as sessionStore from '../services/session-store.js';
import {
  type PendingRepoCompletionEffectSettlement,
  type PendingRepoCompletionPort,
  type PendingRepoCompletionSelection,
  type PendingRepoCompletionTransitionResult,
} from './session-runtime.js';
import { publishAttentionPatch } from './session-activity.js';
import { activeSessionKey, markRepoCardConsumed, type DaemonSession } from './types.js';

export type {
  PendingRepoCompletionSelection as CurrentPendingRepoCompletionSelection,
} from './session-runtime.js';

export interface CurrentPendingRepoOpeningSnapshot {
  readonly prompt: string;
  readonly cliInput?: CliTurnPayload;
  readonly rawInput?: string;
  readonly rawTurnId?: string;
  readonly turnId?: string;
  readonly codexAppText?: string;
  readonly codexAppApplicationContext?: string;
  readonly codexAppMessageContext?: string;
  readonly chatContext?: DaemonSession['pendingChatContext'];
  readonly attachments?: DaemonSession['pendingAttachments'];
  readonly mentions?: DaemonSession['pendingMentions'];
  readonly substituteTrigger?: DaemonSession['pendingSubstituteTrigger'];
  readonly sender?: DaemonSession['pendingSender'];
  readonly followUps?: readonly string[];
  readonly followUpTurnIds?: readonly string[];
  readonly codexAppFollowUps?: readonly string[];
  readonly codexAppFollowUpContexts?: readonly string[];
  readonly codexAppFollowUpGateAccepted?: readonly boolean[];
  /** Synchronously frozen before materialization crosses its first await. */
  readonly whiteboardBlock?: string;
}

export interface CurrentPendingRepoCompletionPreMaterializationInput {
  readonly sessionId: string;
  readonly selection: PendingRepoCompletionSelection;
  readonly hasFrozenCliInput: boolean;
  readonly hasRawInput: boolean;
  /** Raw mode ignores the frozen opening and will rebuild a buffered successor. */
  readonly rawWillBuildFollowUp: boolean;
}

export interface CurrentPendingRepoCompletionPreMaterializationModule {
  /** Runs inside the Session lane and must return synchronously. */
  apply(
    current: DaemonSession,
    input: CurrentPendingRepoCompletionPreMaterializationInput,
  ):
    | { readonly kind: 'ready'; readonly whiteboardBlock?: string }
    | { readonly kind: 'refused'; readonly message: string };
}

export interface CurrentPendingRepoCompletionMaterializeInput {
  readonly sessionId: string;
  readonly claimToken: string;
  readonly selection: PendingRepoCompletionSelection;
  readonly opening: CurrentPendingRepoOpeningSnapshot;
}

export interface CurrentPendingRepoCompletionMaterial {
  readonly sessionId: string;
  /** Opaque composition-local identity for the exact retained dispatch plan. */
  readonly dispatchPlanId?: string;
  readonly workingDir: string;
  readonly userPrompt: string;
  readonly cliInput: CliTurnPayload;
  readonly turnId: string;
  readonly resume: boolean;
  readonly riffRepoDirs?: readonly string[];
  /** Ordered, detached evidence for cleanup if a sync worker start proves refusal. */
  readonly worktrees?: readonly CurrentPendingRepoWorktreeCleanupTarget[];
}

export interface CurrentPendingRepoWorktreeCleanupTarget {
  readonly sourcePath: string;
  readonly path: string;
}

export type CurrentPendingRepoCompletionMaterializeResult =
  | {
      readonly kind: 'materialized';
      readonly material: CurrentPendingRepoCompletionMaterial;
    }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

export type CurrentPendingRepoWorkerCommand = {
  readonly kind: 'forkFirstStart';
  readonly sessionId: string;
  readonly claimToken: string;
  readonly dispatchPlanId?: string;
  readonly workingDir: string;
  readonly input: CliTurnPayload;
  readonly turnId: string;
  readonly resume: boolean;
  readonly riffRepoDirs?: readonly string[];
  readonly worktrees?: readonly CurrentPendingRepoWorktreeCleanupTarget[];
};

export type CurrentPendingRepoWorkerResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'refused'; readonly message?: string }
  | { readonly kind: 'unknown'; readonly message: string };

export type CurrentPendingRepoWorktreeCleanupResult =
  | { readonly kind: 'cleaned' }
  | { readonly kind: 'unknown'; readonly message: string };

/** Exact production evidence that a known-worktree cleanup response was lost. */
export class CurrentPendingRepoCleanupOutcomeUnknownError extends Error {}

function isCleanupOutcomeUnknown(
  error: unknown,
): error is CurrentPendingRepoCleanupOutcomeUnknownError {
  try {
    return error instanceof CurrentPendingRepoCleanupOutcomeUnknownError;
  } catch {
    return false;
  }
}

export interface CurrentPendingRepoCompletionOptions {
  readonly ownerLarkAppId: string;
  readonly activeSessions: Map<string, DaemonSession>;
  readonly preMaterialization?: CurrentPendingRepoCompletionPreMaterializationModule;
  readonly materialize: (
    input: CurrentPendingRepoCompletionMaterializeInput,
  ) => Promise<CurrentPendingRepoCompletionMaterializeResult>;
  readonly dispatchWorker: (
    command: CurrentPendingRepoWorkerCommand,
  ) => CurrentPendingRepoWorkerResult;
  readonly cleanupWorktrees?: (input: {
    readonly sessionId: string;
    readonly claimToken: string;
    readonly dispatchPlanId?: string;
    readonly worktrees: readonly CurrentPendingRepoWorktreeCleanupTarget[];
  }) => Promise<CurrentPendingRepoWorktreeCleanupResult>;
}

interface PendingAttempt {
  readonly id: number;
  readonly claimToken: string;
  readonly sessionId: string;
  readonly key: string;
  readonly ds: DaemonSession;
  readonly session: Session;
  readonly selection: PendingRepoCompletionSelection;
}

interface MaterializationEffect {
  readonly kind: 'materialization';
  readonly attempt: PendingAttempt;
  readonly input: CurrentPendingRepoCompletionMaterializeInput;
}

interface CleanupEffect {
  readonly kind: 'cleanup';
  readonly cleanup: CleanupState;
  readonly input: {
    readonly sessionId: string;
    readonly claimToken: string;
    readonly dispatchPlanId?: string;
    readonly worktrees: readonly CurrentPendingRepoWorktreeCleanupTarget[];
  };
}

type PendingEffect = MaterializationEffect | CleanupEffect;

interface MaterializationContinuation {
  readonly kind: 'materialization';
  readonly attemptId: number;
}

interface CleanupContinuation {
  readonly kind: 'cleanup';
  readonly attemptId: number;
}

type Continuation = MaterializationContinuation | CleanupContinuation;

type CleanupState =
  | {
      readonly kind: 'workerRefusal';
      readonly attempt: PendingAttempt;
      readonly dispatchPlanId?: string;
      readonly refusalMessage: string;
    }
  | {
      readonly kind: 'staleMaterialization';
      readonly attempt: PendingAttempt;
      readonly dispatchPlanId?: string;
    };

type RuntimeField =
  | 'workingDir'
  | 'pendingRepo'
  | 'pendingRepoCommitInFlight'
  | 'pendingRepoCommitClaimToken'
  | 'initialStartPending'
  | 'repoCardMessageId'
  | 'pendingPrompt'
  | 'pendingTurnId'
  | 'pendingCodexAppText'
  | 'pendingCodexAppApplicationContext'
  | 'pendingCodexAppMessageContext'
  | 'pendingChatContext'
  | 'pendingAttachments'
  | 'pendingMentions'
  | 'pendingSubstituteTrigger'
  | 'pendingSender'
  | 'pendingCodexAppSteerable'
  | 'pendingFollowUps'
  | 'pendingFollowUpTurnId'
  | 'pendingFollowUpTurnIds'
  | 'pendingCodexAppFollowUps'
  | 'pendingCodexAppFollowUpContexts'
  | 'pendingCodexAppFollowUpGateAccepted';

type RuntimeSnapshot = {
  readonly [K in RuntimeField]: {
    readonly present: boolean;
    readonly value: DaemonSession[K];
  };
};

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function cloneSelection(selection: PendingRepoCompletionSelection): PendingRepoCompletionSelection {
  return structuredClone(selection);
}

type InspectedPreMaterializationResult =
  | { readonly kind: 'ready'; readonly whiteboardBlock?: string }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'invalid'; readonly thenable?: unknown };

function inspectPreMaterializationResult(value: unknown): InspectedPreMaterializationResult {
  if (nodeUtilTypes.isPromise(value)) return { kind: 'invalid', thenable: value };
  if (!value || typeof value !== 'object' || nodeUtilTypes.isProxy(value)) {
    return { kind: 'invalid' };
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return { kind: 'invalid' };
  const keys = Reflect.ownKeys(value);
  const descriptors = new Map<PropertyKey, PropertyDescriptor>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      return { kind: 'invalid' };
    }
    descriptors.set(key, descriptor);
  }
  const thenable = descriptors.get('then')?.value;
  if (typeof thenable === 'function') return { kind: 'invalid', thenable: value };
  const kind = descriptors.get('kind')?.value;
  if (kind === 'ready') {
    if (keys.some(key => key !== 'kind' && key !== 'whiteboardBlock')) {
      return { kind: 'invalid' };
    }
    const whiteboardBlock = descriptors.get('whiteboardBlock')?.value;
    if (whiteboardBlock !== undefined && typeof whiteboardBlock !== 'string') {
      return { kind: 'invalid' };
    }
    return {
      kind,
      ...(whiteboardBlock === undefined ? {} : { whiteboardBlock }),
    };
  }
  if (kind === 'refused') {
    if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('message')) {
      return { kind: 'invalid' };
    }
    const refusalMessage = descriptors.get('message')?.value;
    if (typeof refusalMessage !== 'string' || refusalMessage.length === 0) {
      return { kind: 'invalid' };
    }
    return { kind, message: refusalMessage };
  }
  return { kind: 'invalid' };
}

function openingFor(
  ds: DaemonSession,
  whiteboardBlock?: string,
): CurrentPendingRepoOpeningSnapshot {
  return deepFreeze(structuredClone({
    prompt: ds.pendingPrompt ?? ds.session.pendingRepoSetup?.prompt ?? '',
    ...(ds.session.pendingRepoSetup?.cliInput
      ? { cliInput: ds.session.pendingRepoSetup.cliInput }
      : {}),
    ...(ds.pendingRawInput ? { rawInput: ds.pendingRawInput } : {}),
    ...(ds.pendingRawTurnId ? { rawTurnId: ds.pendingRawTurnId } : {}),
    ...((ds.pendingTurnId ?? ds.session.pendingRepoSetup?.turnId)
      ? { turnId: ds.pendingTurnId ?? ds.session.pendingRepoSetup?.turnId }
      : {}),
    ...(ds.pendingCodexAppText !== undefined ? { codexAppText: ds.pendingCodexAppText } : {}),
    ...(ds.pendingCodexAppApplicationContext !== undefined
      ? { codexAppApplicationContext: ds.pendingCodexAppApplicationContext }
      : {}),
    ...(ds.pendingCodexAppMessageContext !== undefined
      ? { codexAppMessageContext: ds.pendingCodexAppMessageContext }
      : {}),
    ...(ds.pendingChatContext ? { chatContext: ds.pendingChatContext } : {}),
    ...(ds.pendingAttachments?.length ? { attachments: ds.pendingAttachments } : {}),
    ...(ds.pendingMentions?.length ? { mentions: ds.pendingMentions } : {}),
    ...(ds.pendingSubstituteTrigger ? { substituteTrigger: ds.pendingSubstituteTrigger } : {}),
    ...(ds.pendingSender ? { sender: ds.pendingSender } : {}),
    ...(ds.pendingFollowUps?.length ? { followUps: ds.pendingFollowUps } : {}),
    ...(ds.pendingFollowUpTurnIds?.length
      ? { followUpTurnIds: ds.pendingFollowUpTurnIds }
      : ds.pendingFollowUpTurnId
        ? { followUpTurnIds: [ds.pendingFollowUpTurnId] }
        : {}),
    ...(ds.pendingCodexAppFollowUps?.length
      ? { codexAppFollowUps: ds.pendingCodexAppFollowUps }
      : {}),
    ...(ds.pendingCodexAppFollowUpContexts?.length
      ? { codexAppFollowUpContexts: ds.pendingCodexAppFollowUpContexts }
      : {}),
    ...(ds.pendingCodexAppFollowUpGateAccepted?.length
      ? { codexAppFollowUpGateAccepted: ds.pendingCodexAppFollowUpGateAccepted }
      : {}),
    ...(whiteboardBlock === undefined ? {} : { whiteboardBlock }),
  }));
}

function snapshotRuntime(ds: DaemonSession): RuntimeSnapshot {
  const snapshot = <K extends RuntimeField>(key: K): RuntimeSnapshot[K] => ({
    present: Object.prototype.hasOwnProperty.call(ds, key),
    value: ds[key] === undefined ? undefined : structuredClone(ds[key]),
  }) as RuntimeSnapshot[K];
  return {
    workingDir: snapshot('workingDir'),
    pendingRepo: snapshot('pendingRepo'),
    pendingRepoCommitInFlight: snapshot('pendingRepoCommitInFlight'),
    pendingRepoCommitClaimToken: snapshot('pendingRepoCommitClaimToken'),
    initialStartPending: snapshot('initialStartPending'),
    repoCardMessageId: snapshot('repoCardMessageId'),
    pendingPrompt: snapshot('pendingPrompt'),
    pendingTurnId: snapshot('pendingTurnId'),
    pendingCodexAppText: snapshot('pendingCodexAppText'),
    pendingCodexAppApplicationContext: snapshot('pendingCodexAppApplicationContext'),
    pendingCodexAppMessageContext: snapshot('pendingCodexAppMessageContext'),
    pendingChatContext: snapshot('pendingChatContext'),
    pendingAttachments: snapshot('pendingAttachments'),
    pendingMentions: snapshot('pendingMentions'),
    pendingSubstituteTrigger: snapshot('pendingSubstituteTrigger'),
    pendingSender: snapshot('pendingSender'),
    pendingCodexAppSteerable: snapshot('pendingCodexAppSteerable'),
    pendingFollowUps: snapshot('pendingFollowUps'),
    pendingFollowUpTurnId: snapshot('pendingFollowUpTurnId'),
    pendingFollowUpTurnIds: snapshot('pendingFollowUpTurnIds'),
    pendingCodexAppFollowUps: snapshot('pendingCodexAppFollowUps'),
    pendingCodexAppFollowUpContexts: snapshot('pendingCodexAppFollowUpContexts'),
    pendingCodexAppFollowUpGateAccepted: snapshot('pendingCodexAppFollowUpGateAccepted'),
  };
}

function restoreRuntime(ds: DaemonSession, snapshot: RuntimeSnapshot): void {
  for (const key of Object.keys(snapshot) as RuntimeField[]) {
    const field = snapshot[key];
    if (!field.present) delete ds[key];
    else (ds as unknown as Record<RuntimeField, unknown>)[key] = field.value === undefined
      ? undefined
      : structuredClone(field.value);
  }
}

function restoreSession(session: Session, snapshot: Session): void {
  const mutable = session as unknown as Record<string, unknown>;
  for (const key of Object.keys(mutable)) delete mutable[key];
  Object.assign(mutable, structuredClone(snapshot));
}

function clearFoldedRuntimeBuffers(ds: DaemonSession): void {
  ds.pendingPrompt = undefined;
  ds.pendingTurnId = undefined;
  ds.pendingCodexAppText = undefined;
  ds.pendingCodexAppApplicationContext = undefined;
  ds.pendingCodexAppMessageContext = undefined;
  ds.pendingChatContext = undefined;
  ds.pendingAttachments = undefined;
  ds.pendingMentions = undefined;
  ds.pendingSubstituteTrigger = undefined;
  ds.pendingSender = undefined;
  ds.pendingCodexAppSteerable = undefined;
  ds.pendingFollowUps = undefined;
  ds.pendingFollowUpTurnId = undefined;
  ds.pendingFollowUpTurnIds = undefined;
  ds.pendingCodexAppFollowUps = undefined;
  ds.pendingCodexAppFollowUpContexts = undefined;
  ds.pendingCodexAppFollowUpGateAccepted = undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function absorbThenable(value: unknown): void {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
  try {
    const then = (value as { readonly then?: unknown }).then;
    if (typeof then === 'function') {
      void Promise.resolve(value).catch(() => undefined);
    }
  } catch {
    // The effect outcome is already unknown; never let cleanup throw outward.
  }
}

function isWorktreeCleanupTargets(
  value: unknown,
): value is readonly CurrentPendingRepoWorktreeCleanupTarget[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) return false;
  return value.every((target) => {
    if (!target || typeof target !== 'object' || nodeUtilTypes.isProxy(target)) return false;
    const snapshot = enumerableDataSnapshot(target, 'worktree cleanup target');
    return hasExactKeys(snapshot, ['sourcePath', 'path'])
      && typeof snapshot.sourcePath === 'string'
      && snapshot.sourcePath.length > 0
      && typeof snapshot.path === 'string'
      && snapshot.path.length > 0;
  });
}

function isMaterial(value: unknown, sessionId: string): value is CurrentPendingRepoCompletionMaterial {
  if (!value || typeof value !== 'object' || nodeUtilTypes.isProxy(value)) return false;
  const candidate = value as Partial<CurrentPendingRepoCompletionMaterial>;
  return candidate.sessionId === sessionId
    && (candidate.dispatchPlanId === undefined
      || (typeof candidate.dispatchPlanId === 'string' && candidate.dispatchPlanId.length > 0))
    && typeof candidate.workingDir === 'string'
    && candidate.workingDir.length > 0
    && typeof candidate.userPrompt === 'string'
    && !!candidate.cliInput
    && typeof candidate.cliInput === 'object'
    && typeof candidate.cliInput.content === 'string'
    && typeof candidate.turnId === 'string'
    && candidate.turnId.length > 0
    && typeof candidate.resume === 'boolean'
    && (candidate.worktrees === undefined || isWorktreeCleanupTargets(candidate.worktrees));
}

type InspectedMaterializeResult =
  | { readonly kind: 'materialized'; readonly material: CurrentPendingRepoCompletionMaterial }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

function enumerableDataSnapshot(
  value: object,
  label: string,
): Readonly<Record<string, unknown>> {
  if (nodeUtilTypes.isProxy(value)) throw new Error(`${label} is a Proxy`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} has a non-plain prototype`);
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} contains a symbol property`);
    const found = Object.getOwnPropertyDescriptor(value, key);
    if (!found || !found.enumerable || !('value' in found)) {
      throw new Error(`${label} property ${key} is not enumerable data`);
    }
    snapshot[key] = found.value;
  }
  return snapshot;
}

function hasExactKeys(
  snapshot: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(snapshot);
  return keys.length === expected.length && expected.every(key => keys.includes(key));
}

function inspectMaterializeResult(
  value: unknown,
  sessionId: string,
): InspectedMaterializeResult {
  try {
    if (!value || typeof value !== 'object') {
      return { kind: 'unknown', message: 'pending-repo materializer returned an invalid result' };
    }
    const candidate = enumerableDataSnapshot(value, 'materializer result');
    const kind = candidate.kind;
    if (kind === 'refused') {
      if (!hasExactKeys(candidate, ['kind', 'message'])) {
        return { kind: 'unknown', message: 'pending-repo materializer returned an invalid refusal' };
      }
      const resultMessage = candidate.message;
      if (typeof resultMessage !== 'string' || resultMessage.length === 0) {
        return { kind: 'unknown', message: 'pending-repo materializer returned an invalid refusal' };
      }
      return { kind: 'refused', message: resultMessage };
    }
    if (kind === 'unknown') {
      if (!hasExactKeys(candidate, ['kind', 'message'])) {
        return { kind: 'unknown', message: 'pending-repo materializer returned an invalid unknown result' };
      }
      const resultMessage = candidate.message;
      if (typeof resultMessage !== 'string' || resultMessage.length === 0) {
        return { kind: 'unknown', message: 'pending-repo materializer returned an invalid unknown result' };
      }
      return { kind: 'unknown', message: resultMessage };
    }
    if (!hasExactKeys(candidate, ['kind', 'material'])) {
      return { kind: 'unknown', message: 'pending-repo materializer returned an invalid result' };
    }
    const material = candidate.material;
    if (kind === 'materialized' && isMaterial(material, sessionId)) {
      return { kind: 'materialized', material };
    }
    return { kind: 'unknown', message: 'pending-repo materializer returned invalid material' };
  } catch (error) {
    return {
      kind: 'unknown',
      message: `pending-repo materializer result is unreadable: ${message(error)}`,
    };
  }
}

function inspectCleanupResult(value: unknown): CurrentPendingRepoWorktreeCleanupResult {
  try {
    if (!value || typeof value !== 'object') {
      return { kind: 'unknown', message: 'pending-repo worktree cleanup returned an invalid result' };
    }
    const candidate = enumerableDataSnapshot(value, 'worktree cleanup result');
    if (candidate.kind === 'cleaned' && hasExactKeys(candidate, ['kind'])) {
      return { kind: 'cleaned' };
    }
    if (candidate.kind === 'unknown'
      && hasExactKeys(candidate, ['kind', 'message'])
      && typeof candidate.message === 'string'
      && candidate.message.length > 0) {
      return { kind: 'unknown', message: candidate.message };
    }
    return { kind: 'unknown', message: 'pending-repo worktree cleanup returned an invalid result' };
  } catch (error) {
    return {
      kind: 'unknown',
      message: `pending-repo worktree cleanup result is unreadable: ${message(error)}`,
    };
  }
}

export function createCurrentPendingRepoCompletionPort(
  options: CurrentPendingRepoCompletionOptions,
): PendingRepoCompletionPort {
  let nextAttemptId = 0;
  const attempts = new Map<number, PendingAttempt>();
  const cleanups = new Map<number, CleanupState>();
  const effects = new WeakMap<object, PendingEffect>();

  const isExactPendingClaimOwner = (attempt: PendingAttempt): boolean => {
    const ds = attempt.ds;
    return options.activeSessions.get(attempt.key) === ds
      && activeSessionKey(ds) === attempt.key
      && ds.session === attempt.session
      && ds.session.sessionId === attempt.sessionId
      && ds.session.status === 'active'
      && !!ds.pendingRepo
      && ds.pendingRepoCommitInFlight === true
      && ds.pendingRepoCommitClaimToken === attempt.claimToken;
  };

  const clearExactPendingClaim = (ds: DaemonSession, claimToken: string): void => {
    if (ds.pendingRepoCommitClaimToken !== claimToken) return;
    ds.pendingRepoCommitInFlight = false;
    ds.pendingRepoCommitClaimToken = undefined;
  };

  const isCurrentPendingOwner = (attempt: PendingAttempt): boolean => (
    isExactPendingClaimOwner(attempt)
    && (!attempt.ds.worker || attempt.ds.worker.killed)
  );

  const releaseRetryableOwner = (attempt: PendingAttempt): void => {
    const ds = attempt.ds;
    if (isCurrentPendingOwner(attempt) && ds.pendingRepoCommitInFlight) {
      clearExactPendingClaim(ds, attempt.claimToken);
    }
  };

  const rollbackProvenWorkerRefusalCandidate = (
    attempt: PendingAttempt,
    sessionSnapshot: Session,
    runtimeSnapshot: RuntimeSnapshot,
  ): Extract<PendingRepoCompletionTransitionResult, { kind: 'unknown' }> | undefined => {
    if (!isCurrentPendingOwner(attempt)) {
      return {
        kind: 'unknown',
        message: 'pending-repo Session owner changed before worker-refusal rollback',
      };
    }
    const ds = attempt.ds;
    restoreSession(ds.session, sessionSnapshot);
    restoreRuntime(ds, runtimeSnapshot);
    try {
      sessionStore.updateSession(ds.session);
    } catch (error) {
      return {
        kind: 'unknown',
        message: `pending-repo worker refusal rollback is unknown: ${message(error)}`,
      };
    }
    if (!isExactPendingClaimOwner(attempt)) {
      return {
        kind: 'unknown',
        message: 'pending-repo Session identity changed during worker-refusal rollback',
      };
    }
    return undefined;
  };

  const scheduleCleanup = (
    cleanup: CleanupState,
    worktrees: readonly CurrentPendingRepoWorktreeCleanupTarget[],
  ): PendingRepoCompletionTransitionResult => {
    if (!options.cleanupWorktrees) {
      return {
        kind: 'unknown',
        message: 'pending-repo worktree cleanup effect is not wired',
      };
    }
    const input = deepFreeze({
      sessionId: cleanup.attempt.sessionId,
      claimToken: cleanup.attempt.claimToken,
      ...(cleanup.dispatchPlanId === undefined
        ? {}
        : { dispatchPlanId: cleanup.dispatchPlanId }),
      worktrees: worktrees.map(worktree => ({ ...worktree })),
    });
    const intent = Object.freeze(Object.create(null)) as object;
    cleanups.set(cleanup.attempt.id, cleanup);
    effects.set(intent, { kind: 'cleanup', cleanup, input });
    return {
      kind: 'effect',
      intent,
      continuation: {
        kind: 'cleanup',
        attemptId: cleanup.attempt.id,
      } satisfies Continuation,
    };
  };

  const settleCleanedCleanup = (
    cleanup: CleanupState,
  ): PendingRepoCompletionTransitionResult => {
    if (cleanup.kind === 'staleMaterialization') return { kind: 'staleAddress' };
    const { attempt } = cleanup;
    if (!isCurrentPendingOwner(attempt)) {
      return {
        kind: 'unknown',
        message: 'pending-repo Session owner changed during worktree cleanup',
      };
    }
    const ds = attempt.ds;
    clearExactPendingClaim(ds, attempt.claimToken);
    return { kind: 'retryable', message: cleanup.refusalMessage };
  };

  return {
    begin({ sessionId, selection }): PendingRepoCompletionTransitionResult {
      let detachedSelection: PendingRepoCompletionSelection;
      try {
        detachedSelection = deepFreeze(cloneSelection(selection));
      } catch (error) {
        return {
          kind: 'retryable',
          message: `pending-repo selection could not be detached: ${message(error)}`,
        };
      }
      const candidates = [...options.activeSessions.values()].filter(candidate => (
        candidate.larkAppId === options.ownerLarkAppId
        && candidate.session.sessionId === sessionId
      ));
      if (candidates.length !== 1) return { kind: 'staleAddress' };
      const [ds] = candidates;
      if (!ds
        || options.activeSessions.get(activeSessionKey(ds)) !== ds
        || ds.session.status !== 'active') {
        return { kind: 'staleAddress' };
      }
      if (!ds.pendingRepo) {
        return {
          kind: 'rejected',
          reason: 'notPendingRepo',
          message: 'Session is no longer waiting for its first repository selection',
        };
      }
      if (ds.pendingRepoCommitInFlight) {
        return {
          kind: 'rejected',
          reason: 'selectionBusy',
          message: 'another repository selection is already being prepared',
        };
      }
      if (ds.worker && !ds.worker.killed) {
        return {
          kind: 'rejected',
          reason: 'notPendingRepo',
          message: 'pending-repo first start already has a live worker',
        };
      }
      const claimedSession = ds.session;
      const claimedKey = activeSessionKey(ds);
      const claimToken = randomUUID();
      ds.pendingRepoCommitInFlight = true;
      ds.pendingRepoCommitClaimToken = claimToken;
      const releasePreparationClaim = () => {
        clearExactPendingClaim(ds, claimToken);
      };
      let whiteboardBlock: string | undefined;
      if (options.preMaterialization) {
        let inspected: InspectedPreMaterializationResult;
        try {
          const prepared = options.preMaterialization.apply(ds, deepFreeze({
            sessionId,
            selection: detachedSelection,
            hasFrozenCliInput: ds.session.pendingRepoSetup?.cliInput !== undefined,
            hasRawInput: !!ds.pendingRawInput,
            rawWillBuildFollowUp: !!ds.pendingRawInput && (
              (ds.pendingPrompt
                ?? ds.session.pendingRepoSetup?.prompt
                ?? '').trim().length > 0
              || ds.pendingCodexAppText !== undefined
              || (ds.pendingAttachments?.length ?? 0) > 0
              || (ds.pendingFollowUps?.length ?? 0) > 0
              || ds.pendingChatContext !== undefined
            ),
          }));
          inspected = inspectPreMaterializationResult(prepared);
        } catch (error) {
          releasePreparationClaim();
          return {
            kind: 'retryable',
            message: `pending-repo Current preparation failed: ${message(error)}`,
          };
        }
        if (inspected.kind === 'invalid') {
          absorbThenable(inspected.thenable);
          releasePreparationClaim();
          return {
            kind: 'retryable',
            message: 'pending-repo Current preparation returned an invalid result',
          };
        }
        if (inspected.kind === 'refused') {
          releasePreparationClaim();
          return {
            kind: 'retryable',
            message: inspected.message,
          };
        }
        whiteboardBlock = inspected.whiteboardBlock;
        if (ds.session !== claimedSession
          || activeSessionKey(ds) !== claimedKey
          || options.activeSessions.get(claimedKey) !== ds
          || claimedSession.sessionId !== sessionId
          || claimedSession.status !== 'active'
          || !ds.pendingRepo
          || ds.pendingRepoCommitInFlight !== true
          || ds.pendingRepoCommitClaimToken !== claimToken) {
          releasePreparationClaim();
          return { kind: 'staleAddress' };
        }
      }
      const attempt: PendingAttempt = {
        id: ++nextAttemptId,
        claimToken,
        sessionId,
        key: claimedKey,
        ds,
        session: claimedSession,
        selection: detachedSelection,
      };
      let input: CurrentPendingRepoCompletionMaterializeInput;
      try {
        input = deepFreeze({
          sessionId,
          claimToken,
          selection: detachedSelection,
          opening: openingFor(ds, whiteboardBlock),
        } satisfies CurrentPendingRepoCompletionMaterializeInput);
      } catch (error) {
        releasePreparationClaim();
        return {
          kind: 'retryable',
          message: `pending-repo opening could not be detached: ${message(error)}`,
        };
      }
      attempts.set(attempt.id, attempt);
      const intent = Object.freeze(Object.create(null)) as object;
      effects.set(intent, { kind: 'materialization', attempt, input });
      return {
        kind: 'effect',
        intent,
        continuation: {
          kind: 'materialization',
          attemptId: attempt.id,
        } satisfies Continuation,
      };
    },

    execute(intent: unknown): Promise<unknown> {
      if (!intent || (typeof intent !== 'object' && typeof intent !== 'function')) {
        return Promise.reject(new Error('pending-repo materialization intent is invalid'));
      }
      const effect = effects.get(intent as object);
      if (!effect) {
        return Promise.reject(new Error('pending-repo materialization intent is invalid or already consumed'));
      }
      effects.delete(intent as object);
      let pending: unknown;
      if (effect.kind === 'materialization') {
        if (!isCurrentPendingOwner(effect.attempt)) {
          return Promise.reject(new Error('pending-repo Session owner changed before materialization'));
        }
        try {
          pending = options.materialize(effect.input);
        } catch (error) {
          return Promise.reject(error);
        }
      } else {
        if (!options.cleanupWorktrees) {
          return Promise.reject(new Error('pending-repo worktree cleanup effect is not wired'));
        }
        try {
          pending = options.cleanupWorktrees(effect.input);
        } catch (error) {
          return Promise.reject(error);
        }
      }
      if (!nodeUtilTypes.isPromise(pending)) {
        absorbThenable(pending);
        return Promise.reject(new Error(
          effect.kind === 'materialization'
            ? 'pending-repo materializer must return a native Promise'
            : 'pending-repo worktree cleanup must return a native Promise',
        ));
      }
      return pending;
    },

    resume(
      continuation: unknown,
      settlement: PendingRepoCompletionEffectSettlement,
    ): PendingRepoCompletionTransitionResult {
      const candidate = continuation as Partial<Continuation> | undefined;
      const attemptId = candidate?.attemptId;
      if (candidate?.kind === 'cleanup') {
        const cleanup = typeof attemptId === 'number' ? cleanups.get(attemptId) : undefined;
        if (!cleanup) {
          return {
            kind: 'unknown',
            message: 'pending-repo cleanup continuation is invalid or already settled',
          };
        }
        cleanups.delete(cleanup.attempt.id);
        if (settlement.kind === 'threw') {
          return {
            kind: 'unknown',
            message: `pending-repo worktree cleanup outcome is unknown: ${message(settlement.error)}`,
          };
        }
        const cleaned = inspectCleanupResult(settlement.value);
        if (cleaned.kind === 'unknown') return cleaned;
        return settleCleanedCleanup(cleanup);
      }
      if (candidate?.kind !== 'materialization') {
        return { kind: 'unknown', message: 'pending-repo continuation is invalid' };
      }
      const attempt = typeof attemptId === 'number' ? attempts.get(attemptId) : undefined;
      if (!attempt) {
        return { kind: 'unknown', message: 'pending-repo continuation is invalid or already settled' };
      }
      attempts.delete(attempt.id);
      if (settlement.kind === 'threw') {
        if (isCleanupOutcomeUnknown(settlement.error)) {
          return {
            kind: 'unknown',
            message: `pending-repo materialization failed: ${settlement.error.message}`,
          };
        }
        if (!isCurrentPendingOwner(attempt)) return { kind: 'staleAddress' };
        return {
          kind: 'unknown',
          message: `pending-repo materialization failed: ${message(settlement.error)}`,
        };
      }
      const materialization = inspectMaterializeResult(settlement.value, attempt.sessionId);
      const preparedWorktrees = materialization.kind === 'materialized'
        ? materialization.material.worktrees?.map(worktree => ({ ...worktree }))
        : undefined;
      if (!isCurrentPendingOwner(attempt)) {
        if (materialization.kind === 'materialized') {
          const dispatchPlanId = materialization.material.dispatchPlanId;
          if ((preparedWorktrees?.length ?? 0) > 0 || dispatchPlanId !== undefined) {
            return scheduleCleanup({
              kind: 'staleMaterialization',
              attempt,
              ...(dispatchPlanId === undefined ? {} : { dispatchPlanId }),
            }, preparedWorktrees ?? []);
          }
        }
        return { kind: 'staleAddress' };
      }
      if (materialization.kind === 'refused') {
        releaseRetryableOwner(attempt);
        return { kind: 'retryable', message: materialization.message };
      }
      if (materialization.kind === 'unknown') return materialization;
      const material = materialization.material;
      const ds = attempt.ds;

      const sessionSnapshot = structuredClone(ds.session);
      const runtimeSnapshot = snapshotRuntime(ds);
      try {
        ds.workingDir = material.workingDir;
        const pinWorkingDir = attempt.selection.kind !== 'directory'
          || attempt.selection.pinWorkingDir;
        if (pinWorkingDir) ds.session.workingDir = material.workingDir;
        ds.session.riffRepoDirs = material.riffRepoDirs
          ? [...material.riffRepoDirs]
          : attempt.selection.kind === 'directory' && attempt.selection.riffRepoDirs
            ? [...attempt.selection.riffRepoDirs]
            : undefined;
        sessionStore.updateSession(ds.session);
      } catch (error) {
        // updateSession may have atomically published the candidate and then
        // thrown while reporting its outcome. Rolling the in-memory mirror
        // back would create a split brain and invite a second first-start
        // fork. Keep the candidate and claim sticky until recovery can prove
        // which side committed.
        return {
          kind: 'unknown',
          message: `pending-repo first-start persistence outcome is unknown: ${message(error)}`,
        };
      }

      const command: CurrentPendingRepoWorkerCommand = {
        kind: 'forkFirstStart',
        sessionId: ds.session.sessionId,
        claimToken: attempt.claimToken,
        ...(material.dispatchPlanId === undefined
          ? {}
          : { dispatchPlanId: material.dispatchPlanId }),
        workingDir: material.workingDir,
        input: structuredClone(material.cliInput),
        turnId: material.turnId,
        resume: material.resume,
        ...(ds.session.riffRepoDirs ? { riffRepoDirs: [...ds.session.riffRepoDirs] } : {}),
        ...(preparedWorktrees?.length ? { worktrees: preparedWorktrees.map(worktree => ({ ...worktree })) } : {}),
      };
      let dispatched: CurrentPendingRepoWorkerResult;
      try {
        dispatched = options.dispatchWorker(command);
        if (dispatched && typeof dispatched === 'object'
          && typeof (dispatched as { then?: unknown }).then === 'function') {
          throw new Error('pending-repo worker Adapter must return synchronously');
        }
        if (!dispatched
          || (dispatched.kind !== 'accepted'
            && dispatched.kind !== 'refused'
            && dispatched.kind !== 'unknown')) {
          throw new Error('pending-repo worker Adapter returned an invalid result');
        }
      } catch (error) {
        // The process Adapter may have crossed its acceptance boundary before
        // throwing or returning an invalid/thenable result. Keep the claim and
        // pinned state sticky; blindly restoring would invite a second fork.
        return {
          kind: 'unknown',
          message: `pending-repo worker dispatch outcome is unknown: ${message(error)}`,
        };
      }
      if (!isExactPendingClaimOwner(attempt)) {
        return {
          kind: 'unknown',
          message: 'pending-repo Session identity changed during worker dispatch',
        };
      }
      if (dispatched.kind === 'unknown') return dispatched;
      if (dispatched.kind === 'refused') {
        const rollbackUnknown = rollbackProvenWorkerRefusalCandidate(
          attempt,
          sessionSnapshot,
          runtimeSnapshot,
        );
        if (rollbackUnknown) return rollbackUnknown;
        const cleanup: CleanupState = {
          kind: 'workerRefusal',
          attempt,
          ...(material.dispatchPlanId === undefined
            ? {}
            : { dispatchPlanId: material.dispatchPlanId }),
          refusalMessage: dispatched.message ?? 'pending-repo worker refused the first start',
        };
        if ((preparedWorktrees?.length ?? 0) > 0 || material.dispatchPlanId !== undefined) {
          if (!isCurrentPendingOwner(attempt)) {
            return {
              kind: 'unknown',
              message: 'pending-repo worker refusal did not preserve a cleanup-safe owner',
            };
          }
          return scheduleCleanup(cleanup, preparedWorktrees ?? []);
        }
        return settleCleanedCleanup(cleanup);
      }

      if (attempt.selection.kind === 'directory' && !attempt.selection.pinWorkingDir) {
        const priorWorkingDir = runtimeSnapshot.workingDir;
        if (!priorWorkingDir.present) delete ds.workingDir;
        else ds.workingDir = priorWorkingDir.value;
        if (!Object.hasOwn(sessionSnapshot, 'workingDir')) {
          delete ds.session.workingDir;
        } else {
          ds.session.workingDir = sessionSnapshot.workingDir;
        }
        try {
          sessionStore.updateSession(ds.session);
        } catch (error) {
          return {
            kind: 'unknown',
            message: `pending-repo unpinned working-directory restoration is unknown: ${message(error)}`,
          };
        }
        if (!isExactPendingClaimOwner(attempt)) {
          return {
            kind: 'unknown',
            message: 'pending-repo Session identity changed during unpinned working-directory restoration',
          };
        }
      }
      ds.pendingRepo = false;
      clearExactPendingClaim(ds, attempt.claimToken);
      ds.initialStartPending = ds.session.queuedActivationPending === true;
      markRepoCardConsumed(ds, ds.repoCardMessageId);
      ds.repoCardMessageId = undefined;
      clearFoldedRuntimeBuffers(ds);
      // The needs-you column tracks pendingRepo live; a failed projection
      // publish must not change the committed completion.
      try {
        publishAttentionPatch(ds);
      } catch {
        // Rebuilt on the next full hydrate.
      }
      return { kind: 'committed' };
    },
  };
}
