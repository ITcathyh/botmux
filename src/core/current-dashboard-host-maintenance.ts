/** Owner-bound Current Adapter for Dashboard host-level Session maintenance. */

import { execFileSync } from 'node:child_process';

import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { evaluateReadIsolationGate } from '../adapters/cli/read-isolation.js';
import {
  normalizeCliRuntimeConfig,
  type CliRuntimeConfig,
} from '../adapters/cli/runtime.js';
import type { CliId } from '../adapters/cli/types.js';
import { getBot } from '../bot-registry.js';
import { rmwBotEntry } from '../services/config-store.js';
import { checkCliAvailability } from '../setup/cli-availability.js';
import { resolveCliSelection, selectionKeyForBot } from '../setup/cli-selection.js';
import type { Session } from '../types.js';
import { logger } from '../utils/logger.js';
import { computeInputHash } from '../utils/canonical-input-hash.js';
import { withBotTurnMutation } from './bot-turn-mutation-gate.js';
import type { CurrentDashboardSessionCommandSubmitter } from './current-dashboard-session-command-client.js';
import { isSessionStopped } from './session-liveness.js';
import { isSuspendableBackendType } from './persistent-backend.js';
import {
  sessionCliSelectionMismatch,
  type SessionCliSelectionTarget,
} from './session-cli-selection.js';
import { protectedSessionMutationReasons } from './session-mutation-guard.js';
import { activeSessionKey, type DaemonSession } from './types.js';

export type DashboardHostMaintenanceMode = 'clean_stopped' | 'suspend_idle';

export interface DashboardAgentConfigurationSnapshot {
  readonly cliId: CliId;
  readonly wrapperCli?: string;
  readonly cliRuntime?: CliRuntimeConfig;
  readonly cliPathOverride?: string;
  readonly model?: string;
  readonly readIsolation?: boolean;
  readonly backendType?: string;
}

export interface DashboardAgentConfigurationPort {
  current(): DashboardAgentConfigurationSnapshot;
  publish(input: {
    readonly target: SessionCliSelectionTarget;
    readonly model: string;
    readonly readIsolationSupported: boolean;
  }): Promise<
    | {
        readonly ok: true;
        readonly config: DashboardAgentConfigurationSnapshot;
        readonly readIsolationCleared: boolean;
      }
    | { readonly ok: false; readonly reason: string }
  >;
}

export interface DashboardAgentChangeRequest {
  readonly operationId: string;
  readonly cliId: string;
  readonly model: string;
  readonly cliRuntimePresent: boolean;
  readonly cliRuntime: unknown;
}

export interface DashboardAgentChangeResponse {
  readonly ok: true;
  readonly cliId: CliId;
  readonly cliRuntime: CliRuntimeConfig | null;
  readonly cliPathOverride: string | null;
  readonly wrapperCli: string | null;
  readonly model: string | null;
  readonly selectionKey: string;
  readonly closedMismatchedSessions: number;
  readonly readIsolation: boolean;
  readonly readIsolationSupported: boolean;
  readonly readIsolationCleared: boolean;
  readonly agentAvailable: boolean;
  readonly availabilityWarning?: string;
  readonly requiredCommand?: string;
  readonly runtimeProbe?: { readonly version: string; readonly updateProvider: string };
}

export type DashboardAgentChangeResult =
  | { readonly kind: 'completed'; readonly response: DashboardAgentChangeResponse }
  | { readonly kind: 'invalid'; readonly error: string; readonly message?: string }
  | Extract<DashboardAgentChangePreflightResult, { kind: 'blocked' | 'conflict' }>
  | { readonly kind: 'unavailable'; readonly error: string; readonly message: string }
  | {
      readonly kind: 'pending';
      readonly error: 'agent_change_pending';
      readonly message: string;
    }
  | {
      readonly kind: 'quarantined';
      readonly error: 'agent_change_outcome_unknown';
      readonly message: string;
    };

export type DashboardHostMaintenanceResult =
  | {
      readonly kind: 'completed';
      readonly mode: DashboardHostMaintenanceMode;
      readonly candidates: number;
      readonly affected: number;
    }
  | {
      readonly kind: 'retryable';
      readonly mode: DashboardHostMaintenanceMode;
      readonly candidates: number;
      readonly affected: number;
      readonly message: string;
    }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'quarantined'; readonly message: string };

export interface DashboardHostMaintenance {
  counts(): DashboardHostMaintenanceCounts;
  changeAgent(input: DashboardAgentChangeRequest): Promise<DashboardAgentChangeResult>;
  sweep(input: {
    readonly operationId: string;
    readonly mode: DashboardHostMaintenanceMode;
  }): Promise<DashboardHostMaintenanceResult>;
}

export type DashboardHostMaintenanceCounts =
  | { readonly kind: 'ready'; readonly stopped: number; readonly idle: number }
  | { readonly kind: 'notReady'; readonly message: string };

export type DashboardAgentChangePreflightResult =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'blocked';
      readonly error: 'codex_app_dispatch_pending' | 'session_mutation_pending';
      readonly blockingSessions: readonly {
        readonly sessionId: string;
        readonly cliId?: string;
        readonly reasons: ReturnType<typeof protectedSessionMutationReasons>;
      }[];
    }
  | { readonly kind: 'conflict'; readonly message: string };

export type DashboardAgentCliMismatchSweepResult =
  | {
      readonly kind: 'completed';
      readonly closedMismatchedSessions: number;
      readonly deferredSessions: number;
    }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'pending'; readonly message: string }
  | { readonly kind: 'quarantined'; readonly message: string };

interface HostMaintenanceBatchPlan {
  candidateIds?: readonly string[];
  readonly unresolved: Set<string>;
  readonly affected: Set<string>;
}

interface RunningBatch {
  readonly mode: DashboardHostMaintenanceMode;
  readonly plan: HostMaintenanceBatchPlan;
  readonly terminal: Promise<DashboardHostMaintenanceResult>;
}

interface RetryableBatch {
  readonly mode: DashboardHostMaintenanceMode;
  readonly plan: HostMaintenanceBatchPlan;
}

interface CompletedBatch {
  readonly mode: DashboardHostMaintenanceMode;
  readonly plan: HostMaintenanceBatchPlan;
  readonly outcome: DashboardHostMaintenanceResult;
}

interface AgentChangePlan {
  readonly requestHash: string;
  readonly target: SessionCliSelectionTarget;
  readonly candidateIds: readonly string[];
  readonly candidates: ReadonlyMap<string, DaemonSession>;
  readonly candidateStates: Map<string, AgentCandidateState>;
  readonly preflight: DashboardAgentChangePreflightResult;
}

type AgentCandidateState =
  | { readonly kind: 'closed'; readonly affected: boolean }
  | { readonly kind: 'exempt' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'retryable' }
  | { readonly kind: 'unknown'; readonly message: string };

interface PublishedAgentChange {
  readonly target: SessionCliSelectionTarget;
  readonly model: string;
  readonly cliId: CliId;
  readonly wrapperCli?: string;
  readonly nextRuntime?: CliRuntimeConfig;
  readonly nextLegacyPath?: string;
  readonly publishedConfig: DashboardAgentConfigurationSnapshot;
  readonly readIsolationCleared: boolean;
  readonly agentAvailable: boolean;
  readonly availabilityWarning?: string;
  readonly requiredCommand?: string;
  readonly runtimeProbe?: DashboardAgentChangeResponse['runtimeProbe'];
}

type AgentChangePreflightAttempt =
  | { readonly requestHash: string; readonly terminal: Promise<AgentChangePlan> }
  | AgentChangePlan;

type AgentChangeOperationAttempt =
  | {
      readonly requestHash: string;
      readonly terminal: Promise<DashboardAgentChangeResult>;
    }
  | {
      readonly requestHash: string;
      readonly outcome: DashboardAgentChangeResult;
    }
  | {
      readonly requestHash: string;
      readonly retryable: true;
    };

type OwnerActiveInventory =
  | { readonly kind: 'ready'; readonly sessions: readonly DaemonSession[] }
  | { readonly kind: 'notReady'; readonly message: string };

type OwnerStoredInventory =
  | { readonly kind: 'ready'; readonly sessions: readonly Session[] }
  | { readonly kind: 'notReady'; readonly message: string };

export function dashboardAgentReadIsolationEnforceableFor(
  config: Pick<DashboardAgentConfigurationSnapshot, 'cliId' | 'cliPathOverride' | 'wrapperCli'>,
): boolean {
  let adapterSupports = false;
  try {
    adapterSupports = createCliAdapterSync(config.cliId, config.cliPathOverride)
      .supportsReadIsolation === true;
  } catch {
    // Missing or invalid adapters cannot safely enforce read isolation.
  }
  return evaluateReadIsolationGate({
    configured: true,
    adapterSupports,
    wrapperCliSet: !!config.wrapperCli,
    platform: process.platform,
    sessionDataDirSet: true,
  }).enabled;
}

function dashboardAgentConfigurationSnapshot(
  input: DashboardAgentConfigurationSnapshot,
): DashboardAgentConfigurationSnapshot {
  return {
    cliId: input.cliId,
    ...(input.wrapperCli ? { wrapperCli: input.wrapperCli } : {}),
    ...(input.cliRuntime ? { cliRuntime: structuredClone(input.cliRuntime) } : {}),
    ...(input.cliPathOverride ? { cliPathOverride: input.cliPathOverride } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.readIsolation === undefined ? {} : { readIsolation: input.readIsolation }),
    ...(input.backendType ? { backendType: input.backendType } : {}),
  };
}

/** Current bots.json + live-registry Adapter for one daemon-owned Bot. */
export function createCurrentDashboardAgentConfiguration(
  ownerLarkAppId: string,
): DashboardAgentConfigurationPort {
  return {
    current() {
      return dashboardAgentConfigurationSnapshot(getBot(ownerLarkAppId).config);
    },

    async publish(input) {
      let readIsolationCleared = false;
      const persisted = await rmwBotEntry(ownerLarkAppId, (entry) => {
        entry.cliId = input.target.cliId;
        if (input.target.wrapperCli) entry.wrapperCli = input.target.wrapperCli;
        else delete entry.wrapperCli;
        if (input.target.cliRuntime) {
          entry.cliRuntime = input.target.cliRuntime;
          delete entry.cliPathOverride;
        } else if (input.target.cliPathOverride) {
          entry.cliPathOverride = input.target.cliPathOverride;
          delete entry.cliRuntime;
        } else {
          delete entry.cliRuntime;
          delete entry.cliPathOverride;
        }
        if (input.model) entry.model = input.model;
        else delete entry.model;
        if (entry.readIsolation === true && !input.readIsolationSupported) {
          delete entry.readIsolation;
          readIsolationCleared = true;
        }
        if (input.target.cliId === 'riff') {
          entry.backendType = 'riff';
        } else if (entry.backendType === 'riff') {
          delete entry.backendType;
        }
        return { write: true, result: null };
      });
      if (!persisted.ok) return { ok: false, reason: persisted.reason };

      const bot = getBot(ownerLarkAppId);
      bot.config.cliId = input.target.cliId;
      if (input.target.cliRuntime) {
        bot.config.cliRuntime = input.target.cliRuntime;
        delete bot.config.cliPathOverride;
      } else if (input.target.cliPathOverride) {
        bot.config.cliPathOverride = input.target.cliPathOverride;
        delete bot.config.cliRuntime;
      } else {
        delete bot.config.cliRuntime;
        delete bot.config.cliPathOverride;
      }
      bot.config.wrapperCli = input.target.wrapperCli;
      bot.config.model = input.model || undefined;
      if (readIsolationCleared) bot.config.readIsolation = false;
      if (input.target.cliId === 'riff') {
        bot.config.backendType = 'riff';
      } else if (bot.config.backendType === 'riff') {
        bot.config.backendType = undefined;
      }
      return {
        ok: true,
        config: dashboardAgentConfigurationSnapshot(bot.config),
        readIsolationCleared,
      };
    },
  };
}

function ownerRelated(
  ownerLarkAppId: string,
  session: DaemonSession,
): boolean {
  return session.larkAppId === ownerLarkAppId
    || session.session.larkAppId === ownerLarkAppId;
}

function inspectOwnerActiveSessions(
  ownerLarkAppId: string,
  activeSessions: ReadonlyMap<string, DaemonSession>,
): OwnerActiveInventory {
  const sessions: DaemonSession[] = [];
  const sessionIds = new Set<string>();
  for (const [key, session] of activeSessions.entries()) {
    if (!ownerRelated(ownerLarkAppId, session)) continue;
    let canonical = false;
    try { canonical = key === activeSessionKey(session); }
    catch { /* malformed bindings are not safe to classify */ }
    if (!canonical
      || session.larkAppId !== ownerLarkAppId
      || (!!session.session.larkAppId && session.session.larkAppId !== ownerLarkAppId)
      || typeof session.session.sessionId !== 'string'
      || session.session.sessionId.length === 0
      || session.session.status !== 'active'
      || session.session.chatId !== session.chatId
      || (!!session.session.chatType && session.session.chatType !== session.chatType)
      || (session.session.scope ?? 'thread') !== session.scope) {
      return {
        kind: 'notReady',
        message: 'Host maintenance found a malformed owner registry binding',
      };
    }
    if (sessionIds.has(session.session.sessionId)) {
      return {
        kind: 'notReady',
        message: 'Host maintenance found duplicate live owner bindings for one Session',
      };
    }
    sessionIds.add(session.session.sessionId);
    sessions.push(session);
  }
  return { kind: 'ready', sessions };
}

function inspectOwnerStoredSessions(
  ownerLarkAppId: string,
  sessions: readonly Session[],
): OwnerStoredInventory {
  const owned: Session[] = [];
  const sessionIds = new Set<string>();
  for (const session of sessions) {
    if (session.larkAppId && session.larkAppId !== ownerLarkAppId) continue;
    if (typeof session.sessionId !== 'string'
      || session.sessionId.length === 0
      || sessionIds.has(session.sessionId)) {
      return {
        kind: 'notReady',
        message: 'Host maintenance found malformed durable owner Session evidence',
      };
    }
    sessionIds.add(session.sessionId);
    owned.push(session);
  }
  return { kind: 'ready', sessions: owned };
}

export function createCurrentDashboardHostMaintenance(options: {
  readonly ownerLarkAppId: string;
  readonly activeSessions: ReadonlyMap<string, DaemonSession>;
  readonly listSessions: () => readonly Session[];
  readonly submit: CurrentDashboardSessionCommandSubmitter;
  readonly deferTransfer?: (session: DaemonSession, callback: () => void) => boolean;
  readonly agentConfiguration?: DashboardAgentConfigurationPort;
}): DashboardHostMaintenance {
  // Current has no durable batch receipt. Keep terminal batches for the whole
  // daemon epoch so a stable operation ID never expands to a new candidate set.
  const batches = new Map<string, RunningBatch | RetryableBatch | CompletedBatch>();
  const agentChanges = new Map<string, AgentChangePreflightAttempt>();
  const agentChangeOperations = new Map<string, AgentChangeOperationAttempt>();
  const publishedAgentChanges = new Map<string, PublishedAgentChange>();

  function agentChangePlan(
    requestHash: string,
    target: SessionCliSelectionTarget,
  ): AgentChangePlan {
    const candidates = new Map<string, DaemonSession>();
    const candidateStates = new Map<string, AgentCandidateState>();
    const blockingBySessionId = new Map<string, {
      sessionId: string;
      cliId?: string;
      reasons: ReturnType<typeof protectedSessionMutationReasons>;
    }>();
    const activeInventory = inspectOwnerActiveSessions(
      options.ownerLarkAppId,
      options.activeSessions,
    );
    if (activeInventory.kind === 'notReady') {
      return {
        requestHash,
        target,
        candidateIds: [],
        candidates,
        candidateStates,
        preflight: {
          kind: 'conflict',
          message: activeInventory.message,
        },
      };
    }
    const activeOwnerSessions = activeInventory.sessions;
    const storedInventory = inspectOwnerStoredSessions(
      options.ownerLarkAppId,
      options.listSessions(),
    );
    if (storedInventory.kind === 'notReady') {
      return {
        requestHash,
        target,
        candidateIds: [],
        candidates,
        candidateStates,
        preflight: {
          kind: 'conflict',
          message: storedInventory.message,
        },
      };
    }
    const addBlocker = (value: DaemonSession | Session): void => {
      const session = 'session' in value ? value.session : value;
      const reasons = protectedSessionMutationReasons(value);
      if (reasons.length === 0) return;
      const prior = blockingBySessionId.get(session.sessionId);
      if (prior) {
        prior.reasons = [...new Set([...prior.reasons, ...reasons])];
        return;
      }
      blockingBySessionId.set(session.sessionId, {
        sessionId: session.sessionId,
        ...(session.cliId ? { cliId: session.cliId } : {}),
        reasons,
      });
    };
    for (const session of activeOwnerSessions) addBlocker(session);
    for (const session of storedInventory.sessions) {
      if (session.status !== 'active') continue;
      addBlocker(session);
    }
    for (const session of activeOwnerSessions) {
      if (session.session.queued
        || session.adoptedFrom
        || session.initConfig?.adoptMode
        || session.session.adoptedFrom
        || session.session.title?.startsWith('Adopt:')) continue;
      if (!sessionCliSelectionMismatch(session.session, target)) continue;
      if (!blockingBySessionId.has(session.session.sessionId)) {
        candidates.set(session.session.sessionId, session);
      }
    }
    const blockingSessions = [...blockingBySessionId.values()];
    const liveSessionIds = new Set(activeOwnerSessions.map(session => session.session.sessionId));
    const persistedOnlyMismatch = storedInventory.sessions.find(session => (
      session.status === 'active'
      && !liveSessionIds.has(session.sessionId)
      && sessionCliSelectionMismatch(session, target)
    ));
    const preflight: DashboardAgentChangePreflightResult = blockingSessions.length === 0
      ? persistedOnlyMismatch
        ? {
            kind: 'conflict',
            message: `Agent change found an active durable Session without a canonical live binding: ${persistedOnlyMismatch.sessionId}`,
          }
        : { kind: 'ready' }
      : {
          kind: 'blocked',
          error: blockingSessions.every(blocker => (
            blocker.reasons.every(reason => reason === 'codex_app_dispatch')
          ))
            ? 'codex_app_dispatch_pending'
            : 'session_mutation_pending',
          blockingSessions,
        };
    return {
      requestHash,
      target,
      candidateIds: [...candidates.keys()],
      candidates,
      candidateStates,
      preflight,
    };
  }

  async function preflightAgentChange(input: {
    readonly operationId: string;
    readonly target: SessionCliSelectionTarget;
    readonly settings: { readonly model: string };
  }): Promise<DashboardAgentChangePreflightResult> {
    const requestHash = computeInputHash({ target: input.target, settings: input.settings });
    const prior = agentChanges.get(input.operationId);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        return {
          kind: 'conflict',
          message: 'Agent change operation identity belongs to another target',
        };
      }
      const plan = 'terminal' in prior ? await prior.terminal : prior;
      return plan.preflight;
    }
    const frozenTarget = Object.freeze(structuredClone(input.target));
    const terminal = Promise.resolve().then(() => agentChangePlan(requestHash, frozenTarget));
    agentChanges.set(input.operationId, { requestHash, terminal });
    const plan = await terminal;
    agentChanges.set(input.operationId, plan);
    return plan.preflight;
  }

  async function executeAgentCliMismatchSweep(input: {
    readonly operationId: string;
    readonly target: SessionCliSelectionTarget;
    readonly settings: { readonly model: string };
  }): Promise<DashboardAgentCliMismatchSweepResult> {
    const preflight = await preflightAgentChange(input);
    if (preflight.kind === 'conflict') return preflight;
    if (preflight.kind === 'blocked') {
      return { kind: 'conflict', message: 'Agent change preflight did not authorize the sweep' };
    }
    const plan = agentChanges.get(input.operationId);
    if (!plan || 'terminal' in plan) {
      return { kind: 'conflict', message: 'Agent change preflight receipt is unavailable' };
    }
    const submitClose = (sessionId: string) => options.submit({
      target: { kind: 'externalSession' as const, sessionId },
      idempotencyKey: `${input.operationId}:${sessionId}`,
      command: {
        kind: 'control.mutate' as const,
        input: {
          kind: 'close' as const,
          reason: 'agentCliMismatch' as const,
          target: plan.target,
        },
      },
    });
    const attemptIds = plan.candidateIds.filter(sessionId => {
      const state = plan.candidateStates.get(sessionId);
      return !state || state.kind === 'retryable';
    });
    const settled = await Promise.all(attemptIds.map(async sessionId => {
      try {
        return { sessionId, outcome: await submitClose(sessionId) };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[agent-change] Runtime close failed for ${sessionId.slice(0, 8)}: `
          + detail,
        );
        return {
          sessionId,
          outcome: { kind: 'dispatchThrew' as const, message: detail },
        };
      }
    }));
    for (const { sessionId, outcome } of settled) {
      if (outcome.kind === 'dispatchThrew'
        || outcome.kind === 'ambiguous'
        || outcome.kind === 'quarantined') {
        plan.candidateStates.set(sessionId, {
          kind: 'unknown',
          message: `Agent change Session close outcome is unknown for ${sessionId}: ${outcome.message}`,
        });
        continue;
      }
      if (outcome.kind === 'retryable' || outcome.kind === 'notWired') {
        plan.candidateStates.set(sessionId, { kind: 'retryable' });
        continue;
      }
      if ((outcome.kind === 'applied' || outcome.kind === 'duplicate')
          && outcome.result?.kind === 'closed') {
        plan.candidateStates.set(sessionId, outcome.result.known
          ? { kind: 'closed', affected: !outcome.result.alreadyClosed }
          : { kind: 'exempt' });
        continue;
      }
      if (outcome.kind === 'applied' || outcome.kind === 'duplicate') {
        plan.candidateStates.set(sessionId, {
          kind: 'unknown',
          message: `Agent change Session close returned no terminal close evidence for ${sessionId}`,
        });
        continue;
      }
      if (outcome.kind === 'rejected' && outcome.code === 'session_transferring') {
        const candidate = plan.candidates.get(sessionId);
        if (!candidate || !options.deferTransfer) {
          plan.candidateStates.set(sessionId, { kind: 'retryable' });
          continue;
        }
        plan.candidateStates.set(sessionId, { kind: 'pending' });
        const resume = () => {
          void submitClose(sessionId).then((resumed) => {
            if ((resumed.kind === 'applied' || resumed.kind === 'duplicate')
                && resumed.result?.kind === 'closed') {
              plan.candidateStates.set(sessionId, resumed.result.known
                ? { kind: 'closed', affected: !resumed.result.alreadyClosed }
                : { kind: 'exempt' });
              return;
            }
            if (resumed.kind === 'retryable'
                || resumed.kind === 'notWired'
                || (resumed.kind === 'rejected' && resumed.code === 'session_transferring')) {
              plan.candidateStates.set(sessionId, { kind: 'retryable' });
              return;
            }
            if (resumed.kind === 'ambiguous' || resumed.kind === 'quarantined') {
              plan.candidateStates.set(sessionId, {
                kind: 'unknown',
                message: `Deferred Agent change Session close outcome is unknown for ${sessionId}: ${resumed.message}`,
              });
              return;
            }
            if (resumed.kind === 'applied' || resumed.kind === 'duplicate') {
              plan.candidateStates.set(sessionId, {
                kind: 'unknown',
                message: `Deferred Agent change Session close returned no terminal close evidence for ${sessionId}`,
              });
              return;
            }
            plan.candidateStates.set(sessionId, { kind: 'exempt' });
          }).catch((error) => {
            const detail = error instanceof Error ? error.message : String(error);
            plan.candidateStates.set(sessionId, {
              kind: 'unknown',
              message: `Deferred Agent change Session close outcome is unknown for ${sessionId}: ${detail}`,
            });
          });
        };
        try {
          if (!options.deferTransfer(candidate, resume)) queueMicrotask(resume);
        } catch (error) {
          plan.candidateStates.set(sessionId, {
            kind: 'unknown',
            message: `Agent change transfer deferral outcome is unknown for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        continue;
      }
      // A stale address or deterministic policy rejection proves that this
      // frozen candidate no longer requires the planned close.
      plan.candidateStates.set(sessionId, { kind: 'exempt' });
    }
    const unknown = [...plan.candidateStates.values()].find(
      (state): state is Extract<AgentCandidateState, { kind: 'unknown' }> => (
        state.kind === 'unknown'
      ),
    );
    if (unknown) return { kind: 'quarantined', message: unknown.message };
    const unresolved = [...plan.candidateStates.values()].filter(state => (
      state.kind === 'pending' || state.kind === 'retryable'
    ));
    if (unresolved.length > 0) {
      return {
        kind: 'pending',
        message: `Agent change has ${unresolved.length} unresolved Session close(s)`,
      };
    }
    return {
      kind: 'completed',
      closedMismatchedSessions: [...plan.candidateStates.values()].filter(state => (
        state.kind === 'closed' && state.affected
      )).length,
      deferredSessions: 0,
    };
  }

  async function completePublishedAgentChange(
    operationId: string,
    published: PublishedAgentChange,
  ): Promise<DashboardAgentChangeResult> {
    const mismatchSweep = await executeAgentCliMismatchSweep({
      operationId,
      target: published.target,
      settings: { model: published.model },
    });
    if (mismatchSweep.kind === 'conflict') return mismatchSweep;
    if (mismatchSweep.kind === 'pending') {
      return {
        kind: 'pending',
        error: 'agent_change_pending',
        message: mismatchSweep.message,
      };
    }
    if (mismatchSweep.kind === 'quarantined') {
      return {
        kind: 'quarantined',
        error: 'agent_change_outcome_unknown',
        message: mismatchSweep.message,
      };
    }
    return {
      kind: 'completed',
      response: {
        ok: true,
        cliId: published.cliId,
        cliRuntime: published.nextRuntime ?? null,
        cliPathOverride: published.nextRuntime ? null : published.nextLegacyPath ?? null,
        wrapperCli: published.wrapperCli ?? null,
        model: published.model || null,
        selectionKey: selectionKeyForBot(published.cliId, published.wrapperCli),
        closedMismatchedSessions: mismatchSweep.closedMismatchedSessions,
        readIsolation: published.publishedConfig.readIsolation === true,
        readIsolationSupported: dashboardAgentReadIsolationEnforceableFor(
          published.publishedConfig,
        ),
        readIsolationCleared: published.readIsolationCleared,
        agentAvailable: published.agentAvailable,
        availabilityWarning: published.availabilityWarning,
        requiredCommand: published.requiredCommand,
        runtimeProbe: published.runtimeProbe,
      },
    };
  }

  async function executeAgentChange(
    input: DashboardAgentChangeRequest,
  ): Promise<DashboardAgentChangeResult> {
    const priorPublication = publishedAgentChanges.get(input.operationId);
    if (priorPublication) {
      return completePublishedAgentChange(input.operationId, priorPublication);
    }
    const configuration = options.agentConfiguration;
    if (!configuration) {
      return {
        kind: 'unavailable',
        error: 'agent_change_not_wired',
        message: 'Dashboard Agent configuration Adapter is not wired',
      };
    }
    let selected: ReturnType<typeof resolveCliSelection>;
    try {
      selected = resolveCliSelection(input.cliId);
    } catch (error) {
      return {
        kind: 'invalid',
        error: 'invalid_cli',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    let currentConfig: DashboardAgentConfigurationSnapshot;
    try {
      currentConfig = configuration.current();
    } catch (error) {
      return {
        kind: 'unavailable',
        error: 'agent_change_config_unavailable',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const currentSelectionKey = selectionKeyForBot(
      currentConfig.cliId,
      currentConfig.wrapperCli,
    );
    const selectionChanged = input.cliId !== currentSelectionKey;
    let nextRuntime: CliRuntimeConfig | undefined;
    let nextLegacyPath: string | undefined;
    if (input.cliRuntimePresent) {
      if (input.cliRuntime !== null) {
        if (selected.cliId !== 'codex') {
          return { kind: 'invalid', error: 'runtime_requires_codex' };
        }
        if (selected.wrapperCli) {
          return { kind: 'invalid', error: 'runtime_wrapper_conflict' };
        }
        try {
          nextRuntime = normalizeCliRuntimeConfig(input.cliRuntime, 'cliRuntime');
        } catch (error) {
          return {
            kind: 'invalid',
            error: 'invalid_cli_runtime',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
    } else if (!selectionChanged) {
      nextRuntime = currentConfig.cliRuntime;
      nextLegacyPath = nextRuntime ? undefined : currentConfig.cliPathOverride;
    }

    const effectivePath = nextRuntime?.executable ?? nextLegacyPath;
    const availability = checkCliAvailability({
      cliId: selected.cliId,
      wrapperCli: selected.wrapperCli,
      cliPathOverride: effectivePath,
    });
    let runtimeProbe: DashboardAgentChangeResponse['runtimeProbe'];
    if (input.cliRuntimePresent && nextRuntime) {
      if (!availability.available) {
        return {
          kind: 'invalid',
          error: 'runtime_unavailable',
          message: availability.reason ?? 'runtime executable is unavailable',
        };
      }
      try {
        const raw = execFileSync(
          availability.resolvedPath ?? nextRuntime.executable,
          ['--version'],
          {
            encoding: 'utf8',
            timeout: 5_000,
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 2 * 1024 * 1024,
          },
        ).trim();
        const version = raw.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
        if (!version) throw new Error(`无法识别 --version 输出：${raw.slice(0, 120)}`);
        runtimeProbe = {
          version,
          updateProvider: nextRuntime.update?.provider ?? 'auto',
        };
      } catch (error) {
        return {
          kind: 'invalid',
          error: 'runtime_version_probe_failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const availabilityWarning = availability.available
      ? undefined
      : `配置已保存，但所选 Agent 当前无法启动：${availability.reason ?? '本地启动依赖不可用'}。请先在 daemon 所在机器安装或修正 PATH / CLI 路径。`;
    const target: SessionCliSelectionTarget = {
      cliId: selected.cliId,
      ...(selected.wrapperCli ? { wrapperCli: selected.wrapperCli } : {}),
      ...(nextRuntime ? { cliRuntime: nextRuntime } : {}),
      ...(effectivePath ? { cliPathOverride: effectivePath } : {}),
    };
    let preflight: DashboardAgentChangePreflightResult;
    try {
      preflight = await preflightAgentChange({
        operationId: input.operationId,
        target,
        settings: { model: input.model },
      });
    } catch (error) {
      return {
        kind: 'unavailable',
        error: 'agent_change_preflight_unavailable',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (preflight.kind !== 'ready') return preflight;

    const readIsolationSupported = dashboardAgentReadIsolationEnforceableFor(target);
    let published: Awaited<ReturnType<DashboardAgentConfigurationPort['publish']>>;
    try {
      published = await configuration.publish({
        target,
        model: input.model,
        readIsolationSupported,
      });
    } catch (error) {
      return {
        kind: 'quarantined',
        error: 'agent_change_outcome_unknown',
        message: `Agent configuration publication outcome is unknown: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!published.ok) {
      return { kind: 'invalid', error: published.reason };
    }
    const publication: PublishedAgentChange = {
      target,
      model: input.model,
      cliId: selected.cliId,
      wrapperCli: selected.wrapperCli,
      nextRuntime,
      nextLegacyPath,
      publishedConfig: published.config,
      readIsolationCleared: published.readIsolationCleared,
      agentAvailable: availability.available,
      availabilityWarning,
      requiredCommand: availability.command,
      runtimeProbe,
    };
    publishedAgentChanges.set(input.operationId, publication);
    return completePublishedAgentChange(input.operationId, publication);
  }

  async function execute(input: {
    readonly operationId: string;
    readonly mode: DashboardHostMaintenanceMode;
  }, plan: HostMaintenanceBatchPlan): Promise<DashboardHostMaintenanceResult> {
    const activeInventory = inspectOwnerActiveSessions(
      options.ownerLarkAppId,
      options.activeSessions,
    );
    if (activeInventory.kind === 'notReady') {
      return { kind: 'quarantined', message: activeInventory.message };
    }
    let storedInventory: OwnerStoredInventory;
    try {
      storedInventory = inspectOwnerStoredSessions(
        options.ownerLarkAppId,
        options.listSessions(),
      );
    } catch (error) {
      return {
        kind: 'retryable',
        mode: input.mode,
        candidates: plan.candidateIds?.length ?? 0,
        affected: plan.affected.size,
        message: `Host maintenance inventory is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (storedInventory.kind === 'notReady') {
      return { kind: 'quarantined', message: storedInventory.message };
    }
    if (!plan.candidateIds) {
      const candidateIds = input.mode === 'clean_stopped'
        ? storedInventory.sessions
          .filter(session => (
            session.status === 'active'
            && isSessionStopped(session)
          ))
          .map(session => session.sessionId)
        : activeInventory.sessions
          .filter(session => (
            !!session.worker
            && !session.worker.killed
            && !session.adoptedFrom
            && !session.initConfig?.adoptMode
            && isSuspendableBackendType(session.initConfig?.backendType)
            && session.lastScreenStatus === 'idle'
          ))
          .map(session => session.session.sessionId);
      plan.candidateIds = Object.freeze([...new Set(candidateIds)]);
      for (const sessionId of plan.candidateIds) plan.unresolved.add(sessionId);
    }

    const attemptIds = [...plan.unresolved];
    const settled = await Promise.all(attemptIds.map(async sessionId => {
      try {
        const outcome = await options.submit({
          target: { kind: 'externalSession', sessionId },
          idempotencyKey: `${input.operationId}:${sessionId}`,
          command: {
            kind: 'control.mutate',
            input: input.mode === 'clean_stopped'
              ? { kind: 'close', reason: 'prune' }
              : { kind: 'suspend', source: 'hostOverload' },
          },
        });
        if (outcome.kind === 'ambiguous' || outcome.kind === 'quarantined') {
          return {
            kind: 'unknown' as const,
            sessionId,
            message: outcome.message,
          };
        }
        if (outcome.kind === 'retryable') {
          logger.warn(
            `[overload-sweep] ${input.mode} retryable for ${sessionId.slice(0, 8)}: `
            + outcome.message,
          );
          return { kind: 'retryable' as const, sessionId, message: outcome.message };
        }
        if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') {
          logger.warn(
            `[overload-sweep] ${input.mode} refused for ${sessionId.slice(0, 8)}: `
            + `${'message' in outcome ? outcome.message : outcome.kind}`,
          );
          return { kind: 'settled' as const, sessionId, affected: false };
        }
        const affected = input.mode === 'clean_stopped'
          ? outcome.result?.kind === 'closed' && !outcome.result.alreadyClosed
          : outcome.result?.kind === 'suspended' && outcome.result.suspended;
        return { kind: 'settled' as const, sessionId, affected };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[overload-sweep] ${input.mode} failed for ${sessionId.slice(0, 8)}: `
          + message,
        );
        return { kind: 'unknown' as const, sessionId, message };
      }
    }));

    const unknown = settled.find(candidate => candidate.kind === 'unknown');
    if (unknown) {
      return {
        kind: 'quarantined',
        message: `Host maintenance ${input.mode} outcome is unknown for ${unknown.sessionId}: ${unknown.message}`,
      };
    }

    for (const candidate of settled) {
      if (candidate.kind !== 'settled') continue;
      plan.unresolved.delete(candidate.sessionId);
      if (candidate.affected) plan.affected.add(candidate.sessionId);
    }
    if (settled.some(candidate => candidate.kind === 'retryable')) {
      return {
        kind: 'retryable',
        mode: input.mode,
        candidates: plan.candidateIds.length,
        affected: plan.affected.size,
        message: `Host maintenance ${input.mode} has ${plan.unresolved.size} retryable candidate(s)`,
      };
    }

    return {
      kind: 'completed',
      mode: input.mode,
      candidates: plan.candidateIds.length,
      affected: plan.affected.size,
    };
  }

  async function runBatchAttempt(
    input: { readonly operationId: string; readonly mode: DashboardHostMaintenanceMode },
    plan: HostMaintenanceBatchPlan,
  ): Promise<DashboardHostMaintenanceResult> {
    const terminal = Promise.resolve().then(() => execute(input, plan)).catch(error => ({
      kind: 'quarantined' as const,
      message: `Host maintenance outcome is unknown: ${error instanceof Error ? error.message : String(error)}`,
    }));
    batches.set(input.operationId, { mode: input.mode, plan, terminal });
    const outcome = await terminal;
    if (outcome.kind === 'retryable') {
      batches.set(input.operationId, { mode: input.mode, plan });
    } else {
      batches.set(input.operationId, { mode: input.mode, plan, outcome });
    }
    return outcome;
  }

  return {
    counts() {
      const activeInventory = inspectOwnerActiveSessions(
        options.ownerLarkAppId,
        options.activeSessions,
      );
      if (activeInventory.kind === 'notReady') return activeInventory;
      try {
        const storedInventory = inspectOwnerStoredSessions(
          options.ownerLarkAppId,
          options.listSessions(),
        );
        if (storedInventory.kind === 'notReady') return storedInventory;
        const stopped = storedInventory.sessions.filter(session => (
          session.status === 'active'
          && isSessionStopped(session)
        )).length;
        const idle = activeInventory.sessions.filter(session => (
          !!session.worker
          && !session.worker.killed
          && !session.adoptedFrom
          && !session.initConfig?.adoptMode
          && isSuspendableBackendType(session.initConfig?.backendType)
          && session.lastScreenStatus === 'idle'
        )).length;
        return { kind: 'ready', stopped, idle };
      } catch (error) {
        return {
          kind: 'notReady',
          message: `Host maintenance inventory is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },

    async changeAgent(input) {
      const requestHash = computeInputHash({
        cliId: input.cliId,
        model: input.model,
        cliRuntimePresent: input.cliRuntimePresent,
        cliRuntime: input.cliRuntime,
      });
      const prior = agentChangeOperations.get(input.operationId);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          return {
            kind: 'conflict',
            message: 'Agent change operation identity belongs to another request',
          };
        }
        if ('terminal' in prior) return prior.terminal;
        if ('outcome' in prior) return prior.outcome;
      }
      const terminal = Promise.resolve().then(() => withBotTurnMutation(
        options.ownerLarkAppId,
        () => executeAgentChange(input),
      ));
      agentChangeOperations.set(input.operationId, { requestHash, terminal });
      const outcome = await terminal;
      if (outcome.kind === 'blocked' || outcome.kind === 'unavailable') {
        agentChanges.delete(input.operationId);
        agentChangeOperations.set(input.operationId, { requestHash, retryable: true });
      } else if (outcome.kind === 'pending') {
        agentChangeOperations.set(input.operationId, { requestHash, retryable: true });
      } else {
        agentChangeOperations.set(input.operationId, { requestHash, outcome });
      }
      return outcome;
    },

    async sweep(input) {
      const prior = batches.get(input.operationId);
      if (prior) {
        if (prior.mode !== input.mode) {
          return {
            kind: 'conflict',
            message: 'Host maintenance operation identity belongs to another mode',
          };
        }
        if ('terminal' in prior) return prior.terminal;
        if ('outcome' in prior) return prior.outcome;
        return runBatchAttempt(input, prior.plan);
      }

      // Publish the receipt before any candidate lookup can synchronously
      // re-enter this port.
      return runBatchAttempt(input, { unresolved: new Set(), affected: new Set() });
    },
  };
}
