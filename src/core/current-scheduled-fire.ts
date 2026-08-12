/**
 * Current Target-A Adapter for scheduled Session commands.
 *
 * The scheduler supplies only a stable ScheduledFireEnvelope. This Adapter
 * owns Lark route materialization, Current Session publication and staged
 * Agent CLI hand-off. It intentionally provides process-local dedup only;
 * schedules.json remains the deadline authority and is not a firing ledger.
 */

import { getAllBots } from '../bot-registry.js';
import { randomUUID } from 'node:crypto';
import { localeForBot, t } from '../i18n/index.js';
import { chatAppLink, normalizeBrand, threadAppLink } from '../im/lark/lark-hosts.js';
import * as messageQueue from '../services/message-queue.js';
import * as sessionStore from '../services/session-store.js';
import { resolveRegularGroupMode } from '../services/chat-reply-mode-store.js';
import {
  ensureDefaultWhiteboard,
  getWhiteboard,
  whiteboardEnabled,
} from '../services/whiteboard-store.js';
import { computeInputHash } from '../utils/canonical-input-hash.js';
import { logger } from '../utils/logger.js';
import {
  buildFollowUpCliInput,
  buildNewTopicCliInput,
  buildSilentScheduleHint,
  rememberLastCliInput,
  resolveScheduledTaskExecutionPosition,
  resolveScheduledTaskScope,
  type RefreshCliVersion,
} from './session-manager.js';
import {
  currentRouteAdmissionKey,
  reserveCurrentRouteAdmission,
} from './current-route-admission.js';
import { beginReplyTargetTurn } from './reply-target.js';
import { markSessionActivity } from './session-activity.js';
import { hasProtectedSessionMutationOwnership } from './session-mutation-guard.js';
import {
  createManualScheduledFireIdentity,
  createScheduledFireEnvelope,
  type ScheduledFireEnvelope,
  type ScheduledFireSubmitOutcome,
} from './scheduled-fire.js';
import type {
  CommandOutcomeFor,
  ControlMutationCommandOutcome,
  ScheduledFireCommand,
  ScheduledFireCommandOutcome,
  ScheduledFireEffectSettlement,
  ScheduledFirePort,
  ScheduledFireTransitionResult,
  SessionCommand,
  SessionCommandRequest,
  SessionProjection,
  SessionRuntime,
} from './session-runtime.js';
import { createSessionRuntimeHost } from './session-runtime.js';
import {
  ensureCurrentSessionActivation,
  currentSessionActivationCoordinator,
  type CurrentSessionActivationCoordinator,
} from './current-session-activation.js';
import { createCurrentSessionControlPort } from './current-session-control.js';
import { createCurrentRouteScratchRetirementPort } from './current-route-scratch-retirement.js';
import type { SessionActivationOutcome } from './session-activation-runtime.js';
import {
  activeSessionAnchorId,
  activeSessionKey,
  sessionKey,
  type DaemonSession,
} from './types.js';
import {
  getDaemonBootId,
  getCurrentCliVersion,
  isRelayableRealSession,
  sendWorkerInput,
  setActiveSessionIfActive,
} from './worker-pool.js';
import { isDisposableCurrentRouteScratch } from './current-route-scratch.js';
import {
  armSilentScheduledTurn,
  disarmSilentScheduledTurn,
} from './silent-schedule-turns.js';

interface CurrentScheduledRoutePlan {
  readonly fire: ScheduledFireEnvelope;
  readonly current: DaemonSession;
  readonly bot: ReturnType<typeof getAllBots>[number];
  readonly isContinuation: boolean;
  readonly newlyCreated: boolean;
  readonly sharedTopicRootId?: string;
}

interface PreparedInput {
  readonly plan: CurrentScheduledRoutePlan;
  readonly input: ReturnType<typeof buildFollowUpCliInput>;
  readonly whiteboardId?: string;
}

interface CurrentScheduledDownstream {
  readonly runtime: SessionRuntime;
  readonly projection: SessionProjection;
}

type CurrentScheduledRouteEffectPhase =
  | { readonly kind: 'preEffect'; readonly effectsStarted: false }
  | { readonly kind: 'effectsStarted'; readonly effectsStarted: true };

interface CurrentScheduledRouteEffectTracker {
  readonly effectsStarted: boolean;
  markStarted(): void;
}

function createScheduledRouteEffectTracker(): CurrentScheduledRouteEffectTracker {
  let phase: CurrentScheduledRouteEffectPhase = {
    kind: 'preEffect',
    effectsStarted: false,
  };
  return {
    get effectsStarted() { return phase.effectsStarted; },
    markStarted() {
      phase = { kind: 'effectsStarted', effectsStarted: true };
    },
  };
}

type ScheduledEffect =
  | { readonly kind: 'prepareInput'; readonly plan: CurrentScheduledRoutePlan }
  | { readonly kind: 'sendInput'; readonly prepared: PreparedInput }
  | {
      readonly kind: 'fork';
      readonly prepared: PreparedInput;
      readonly replaceCurrent: boolean;
    };

type ScheduledContinuation =
  | { readonly kind: 'prepared'; readonly plan: CurrentScheduledRoutePlan }
  | { readonly kind: 'sent'; readonly prepared: PreparedInput }
  | {
      readonly kind: 'forked';
      readonly prepared: PreparedInput;
      readonly replaceCurrent: boolean;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionCreatedAtMs(session: { createdAt?: string }): number {
  return session.createdAt ? (Date.parse(session.createdAt) || Date.now()) : Date.now();
}

function resolveWhiteboardId(plan: CurrentScheduledRoutePlan): string | undefined {
  if (!whiteboardEnabled()) return undefined;
  const existing = plan.current.session.whiteboardId;
  if (existing && getWhiteboard(existing)) return existing;
  try {
    return ensureDefaultWhiteboard({
      larkAppId: plan.current.larkAppId,
      chatId: plan.current.session.chatId,
      workingDir: plan.current.session.workingDir ?? plan.current.workingDir,
      sessionId: plan.current.session.sessionId,
    }).id;
  } catch (error) {
    logger.warn(
      `[whiteboard] scheduled preparation failed for ${plan.current.session.sessionId}: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

function prepareInput(plan: CurrentScheduledRoutePlan): PreparedInput {
  const { current, fire, bot } = plan;
  const larkAppId = current.larkAppId;
  const silent = fire.task.silent === true;
  const firePrompt = silent
    ? `${buildSilentScheduleHint(fire.task.name, localeForBot(larkAppId))}\n\n${fire.task.prompt}`
    : fire.task.prompt;
  const whiteboardId = resolveWhiteboardId(plan);
  const input = plan.isContinuation
    ? buildFollowUpCliInput(firePrompt, current.session.sessionId, {
        isAdoptMode: false,
        cliId: current.session.cliId ?? bot.config.cliId,
        cliPathOverride: current.session.cliPathOverride ?? bot.config.cliPathOverride,
        locale: localeForBot(larkAppId),
        larkAppId,
        chatId: fire.task.chatId,
        whiteboardId,
      })
    : buildNewTopicCliInput(
        firePrompt,
        current.session.sessionId,
        bot.config.cliId,
        bot.config.cliPathOverride,
        undefined,
        undefined,
        undefined,
        undefined,
        { name: bot.botName, openId: bot.botOpenId },
        localeForBot(larkAppId),
        undefined,
        { larkAppId, chatId: fire.task.chatId, whiteboardId },
      );
  return { plan, input, whiteboardId };
}

function currentPlanStillOwns(
  activeSessions: Map<string, DaemonSession>,
  plan: CurrentScheduledRoutePlan,
): boolean {
  return plan.current.session.status === 'active'
    && activeSessions.get(activeSessionKey(plan.current)) === plan.current;
}

export interface CurrentScheduledFireAdapter {
  readonly port: ScheduledFirePort;
  wrapRuntime(downstream: {
    readonly runtime: SessionRuntime;
    readonly projection: SessionProjection;
  }): SessionRuntime;
}

export function createCurrentScheduledFireAdapter(options: {
  readonly ownerLarkAppId: string;
  readonly activeSessions: Map<string, DaemonSession>;
  readonly refreshCliVersion: RefreshCliVersion;
  /** Stable owner/epoch activation capability supplied by daemon composition. */
  readonly activation?: Pick<CurrentSessionActivationCoordinator, 'ensure'>;
  /** Synchronous owner-store revision fence. Omitted only by compatibility tests. */
  readonly readDefinitionRevision?: (scheduleId: string) => number | undefined;
}): CurrentScheduledFireAdapter {
  const routePlans = new Map<string, CurrentScheduledRoutePlan>();

  const finishPlan = (plan: CurrentScheduledRoutePlan): void => {
    if (routePlans.get(plan.fire.runId) === plan) routePlans.delete(plan.fire.runId);
  };

  const port: ScheduledFirePort = {
    begin({ sessionId, fire }): ScheduledFireTransitionResult {
      const plan = routePlans.get(fire.runId);
      if (!plan || plan.fire !== fire || plan.current.session.sessionId !== sessionId) {
        return { kind: 'retryable', message: 'scheduled route plan is no longer current' };
      }
      if (!currentPlanStillOwns(options.activeSessions, plan)) {
        finishPlan(plan);
        return { kind: 'retryable', message: 'scheduled Session owner changed before dispatch' };
      }
      return {
        kind: 'effect',
        intent: { kind: 'prepareInput', plan } satisfies ScheduledEffect,
        continuation: { kind: 'prepared', plan } satisfies ScheduledContinuation,
      };
    },

    async execute(intent: unknown): Promise<unknown> {
      const effect = intent as ScheduledEffect;
      if (effect.kind === 'prepareInput') return prepareInput(effect.plan);
      if (effect.kind === 'sendInput') {
        return sendWorkerInput(
          effect.prepared.plan.current,
          effect.prepared.input,
          effect.prepared.plan.fire.runId,
        );
      }
      if (effect.kind === 'fork') {
        const { plan, input } = effect.prepared;
        const resumeOrTurnId = plan.isContinuation && !plan.newlyCreated
          ? { resume: plan.current.hasHistory, turnId: plan.fire.runId }
          : plan.fire.runId;
        const requestIdentity = effect.replaceCurrent
          ? `${plan.fire.runId}:replacement`
          : plan.fire.runId;
        return options.activation
          ? options.activation.ensure({
              sessionId: plan.current.session.sessionId,
              requestIdentity,
              cause: effect.replaceCurrent ? 'replacement' : 'scheduler',
              promptInput: input,
              resumeOrTurnId,
            })
          : ensureCurrentSessionActivation({
              ownerLarkAppId: options.ownerLarkAppId,
              activeSessions: options.activeSessions,
              sessionId: plan.current.session.sessionId,
              requestIdentity,
              cause: effect.replaceCurrent ? 'replacement' : 'scheduler',
              promptInput: input,
              resumeOrTurnId,
            });
      }
      throw new Error('unknown scheduled effect');
    },

    resume(
      continuation: unknown,
      settlement: ScheduledFireEffectSettlement,
    ): ScheduledFireTransitionResult {
      const next = continuation as ScheduledContinuation;
      const plan = next.kind === 'prepared' ? next.plan : next.prepared.plan;
      if (!currentPlanStillOwns(options.activeSessions, plan)) {
        finishPlan(plan);
        if (next.kind === 'prepared') {
          return { kind: 'retryable', message: 'scheduled Session owner changed during preparation' };
        }
        if (next.kind === 'sent') {
          if (settlement.kind === 'returned' && settlement.value === true) {
            return {
              kind: 'unknown',
              message: 'scheduled input was accepted before the Session owner changed',
            };
          }
          if (plan.fire.task.silent === true) {
            disarmSilentScheduledTurn(plan.current, plan.fire.runId);
          }
          return {
            kind: 'retryable',
            message: 'scheduled Session owner changed after the live send was refused',
          };
        }
        if (settlement.kind === 'returned') {
          const activation = settlement.value as SessionActivationOutcome | undefined;
          const terminal = activation?.kind === 'duplicate' ? activation.outcome : activation;
          if (terminal?.kind === 'retryable'
              || terminal?.kind === 'staleBeforeEffect'
              || terminal?.kind === 'rejected') {
            if (plan.fire.task.silent === true) {
              disarmSilentScheduledTurn(plan.current, plan.fire.runId);
            }
            return {
              kind: 'retryable',
              message: terminal.message,
            };
          }
        }
        return {
          kind: 'unknown',
          message: 'scheduled activation may have started before the Session owner changed',
        };
      }
      if (next.kind === 'prepared') {
        if (settlement.kind === 'threw') {
          finishPlan(plan);
          return {
            kind: 'retryable',
            message: `scheduled input preparation failed: ${errorMessage(settlement.error)}`,
          };
        }
        const prepared = settlement.value as PreparedInput;
        if (!prepared || prepared.plan !== plan) {
          finishPlan(plan);
          return { kind: 'unknown', message: 'scheduled input preparation returned an invalid result' };
        }
        const ds = plan.current;
        let sessionChanged = false;
        if (prepared.whiteboardId && ds.session.whiteboardId !== prepared.whiteboardId) {
          ds.session.whiteboardId = prepared.whiteboardId;
          sessionChanged = true;
        }
        markSessionActivity(ds);
        if (plan.sharedTopicRootId) {
          beginReplyTargetTurn(ds, plan.sharedTopicRootId, plan.fire.runId);
          sessionChanged = true;
        }
        if (sessionChanged) sessionStore.updateSession(ds.session);
        rememberLastCliInput(ds, plan.fire.task.prompt, prepared.input);
        if (plan.fire.task.silent === true) armSilentScheduledTurn(ds, plan.fire.runId);
        if (plan.isContinuation && ds.worker && !ds.worker.killed) {
          return {
            kind: 'effect',
            intent: { kind: 'sendInput', prepared } satisfies ScheduledEffect,
            continuation: { kind: 'sent', prepared } satisfies ScheduledContinuation,
          };
        }
        return {
          kind: 'effect',
          intent: {
            kind: 'fork', prepared, replaceCurrent: false,
          } satisfies ScheduledEffect,
          continuation: {
            kind: 'forked', prepared, replaceCurrent: false,
          } satisfies ScheduledContinuation,
        };
      }
      if (next.kind === 'sent') {
        if (settlement.kind === 'returned' && settlement.value === true) {
          finishPlan(plan);
          return { kind: 'committed' };
        }
        // A live worker refusal/throw is proven not accepted by the Current
        // synchronous IPC seam; preserve the legacy cold-resume fallback.
        return {
          kind: 'effect',
          intent: {
            kind: 'fork', prepared: next.prepared, replaceCurrent: true,
          } satisfies ScheduledEffect,
          continuation: {
            kind: 'forked', prepared: next.prepared, replaceCurrent: true,
          } satisfies ScheduledContinuation,
        };
      }
      if (settlement.kind === 'threw') {
        if (plan.fire.task.silent === true) {
          disarmSilentScheduledTurn(plan.current, plan.fire.runId);
        }
        finishPlan(plan);
        return {
          kind: 'unknown',
          message: `scheduled worker dispatch outcome is unknown: ${errorMessage(settlement.error)}`,
        };
      }
      const activation = settlement.value as SessionActivationOutcome | undefined;
      const terminal = activation?.kind === 'duplicate' ? activation.outcome : activation;
      if (!terminal || terminal.kind !== 'active') {
        if (plan.fire.task.silent === true) {
          disarmSilentScheduledTurn(plan.current, plan.fire.runId);
        }
        finishPlan(plan);
        if (terminal?.kind === 'retryable'
            || terminal?.kind === 'staleBeforeEffect'
            || terminal?.kind === 'rejected') {
          return {
            kind: 'retryable',
            message: terminal.kind === 'rejected'
              ? terminal.message
              : terminal.message,
          };
        }
        return {
          kind: 'unknown',
          message: terminal && 'message' in terminal
            ? terminal.message
            : 'scheduled activation returned an invalid outcome',
        };
      }
      if (terminal.action === 'alreadyActive' && !next.replaceCurrent) {
        return {
          kind: 'effect',
          intent: { kind: 'sendInput', prepared: next.prepared } satisfies ScheduledEffect,
          continuation: { kind: 'sent', prepared: next.prepared } satisfies ScheduledContinuation,
        };
      }
      if (plan.newlyCreated) {
        plan.current.initialStartPending = false;
        plan.current.pendingPrompt = undefined;
      }
      finishPlan(plan);
      return { kind: 'committed' };
    },
  };

  const targetNotice = async (params: {
    readonly kind: 'chat' | 'thread';
    readonly taskName: string;
    readonly targetAppId: string;
    readonly targetChatId: string;
    readonly targetRootMessageId?: string;
    readonly targetBrand?: unknown;
    readonly localeAppId: string;
  }): Promise<string> => {
    const { getMessageThreadId } = await import('../im/lark/client.js');
    const brand = normalizeBrand(params.targetBrand);
    let link = chatAppLink(params.targetChatId, brand);
    if (params.kind === 'thread' && params.targetRootMessageId) {
      try {
        const threadId = await getMessageThreadId(
          params.targetAppId,
          params.targetRootMessageId,
        );
        if (threadId) link = threadAppLink(params.targetChatId, threadId, brand);
      } catch (error) {
        logger.warn(
          `[scheduler] Failed to resolve target topic ${params.targetRootMessageId}; `
          + `falling back to chat link (${errorMessage(error)})`,
        );
      }
    }
    return t(
      params.kind === 'thread'
        ? 'scheduler.task_triggered_target_thread'
        : 'scheduler.task_triggered_target_chat',
      { name: params.taskName, link },
      localeForBot(params.localeAppId),
    );
  };

  const routeAdmissionKey = (fire: ScheduledFireEnvelope): string => {
    const task = fire.task;
    const executionPosition = resolveScheduledTaskExecutionPosition(task);
    const scope = resolveScheduledTaskScope(task);
    const chatType = task.chatType === 'p2p' ? 'p2p' : 'group';
    if (executionPosition === 'new-topic') {
      return `${options.ownerLarkAppId}\u0000schedule-run\u0000${fire.runId}`;
    }
    const canonicalAnchor = scope === 'thread' && task.rootMessageId
      ? task.rootMessageId
      : task.chatId;
    return currentRouteAdmissionKey({
      ownerLarkAppId: options.ownerLarkAppId,
      scope,
      canonicalAnchor,
      chatId: task.chatId,
      chatType,
    });
  };

  const retireDisposableRouteScratch = async (input: {
    readonly fire: ScheduledFireEnvelope;
    readonly current: DaemonSession;
    readonly downstream: CurrentScheduledDownstream;
    readonly routeReservation: object;
    readonly effects: CurrentScheduledRouteEffectTracker;
  }): Promise<ScheduledFireCommandOutcome | undefined> => {
    const { current } = input;
    const routeKey = activeSessionKey(current);
    const expectedRoute = {
      scope: current.scope,
      canonicalAnchor: activeSessionAnchorId(current),
      chatId: current.chatId,
      chatType: current.chatType,
    } as const;
    const routeBusy = (message: string): ScheduledFireCommandOutcome => ({
      kind: 'rejected',
      reason: 'routeBusy',
      message,
    });
    const classifyDeparture = (unresolvedMessage: string): ScheduledFireCommandOutcome | undefined => {
      const winner = options.activeSessions.get(routeKey);
      if (!winner) return undefined;
      if (winner !== current) {
        return routeBusy(`scheduled route was claimed by ${winner.session.sessionId}`);
      }
      return { kind: 'quarantined', message: unresolvedMessage };
    };

    let projected: Awaited<ReturnType<SessionProjection['read']>>;
    try {
      projected = await input.downstream.projection.read({
        kind: 'byExternalSession',
        sessionId: current.session.sessionId,
      });
    } catch (error) {
      return {
        kind: 'retryable',
        message: `scheduled route scratch projection failed: ${errorMessage(error)}`,
      };
    }
    if (projected.kind === 'notReady') {
      return { kind: 'retryable', message: projected.message };
    }
    if (projected.kind === 'notFound') {
      return classifyDeparture(
        'scheduled route scratch remains Current without an exact Session projection',
      );
    }
    if (projected.kind !== 'one'
        || projected.session.sessionId !== current.session.sessionId) {
      return {
        kind: 'quarantined',
        message: 'scheduled route scratch projection did not preserve its exact Session identity',
      };
    }
    const routeMatches = projected.session.recordStatus === 'active'
      && (expectedRoute.scope === 'thread'
        ? projected.session.route.kind === 'thread'
          && projected.session.route.anchorId === expectedRoute.canonicalAnchor
        : projected.session.route.kind === 'chat'
          && projected.session.route.chatId === expectedRoute.chatId);
    if (!routeMatches) {
      return classifyDeparture(
        'scheduled route scratch remained Current after leaving its exact route binding',
      );
    }
    const currentWinner = options.activeSessions.get(routeKey);
    if (!currentWinner) return undefined;
    if (currentWinner !== current) {
      return routeBusy(`scheduled route was claimed by ${currentWinner.session.sessionId}`);
    }
    if (!isDisposableCurrentRouteScratch(current)) {
      return routeBusy('scheduled route owner is no longer a disposable route scratch');
    }

    const closeOperation = `route-scratch:${computeInputHash({
      source: 'scheduler',
      runId: input.fire.runId,
      sessionId: current.session.sessionId,
      expectedRoute,
    })}`;
    let closed: ControlMutationCommandOutcome;
    try {
      closed = await input.downstream.runtime.submit({
        target: {
          kind: 'session',
          address: projected.session.address,
          controlRouteReservation: input.routeReservation,
        },
        idempotencyKey: closeOperation,
        command: {
          kind: 'control.mutate',
          input: {
            kind: 'close',
            reason: 'routeScratch',
            source: 'scheduler',
            expectedRoute,
          },
        },
      });
    } catch (error) {
      return {
        kind: 'quarantined',
        message: `scheduled route scratch close outcome is unknown: ${errorMessage(error)}`,
      };
    }
    if ((closed.kind === 'applied' || closed.kind === 'duplicate')
        && closed.sessionId === current.session.sessionId
        && closed.result?.kind === 'closed') {
      if (closed.result.known && !closed.result.alreadyClosed) {
        input.effects.markStarted();
      }
      return classifyDeparture(
        'scheduled route scratch close returned without retiring its exact Current owner',
      );
    }
    if (closed.kind === 'retryable') return closed;
    if (closed.kind === 'notWired') {
      return { kind: 'retryable', message: closed.message };
    }
    if (closed.kind === 'staleAddress') {
      return {
        kind: 'retryable',
        message: 'scheduled route scratch address became stale before the close effect',
      };
    }
    if (closed.kind === 'rejected' && closed.reason === 'sessionNotFound') {
      return classifyDeparture(
        'scheduled route scratch address became stale while its Current owner remained',
      );
    }
    if (closed.kind === 'rejected' && closed.reason === 'transitionRejected') {
      return routeBusy(closed.message);
    }
    return {
      kind: 'quarantined',
      message: closed.kind === 'ambiguous' || closed.kind === 'quarantined'
        ? `scheduled route scratch close is unresolved: ${closed.message}`
        : 'scheduled route scratch close returned no exact closed proof',
    };
  };

  const prepareRoute = async (
    fire: ScheduledFireEnvelope,
    bot: ReturnType<typeof getAllBots>[number],
    downstream: CurrentScheduledDownstream,
    routeAdmission: { readonly key: string; readonly token: object },
    effects: CurrentScheduledRouteEffectTracker,
  ): Promise<CurrentScheduledRoutePlan | ScheduledFireCommandOutcome> => {
    const task = fire.task;
    const larkAppId = bot.config.larkAppId;
    const { getChatMode, sendMessage, replyMessage } = await import('../im/lark/client.js');
    const executionPosition = resolveScheduledTaskExecutionPosition(task);
    const scope = resolveScheduledTaskScope(task);
    const silent = task.silent === true;
    let anchor: string;
    let isContinuation = false;
    let sharedTopicRootId: string | undefined;

    if (executionPosition === 'new-topic') {
      if (silent) {
        anchor = `schedule-run:${encodeURIComponent(fire.runId)}`;
      } else {
        if (task.creatorRootMessageId && task.creatorChatId !== task.chatId) {
          const creatorAppId = task.creatorLarkAppId ?? larkAppId;
          effects.markStarted();
          void targetNotice({
            kind: 'chat', taskName: task.name, targetAppId: larkAppId,
            targetChatId: task.chatId, targetBrand: bot.config.brand,
            localeAppId: creatorAppId,
          }).then(content => replyMessage(
            creatorAppId, task.creatorRootMessageId!, content, 'text', true,
          )).catch(error => logger.warn(
            `[scheduler] Failed to notify creator thread ${task.creatorRootMessageId} (${errorMessage(error)})`,
          ));
        }
        effects.markStarted();
        anchor = await sendMessage(
          larkAppId,
          task.chatId,
          task.topicTitle?.trim()
            || t('scheduler.task_started', { name: task.name }, localeForBot(larkAppId)),
        );
      }
    } else if (scope === 'chat') {
      const chatMode = await getChatMode(larkAppId, task.chatId, { forceRefresh: true });
      let topLevelTriggerId: string | undefined;
      if (!silent) {
        if (task.creatorRootMessageId && task.creatorChatId !== task.chatId) {
          const creatorAppId = task.creatorLarkAppId ?? larkAppId;
          effects.markStarted();
          void targetNotice({
            kind: 'chat', taskName: task.name, targetAppId: larkAppId,
            targetChatId: task.chatId, targetBrand: bot.config.brand,
            localeAppId: creatorAppId,
          }).then(content => replyMessage(
            creatorAppId, task.creatorRootMessageId!, content, 'text', true,
          )).catch(error => logger.warn(
            `[scheduler] Failed to notify creator thread ${task.creatorRootMessageId} (${errorMessage(error)})`,
          ));
        }
        try {
          effects.markStarted();
          topLevelTriggerId = await sendMessage(
            larkAppId,
            task.chatId,
            t('scheduler.task_started', { name: task.name }, localeForBot(larkAppId)),
          );
        } catch (error) {
          logger.warn(
            `[scheduler] Failed to post start banner in chat ${task.chatId} (${errorMessage(error)})`,
          );
        }
      }
      const regularGroupMode = task.chatType === 'p2p'
        ? 'chat'
        : resolveRegularGroupMode(larkAppId, task.chatId);
      const opensIndependentTopic = !!topLevelTriggerId
        && (chatMode === 'topic' || regularGroupMode === 'new-topic');
      if (opensIndependentTopic) {
        anchor = topLevelTriggerId!;
      } else {
        anchor = task.chatId;
        isContinuation = options.activeSessions.has(sessionKey(anchor, larkAppId));
        if (topLevelTriggerId && chatMode === 'group' && regularGroupMode === 'shared') {
          sharedTopicRootId = topLevelTriggerId;
        }
      }
    } else {
      const isCrossThread = !!task.creatorRootMessageId
        && !!task.rootMessageId
        && task.creatorRootMessageId !== task.rootMessageId;
      if (isCrossThread) {
        if (!silent) {
          const creatorAppId = task.creatorLarkAppId ?? larkAppId;
          effects.markStarted();
          void targetNotice({
            kind: 'thread', taskName: task.name, targetAppId: larkAppId,
            targetChatId: task.chatId, targetRootMessageId: task.rootMessageId,
            targetBrand: bot.config.brand, localeAppId: creatorAppId,
          }).then(content => replyMessage(
            creatorAppId, task.creatorRootMessageId!, content, 'text', true,
          )).catch(error => logger.warn(
            `[scheduler] Failed to notify creator thread ${task.creatorRootMessageId} (${errorMessage(error)})`,
          ));
        }
        anchor = task.rootMessageId!;
        isContinuation = true;
      } else if (task.rootMessageId) {
        if (silent) {
          anchor = task.rootMessageId;
          isContinuation = true;
        } else {
          try {
            effects.markStarted();
            await replyMessage(
              larkAppId,
              task.rootMessageId,
              t('scheduler.task_started', { name: task.name }, localeForBot(larkAppId)),
              'text',
              true,
            );
            anchor = task.rootMessageId;
            isContinuation = true;
          } catch (error) {
            logger.warn(
              `[scheduler] Failed to reply in original thread ${task.rootMessageId} `
              + `(${errorMessage(error)}); falling back to new thread`,
            );
            effects.markStarted();
            anchor = await sendMessage(
              larkAppId,
              task.chatId,
              t('scheduler.task_started', { name: task.name }, localeForBot(larkAppId)),
            );
          }
        }
      } else {
        effects.markStarted();
        anchor = await sendMessage(
          larkAppId,
          task.chatId,
          t('scheduler.task_started', { name: task.name }, localeForBot(larkAppId)),
        );
      }
    }

    const deferredFreshTopic = executionPosition === 'new-topic' && silent;
    const runtimeScope: 'thread' | 'chat' = deferredFreshTopic
      ? 'chat'
      : scope === 'chat' && anchor !== task.chatId ? 'thread' : scope;
    const expectedRoute = {
      scope: runtimeScope,
      canonicalAnchor: runtimeScope === 'thread' ? anchor : task.chatId,
      chatId: task.chatId,
      chatType: task.chatType === 'p2p' ? 'p2p' : 'group',
    } as const;
    const exactAdmissionKey = deferredFreshTopic
      ? routeAdmission.key
      : currentRouteAdmissionKey({ ownerLarkAppId: options.ownerLarkAppId, ...expectedRoute });
    const projectionQuery = {
      kind: 'byRoute' as const,
      route: runtimeScope === 'thread'
        ? { kind: 'thread' as const, anchorId: anchor }
        : { kind: 'chat' as const, chatId: task.chatId },
    };

    const prepareUnderExactAdmission = async (
      routeReservation: object,
    ): Promise<CurrentScheduledRoutePlan | ScheduledFireCommandOutcome> => {
      options.refreshCliVersion(bot.config);
      const key = sessionKey(anchor, larkAppId);
      let existing = options.activeSessions.get(key);
      if (existing) {
        const reservedState = existing.pendingRepo
          ? 'pending_repo'
          : existing.pendingRepoCommitInFlight
            ? 'pending_repo_commit'
            : existing.initialStartPending
              ? 'initial_start_pending'
              : existing.worktreeCreating
                ? 'worktree_creating'
                : existing.session.queued
                  ? 'queued_backlog'
                  : undefined;
        if (reservedState) {
          return {
            kind: 'rejected',
            reason: 'routeBusy',
            message: `scheduled route owner is in ${reservedState}`,
          };
        }
        if (hasProtectedSessionMutationOwnership(existing)) {
          return {
            kind: 'rejected',
            reason: 'routeBusy',
            message: 'scheduled route has a protected activation owner',
          };
        }
        if (!isContinuation) {
          return {
            kind: 'rejected',
            reason: 'routeBusy',
            message: `scheduled fresh route was claimed by ${existing.session.sessionId}`,
          };
        }
        const resumableOwner = isRelayableRealSession(existing)
          || !!existing.session.suspendedColdResume;
        if (resumableOwner) {
          return {
            fire, current: existing, bot, isContinuation: true,
            newlyCreated: false, sharedTopicRootId,
          };
        }
        if (isDisposableCurrentRouteScratch(existing)) {
          const retirement = await retireDisposableRouteScratch({
            fire,
            current: existing,
            downstream,
            routeReservation,
            effects,
          });
          if (retirement) return retirement;
          existing = options.activeSessions.get(key);
          if (existing) {
            return {
              kind: 'rejected',
              reason: 'routeBusy',
              message: `scheduled route was claimed by ${existing.session.sessionId}`,
            };
          }
        }
        if (existing) {
          return {
            kind: 'rejected',
            reason: 'routeBusy',
            message: 'scheduled route owner is neither resumable nor disposable',
          };
        }
      }

      if (!deferredFreshTopic && !options.activeSessions.has(key)) {
        let projected: Awaited<ReturnType<SessionProjection['read']>>;
        try {
          projected = await downstream.projection.read(projectionQuery);
        } catch (error) {
          return {
            kind: 'retryable',
            message: `scheduled durable route projection failed: ${errorMessage(error)}`,
          };
        }
        if (projected.kind === 'notReady') {
          return { kind: 'retryable', message: projected.message };
        }
        if (projected.kind === 'one' && projected.session.recordStatus === 'active') {
          if (!isContinuation && runtimeScope === 'thread') {
            return {
              kind: 'rejected',
              reason: 'routeBusy',
              message: `scheduled fresh route was claimed by ${projected.session.sessionId}`,
            };
          }
          let closed: ControlMutationCommandOutcome;
          try {
            closed = await downstream.runtime.submit({
              target: {
                kind: 'session',
                address: projected.session.address,
                controlRouteReservation: routeReservation,
              },
              idempotencyKey: `route-scratch:${computeInputHash({
                source: 'scheduler',
                runId: fire.runId,
                sessionId: projected.session.sessionId,
                expectedRoute,
              })}`,
              command: {
                kind: 'control.mutate',
                input: {
                  kind: 'close',
                  reason: 'routeScratch',
                  source: 'scheduler',
                  expectedRoute,
                },
              },
            });
          } catch (error) {
            return {
              kind: 'quarantined',
              message: `scheduled durable route scratch close outcome is unknown: ${errorMessage(error)}`,
            };
          }
          if (closed.kind === 'rejected' && closed.reason === 'transitionRejected') {
            return { kind: 'rejected', reason: 'routeBusy', message: closed.message };
          }
          if (closed.kind === 'retryable') return closed;
          if (closed.kind === 'notWired') {
            return { kind: 'retryable', message: closed.message };
          }
          if (closed.kind === 'staleAddress') {
            return {
              kind: 'retryable',
              message: 'scheduled durable route scratch address became stale before the close effect',
            };
          }
          if (closed.kind === 'rejected' && closed.reason === 'sessionNotFound') {
            return {
              kind: 'retryable',
              message: 'scheduled durable route scratch departed before the close effect',
            };
          }
          if ((closed.kind === 'applied' || closed.kind === 'duplicate')
              && closed.sessionId === projected.session.sessionId
              && closed.result?.kind === 'closed') {
            if (closed.result.known && !closed.result.alreadyClosed) {
              effects.markStarted();
            }
            const liveWinner = options.activeSessions.get(key);
            if (liveWinner) {
              return {
                kind: 'rejected',
                reason: 'routeBusy',
                message: `scheduled route was claimed by ${liveWinner.session.sessionId}`,
              };
            }
            let afterClose: Awaited<ReturnType<SessionProjection['read']>>;
            try {
              afterClose = await downstream.projection.read(projectionQuery);
            } catch (error) {
              return {
                kind: 'retryable',
                message: `scheduled durable route recheck failed: ${errorMessage(error)}`,
              };
            }
            if (afterClose.kind === 'notReady') {
              return { kind: 'retryable', message: afterClose.message };
            }
            if (afterClose.kind === 'one' && afterClose.session.recordStatus === 'active') {
              return afterClose.session.sessionId === projected.session.sessionId
                ? {
                    kind: 'quarantined',
                    message: 'scheduled durable route scratch remained active after exact close proof',
                  }
                : {
                    kind: 'rejected',
                    reason: 'routeBusy',
                    message: `scheduled route was claimed by ${afterClose.session.sessionId}`,
                  };
            }
            if (afterClose.kind === 'notFound'
                || (afterClose.kind === 'one' && afterClose.session.recordStatus === 'closed')) {
              isContinuation = true;
            } else {
              return {
                kind: 'quarantined',
                message: 'scheduled durable route recheck returned no exact Session proof',
              };
            }
          } else {
            return {
              kind: 'quarantined',
              message: 'scheduled durable route owner has no exact retirement proof',
            };
          }
        } else if (projected.kind !== 'notFound') {
          return {
            kind: 'quarantined',
            message: 'scheduled durable route projection returned an invalid result',
          };
        }
      }

      effects.markStarted();
      const session = sessionStore.createSession(
        task.chatId,
        anchor,
        `${t('schedule.title_prefix', undefined, localeForBot(larkAppId))} ${task.name}`,
        task.chatType === 'p2p' ? 'p2p' : 'group',
      );
      const now = Date.now();
      session.larkAppId = larkAppId;
      session.scope = runtimeScope;
      if (deferredFreshTopic) {
        session.deferredScheduleRun = {
          taskId: task.id,
          turnId: fire.runId,
          routingAnchor: anchor,
          ...(task.topicTitle?.trim() ? { topicTitle: task.topicTitle.trim() } : {}),
          createdAt: new Date(now).toISOString(),
        };
      }
      session.lastMessageAt = new Date(now).toISOString();
      sessionStore.updateSession(session);
      messageQueue.ensureQueue(anchor);
      const current: DaemonSession = {
        session,
        worker: null,
        workerPort: null,
        workerToken: null,
        larkAppId,
        chatId: task.chatId,
        chatType: task.chatType === 'p2p' ? 'p2p' : 'group',
        scope: runtimeScope,
        spawnedAt: sessionCreatedAtMs(session),
        cliVersion: getCurrentCliVersion(),
        lastMessageAt: now,
        hasHistory: isContinuation,
        workingDir: task.workingDir,
        initialStartPending: true,
        pendingPrompt: task.silent === true
          ? `${buildSilentScheduleHint(task.name, localeForBot(larkAppId))}\n\n${task.prompt}`
          : task.prompt,
      };
      if (!setActiveSessionIfActive(options.activeSessions, key, current)) {
        const winner = options.activeSessions.get(key);
        sessionStore.closeSession(session.sessionId);
        return {
          kind: 'rejected',
          reason: 'routeBusy',
          message: `scheduled route registration lost${winner ? ` to ${winner.session.sessionId}` : ''}`,
        };
      }
      return {
        fire, current, bot, isContinuation, newlyCreated: true, sharedTopicRootId,
      };
    };

    if (exactAdmissionKey === routeAdmission.key) {
      return prepareUnderExactAdmission(routeAdmission.token);
    }
    const exactAdmission = reserveCurrentRouteAdmission(exactAdmissionKey);
    await exactAdmission.ready;
    try {
      return await prepareUnderExactAdmission(exactAdmission.token);
    } finally {
      exactAdmission.release();
    }
  };

  const wrapRuntime = (downstream: CurrentScheduledDownstream): SessionRuntime => {
    interface RouteAttempt {
      readonly terminal: Promise<ScheduledFireCommandOutcome>;
      settle(outcome: ScheduledFireCommandOutcome): void;
    }
    type RouteRecord =
      | {
          readonly requestHash: string;
          readonly state: 'received';
          readonly attempt: RouteAttempt;
        }
      | { readonly requestHash: string; readonly state: 'retryable' }
      | {
          readonly requestHash: string;
          readonly state: 'terminal';
          readonly outcome: ScheduledFireCommandOutcome;
        };
    const records = new Map<string, RouteRecord>();
    const settledOrder: Array<{ readonly runId: string; readonly record: RouteRecord }> = [];

    const retainSettled = (runId: string, record: RouteRecord): void => {
      records.set(runId, record);
      settledOrder.push({ runId, record });
      while (settledOrder.length > 1024) {
        const evicted = settledOrder.shift();
        if (evicted && records.get(evicted.runId) === evicted.record) {
          records.delete(evicted.runId);
        }
      }
    };

    const replay = (
      outcome: ScheduledFireCommandOutcome,
      state: 'inFlight' | 'inputAccepted',
    ): ScheduledFireCommandOutcome => {
      if (outcome.kind === 'applied') {
        return {
          kind: 'duplicate',
          state,
          policy: 'scheduled-process-local',
          durability: 'processLocal',
          sessionId: outcome.sessionId,
          message: 'scheduled route joined the winning Current attempt',
        };
      }
      if (outcome.kind === 'ambiguous') return { ...outcome, idempotent: true };
      return outcome;
    };

    const createAttempt = (): RouteAttempt => {
      let resolveTerminal!: (outcome: ScheduledFireCommandOutcome) => void;
      let settled = false;
      const terminal = new Promise<ScheduledFireCommandOutcome>((resolve) => {
        resolveTerminal = resolve;
      });
      return {
        terminal,
        settle(outcome) {
          if (settled) return;
          settled = true;
          resolveTerminal(outcome);
        },
      };
    };

    const submitScheduled = async (
      request: SessionCommandRequest<ScheduledFireCommand>,
    ): Promise<ScheduledFireCommandOutcome> => {
      const fire = request.command.input;
      if (request.target.kind !== 'route'
          || request.target.route.kind !== 'schedule'
          || request.target.route.runId !== fire.runId
          || request.idempotencyKey !== fire.runId) {
        return {
          kind: 'rejected', reason: 'invalidCommand',
          message: 'scheduled route target must carry the unchanged logical run id',
        };
      }
      let requestHash: string;
      try {
        requestHash = computeInputHash(fire);
      } catch (error) {
        return {
          kind: 'rejected', reason: 'invalidCommand',
          message: `scheduled route input is not canonicalizable: ${errorMessage(error)}`,
        };
      }
      const prior = records.get(fire.runId);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          return {
            kind: 'rejected', reason: 'idempotencyConflict',
            message: 'logical run id already belongs to a different scheduled fire',
          };
        }
        if (prior.state === 'received') {
          return replay(await prior.attempt.terminal, 'inFlight');
        }
        if (prior.state === 'terminal') return replay(prior.outcome, 'inputAccepted');
      }
      const attempt = createAttempt();
      records.set(fire.runId, { requestHash, state: 'received', attempt });
      const initialAdmissionKey = routeAdmissionKey(fire);
      const admission = reserveCurrentRouteAdmission(initialAdmissionKey);
      await admission.ready;
      let final!: ScheduledFireCommandOutcome;
      let preparedPlan: CurrentScheduledRoutePlan | undefined;
      const routeEffects = createScheduledRouteEffectTracker();
      try {
        let currentDefinitionRevision: number | undefined;
        let definitionReadFailed = false;
        let definitionReadError: unknown;
        try {
          currentDefinitionRevision = options.readDefinitionRevision?.(
            fire.identity.scheduleId,
          );
        } catch (error) {
          definitionReadFailed = true;
          definitionReadError = error;
        }
        if (definitionReadFailed) {
          final = {
            kind: 'retryable',
            message: `scheduled definition revision is unreadable: ${errorMessage(definitionReadError)}`,
          };
        } else if (options.readDefinitionRevision
            && currentDefinitionRevision !== fire.identity.definitionRevision) {
          final = {
            kind: 'rejected',
            reason: 'definitionSuperseded',
            message: `scheduled definition revision ${fire.identity.definitionRevision} was superseded`,
          };
        } else {
          const allBots = getAllBots();
          if (allBots.length === 0) {
            final = {
              kind: 'retryable',
              message: 'no Bot is configured for scheduled execution',
            };
          } else {
            const bot = allBots.find(
              candidate => candidate.config.larkAppId === options.ownerLarkAppId,
            );
            if (!bot
                || (fire.task.larkAppId
                  && fire.task.larkAppId !== options.ownerLarkAppId)) {
              final = {
                kind: 'rejected',
                reason: 'invalidCommand',
                message: `scheduled task ${fire.task.id} is bound to an unavailable Bot`,
              };
            } else {
              const prepared = await prepareRoute(
                fire,
                bot,
                downstream,
                { key: initialAdmissionKey, token: admission.token },
                routeEffects,
              );
              if (!('fire' in prepared)) {
                final = prepared;
              } else {
                preparedPlan = prepared;
                routePlans.set(fire.runId, prepared);
                const projected = await downstream.projection.read({
                  kind: 'byExternalSession',
                  sessionId: prepared.current.session.sessionId,
                });
                if (projected.kind !== 'one') {
                  final = {
                    kind: 'retryable',
                    message: projected.kind === 'notReady'
                      ? projected.message
                      : 'scheduled route winner has no exact Session projection',
                  };
                } else {
                  try {
                    final = await downstream.runtime.submit({
                      target: { kind: 'session', address: projected.session.address },
                      idempotencyKey: fire.runId,
                      command: request.command,
                    });
                  } catch (error) {
                    final = {
                      kind: 'quarantined',
                      message: `scheduled child effect outcome is unknown: ${errorMessage(error)}`,
                    };
                  }
                }
              }
            }
          }
        }
      } catch (error) {
        final = routeEffects.effectsStarted
          ? {
              kind: 'quarantined',
              message: `scheduled route execution failed after route effects: ${errorMessage(error)}`,
            }
          : {
              kind: 'retryable',
              message: `scheduled route execution failed before route effects: ${errorMessage(error)}`,
            };
      } finally {
        if (preparedPlan) finishPlan(preparedPlan);
        admission.release();
      }
      if (final.kind === 'staleAddress') {
        final = {
          kind: 'retryable',
          message: 'scheduled Session address became stale before the child effect',
        };
      } else if (final.kind === 'notWired') {
        final = { kind: 'retryable', message: final.message };
      }
      if (routeEffects.effectsStarted && final.kind === 'retryable') {
        final = {
          kind: 'quarantined',
          message: `scheduled route outcome is unknown after route effects: ${final.message}`,
        };
      }
      const current = records.get(fire.runId);
      if (current?.state === 'received' && current.attempt === attempt) {
        retainSettled(fire.runId, final.kind === 'retryable'
          ? { requestHash, state: 'retryable' }
          : { requestHash, state: 'terminal', outcome: final });
      }
      attempt.settle(final);
      return final;
    };

    return {
      submit<C extends SessionCommand>(
        request: SessionCommandRequest<C>,
      ): Promise<CommandOutcomeFor<C>> {
        if (request.command.kind !== 'scheduled.fire'
            || request.target.kind !== 'route') {
          return downstream.runtime.submit(request);
        }
        return submitScheduled(
          request as SessionCommandRequest<ScheduledFireCommand>,
        ) as Promise<CommandOutcomeFor<C>>;
      },
    };
  };

  return { port, wrapRuntime };
}

/**
 * Legacy in-process test/API bridge. Production scheduler code must submit the
 * envelope through the owner-bound daemon Host instead of constructing a Host
 * per call. This bridge deliberately carries the same process-local semantics.
 */
export async function executeScheduledTaskThroughRuntime(
  task: Parameters<typeof createScheduledFireEnvelope>[1],
  activeSessions: Map<string, DaemonSession>,
  refreshCliVersion: RefreshCliVersion,
  activation?: Pick<CurrentSessionActivationCoordinator, 'ensure'>,
): Promise<void> {
  const ownerLarkAppId = task.larkAppId ?? getAllBots()[0]?.config.larkAppId;
  if (!ownerLarkAppId) return;
  const adapter = createCurrentScheduledFireAdapter({
    ownerLarkAppId,
    activeSessions,
    refreshCliVersion,
    ...(activation === undefined ? {} : { activation }),
  });
  const ownerBot = getAllBots().find(bot => bot.config.larkAppId === ownerLarkAppId);
  const ownerBotId = ownerBot?.botId;
  const runtimeEpoch = getDaemonBootId();
  let base!: ReturnType<typeof createSessionRuntimeHost>;
  const canonicalActivation = ownerBotId
    ? currentSessionActivationCoordinator({
        ownerBotId,
        ownerLarkAppId,
        runtimeEpoch,
        activeSessions,
      })
    : undefined;
  const routeScratchRetirement = canonicalActivation
    ? createCurrentRouteScratchRetirementPort({
        ownerLarkAppId,
        downstream: () => base,
      })
    : undefined;
  const controlMutation = canonicalActivation && routeScratchRetirement && ownerBotId
    ? createCurrentSessionControlPort({
        ownerBotId,
        ownerLarkAppId,
        runtimeEpoch,
        activation: canonicalActivation,
        routeScratchRetirement,
        activeSessions,
      })
    : undefined;
  const directory = {
    async read(query: Parameters<SessionProjection['read']>[0]) {
      const matches = [...activeSessions.values()].filter(current => (
        current.larkAppId === ownerLarkAppId
        && current.session.status === 'active'
        && (query.kind === 'byExternalSession'
          ? current.session.sessionId === query.sessionId
          : query.kind === 'byRoute'
            ? query.route.kind === 'thread'
              ? current.scope === 'thread'
                && activeSessionAnchorId(current) === query.route.anchorId
              : current.scope === 'chat'
                && activeSessionAnchorId(current) === query.route.chatId
            : true)
      ));
      if (query.kind === 'list') {
        return {
          kind: 'list' as const,
          rows: matches.map(current => ({
            key: `${ownerLarkAppId}\u0000${current.session.sessionId}`,
            sessionId: current.session.sessionId,
            route: current.scope === 'thread'
              ? { kind: 'thread' as const, anchorId: activeSessionAnchorId(current) }
              : { kind: 'chat' as const, chatId: current.chatId },
            ordinaryIngressBinding: {
              scope: current.scope,
              canonicalAnchor: activeSessionAnchorId(current),
              chatId: current.chatId,
              chatType: current.chatType,
            },
            recordStatus: 'active' as const,
            executorStatus: current.worker && !current.worker.killed
              ? 'working' as const
              : 'dormant' as const,
          })),
        };
      }
      if (matches.length > 1) {
        return {
          kind: 'notReady' as const,
          message: 'scheduled bridge projection has multiple active owner bindings',
        };
      }
      const current = matches[0];
      if (!current) return { kind: 'notFound' as const };
      return {
        kind: 'one' as const,
        row: {
          key: `${ownerLarkAppId}\u0000${current.session.sessionId}`,
          sessionId: current.session.sessionId,
          route: current.scope === 'thread'
            ? { kind: 'thread' as const, anchorId: activeSessionAnchorId(current) }
            : { kind: 'chat' as const, chatId: current.chatId },
          ordinaryIngressBinding: {
            scope: current.scope,
            canonicalAnchor: activeSessionAnchorId(current),
            chatId: current.chatId,
            chatType: current.chatType,
          },
          recordStatus: 'active' as const,
          executorStatus: current.worker && !current.worker.killed
            ? 'working' as const
            : 'dormant' as const,
        },
      };
    },
  };
  base = createSessionRuntimeHost({
    directory,
    keyedTriggers: {
      inspect: () => ({ kind: 'blocked', message: 'not available in schedule bridge' }),
      reserve: () => ({ kind: 'retryable', message: 'not available in schedule bridge' }),
      begin: () => ({ kind: 'unreadable', message: 'not available in schedule bridge' }),
      settleDispatchUnknown: () => ({ kind: 'unreadable', message: 'not available in schedule bridge' }),
    },
    keyedTriggerTurns: {
      prepare: () => ({ kind: 'retryable', message: 'not available in schedule bridge' }),
      acceptAtMostOnce: async () => ({ kind: 'refused', message: 'not available in schedule bridge' }),
      failClose: async () => ({ kind: 'unreadable', message: 'not available in schedule bridge' }),
    },
    scheduledFire: adapter.port,
    ...(controlMutation ? { controlMutation } : {}),
  });
  const host = { projection: base.projection, runtime: adapter.wrapRuntime(base) };
  const identity = createManualScheduledFireIdentity({
    scheduleId: task.id,
    definitionRevision: task.definitionRevision ?? 1,
    manualRequestId: randomUUID(),
  });
  const fire = createScheduledFireEnvelope(identity, task);
  const outcome = await host.runtime.submit({
    target: { kind: 'route', route: { kind: 'schedule', runId: fire.runId } },
    idempotencyKey: fire.runId,
    command: { kind: 'scheduled.fire', input: fire },
  });
  if (outcome.kind === 'applied' || outcome.kind === 'duplicate') return;
  throw new Error('message' in outcome ? outcome.message : 'scheduled Session address became stale');
}

export function toSchedulerSubmitOutcome(
  outcome: ScheduledFireCommandOutcome,
): ScheduledFireSubmitOutcome {
  if (outcome.kind === 'applied') return { kind: 'applied', sessionId: outcome.sessionId };
  if (outcome.kind === 'duplicate') {
    return { kind: 'duplicate', state: outcome.state, sessionId: outcome.sessionId };
  }
  if (outcome.kind === 'retryable') return outcome;
  if (outcome.kind === 'ambiguous') return { kind: 'ambiguous', message: outcome.message };
  if (outcome.kind === 'quarantined') return outcome;
  if (outcome.kind === 'notWired') return { kind: 'quarantined', message: outcome.message };
  if (outcome.kind === 'staleAddress') {
    return { kind: 'retryable', message: 'scheduled Session address became stale' };
  }
  return { kind: 'rejected', message: outcome.message };
}
