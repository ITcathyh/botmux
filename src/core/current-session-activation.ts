/** Current worker-pool Adapter for the Session activation coordinator. */

import { randomUUID } from 'node:crypto';
import type { CliTurnPayload } from '../types.js';
import { parseBotId, type BotId } from './bot-identity.js';
import {
  createSessionActivationRuntime,
  type SessionActivationOutcome,
  type SessionActivationPort,
  type SessionActivationRequest,
  type SessionActivationTransition,
  type SessionRetirementOutcome,
  type SessionRetirementReason,
} from './session-activation-runtime.js';
import {
  currentSessionCommandLane,
  currentSessionLaneAddress,
} from './current-session-command-lane.js';
import {
  forkAdoptWorker,
  forkWorker,
  getDaemonBootId,
  getActiveSessionsRegistry,
  type ForkResumeOrTurnId,
} from './worker-pool.js';
import { activeSessionKey, type DaemonSession } from './types.js';

export type CurrentSessionActivationInput =
  | {
      readonly kind: 'managed';
      readonly promptInput: string | CliTurnPayload;
      readonly resumeOrTurnId: ForkResumeOrTurnId;
    }
  | {
      readonly kind: 'adopt';
      readonly prompt: string;
      readonly turnId?: string;
      readonly restoredFromMetadata?: boolean;
    };

export interface CurrentSessionActivationCoordinator {
  ensure(input: {
    readonly sessionId: string;
    readonly requestIdentity: string;
    readonly cause: Exclude<SessionActivationRequest['goal'], { kind: 'reconcile' }>['cause'];
    readonly promptInput: string | CliTurnPayload;
    readonly resumeOrTurnId?: ForkResumeOrTurnId;
    readonly executor?: 'managed' | 'adopt';
    readonly restoredFromMetadata?: boolean;
  }): Promise<SessionActivationOutcome>;
  reconcile(input: {
    readonly sessionId: string;
    readonly requestIdentity: string;
    readonly observation: 'exists' | 'missing' | 'unknown';
    readonly promptInput?: string | CliTurnPayload;
    readonly resumeOrTurnId?: ForkResumeOrTurnId;
    readonly executor?: 'managed' | 'adopt';
    readonly restoredFromMetadata?: boolean;
  }): Promise<SessionActivationOutcome>;
  retire(input: {
    readonly sessionId: string;
    readonly requestIdentity: string;
    readonly reason: SessionRetirementReason;
  }): Promise<SessionRetirementOutcome>;
}

interface CurrentActivationPlan {
  readonly current: DaemonSession;
  readonly session: DaemonSession['session'];
  readonly registryKey: string;
  readonly input: CurrentSessionActivationInput;
  readonly action: 'activated' | 'reattached';
  readonly priorWorker: DaemonSession['worker'];
  readonly priorGeneration: number | undefined;
}

interface CurrentActivationExecution {
  readonly accepted: boolean;
}

interface CurrentActivationQuarantine {
  readonly current: DaemonSession;
  readonly session: DaemonSession['session'];
  readonly registryKey: string;
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === 'object';
}

function promptContent(input: string | CliTurnPayload): string {
  return typeof input === 'string' ? input : input.content;
}

function activationInput(goal: SessionActivationRequest['goal']): CurrentSessionActivationInput | undefined {
  if (!isObject(goal.input)) return undefined;
  const promptInput = goal.input.promptInput;
  const resumeOrTurnId = goal.input.resumeOrTurnId;
  if (typeof promptInput !== 'string'
      && (!isObject(promptInput) || typeof promptInput.content !== 'string')) {
    return undefined;
  }
  const validResume = typeof resumeOrTurnId === 'boolean'
    || typeof resumeOrTurnId === 'string'
    || (isObject(resumeOrTurnId)
      && (resumeOrTurnId.resume === undefined || typeof resumeOrTurnId.resume === 'boolean')
      && (resumeOrTurnId.turnId === undefined || typeof resumeOrTurnId.turnId === 'string')
      && (resumeOrTurnId.dispatchAttempt === undefined || Number.isSafeInteger(resumeOrTurnId.dispatchAttempt))
      && (resumeOrTurnId.codexAppInputGateFrozen === undefined || typeof resumeOrTurnId.codexAppInputGateFrozen === 'boolean')
      && (resumeOrTurnId.restartAttemptId === undefined || typeof resumeOrTurnId.restartAttemptId === 'string')
      && (resumeOrTurnId.atMostOnce === undefined || typeof resumeOrTurnId.atMostOnce === 'boolean'));
  if (!validResume) return undefined;
  const typedPrompt = promptInput as string | CliTurnPayload;
  const typedResume = resumeOrTurnId as ForkResumeOrTurnId;
  if (goal.input.executor === 'adopt') {
    const turnId = isObject(typedResume) && typeof typedResume.turnId === 'string'
      ? typedResume.turnId
      : typeof typedResume === 'string'
        ? typedResume
        : undefined;
    return Object.freeze({
      kind: 'adopt' as const,
      prompt: promptContent(typedPrompt),
      ...(turnId === undefined ? {} : { turnId }),
      ...(goal.input.restoredFromMetadata === true
        ? { restoredFromMetadata: true }
        : {}),
    });
  }
  return Object.freeze({
    kind: 'managed' as const,
    promptInput: typeof typedPrompt === 'string'
      ? typedPrompt
      : Object.freeze({
          content: typedPrompt.content,
          ...(typedPrompt.codexAppInput === undefined ? {} : { codexAppInput: typedPrompt.codexAppInput }),
          ...(typedPrompt.codexAppSteerable === true ? { codexAppSteerable: true as const } : {}),
        }),
    resumeOrTurnId: typeof typedResume === 'object' && typedResume !== null
      ? Object.freeze({ ...typedResume })
      : typedResume,
  });
}

function resolveExact(
  registry: ReadonlyMap<string, DaemonSession>,
  ownerLarkAppId: string,
  sessionId: string,
): { current: DaemonSession; key: string } | 'ambiguous' | undefined {
  const matches: Array<{ current: DaemonSession; key: string }> = [];
  for (const [key, current] of registry) {
    if (current.larkAppId !== ownerLarkAppId
        || current.session.sessionId !== sessionId
        || key !== activeSessionKey(current)
        || registry.get(key) !== current) continue;
    matches.push({ current, key });
  }
  if (matches.length > 1) return 'ambiguous';
  return matches[0];
}

export function createCurrentSessionActivationPort(options: {
  readonly ownerLarkAppId: string;
  readonly activeSessions: Map<string, DaemonSession>;
  readonly forkWorker?: typeof forkWorker;
  readonly forkAdoptWorker?: typeof forkAdoptWorker;
}): SessionActivationPort {
  const intents = new WeakMap<object, CurrentActivationPlan>();
  const continuations = new WeakMap<object, CurrentActivationPlan>();
  const quarantines = new Map<string, CurrentActivationQuarantine>();
  const token = (): object => Object.freeze(Object.create(null)) as object;

  const bindingStillExact = (plan: CurrentActivationPlan): boolean => {
    const exact = resolveExact(
      options.activeSessions,
      options.ownerLarkAppId,
      plan.current.session.sessionId,
    );
    return exact !== undefined
      && exact !== 'ambiguous'
      && exact.key === plan.registryKey
      && exact.current === plan.current
      && exact.current.session === plan.session;
  };

  return {
    begin(request): SessionActivationTransition {
      const exact = resolveExact(options.activeSessions, options.ownerLarkAppId, request.sessionId);
      if (exact === 'ambiguous') {
        return { kind: 'quarantined', message: 'Current activation has multiple exact owner bindings' };
      }
      if (!exact) {
        return { kind: 'rejected', reason: 'notFound', message: 'Current Session is not active in this owner Host' };
      }
      if (exact.current.session.status === 'closed') {
        return { kind: 'rejected', reason: 'closed', message: 'Current Session is closed' };
      }
      const quarantined = quarantines.get(request.sessionId);
      if (quarantined) {
        const sameQuarantinedBinding = quarantined.current === exact.current
          && quarantined.session === exact.current.session
          && quarantined.registryKey === exact.key;
        if (!sameQuarantinedBinding) {
          return {
            kind: 'quarantined',
            message: 'persistent backend quarantine is bound to a superseded Current Session',
          };
        }
        if (request.goal.kind !== 'reconcile'
            || request.goal.observation === 'unknown') {
          return {
            kind: 'quarantined',
            message: 'persistent backend binding is quarantined pending an explicit re-probe',
          };
        }
        // A typed exists/missing observation is the only operation that clears
        // an unknown probe. It remains fenced to this exact owner binding.
        quarantines.delete(request.sessionId);
      }
      if (request.goal.kind === 'reconcile' && request.goal.observation === 'unknown') {
        quarantines.set(request.sessionId, {
          current: exact.current,
          session: exact.current.session,
          registryKey: exact.key,
        });
        return { kind: 'quarantined', message: 'persistent backend observation is unknown' };
      }
      const input = activationInput(request.goal);
      if (!input) {
        return { kind: 'quarantined', message: 'Current activation input is invalid' };
      }
      const live = exact.current.worker !== null && !exact.current.worker.killed;
      if (live && request.goal.kind === 'ensure' && request.goal.cause !== 'replacement') {
        return { kind: 'active', action: 'alreadyActive' };
      }
      if (live && input.kind === 'managed' && promptContent(input.promptInput) === '') {
        return { kind: 'active', action: 'alreadyActive' };
      }
      if (input.kind === 'adopt' && !exact.current.adoptedFrom) {
        return { kind: 'rejected', reason: 'conflict', message: 'Current adopt activation targets a non-adopted Session' };
      }
      const action = request.goal.kind === 'reconcile' && request.goal.observation === 'exists'
        ? 'reattached' as const
        : 'activated' as const;
      const plan = Object.freeze({
        current: exact.current,
        session: exact.current.session,
        registryKey: exact.key,
        input,
        action,
        priorWorker: exact.current.worker,
        priorGeneration: exact.current.workerGeneration,
      });
      const intent = token();
      const continuation = token();
      intents.set(intent, plan);
      continuations.set(continuation, plan);
      return { kind: 'effect', intent, continuation };
    },

    async execute(intent): Promise<CurrentActivationExecution> {
      if (!isObject(intent)) throw new Error('invalid Current activation intent');
      const plan = intents.get(intent);
      if (!plan) throw new Error('Current activation intent was already consumed');
      intents.delete(intent);
      if (plan.input.kind === 'managed') {
        return {
          accepted: (options.forkWorker ?? forkWorker)(
            plan.current,
            plan.input.promptInput,
            plan.input.resumeOrTurnId,
          ),
        };
      }
      const result: unknown = (options.forkAdoptWorker ?? forkAdoptWorker)(plan.current, {
        ...(plan.input.restoredFromMetadata === true ? { restoredFromMetadata: true } : {}),
        ...(plan.input.prompt === '' ? {} : { prompt: plan.input.prompt }),
        ...(plan.input.turnId === undefined ? {} : { turnId: plan.input.turnId }),
      });
      if (result === false) return { accepted: false };
      if (result === true) return { accepted: true };
      const live = plan.current.worker !== null && !plan.current.worker.killed;
      return {
        accepted: live && (
          plan.current.worker !== plan.priorWorker
          || plan.current.workerGeneration !== plan.priorGeneration
        ),
      };
    },

    resume(continuation, settlement): SessionActivationTransition {
      if (!isObject(continuation)) {
        return { kind: 'quarantined', message: 'invalid Current activation continuation' };
      }
      const plan = continuations.get(continuation);
      if (!plan) {
        return { kind: 'quarantined', message: 'Current activation continuation was already consumed' };
      }
      continuations.delete(continuation);
      if (!bindingStillExact(plan)) {
        return { kind: 'stale', message: 'Current Session binding changed during activation' };
      }
      if (settlement.kind === 'threw') {
        quarantines.set(plan.session.sessionId, {
          current: plan.current,
          session: plan.session,
          registryKey: plan.registryKey,
        });
        return {
          kind: 'ambiguous',
          message: `Current worker activation outcome is unknown: ${settlement.error instanceof Error
            ? settlement.error.message
            : String(settlement.error)}`,
        };
      }
      const execution = settlement.value as Partial<CurrentActivationExecution> | null;
      if (!execution || typeof execution.accepted !== 'boolean') {
        quarantines.set(plan.session.sessionId, {
          current: plan.current,
          session: plan.session,
          registryKey: plan.registryKey,
        });
        return { kind: 'quarantined', message: 'Current activation Adapter returned no acceptance proof' };
      }
      if (!execution.accepted) {
        return { kind: 'retryable', message: 'Current worker activation was refused without side effects' };
      }
      const live = plan.current.worker !== null && !plan.current.worker.killed;
      return live
        ? { kind: 'active', action: plan.action }
        : { kind: 'active', action: 'deferred' };
    },

    retire(request): SessionRetirementOutcome {
      quarantines.delete(request.sessionId);
      const exact = resolveExact(options.activeSessions, options.ownerLarkAppId, request.sessionId);
      if (exact === 'ambiguous') {
        return { kind: 'quarantined', message: 'Current retirement has multiple exact owner bindings' };
      }
      return exact
        ? { kind: 'retired', action: 'retired' }
        : { kind: 'retired', action: 'alreadyRetired' };
    },
  };
}

const coordinatorsByRegistry = new WeakMap<
  Map<string, DaemonSession>,
  Map<string, CurrentSessionActivationCoordinator>
>();
const adapterBotIdsByRegistry = new WeakMap<
  Map<string, DaemonSession>,
  Map<string, BotId>
>();
function createCoordinator(options: {
  readonly ownerBotId: BotId;
  readonly ownerLarkAppId: string;
  readonly runtimeEpoch: string;
  readonly activeSessions: Map<string, DaemonSession>;
  readonly forkWorker?: typeof forkWorker;
  readonly forkAdoptWorker?: typeof forkAdoptWorker;
}): CurrentSessionActivationCoordinator {
  const runtime = createSessionActivationRuntime({
    commandLane: currentSessionCommandLane,
    laneAddress: sessionId => currentSessionLaneAddress(
      options.runtimeEpoch,
      options.ownerBotId,
      sessionId,
    ),
    port: createCurrentSessionActivationPort({
      ownerLarkAppId: options.ownerLarkAppId,
      activeSessions: options.activeSessions,
      ...(options.forkWorker === undefined ? {} : { forkWorker: options.forkWorker }),
      ...(options.forkAdoptWorker === undefined
        ? {}
        : { forkAdoptWorker: options.forkAdoptWorker }),
    }),
  });
  const coordinator: CurrentSessionActivationCoordinator = {
    ensure(input) {
      return runtime.ensure({
        sessionId: input.sessionId,
        requestIdentity: input.requestIdentity,
        goal: {
          kind: 'ensure',
          cause: input.cause,
          input: {
            promptInput: input.promptInput,
            resumeOrTurnId: input.resumeOrTurnId ?? false,
            ...(input.executor === undefined ? {} : { executor: input.executor }),
            ...(input.restoredFromMetadata === undefined
              ? {}
              : { restoredFromMetadata: input.restoredFromMetadata }),
          },
        },
      });
    },
    reconcile(input) {
      return runtime.ensure({
        sessionId: input.sessionId,
        requestIdentity: input.requestIdentity,
        goal: {
          kind: 'reconcile',
          cause: 'restore',
          observation: input.observation,
          input: {
            promptInput: input.promptInput ?? '',
            resumeOrTurnId: input.resumeOrTurnId ?? true,
            ...(input.executor === undefined ? {} : { executor: input.executor }),
            ...(input.restoredFromMetadata === undefined
              ? {}
              : { restoredFromMetadata: input.restoredFromMetadata }),
          },
        },
      });
    },
    retire(input) {
      return runtime.retire(input);
    },
  };
  return Object.freeze(coordinator);
}

/**
 * Return the one activation coordinator for an immutable Current owner Host.
 * Production composition must bind the stable BotId and daemon epoch once and
 * inject this narrow capability into callers; no caller may mint a parallel
 * activation truth from the transport App ID.
 */
export function currentSessionActivationCoordinator(options: {
  readonly ownerBotId: BotId;
  readonly ownerLarkAppId: string;
  readonly runtimeEpoch: string;
  readonly activeSessions: Map<string, DaemonSession>;
}): CurrentSessionActivationCoordinator {
  let byOwner = coordinatorsByRegistry.get(options.activeSessions);
  if (!byOwner) {
    byOwner = new Map();
    coordinatorsByRegistry.set(options.activeSessions, byOwner);
  }
  const hostKey = `${options.ownerBotId}\0${options.runtimeEpoch}`;
  let coordinator = byOwner.get(hostKey);
  if (!coordinator) {
    coordinator = createCoordinator(options);
    byOwner.set(hostKey, coordinator);
  }
  return coordinator;
}

function currentActivationCoordinator(
  ownerBotId: BotId | undefined,
  ownerLarkAppId: string,
  activeSessionsOverride?: Map<string, DaemonSession>,
  runtimeEpoch: string = getDaemonBootId(),
) {
  const activeSessions = activeSessionsOverride ?? getActiveSessionsRegistry();
  if (!activeSessions) return undefined;
  let stableOwnerBotId = ownerBotId;
  if (!stableOwnerBotId) {
    let byOwner = adapterBotIdsByRegistry.get(activeSessions);
    if (!byOwner) {
      byOwner = new Map();
      adapterBotIdsByRegistry.set(activeSessions, byOwner);
    }
    stableOwnerBotId = byOwner.get(ownerLarkAppId);
    if (!stableOwnerBotId) {
      stableOwnerBotId = parseBotId(`bot_${randomUUID().replaceAll('-', '')}`);
      byOwner.set(ownerLarkAppId, stableOwnerBotId);
    }
  }
  return currentSessionActivationCoordinator({
    ownerBotId: stableOwnerBotId,
    ownerLarkAppId,
    runtimeEpoch,
    activeSessions,
  });
}

export async function ensureCurrentSessionActivation(input: {
  readonly ownerBotId?: BotId;
  readonly ownerLarkAppId: string;
  /** Must match the owner Host/Executor epoch; production defaults to daemon boot. */
  readonly runtimeEpoch?: string;
  readonly sessionId: string;
  readonly requestIdentity: string;
  readonly cause: Exclude<SessionActivationRequest['goal'], { kind: 'reconcile' }>['cause'];
  readonly promptInput: string | CliTurnPayload;
  readonly resumeOrTurnId?: ForkResumeOrTurnId;
  /** Current composition/tests may provide the exact owner registry explicitly. */
  readonly activeSessions?: Map<string, DaemonSession>;
}): Promise<SessionActivationOutcome> {
  const coordinator = currentActivationCoordinator(
    input.ownerBotId,
    input.ownerLarkAppId,
    input.activeSessions,
    input.runtimeEpoch,
  );
  if (!coordinator) {
    return { kind: 'retryable', message: 'Current active Session registry is not ready' };
  }
  return coordinator.ensure({
    sessionId: input.sessionId,
    requestIdentity: input.requestIdentity,
    cause: input.cause,
    promptInput: input.promptInput,
    resumeOrTurnId: input.resumeOrTurnId,
  });
}

export async function reconcileCurrentSessionActivation(input: {
  readonly ownerBotId?: BotId;
  readonly ownerLarkAppId: string;
  /** Must match the owner Host/Executor epoch; production defaults to daemon boot. */
  readonly runtimeEpoch?: string;
  readonly sessionId: string;
  readonly requestIdentity: string;
  readonly observation: 'exists' | 'missing' | 'unknown';
  readonly promptInput?: string | CliTurnPayload;
  readonly resumeOrTurnId?: ForkResumeOrTurnId;
  readonly executor?: 'managed' | 'adopt';
  readonly restoredFromMetadata?: boolean;
  readonly activeSessions?: Map<string, DaemonSession>;
}): Promise<SessionActivationOutcome> {
  const coordinator = currentActivationCoordinator(
    input.ownerBotId,
    input.ownerLarkAppId,
    input.activeSessions,
    input.runtimeEpoch,
  );
  if (!coordinator) {
    return { kind: 'retryable', message: 'Current active Session registry is not ready' };
  }
  return coordinator.reconcile({
    sessionId: input.sessionId,
    requestIdentity: input.requestIdentity,
    observation: input.observation,
    promptInput: input.promptInput,
    resumeOrTurnId: input.resumeOrTurnId,
    executor: input.executor,
    restoredFromMetadata: input.restoredFromMetadata,
  });
}

export async function retireCurrentSessionActivation(input: {
  readonly ownerBotId?: BotId;
  readonly ownerLarkAppId: string;
  /** Must match the owner Host/Executor epoch; production defaults to daemon boot. */
  readonly runtimeEpoch?: string;
  readonly sessionId: string;
  readonly requestIdentity: string;
  readonly reason: SessionRetirementReason;
}): Promise<SessionRetirementOutcome> {
  const coordinator = currentActivationCoordinator(
    input.ownerBotId,
    input.ownerLarkAppId,
    undefined,
    input.runtimeEpoch,
  );
  if (!coordinator) {
    return { kind: 'retryable', message: 'Current active Session registry is not ready' };
  }
  return coordinator.retire(input);
}
