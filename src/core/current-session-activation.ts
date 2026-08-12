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
  type SessionRetirementDisposition,
  type SessionRetirementOutcome,
  type SessionRetirementReason,
  type SessionRetirementSettlementOutcome,
} from './session-activation-runtime.js';
import {
  currentSessionCommandLane,
  currentSessionLaneAddress,
} from './current-session-command-lane.js';
// Type-only: this Adapter is the composition target of worker-pool's own
// import graph (worker-pool → session-manager → … → here), so a static VALUE
// import of worker-pool would close a runtime cycle that silently disables
// partial vi.mock(worker-pool) for every test importing the graph. Effect
// executors are composition-injected (or lazily imported as the production
// default) instead.
import type { forkAdoptWorker, forkWorker, ForkResumeOrTurnId } from './worker-pool.js';
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
  settleRetirement(input: {
    readonly sessionId: string;
    readonly requestIdentity: string;
    readonly reason: SessionRetirementReason;
    readonly disposition: SessionRetirementDisposition;
  }): Promise<SessionRetirementSettlementOutcome>;
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
  backendUnknown: boolean;
  readonly pendingRetirements: Set<string>;
}

interface CurrentRetirementPlan {
  readonly reason: SessionRetirementReason;
  readonly action: 'retired' | 'alreadyRetired';
  readonly quarantine?: CurrentActivationQuarantine;
  settlement?: {
    readonly disposition: SessionRetirementDisposition;
    readonly outcome: SessionRetirementSettlementOutcome;
  };
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
): { current: DaemonSession; key: string } | 'ambiguous' | 'unreadable' | undefined {
  const matches = new Map<string, { current: DaemonSession; key: string }>();
  for (const [key, current] of registry) {
    const ownerRelated = current.larkAppId === ownerLarkAppId
      || current.session.larkAppId === ownerLarkAppId;
    if (!ownerRelated) continue;
    let canonical = false;
    try { canonical = key === activeSessionKey(current); }
    catch { /* malformed owner evidence keeps the activation partition unavailable */ }
    if (!canonical
        || registry.get(key) !== current
        || current.larkAppId !== ownerLarkAppId
        || (!!current.session.larkAppId && current.session.larkAppId !== ownerLarkAppId)
        || !current.session.sessionId
        || current.session.status !== 'active'
        || current.session.chatId !== current.chatId
        || (!!current.session.chatType && current.session.chatType !== current.chatType)
        || (current.session.scope ?? 'thread') !== current.scope) {
      return 'unreadable';
    }
    if (matches.has(current.session.sessionId)) return 'ambiguous';
    matches.set(current.session.sessionId, { current, key });
  }
  return matches.get(sessionId);
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
  const retirements = new Map<string, CurrentRetirementPlan>();
  const token = (): object => Object.freeze(Object.create(null)) as object;
  const retirementKey = (sessionId: string, requestIdentity: string): string => (
    `${sessionId}\0${requestIdentity}`
  );
  const sameQuarantinedBinding = (
    quarantine: CurrentActivationQuarantine,
    exact: { current: DaemonSession; key: string },
  ): boolean => quarantine.current === exact.current
    && quarantine.session === exact.current.session
    && quarantine.registryKey === exact.key;
  const quarantineFor = (
    exact: { current: DaemonSession; key: string },
  ): CurrentActivationQuarantine => {
    const prior = quarantines.get(exact.current.session.sessionId);
    if (prior && sameQuarantinedBinding(prior, exact)) return prior;
    const quarantine: CurrentActivationQuarantine = {
      current: exact.current,
      session: exact.current.session,
      registryKey: exact.key,
      backendUnknown: false,
      pendingRetirements: new Set(),
    };
    quarantines.set(exact.current.session.sessionId, quarantine);
    return quarantine;
  };

  const bindingStillExact = (plan: CurrentActivationPlan): boolean => {
    const exact = resolveExact(
      options.activeSessions,
      options.ownerLarkAppId,
      plan.current.session.sessionId,
    );
    return exact !== undefined
      && typeof exact !== 'string'
      && exact.key === plan.registryKey
      && exact.current === plan.current
      && exact.current.session === plan.session;
  };

  return {
    begin(request): SessionActivationTransition {
      const exact = resolveExact(options.activeSessions, options.ownerLarkAppId, request.sessionId);
      if (exact === 'unreadable') {
        return { kind: 'quarantined', message: 'Current activation registry has malformed owner evidence' };
      }
      if (exact === 'ambiguous') {
        return { kind: 'quarantined', message: 'Current activation has multiple exact owner bindings' };
      }
      if (!exact) {
        return { kind: 'rejected', reason: 'notFound', message: 'Current Session is not active in this owner Host' };
      }
      if (exact.current.session.status === 'closed') {
        return { kind: 'rejected', reason: 'closed', message: 'Current Session is closed' };
      }
      let quarantined = quarantines.get(request.sessionId);
      if (quarantined) {
        if (!sameQuarantinedBinding(quarantined, exact)) {
          // The danger this record encodes (a possibly-live backend pane keyed
          // by sessionId) survives re-registration, so the quarantine must
          // follow the Session onto its live binding instead of wedging the
          // sessionId forever on a superseded object graph. Rebinding keeps the
          // fail-closed state and, crucially, restores the release paths (typed
          // re-probe / retirement settlement) on the current binding. The
          // pendingRetirements Set is carried by reference: in-flight
          // retirement plans hold the same Set and their settlement must keep
          // clearing the gate.
          const rebound: CurrentActivationQuarantine = {
            current: exact.current,
            session: exact.current.session,
            registryKey: exact.key,
            backendUnknown: quarantined.backendUnknown,
            pendingRetirements: quarantined.pendingRetirements,
          };
          quarantines.set(request.sessionId, rebound);
          quarantined = rebound;
        }
        if (quarantined.pendingRetirements.size > 0) {
          return {
            kind: 'quarantined',
            message: 'activation retirement is pending provider settlement',
          };
        }
        if (quarantined.backendUnknown
            && (request.goal.kind !== 'reconcile'
              || request.goal.observation === 'unknown')) {
          return {
            kind: 'quarantined',
            message: 'persistent backend binding is quarantined pending an explicit re-probe',
          };
        }
        if (quarantined.backendUnknown) {
          // A typed exists/missing observation is the only operation that clears
          // an unknown probe. It remains fenced to this exact owner binding.
          quarantined.backendUnknown = false;
          quarantines.delete(request.sessionId);
        }
      }
      if (request.goal.kind === 'reconcile' && request.goal.observation === 'unknown') {
        quarantineFor(exact).backendUnknown = true;
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
        const fork = options.forkWorker
          ?? (await import('./worker-pool.js')).forkWorker;
        return {
          accepted: fork(
            plan.current,
            plan.input.promptInput,
            plan.input.resumeOrTurnId,
          ),
        };
      }
      const forkAdopt = options.forkAdoptWorker
        ?? (await import('./worker-pool.js')).forkAdoptWorker;
      const result: unknown = forkAdopt(plan.current, {
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
        return {
          kind: 'unknownAfterEffect',
          message: 'Current Session binding changed after activation effect invocation',
        };
      }
      if (settlement.kind === 'threw') {
        quarantineFor({ current: plan.current, key: plan.registryKey }).backendUnknown = true;
        return {
          kind: 'ambiguous',
          message: `Current worker activation outcome is unknown: ${settlement.error instanceof Error
            ? settlement.error.message
            : String(settlement.error)}`,
        };
      }
      const execution = settlement.value as Partial<CurrentActivationExecution> | null;
      if (!execution || typeof execution.accepted !== 'boolean') {
        quarantineFor({ current: plan.current, key: plan.registryKey }).backendUnknown = true;
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
      const key = retirementKey(request.sessionId, request.requestIdentity);
      const prior = retirements.get(key);
      if (prior) {
        return prior.reason === request.reason
          ? { kind: 'retired', action: prior.action }
          : {
              kind: 'quarantined',
              message: 'Current retirement identity already belongs to a different reason',
            };
      }
      const exact = resolveExact(options.activeSessions, options.ownerLarkAppId, request.sessionId);
      if (exact === 'unreadable') {
        return { kind: 'quarantined', message: 'Current retirement registry has malformed owner evidence' };
      }
      if (exact === 'ambiguous') {
        return { kind: 'quarantined', message: 'Current retirement has multiple exact owner bindings' };
      }
      const action = exact ? 'retired' as const : 'alreadyRetired' as const;
      if (exact) {
        const quarantine = quarantineFor(exact);
        quarantine.pendingRetirements.add(key);
        retirements.set(key, { reason: request.reason, action, quarantine });
      } else {
        retirements.set(key, { reason: request.reason, action });
      }
      return { kind: 'retired', action };
    },

    settleRetirement(request): SessionRetirementSettlementOutcome {
      const key = retirementKey(request.sessionId, request.requestIdentity);
      const retirement = retirements.get(key);
      if (!retirement) {
        return { kind: 'quarantined', message: 'Current retirement settlement has no prepared fence' };
      }
      if (retirement.reason !== request.reason) {
        return { kind: 'quarantined', message: 'Current retirement settlement reason changed' };
      }
      if (retirement.settlement) {
        return retirement.settlement.disposition === request.disposition
          ? retirement.settlement.outcome
          : {
              kind: 'quarantined',
              message: 'Current retirement settlement identity already belongs to different evidence',
            };
      }
      const quarantine = retirement.quarantine;
      let outcome: SessionRetirementSettlementOutcome;
      if (request.disposition === 'applied') {
        if (quarantine && quarantines.get(request.sessionId) === quarantine) {
          quarantines.delete(request.sessionId);
        }
        outcome = { kind: 'settled', disposition: 'applied' };
      } else if (request.disposition === 'notApplied') {
        if (quarantine) {
          quarantine.pendingRetirements.delete(key);
          if (!quarantine.backendUnknown && quarantine.pendingRetirements.size === 0
              && quarantines.get(request.sessionId) === quarantine) {
            quarantines.delete(request.sessionId);
          }
        }
        outcome = { kind: 'settled', disposition: 'notApplied' };
      } else {
        if (quarantine) {
          quarantine.pendingRetirements.delete(key);
          quarantine.backendUnknown = true;
        }
        outcome = {
          kind: 'quarantined',
          message: 'Current retirement provider outcome is unknown',
        };
      }
      retirement.settlement = { disposition: request.disposition, outcome };
      return outcome;
    },
  };
}

const coordinatorsByRegistry = new WeakMap<
  Map<string, DaemonSession>,
  Map<string, {
    readonly ownerLarkAppId: string;
    readonly coordinator: CurrentSessionActivationCoordinator;
  }>
>();
const coordinatorOwnersByRegistry = new WeakMap<
  Map<string, DaemonSession>,
  Map<BotId, string>
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
    settleRetirement(input) {
      return runtime.settleRetirement(input);
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
  let owners = coordinatorOwnersByRegistry.get(options.activeSessions);
  if (!owners) {
    owners = new Map();
    coordinatorOwnersByRegistry.set(options.activeSessions, owners);
  }
  const boundOwner = owners.get(options.ownerBotId);
  if (boundOwner !== undefined && boundOwner !== options.ownerLarkAppId) {
    throw new Error('Current activation Bot is already bound to a different Lark owner');
  }
  owners.set(options.ownerBotId, options.ownerLarkAppId);
  let byOwner = coordinatorsByRegistry.get(options.activeSessions);
  if (!byOwner) {
    byOwner = new Map();
    coordinatorsByRegistry.set(options.activeSessions, byOwner);
  }
  const hostKey = `${options.ownerBotId}\0${options.runtimeEpoch}`;
  const cached = byOwner.get(hostKey);
  if (cached) {
    if (cached.ownerLarkAppId !== options.ownerLarkAppId) {
      throw new Error('Current activation Bot epoch is already bound to a different Lark owner');
    }
    return cached.coordinator;
  }
  const coordinator = createCoordinator(options);
  byOwner.set(hostKey, {
    ownerLarkAppId: options.ownerLarkAppId,
    coordinator,
  });
  return coordinator;
}

async function currentActivationCoordinator(
  ownerBotId: BotId | undefined,
  ownerLarkAppId: string,
  activeSessionsOverride?: Map<string, DaemonSession>,
  runtimeEpochOverride?: string,
) {
  const workerPool = await import('./worker-pool.js');
  const runtimeEpoch = runtimeEpochOverride ?? workerPool.getDaemonBootId();
  const activeSessions = activeSessionsOverride ?? workerPool.getActiveSessionsRegistry();
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
  const coordinator = await currentActivationCoordinator(
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
  const coordinator = await currentActivationCoordinator(
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
  const coordinator = await currentActivationCoordinator(
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

export async function settleCurrentSessionRetirement(input: {
  readonly ownerBotId?: BotId;
  readonly ownerLarkAppId: string;
  /** Must match the owner Host/Executor epoch; production defaults to daemon boot. */
  readonly runtimeEpoch?: string;
  readonly sessionId: string;
  readonly requestIdentity: string;
  readonly reason: SessionRetirementReason;
  readonly disposition: SessionRetirementDisposition;
}): Promise<SessionRetirementSettlementOutcome> {
  const coordinator = await currentActivationCoordinator(
    input.ownerBotId,
    input.ownerLarkAppId,
    undefined,
    input.runtimeEpoch,
  );
  if (!coordinator) {
    return { kind: 'quarantined', message: 'Current active Session registry is not ready' };
  }
  return coordinator.settleRetirement(input);
}
