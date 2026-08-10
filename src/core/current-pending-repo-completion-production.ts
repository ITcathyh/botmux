/**
 * Production composition for Current pending-repository first-start completion.
 *
 * Card, text command, and detached auto-worktree callers submit the same
 * semantic `pendingRepo.complete` command. This Module adapts its detached
 * materialization to the existing repository, roster, prompt, and worker
 * helpers; the staged Current port remains the sole owner of Session mutation
 * and late-result fencing.
 */

import { basename } from 'node:path';

import { getBot } from '../bot-registry.js';
import type { CliId } from '../adapters/cli/types.js';
import { config } from '../config.js';
import { localeForBot, t } from '../i18n/index.js';
import * as gitWorktree from '../services/git-worktree.js';
import { worktreeSlugFromContextAI } from '../services/worktree-slug-ai.js';
import type { CliTurnPayload } from '../types.js';
import {
  CurrentPendingRepoCleanupOutcomeUnknownError,
  createCurrentPendingRepoCompletionPort,
  type CurrentPendingRepoCompletionMaterializeInput,
  type CurrentPendingRepoCompletionMaterializeResult,
  type CurrentPendingRepoWorktreeCleanupResult,
  type CurrentPendingRepoWorktreeCleanupTarget,
} from './current-pending-repo-completion.js';
import { markInitialUserTurnPending } from './initial-user-turn.js';
import { resolvePairedSpawnBackendType } from './persistent-backend.js';
import {
  createPendingWorktreePreparation,
  type PendingWorktreeCreateResult,
  type PendingWorktreePreparationInput,
  type PendingWorktreePreparationResult,
} from './current-pending-worktree-preparation.js';
import * as sessionManager from './session-manager.js';
import type { PendingRepoCompletionPort } from './session-runtime.js';
import { activeSessionAnchorId, activeSessionKey, type DaemonSession } from './types.js';
import * as workerPool from './worker-pool.js';

export interface CurrentPendingRepoCompletionNotice {
  readonly ownerLarkAppId: string;
  readonly sessionId: string;
  readonly anchorId: string;
  readonly content: string;
  readonly turnId: string;
}

export interface CurrentPendingRepoCompletionNotices {
  publish(notice: CurrentPendingRepoCompletionNotice): Promise<void>;
}

export interface CurrentPendingRepoCompletionProductionAdapters {
  readonly availableBots: typeof sessionManager.getAvailableBots;
  readonly prepareWorktree: (
    input: PendingWorktreePreparationInput,
    assertCurrent: () => void,
  ) => Promise<PendingWorktreePreparationResult>;
  readonly cleanupWorktrees: (
    input: readonly CurrentPendingRepoWorktreeCleanupTarget[],
    assertCurrent: () => void,
  ) => Promise<CurrentPendingRepoWorktreeCleanupResult>;
  readonly forkWorker: (
    ds: DaemonSession,
    input: string | CliTurnPayload,
    resumeOrTurnId: Parameters<typeof workerPool.forkWorker>[2],
  ) => boolean;
}

export interface CurrentPendingRepoCompletionProductionOptions {
  readonly ownerLarkAppId: string;
  readonly activeSessions: Map<string, DaemonSession>;
  /** Internal true-external seams. Production callers omit this override. */
  readonly adapters?: CurrentPendingRepoCompletionProductionAdapters;
  /** Best-effort presentation effect; authority never depends on its result. */
  readonly notices?: CurrentPendingRepoCompletionNotices;
}

interface DispatchPlan {
  readonly userPrompt: string;
  readonly turnId: string;
  readonly emptyStart: boolean;
  readonly rawInput?: string;
  readonly followUpInput?: NonNullable<DaemonSession['pendingFollowUpInput']>;
  readonly createdWorktree?: {
    readonly path: string;
    readonly branch: string;
  };
  readonly successNotices: readonly string[];
  readonly preparedWorktrees: readonly CurrentPendingRepoWorktreeCleanupTarget[];
  readonly binding: MaterializationBindingStamp;
  workerRefusalMessage?: string;
}

interface MaterializationBindingStamp {
  readonly key: string;
  readonly sessionId: string;
  readonly claimToken: string;
  readonly daemonToken: object;
  readonly sessionToken: object;
  readonly chatId: string;
  readonly chatType: DaemonSession['chatType'];
  readonly scope: DaemonSession['scope'];
  readonly anchorId: string;
  readonly title: string;
  readonly cliId: CliId;
  readonly cliPathOverride?: string;
  readonly whiteboardId?: string;
  readonly sessionBackendType?: DaemonSession['session']['backendType'];
  readonly botBackendType?: ReturnType<typeof getBot>['config']['backendType'];
  readonly codexAppCleanInput: boolean;
}

const productionAdapters: CurrentPendingRepoCompletionProductionAdapters = {
  availableBots: sessionManager.getAvailableBots,
  async prepareWorktree(input, assertCurrent) {
    const knownCreated: CurrentPendingRepoWorktreeCleanupTarget[] = [];
    const forgetCreated = (sourcePath: string, worktreePath: string): void => {
      const index = knownCreated.findIndex(worktree => (
        worktree.sourcePath === sourcePath && worktree.path === worktreePath
      ));
      if (index >= 0) knownCreated.splice(index, 1);
    };
    const cleanupKnownCreated = async (): Promise<CurrentPendingRepoWorktreeCleanupResult> => {
      for (const worktree of [...knownCreated]) {
        try {
          await gitWorktree.removeRepoWorktree(worktree.sourcePath, worktree.path);
        } catch (error) {
          return {
            kind: 'unknown',
            message: `pending-repo owner-loss cleanup failed for ${worktree.sourcePath}: ${
              error instanceof Error ? error.message : 'unknown cleanup failure'
            }`,
          };
        }
        forgetCreated(worktree.sourcePath, worktree.path);
      }
      return { kind: 'cleaned' };
    };
    const guard = <A extends readonly unknown[], R>(
      effect: (...args: A) => Promise<R>,
    ) => async (...args: A): Promise<R> => {
      assertCurrent();
      const result = await effect(...args);
      assertCurrent();
      return result;
    };
    const preparation = createPendingWorktreePreparation({
      slug: guard((title, prompt) => worktreeSlugFromContextAI(title, prompt)),
      isGit: guard(path => gitWorktree.isGitWorkTree(path)),
      create: async (sourcePath, createOptions) => {
        assertCurrent();
        let result: PendingWorktreeCreateResult;
        try {
          const created = await gitWorktree.createRepoWorktree(sourcePath, createOptions);
          result = { kind: 'created', ...created };
        } catch (error) {
          if (error instanceof gitWorktree.RepoWorktreePreAddRefusal) {
            result = { kind: 'refused', message: error.message };
          } else {
            throw error;
          }
        }
        if (result.kind === 'created') {
          knownCreated.push({ sourcePath, path: result.path });
        }
        assertCurrent();
        return result;
      },
      remove: async (sourcePath, worktreePath) => {
        assertCurrent();
        await gitWorktree.removeRepoWorktree(sourcePath, worktreePath);
        forgetCreated(sourcePath, worktreePath);
        assertCurrent();
      },
      push: guard((worktreePath, branch) => gitWorktree.pushWorktreeBranch(
        worktreePath,
        branch,
      )),
    });
    try {
      const result = await preparation.prepare(input);
      assertCurrent();
      return result;
    } catch (error) {
      const cleanup = await cleanupKnownCreated();
      if (cleanup.kind === 'unknown') {
        throw new CurrentPendingRepoCleanupOutcomeUnknownError(cleanup.message, { cause: error });
      }
      throw error;
    }
  },
  async cleanupWorktrees(worktrees, assertCurrent) {
    for (const worktree of worktrees) {
      assertCurrent();
      try {
        await gitWorktree.removeRepoWorktree(worktree.sourcePath, worktree.path);
      } catch (error) {
        return {
          kind: 'unknown',
          message: `pending-repo worktree cleanup failed for ${worktree.sourcePath}: ${
            error instanceof Error ? error.message : 'unknown cleanup failure'
          }`,
        };
      }
      assertCurrent();
    }
    return { kind: 'cleaned' };
  },
  forkWorker: (ds, input, resumeOrTurnId) => workerPool.forkWorker(ds, input, resumeOrTurnId),
};

function currentOwner(
  options: CurrentPendingRepoCompletionProductionOptions,
  sessionId: string,
): DaemonSession | undefined {
  const candidates = [...options.activeSessions.values()].filter(candidate => (
    candidate.larkAppId === options.ownerLarkAppId
    && candidate.session.sessionId === sessionId
  ));
  if (candidates.length !== 1) return undefined;
  const [ds] = candidates;
  if (!ds
    || options.activeSessions.get(activeSessionKey(ds)) !== ds
    || ds.session.status !== 'active') {
    return undefined;
  }
  return ds;
}

function hasBufferedOpening(input: CurrentPendingRepoCompletionMaterializeInput): boolean {
  const opening = input.opening;
  return opening.prompt.trim().length > 0
    || opening.codexAppText !== undefined
    || (opening.attachments?.length ?? 0) > 0
    || (opening.followUps?.length ?? 0) > 0
    || opening.chatContext !== undefined;
}

function hasEffectiveOpeningInput(userPrompt: string, input: CliTurnPayload): boolean {
  return userPrompt.trim().length > 0
    || input.content.length > 0
    || input.codexAppInput !== undefined;
}

async function resolvedDirectory(
  input: CurrentPendingRepoCompletionMaterializeInput,
  adapters: CurrentPendingRepoCompletionProductionAdapters,
  bindingIsCurrent: () => boolean,
  context: {
    readonly title: string;
    readonly pushForRiff: boolean;
  },
): Promise<PendingWorktreePreparationResult> {
  const assertCurrent = (): void => {
    if (!bindingIsCurrent()) {
      throw new Error('pending-repo Session owner changed during worktree preparation');
    }
  };
  assertCurrent();
  if (input.selection.kind === 'directory') {
    return {
      kind: 'ready',
      workingDir: input.selection.path,
      ...(input.selection.riffRepoDirs
        ? { riffRepoDirs: [...input.selection.riffRepoDirs] }
        : {}),
      worktrees: [],
      warnings: [],
    };
  }
  const preparationInput = input.selection.kind === 'autoWorktree'
    ? {
        kind: 'autoWorktree' as const,
        baseDir: input.selection.baseDir,
        title: context.title,
        prompt: input.opening.prompt,
        pushForRiff: context.pushForRiff,
      }
    : {
        kind: 'manual' as const,
        repositories: input.selection.repositories.map(repository => ({ ...repository })),
        ...(input.selection.branch === undefined ? {} : { branch: input.selection.branch }),
        layout: { ...input.selection.layout },
        title: context.title,
        prompt: input.opening.prompt,
        pushForRiff: context.pushForRiff,
  };
  const result = await adapters.prepareWorktree(preparationInput, assertCurrent);
  return result;
}

function exactTurnId(input: CurrentPendingRepoCompletionMaterializeInput): string {
  return input.opening.turnId
    ?? input.opening.cliInput?.codexAppInput?.clientUserMessageId
    ?? `pending-repo:${input.sessionId}`;
}

function safeErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message;
    if (typeof error === 'string') return error;
  } catch {
    // A hostile thrown value must not hide an uncertain cleanup outcome.
  }
  return 'unknown error';
}

/**
 * Compose a PendingRepoCompletionPort for one Current owner. The returned port
 * is the exact value passed to `currentSessionRuntimeHost({ pendingRepoCompletion })`.
 */
export function createCurrentPendingRepoCompletionProduction(
  options: CurrentPendingRepoCompletionProductionOptions,
): PendingRepoCompletionPort {
  const adapters = options.adapters ?? productionAdapters;
  const dispatchPlans = new Map<string, DispatchPlan>();
  let nextDispatchPlanId = 0;
  const retainDispatchPlan = (plan: DispatchPlan): string => {
    const id = `pending-repo-plan:${++nextDispatchPlanId}`;
    dispatchPlans.set(id, plan);
    return id;
  };
  let larkClientPromise: Promise<typeof import('../im/lark/client.js')> | undefined;
  const daemonTokens = new WeakMap<DaemonSession, object>();
  const sessionTokens = new WeakMap<object, object>();
  const tokenFor = <T extends object>(map: WeakMap<T, object>, value: T): object => {
    const prior = map.get(value);
    if (prior) return prior;
    const token = Object.freeze(Object.create(null)) as object;
    map.set(value, token);
    return token;
  };
  const captureBinding = (
    ds: DaemonSession,
    bot: ReturnType<typeof getBot>,
    claimToken: string,
  ): MaterializationBindingStamp => Object.freeze({
    key: activeSessionKey(ds),
    sessionId: ds.session.sessionId,
    claimToken,
    daemonToken: tokenFor(daemonTokens, ds),
    sessionToken: tokenFor(sessionTokens, ds.session),
    chatId: ds.chatId,
    chatType: ds.chatType,
    scope: ds.scope,
    anchorId: activeSessionAnchorId(ds),
    title: ds.session.title,
    cliId: ds.session.cliId ?? bot.config.cliId,
    ...(ds.session.cliPathOverride ?? bot.config.cliPathOverride
      ? { cliPathOverride: ds.session.cliPathOverride ?? bot.config.cliPathOverride }
      : {}),
    ...(ds.session.whiteboardId === undefined
      ? {}
      : { whiteboardId: ds.session.whiteboardId }),
    ...(ds.session.backendType === undefined
      ? {}
      : { sessionBackendType: ds.session.backendType }),
    ...(bot.config.backendType === undefined
      ? {}
      : { botBackendType: bot.config.backendType }),
    codexAppCleanInput: bot.config.codexAppCleanInput === true,
  });
  const bindingIdentityIsCurrent = (stamp: MaterializationBindingStamp): boolean => {
    const current = options.activeSessions.get(stamp.key);
    return !!current
      && tokenFor(daemonTokens, current) === stamp.daemonToken
      && tokenFor(sessionTokens, current.session) === stamp.sessionToken
      && activeSessionKey(current) === stamp.key
      && current.chatId === stamp.chatId
      && current.chatType === stamp.chatType
      && current.scope === stamp.scope
      && activeSessionAnchorId(current) === stamp.anchorId
      && current.larkAppId === options.ownerLarkAppId
      && current.session.sessionId === stamp.sessionId
      && current.session.status === 'active';
  };
  const bindingIsCurrent = (stamp: MaterializationBindingStamp): boolean => {
    const current = options.activeSessions.get(stamp.key);
    return bindingIdentityIsCurrent(stamp)
      && !!current?.pendingRepo
      && current.pendingRepoCommitInFlight === true
      && current.pendingRepoCommitClaimToken === stamp.claimToken
      && (!current.worker || current.worker.killed);
  };
  const failAfterOwnerLoss = async (
    worktrees: readonly CurrentPendingRepoWorktreeCleanupTarget[],
    stage: string,
  ): Promise<never> => {
    if (worktrees.length > 0) {
      let cleanup: unknown;
      try {
        cleanup = await adapters.cleanupWorktrees(worktrees, () => undefined);
      } catch (error) {
        throw new CurrentPendingRepoCleanupOutcomeUnknownError(
          `pending-repo owner-loss cleanup outcome is unknown ${stage}: ${safeErrorMessage(error)}`,
          { cause: error },
        );
      }
      try {
        if (!cleanup || typeof cleanup !== 'object') {
          throw new Error('cleanup Adapter returned an invalid result');
        }
        const kind = (cleanup as { readonly kind?: unknown }).kind;
        if (kind !== 'cleaned') {
          const message = kind === 'unknown'
            ? (cleanup as { readonly message?: unknown }).message
            : undefined;
          throw new Error(
            typeof message === 'string' && message.length > 0
              ? message
              : 'cleanup Adapter returned an invalid result',
          );
        }
      } catch (error) {
        throw new CurrentPendingRepoCleanupOutcomeUnknownError(
          `pending-repo owner-loss cleanup outcome is unknown ${stage}: ${safeErrorMessage(error)}`,
          { cause: error },
        );
      }
    }
    throw new Error(`pending-repo Session owner changed ${stage}`);
  };
  const fenceMaterialization = async (
    stamp: MaterializationBindingStamp,
    worktrees: readonly CurrentPendingRepoWorktreeCleanupTarget[],
    stage: string,
  ): Promise<void> => {
    if (!bindingIsCurrent(stamp)) {
      await failAfterOwnerLoss(worktrees, stage);
    }
  };
  const publishNotice = (
    stamp: MaterializationBindingStamp,
    turnId: string,
    content: string,
    authority: 'pendingClaim' | 'exactIdentity' = 'pendingClaim',
  ): void => {
    if (authority === 'pendingClaim'
      ? !bindingIsCurrent(stamp)
      : !bindingIdentityIsCurrent(stamp)) return;
    const dispatch = async (): Promise<void> => {
      try {
        if (options.notices) {
          if (!bindingIdentityIsCurrent(stamp)) return;
          await options.notices.publish({
            ownerLarkAppId: options.ownerLarkAppId,
            sessionId: stamp.sessionId,
            anchorId: stamp.anchorId,
            content,
            turnId,
          });
        } else {
          const current = currentOwner(options, stamp.sessionId);
          if (!current || !bindingIdentityIsCurrent(stamp)) return;
          const client = await (larkClientPromise ??= import('../im/lark/client.js'));
          if (!bindingIdentityIsCurrent(stamp)) return;
          if (current.scope === 'chat') {
            await client.sendMessage(
              options.ownerLarkAppId,
              stamp.chatId,
              content,
              'text',
            );
          } else {
            await client.replyMessage(
              options.ownerLarkAppId,
              stamp.anchorId,
              content,
              'text',
              true,
            );
          }
        }
      } catch {
        // Presentation is best effort and never changes Session authority.
      }
    };
    try {
      void dispatch().catch(() => undefined);
    } catch {
      // Even a hostile presentation Adapter cannot escape into authority.
    }
  };

  return createCurrentPendingRepoCompletionPort({
    ownerLarkAppId: options.ownerLarkAppId,
    activeSessions: options.activeSessions,
    preMaterialization: {
      apply(current, input) {
        if ((input.hasFrozenCliInput && !input.hasRawInput)
          || (input.hasRawInput && !input.rawWillBuildFollowUp)) return { kind: 'ready' };
        sessionManager.ensureSessionWhiteboard(current);
        return {
          kind: 'ready',
          whiteboardBlock: sessionManager.snapshotWhiteboardPromptBlock(
            current.session.whiteboardId,
          ),
        };
      },
    },
    async materialize(input): Promise<CurrentPendingRepoCompletionMaterializeResult> {
      const ds = currentOwner(options, input.sessionId);
      if (!ds) throw new Error('pending-repo Session owner changed before materialization');
      const bot = getBot(options.ownerLarkAppId);
      const stamp = captureBinding(ds, bot, input.claimToken);
      const turnId = exactTurnId(input);
      const pushForRiff = resolvePairedSpawnBackendType(
        stamp.cliId,
        stamp.sessionBackendType,
        stamp.botBackendType,
        config.daemon.backendType,
      ) === 'riff';
      const resolved = await resolvedDirectory(
        input,
        adapters,
        () => bindingIsCurrent(stamp),
        { title: stamp.title, pushForRiff },
      );
      const locale = localeForBot(options.ownerLarkAppId);
      if (resolved.kind !== 'ready') {
        if (!bindingIsCurrent(stamp)) {
          throw new Error('pending-repo Session owner changed during directory resolution');
        }
        if (resolved.kind === 'unknown'
          && (input.selection.kind === 'worktree'
            || input.selection.kind === 'autoWorktree')) {
          publishNotice(stamp, turnId, t('cmd.repo.worktree_create_unknown', {
            error: resolved.message,
          }, locale));
        } else if (resolved.kind === 'refused' && input.selection.kind === 'worktree') {
          const failureNotice = resolved.rollback
            && resolved.rollback.rolledBackCount > 0
            ? t('card.repo.worktree_rolled_back', {
                repo: basename(resolved.rollback.failedSourcePath),
                error: resolved.message,
                count: resolved.rollback.rolledBackCount,
              }, locale)
            : t('cmd.repo.worktree_failed', { error: resolved.message }, locale);
          publishNotice(stamp, turnId, failureNotice);
        }
        return { kind: resolved.kind, message: resolved.message };
      }
      const preparedWorktrees = resolved.worktrees.map(worktree => ({
        sourcePath: worktree.sourcePath,
        path: worktree.path,
      }));
      await fenceMaterialization(
        stamp,
        preparedWorktrees,
        'during directory resolution',
      );
      for (const warning of resolved.warnings) {
        publishNotice(stamp, turnId, t('card.repo.riff_worktree_push_failed', {
          branch: warning.branch,
          error: warning.message,
        }, locale));
      }
      const successNotices: string[] = [];
      if (input.selection.kind === 'autoWorktree') {
        const created = resolved.worktrees[0];
        if (created) {
          successNotices.push(t('worktree.auto_created', {
            path: created.path,
            branch: created.branch,
            base: created.baseRef,
          }, locale));
        } else if (resolved.fallback) {
          successNotices.push(t('worktree.auto_fallback', {
            dir: resolved.workingDir,
            error: resolved.fallback.message,
          }, locale));
        }
      } else if (input.selection.kind === 'worktree' && resolved.worktrees.length > 0) {
        successNotices.push(t('cmd.repo.worktree_created', {
          path: resolved.workingDir,
          branch: Array.from(new Set(resolved.worktrees.map(worktree => worktree.branch))).join(', '),
          base: Array.from(new Set(resolved.worktrees.map(worktree => worktree.baseRef))).join(', '),
        }, locale));
      }
      await fenceMaterialization(stamp, preparedWorktrees, 'during worktree notices');
      const createdWorktree = resolved.worktrees.length > 0
        ? {
            path: resolved.workingDir,
            branch: Array.from(new Set(
              resolved.worktrees.map(worktree => worktree.branch),
            )).join(', '),
          }
        : undefined;
      const opening = input.opening;
      const exactInput = opening.cliInput;
      if (!opening.rawInput && exactInput) {
        const userPrompt = opening.prompt;
        const cliInput = structuredClone(exactInput);
        await fenceMaterialization(stamp, preparedWorktrees, 'during opening materialization');
        const dispatchPlanId = retainDispatchPlan({
          userPrompt,
          turnId,
          emptyStart: !hasEffectiveOpeningInput(userPrompt, exactInput),
          ...(createdWorktree ? { createdWorktree } : {}),
          successNotices: [...successNotices],
          preparedWorktrees,
          binding: stamp,
        });
        return {
          kind: 'materialized',
          material: {
            sessionId: input.sessionId,
            dispatchPlanId,
            workingDir: resolved.workingDir,
            userPrompt,
            cliInput,
            turnId,
            resume: false,
            ...(resolved.riffRepoDirs ? { riffRepoDirs: resolved.riffRepoDirs } : {}),
            ...(preparedWorktrees.length ? { worktrees: preparedWorktrees } : {}),
          },
        };
      }

      const hasOpening = hasBufferedOpening(input);
      let availableBots: Awaited<ReturnType<typeof adapters.availableBots>> = [];
      try {
        if (hasOpening) {
          availableBots = await adapters.availableBots(options.ownerLarkAppId, stamp.chatId);
        }
      } catch (error) {
        if (!bindingIsCurrent(stamp)) {
          await failAfterOwnerLoss(preparedWorktrees, 'during available-Bot lookup');
        }
        throw error;
      }
      await fenceMaterialization(stamp, preparedWorktrees, 'during available-Bot lookup');
      const cliInput = hasOpening
        ? sessionManager.buildNewTopicCliInput(
            opening.prompt,
            input.sessionId,
            stamp.cliId,
            stamp.cliPathOverride,
            opening.attachments ? [...opening.attachments] : undefined,
            opening.mentions ? [...opening.mentions] : undefined,
            availableBots,
            opening.followUps ? [...opening.followUps] : undefined,
            { name: bot.botName, openId: bot.botOpenId },
            localeForBot(options.ownerLarkAppId),
            opening.sender,
            {
              larkAppId: options.ownerLarkAppId,
              chatId: stamp.chatId,
              whiteboardId: stamp.whiteboardId,
              whiteboardBlock: opening.whiteboardBlock,
              substituteTrigger: opening.substituteTrigger,
              codexAppText: opening.codexAppText,
              codexAppApplicationContext: opening.codexAppApplicationContext,
              codexAppMessageContext: opening.codexAppMessageContext,
              codexAppFollowUps: opening.codexAppFollowUps
                ? [...opening.codexAppFollowUps]
                : undefined,
              codexAppFollowUpContexts: opening.codexAppFollowUpContexts
                ? [...opening.codexAppFollowUpContexts]
                : undefined,
              chatContext: opening.chatContext,
            },
          )
        : { content: '' };
      await fenceMaterialization(stamp, preparedWorktrees, 'during opening materialization');
      const userPrompt = [opening.prompt, ...(opening.followUps ?? [])].filter(Boolean).join('\n\n');
      if (opening.rawInput) {
        const followUpUserPrompt = opening.codexAppText !== undefined
          || opening.codexAppFollowUps !== undefined
          ? [opening.codexAppText ?? '', ...(opening.codexAppFollowUps ?? [])]
              .filter(Boolean)
              .join('\n\n')
          : userPrompt;
        const gateDecisions = opening.codexAppFollowUpGateAccepted ?? [];
        const codexAppInputAccepted = gateDecisions.length > 0
          ? gateDecisions.every(Boolean)
          : stamp.codexAppCleanInput;
        const lastFollowUpTurnId = opening.followUpTurnIds?.at(-1);
        const followUpInput = hasOpening && cliInput.content.length > 0
          ? {
              userPrompt: followUpUserPrompt,
              cliInput: cliInput.content,
              ...(lastFollowUpTurnId ? { turnId: lastFollowUpTurnId } : {}),
              ...(stamp.cliId === 'codex-app'
                && codexAppInputAccepted
                && cliInput.codexAppInput
                ? { codexAppInput: structuredClone(cliInput.codexAppInput) }
                : {}),
              codexAppInputGateFrozen: true as const,
            }
          : undefined;
        await fenceMaterialization(stamp, preparedWorktrees, 'during follow-up materialization');
        const dispatchPlanId = retainDispatchPlan({
          userPrompt: opening.rawInput,
          turnId: opening.rawTurnId ?? turnId,
          emptyStart: false,
          rawInput: opening.rawInput,
          ...(followUpInput ? { followUpInput } : {}),
          ...(createdWorktree ? { createdWorktree } : {}),
          successNotices: [...successNotices],
          preparedWorktrees,
          binding: stamp,
        });
        return {
          kind: 'materialized',
          material: {
            sessionId: input.sessionId,
            dispatchPlanId,
            workingDir: resolved.workingDir,
            userPrompt: opening.rawInput,
            cliInput: { content: '' },
            turnId: opening.rawTurnId ?? turnId,
            resume: false,
            ...(resolved.riffRepoDirs ? { riffRepoDirs: resolved.riffRepoDirs } : {}),
            ...(preparedWorktrees.length ? { worktrees: preparedWorktrees } : {}),
          },
        };
      }
      await fenceMaterialization(stamp, preparedWorktrees, 'before worker dispatch planning');
      const dispatchPlanId = retainDispatchPlan({
        userPrompt,
        turnId,
        emptyStart: !hasOpening,
        ...(createdWorktree ? { createdWorktree } : {}),
        successNotices: [...successNotices],
        preparedWorktrees,
        binding: stamp,
      });
      return {
        kind: 'materialized',
        material: {
          sessionId: input.sessionId,
          dispatchPlanId,
          workingDir: resolved.workingDir,
          userPrompt,
          cliInput,
          turnId,
          resume: false,
          ...(resolved.riffRepoDirs ? { riffRepoDirs: resolved.riffRepoDirs } : {}),
          ...(preparedWorktrees.length ? { worktrees: preparedWorktrees } : {}),
        },
      };
    },
    async cleanupWorktrees(input) {
      const dispatchPlanId = input.dispatchPlanId;
      if (dispatchPlanId === undefined) {
        throw new Error('pending-repo worktree cleanup has no exact dispatch-plan identity');
      }
      const plan = dispatchPlans.get(dispatchPlanId);
      if (!plan) throw new Error('pending-repo worktree cleanup has no exact dispatch plan');
      if (plan.binding.claimToken !== input.claimToken
        || plan.preparedWorktrees.length !== input.worktrees.length
        || plan.preparedWorktrees.some((planned, index) => (
          planned.sourcePath !== input.worktrees[index]?.sourcePath
          || planned.path !== input.worktrees[index]?.path
        ))) {
        return {
          kind: 'unknown',
          message: 'pending-repo worktree cleanup evidence did not match the dispatch plan',
        };
      }
      const publishCleanupUnknown = (cleanupMessage: string): void => {
        if (!plan.workerRefusalMessage || plan.preparedWorktrees.length === 0) return;
        publishNotice(plan.binding, plan.turnId, t('cmd.repo.worktree_failed', {
          error: `${plan.workerRefusalMessage}; worktree cleanup outcome is unknown: ${cleanupMessage}`,
        }, localeForBot(options.ownerLarkAppId)));
      };
      let result: CurrentPendingRepoWorktreeCleanupResult;
      try {
        result = await adapters.cleanupWorktrees(input.worktrees, () => undefined);
      } catch (error) {
        publishCleanupUnknown(safeErrorMessage(error));
        throw error;
      }
      if (result.kind === 'unknown') {
        publishCleanupUnknown(result.message);
      } else if (plan.workerRefusalMessage && plan.preparedWorktrees.length > 0) {
        publishNotice(plan.binding, plan.turnId, t('card.repo.worktree_rolled_back', {
          repo: basename(plan.preparedWorktrees.at(-1)!.sourcePath),
          error: plan.workerRefusalMessage,
          count: plan.preparedWorktrees.length,
        }, localeForBot(options.ownerLarkAppId)));
      }
      if (result.kind === 'cleaned' && dispatchPlans.get(dispatchPlanId) === plan) {
        dispatchPlans.delete(dispatchPlanId);
      }
      return result;
    },
    dispatchWorker(command) {
      const dispatchPlanId = command.dispatchPlanId;
      if (dispatchPlanId === undefined) {
        return {
          kind: 'unknown',
          message: 'pending-repo worker dispatch has no exact dispatch-plan identity',
        };
      }
      const plan = dispatchPlans.get(dispatchPlanId);
      const ds = currentOwner(options, command.sessionId);
      if (!ds
        || !plan
        || plan.binding.claimToken !== command.claimToken
        || !bindingIsCurrent(plan.binding)) {
        return {
          kind: 'unknown',
          message: 'pending-repo Session identity changed before worker dispatch',
        };
      }
      if (!ds.pendingRepo || !ds.pendingRepoCommitInFlight) {
        return { kind: 'refused', message: 'pending-repo Session owner changed before fork' };
      }
      const publishSwitchUncertainty = (error: unknown): void => {
        if (!plan.createdWorktree) return;
        void publishNotice(
          plan.binding,
          command.turnId,
          t('cmd.repo.worktree_switch_unknown', {
            path: plan.createdWorktree.path,
            error: safeErrorMessage(error),
          }, localeForBot(options.ownerLarkAppId)),
          'exactIdentity',
        );
      };
      const queuedRecovery = !plan.rawInput
        && plan.emptyStart
        && (ds.session.queuedActivationTail?.length ?? 0) > 0
        ? workerPool.prepareQueuedActivationRecoveryFork(ds)
        : undefined;
      if (queuedRecovery?.kind === 'refused') {
        plan.workerRefusalMessage = queuedRecovery.message;
        return { kind: 'refused', message: queuedRecovery.message };
      }
      if (queuedRecovery?.kind === 'unknown') {
        return {
          kind: 'unknown',
          message: queuedRecovery.message,
        };
      }
      let accepted: unknown;
      try {
        accepted = plan.rawInput
          ? adapters.forkWorker(ds, '', false)
          : queuedRecovery
            ? adapters.forkWorker(
                ds,
                queuedRecovery.promptInput,
                queuedRecovery.resumeOrTurnId,
              )
            : plan.emptyStart
              ? adapters.forkWorker(ds, '', false)
          : adapters.forkWorker(
              ds,
              command.input,
              command.resume
                ? { resume: true, turnId: command.turnId }
                : { turnId: command.turnId },
            );
        if (accepted !== null
          && (typeof accepted === 'object' || typeof accepted === 'function')) {
          let then: unknown;
          try {
            then = (accepted as { readonly then?: unknown }).then;
          } catch {
            throw new Error('pending-repo worker primitive returned an unreadable result');
          }
          if (typeof then === 'function') {
            try {
              void Promise.resolve(accepted).catch(() => undefined);
            } catch {
              // The worker outcome is already unknown and remains sticky.
            }
            throw new Error('pending-repo worker primitive must return synchronously');
          }
        }
      } catch (error) {
        publishSwitchUncertainty(error);
        throw error;
      }
      if (accepted === false) {
        plan.workerRefusalMessage = 'worker refused pending-repo first start';
        return { kind: 'refused', message: plan.workerRefusalMessage };
      }
      if (accepted !== true) {
        const error = new Error('pending-repo worker primitive returned an invalid result');
        publishSwitchUncertainty(error);
        throw error;
      }
      if (!bindingIdentityIsCurrent(plan.binding)) {
        return {
          kind: 'unknown',
          message: 'pending-repo Session identity changed during worker dispatch',
        };
      }
      if (plan.followUpInput) {
        ds.pendingFollowUpInput = structuredClone(plan.followUpInput);
      }
      if (plan.rawInput) {
        sessionManager.rememberLastCliInput(ds, plan.rawInput, plan.rawInput);
      } else if (queuedRecovery?.source === 'promotedTail') {
        sessionManager.rememberLastCliInput(
          ds,
          queuedRecovery.logicalInput.userPrompt,
          queuedRecovery.logicalInput.cliInput,
          {
            codexAppInputAccepted: !!queuedRecovery.logicalInput.cliInput.codexAppInput,
          },
        );
      } else if (plan.emptyStart) {
        markInitialUserTurnPending(ds);
      } else {
        sessionManager.rememberLastCliInput(ds, plan.userPrompt, command.input);
      }
      if (dispatchPlans.get(dispatchPlanId) === plan) dispatchPlans.delete(dispatchPlanId);
      for (const content of plan.successNotices) {
        publishNotice(plan.binding, plan.turnId, content, 'exactIdentity');
      }
      return { kind: 'accepted' };
    },
  });
}
