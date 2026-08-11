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
  activeSessionAnchorId,
  activeSessionKey,
  sessionKey,
  type DaemonSession,
} from './types.js';
import {
  closeSession,
  forkWorker,
  getCurrentCliVersion,
  isDisposableCommandScratch,
  isRelayableRealSession,
  sendWorkerInput,
  setActiveSessionIfActive,
} from './worker-pool.js';
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

type ScheduledEffect =
  | { readonly kind: 'prepareInput'; readonly plan: CurrentScheduledRoutePlan }
  | { readonly kind: 'sendInput'; readonly prepared: PreparedInput }
  | { readonly kind: 'fork'; readonly prepared: PreparedInput };

type ScheduledContinuation =
  | { readonly kind: 'prepared'; readonly plan: CurrentScheduledRoutePlan }
  | { readonly kind: 'sent'; readonly prepared: PreparedInput }
  | { readonly kind: 'forked'; readonly prepared: PreparedInput };

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
        if (plan.isContinuation && !plan.newlyCreated) {
          forkWorker(plan.current, input, {
            resume: plan.current.hasHistory,
            turnId: plan.fire.runId,
          });
        } else {
          forkWorker(plan.current, input, plan.fire.runId);
        }
        return undefined;
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
        return { kind: 'retryable', message: 'scheduled Session owner changed during dispatch' };
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
          intent: { kind: 'fork', prepared } satisfies ScheduledEffect,
          continuation: { kind: 'forked', prepared } satisfies ScheduledContinuation,
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
          intent: { kind: 'fork', prepared: next.prepared } satisfies ScheduledEffect,
          continuation: { kind: 'forked', prepared: next.prepared } satisfies ScheduledContinuation,
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

  const prepareRoute = async (
    fire: ScheduledFireEnvelope,
  ): Promise<CurrentScheduledRoutePlan | ScheduledFireCommandOutcome> => {
    const allBots = getAllBots();
    if (allBots.length === 0) {
      return { kind: 'retryable', message: 'no Bot is configured for scheduled execution' };
    }
    const bot = allBots.find(candidate => candidate.config.larkAppId === options.ownerLarkAppId);
    if (!bot || (fire.task.larkAppId && fire.task.larkAppId !== options.ownerLarkAppId)) {
      return {
        kind: 'rejected',
        reason: 'invalidCommand',
        message: `scheduled task ${fire.task.id} is bound to an unavailable Bot`,
      };
    }
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
            anchor = await sendMessage(
              larkAppId,
              task.chatId,
              t('scheduler.task_started', { name: task.name }, localeForBot(larkAppId)),
            );
          }
        }
      } else {
        anchor = await sendMessage(
          larkAppId,
          task.chatId,
          t('scheduler.task_started', { name: task.name }, localeForBot(larkAppId)),
        );
      }
    }

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
      const resumableOwner = isRelayableRealSession(existing)
        || !!existing.session.suspendedColdResume;
      if (isContinuation && resumableOwner) {
        return {
          fire, current: existing, bot, isContinuation: true,
          newlyCreated: false, sharedTopicRootId,
        };
      }
      if (isContinuation && isDisposableCommandScratch(existing)) {
        await closeSession(existing.session.sessionId);
        if (options.activeSessions.get(key) === existing) options.activeSessions.delete(key);
        existing = undefined;
      }
    }

    const deferredFreshTopic = executionPosition === 'new-topic' && silent;
    const runtimeScope: 'thread' | 'chat' = deferredFreshTopic
      ? 'chat'
      : scope === 'chat' && anchor !== task.chatId ? 'thread' : scope;
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
      await closeSession(session.sessionId);
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

  const wrapRuntime = (downstream: {
    readonly runtime: SessionRuntime;
    readonly projection: SessionProjection;
  }): SessionRuntime => {
    interface RouteAttempt {
      readonly requestHash: string;
      readonly terminal: Promise<ScheduledFireCommandOutcome>;
      settle(outcome: ScheduledFireCommandOutcome): void;
    }
    const attempts = new Map<string, RouteAttempt>();
    const completed = new Map<string, { requestHash: string; sessionId: string }>();
    const completedOrder: string[] = [];

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
      const priorCompleted = completed.get(fire.runId);
      if (priorCompleted) {
        if (priorCompleted.requestHash !== requestHash) {
          return {
            kind: 'rejected', reason: 'idempotencyConflict',
            message: 'logical run id already belongs to a different scheduled fire',
          };
        }
        return {
          kind: 'duplicate', state: 'inputAccepted',
          policy: 'scheduled-process-local', durability: 'processLocal',
          sessionId: priorCompleted.sessionId,
          message: 'scheduled route was already accepted in this runtime epoch',
        };
      }
      const prior = attempts.get(fire.runId);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          return {
            kind: 'rejected', reason: 'idempotencyConflict',
            message: 'logical run id already belongs to a different scheduled fire',
          };
        }
        const terminal = await prior.terminal;
        if (terminal.kind === 'applied') {
          return {
            kind: 'duplicate', state: 'inputAccepted',
            policy: 'scheduled-process-local', durability: 'processLocal',
            sessionId: terminal.sessionId,
            message: 'scheduled route joined the winning Current attempt',
          };
        }
        return terminal;
      }
      let settle!: (outcome: ScheduledFireCommandOutcome) => void;
      const terminal = new Promise<ScheduledFireCommandOutcome>((resolve) => { settle = resolve; });
      const attempt: RouteAttempt = { requestHash, terminal, settle };
      attempts.set(fire.runId, attempt);
      const admission = reserveCurrentRouteAdmission(routeAdmissionKey(fire));
      await admission.ready;
      let final: ScheduledFireCommandOutcome;
      try {
        let currentDefinitionRevision: number | undefined;
        let definitionReadError: unknown;
        try {
          currentDefinitionRevision = options.readDefinitionRevision?.(
            fire.identity.scheduleId,
          );
        } catch (error) {
          definitionReadError = error;
        }
        if (definitionReadError !== undefined) {
          final = {
            kind: 'quarantined',
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
          const prepared = await prepareRoute(fire);
          if (!('fire' in prepared)) {
            final = prepared;
          } else {
            routePlans.set(fire.runId, prepared);
            const projected = await downstream.projection.read({
              kind: 'byExternalSession',
              sessionId: prepared.current.session.sessionId,
            });
            if (projected.kind !== 'one') {
              finishPlan(prepared);
              final = {
                kind: 'quarantined',
                message: projected.kind === 'notReady'
                  ? projected.message
                  : 'scheduled route winner has no exact Session projection',
              };
            } else {
              final = await downstream.runtime.submit({
                target: { kind: 'session', address: projected.session.address },
                idempotencyKey: fire.runId,
                command: request.command,
              });
              finishPlan(prepared);
            }
          }
        }
      } catch (error) {
        final = {
          kind: 'quarantined',
          message: `scheduled route execution failed: ${errorMessage(error)}`,
        };
      } finally {
        admission.release();
      }
      attempts.delete(fire.runId);
      if (final.kind === 'applied') {
        completed.set(fire.runId, { requestHash, sessionId: final.sessionId });
        completedOrder.push(fire.runId);
        while (completedOrder.length > 1024) {
          const evicted = completedOrder.shift();
          if (evicted) completed.delete(evicted);
        }
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
): Promise<void> {
  const ownerLarkAppId = task.larkAppId ?? getAllBots()[0]?.config.larkAppId;
  if (!ownerLarkAppId) return;
  const adapter = createCurrentScheduledFireAdapter({
    ownerLarkAppId,
    activeSessions,
    refreshCliVersion,
  });
  const directory = {
    async read(query: Parameters<SessionProjection['read']>[0]) {
      const matches = [...activeSessions.values()].filter(current => (
        current.larkAppId === ownerLarkAppId
        && current.session.status === 'active'
        && (query.kind !== 'byExternalSession'
          || current.session.sessionId === query.sessionId)
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
  const base = createSessionRuntimeHost({
    directory,
    keyedTriggers: {
      inspect: () => ({ kind: 'blocked', message: 'not available in schedule bridge' }),
      reserve: () => ({ kind: 'retryable', message: 'not available in schedule bridge' }),
      begin: () => ({ kind: 'unreadable', message: 'not available in schedule bridge' }),
      settleDispatchUnknown: () => ({ kind: 'unreadable', message: 'not available in schedule bridge' }),
    },
    keyedTriggerTurns: {
      prepare: () => ({ kind: 'retryable', message: 'not available in schedule bridge' }),
      acceptAtMostOnce: () => ({ kind: 'refused', message: 'not available in schedule bridge' }),
      failClose: async () => ({ kind: 'unreadable', message: 'not available in schedule bridge' }),
    },
    scheduledFire: adapter.port,
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
