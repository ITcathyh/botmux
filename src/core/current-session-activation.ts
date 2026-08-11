/** Current worker-pool Adapter for the Session activation coordinator. */

import { randomUUID } from 'node:crypto';
import type { CliTurnPayload } from '../types.js';
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
  forkWorker,
  getActiveSessionsRegistry,
  type ForkResumeOrTurnId,
} from './worker-pool.js';
import { activeSessionKey, type DaemonSession } from './types.js';

export interface CurrentSessionActivationInput {
  readonly promptInput: string | CliTurnPayload;
  readonly resumeOrTurnId: ForkResumeOrTurnId;
}

interface CurrentActivationPlan {
  readonly current: DaemonSession;
  readonly session: DaemonSession['session'];
  readonly registryKey: string;
  readonly input: CurrentSessionActivationInput;
  readonly action: 'activated' | 'reattached';
}

interface CurrentActivationExecution {
  readonly accepted: boolean;
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
  return Object.freeze({
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
}): SessionActivationPort {
  const intents = new WeakMap<object, CurrentActivationPlan>();
  const continuations = new WeakMap<object, CurrentActivationPlan>();
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
      if (request.goal.kind === 'reconcile' && request.goal.observation === 'unknown') {
        return { kind: 'quarantined', message: 'persistent backend observation is unknown' };
      }
      const input = activationInput(request.goal);
      if (!input) {
        return { kind: 'quarantined', message: 'Current activation input is invalid' };
      }
      const live = exact.current.worker !== null && !exact.current.worker.killed;
      if (live && promptContent(input.promptInput) === '') {
        return { kind: 'active', action: 'alreadyActive' };
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
      return {
        accepted: (options.forkWorker ?? forkWorker)(
          plan.current,
          plan.input.promptInput,
          plan.input.resumeOrTurnId,
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
        return {
          kind: 'ambiguous',
          message: `Current worker activation outcome is unknown: ${settlement.error instanceof Error
            ? settlement.error.message
            : String(settlement.error)}`,
        };
      }
      const execution = settlement.value as Partial<CurrentActivationExecution> | null;
      if (!execution || typeof execution.accepted !== 'boolean') {
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

const hostsByRegistry = new WeakMap<
  Map<string, DaemonSession>,
  Map<string, ReturnType<typeof createSessionActivationRuntime>>
>();
const CURRENT_ACTIVATION_RUNTIME_EPOCH = randomUUID();

function currentActivationRuntime(
  ownerLarkAppId: string,
  activeSessionsOverride?: Map<string, DaemonSession>,
) {
  const activeSessions = activeSessionsOverride ?? getActiveSessionsRegistry();
  if (!activeSessions) return undefined;
  let byOwner = hostsByRegistry.get(activeSessions);
  if (!byOwner) {
    byOwner = new Map();
    hostsByRegistry.set(activeSessions, byOwner);
  }
  let runtime = byOwner.get(ownerLarkAppId);
  if (!runtime) {
    const runtimeEpoch = CURRENT_ACTIVATION_RUNTIME_EPOCH;
    runtime = createSessionActivationRuntime({
      commandLane: currentSessionCommandLane,
      laneAddress: sessionId => currentSessionLaneAddress(
        runtimeEpoch,
        ownerLarkAppId,
        sessionId,
      ),
      port: createCurrentSessionActivationPort({ ownerLarkAppId, activeSessions }),
    });
    byOwner.set(ownerLarkAppId, runtime);
  }
  return runtime;
}

export async function ensureCurrentSessionActivation(input: {
  readonly ownerLarkAppId: string;
  readonly sessionId: string;
  readonly requestIdentity: string;
  readonly cause: Exclude<SessionActivationRequest['goal'], { kind: 'reconcile' }>['cause'];
  readonly promptInput: string | CliTurnPayload;
  readonly resumeOrTurnId?: ForkResumeOrTurnId;
  /** Current composition/tests may provide the exact owner registry explicitly. */
  readonly activeSessions?: Map<string, DaemonSession>;
}): Promise<SessionActivationOutcome> {
  const runtime = currentActivationRuntime(input.ownerLarkAppId, input.activeSessions);
  if (!runtime) {
    return { kind: 'retryable', message: 'Current active Session registry is not ready' };
  }
  return runtime.ensure({
    sessionId: input.sessionId,
    requestIdentity: input.requestIdentity,
    goal: {
      kind: 'ensure',
      cause: input.cause,
      input: {
        promptInput: input.promptInput,
        resumeOrTurnId: input.resumeOrTurnId ?? false,
      },
    },
  });
}

export async function reconcileCurrentSessionActivation(input: {
  readonly ownerLarkAppId: string;
  readonly sessionId: string;
  readonly requestIdentity: string;
  readonly observation: 'exists' | 'missing' | 'unknown';
  readonly promptInput?: string | CliTurnPayload;
  readonly resumeOrTurnId?: ForkResumeOrTurnId;
  readonly activeSessions?: Map<string, DaemonSession>;
}): Promise<SessionActivationOutcome> {
  const runtime = currentActivationRuntime(input.ownerLarkAppId, input.activeSessions);
  if (!runtime) {
    return { kind: 'retryable', message: 'Current active Session registry is not ready' };
  }
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
      },
    },
  });
}

export async function retireCurrentSessionActivation(input: {
  readonly ownerLarkAppId: string;
  readonly sessionId: string;
  readonly requestIdentity: string;
  readonly reason: SessionRetirementReason;
}): Promise<SessionRetirementOutcome> {
  const runtime = currentActivationRuntime(input.ownerLarkAppId);
  if (!runtime) {
    return { kind: 'retryable', message: 'Current active Session registry is not ready' };
  }
  return runtime.retire(input);
}
