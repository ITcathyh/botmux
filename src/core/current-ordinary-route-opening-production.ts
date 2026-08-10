/**
 * Production creation policy for a Current ordinary route with no Session.
 *
 * Detached policy I/O runs only after route admission. This Module then mints
 * both identities, publishes one complete Session row in the synchronous
 * resume step, and returns the only mutable DaemonSession that may be installed
 * into the owner registry. It never accepts caller-created Session or worker
 * authority.
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { CliId } from '../adapters/cli/types.js';
import {
  snapshotCliRuntime,
  type CliRuntimeSnapshot,
} from '../adapters/cli/runtime.js';
import * as sessionStore from '../services/session-store.js';
import type { Session } from '../types.js';
import { computeInputHash } from '../utils/canonical-input-hash.js';
import type { NormalizedOrdinaryImTurn } from './ordinary-im-turn.js';
import type {
  CurrentOrdinaryRouteOpeningCreator,
  CurrentOrdinaryRouteOpeningCreationResult,
  CurrentOrdinaryRouteOpeningEffectSettlement,
  CurrentOrdinaryRouteOpeningPostCommitToken,
  CurrentOrdinaryRouteOpeningRollbackToken,
} from './current-ordinary-route-registry.js';
import { activeSessionKey, type DaemonSession } from './types.js';

export type CurrentOrdinaryRouteOpeningRepositoryPolicy =
  | { readonly kind: 'pinned'; readonly workingDir: string }
  | { readonly kind: 'picker' }
  | { readonly kind: 'autoWorktree'; readonly baseDir: string };

export interface CurrentOrdinaryRouteOpeningOwnershipFacts {
  readonly ownerOpenId?: string;
  readonly ownerUnionId?: string;
  readonly creatorOpenId?: string;
}

export interface CurrentOrdinaryRouteOpeningTitleFacts {
  readonly sessionTitle: string;
  readonly nativeSessionTitle: string;
  readonly chatDisplayName?: string;
}

export interface CurrentOrdinaryRouteOpeningCliFacts {
  readonly cliId: CliId;
  readonly cliRuntime?: CliRuntimeSnapshot;
  readonly cliPathOverride?: string;
  readonly wrapperCli?: string;
  readonly model?: string;
  readonly reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  readonly cliVersion: string;
}

/** Detached facts resolved after daemon default-oncall binding has completed. */
export interface CurrentOrdinaryRouteOpeningPolicyFacts {
  readonly repository: CurrentOrdinaryRouteOpeningRepositoryPolicy;
  readonly ownership: CurrentOrdinaryRouteOpeningOwnershipFacts;
  readonly title: CurrentOrdinaryRouteOpeningTitleFacts;
  readonly cli: CurrentOrdinaryRouteOpeningCliFacts;
}

export type CurrentOrdinaryRouteOpeningPolicyResolution =
  | {
      readonly kind: 'resolved';
      readonly facts: CurrentOrdinaryRouteOpeningPolicyFacts;
    }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

export type CurrentOrdinaryRouteOpeningPolicyEffect = Readonly<{
  readonly kind: 'resolveOpeningPolicy';
  readonly ownerLarkAppId: string;
  readonly turn: NormalizedOrdinaryImTurn;
}>;

export interface CurrentOrdinaryRouteOpeningPolicyEffects {
  execute(
    effect: CurrentOrdinaryRouteOpeningPolicyEffect,
  ): Promise<CurrentOrdinaryRouteOpeningPolicyResolution>;
}

export type CurrentOrdinaryRouteOpeningPostCommitEffect = {
  readonly kind: 'pendingRepo.openingCommitted';
  readonly ownerLarkAppId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly route: NormalizedOrdinaryImTurn['route'];
  readonly mode: 'picker' | 'auto_worktree';
  readonly baseDir?: string;
};

export type CurrentOrdinaryRouteOpeningPostCommitEffectResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

/** Synchronous detached dispatch; asynchronous work starts behind this Adapter. */
export interface CurrentOrdinaryRouteOpeningPostCommitEffects {
  dispatch(
    effect: CurrentOrdinaryRouteOpeningPostCommitEffect,
  ): CurrentOrdinaryRouteOpeningPostCommitEffectResult;
}

export interface CurrentOrdinaryRouteOpeningProductionOptions {
  readonly ownerLarkAppId: string;
  readonly activeSessions: Map<string, DaemonSession>;
  readonly policyEffects: CurrentOrdinaryRouteOpeningPolicyEffects;
  readonly postCommitEffects: CurrentOrdinaryRouteOpeningPostCommitEffects;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function optionalIdentity(value: string | undefined): boolean {
  return value === undefined || nonEmpty(value);
}

function policyIsValid(facts: CurrentOrdinaryRouteOpeningPolicyFacts): boolean {
  if (!facts || typeof facts !== 'object'
      || !facts.repository || typeof facts.repository !== 'object'
      || !facts.ownership || typeof facts.ownership !== 'object'
      || !facts.title || typeof facts.title !== 'object'
      || !facts.cli || typeof facts.cli !== 'object') {
    return false;
  }
  if (facts.repository.kind === 'pinned') {
    if (!nonEmpty(facts.repository.workingDir)) return false;
  } else if (facts.repository.kind === 'autoWorktree') {
    if (!nonEmpty(facts.repository.baseDir)) return false;
  } else if (facts.repository.kind !== 'picker') {
    return false;
  }
  return nonEmpty(facts.title.sessionTitle)
    && nonEmpty(facts.title.nativeSessionTitle)
    && optionalIdentity(facts.title.chatDisplayName)
    && optionalIdentity(facts.ownership.ownerOpenId)
    && optionalIdentity(facts.ownership.ownerUnionId)
    && optionalIdentity(facts.ownership.creatorOpenId)
    && nonEmpty(facts.cli.cliId)
    && nonEmpty(facts.cli.cliVersion)
    && optionalIdentity(facts.cli.cliPathOverride)
    && optionalIdentity(facts.cli.wrapperCli)
    && optionalIdentity(facts.cli.model);
}

function createSession(
  ownerLarkAppId: string,
  turn: NormalizedOrdinaryImTurn,
  facts: CurrentOrdinaryRouteOpeningPolicyFacts,
  createdAt: string,
): Session {
  const workingDir = facts.repository.kind === 'picker'
    ? undefined
    : facts.repository.kind === 'pinned'
      ? facts.repository.workingDir
      : facts.repository.baseDir;
  const pendingRepository = facts.repository.kind !== 'pinned';
  const pendingMode = facts.repository.kind === 'autoWorktree'
    ? 'auto_worktree' as const
    : 'picker' as const;
  return {
    sessionId: randomUUID(),
    larkAppId: ownerLarkAppId,
    chatId: turn.route.chatId,
    chatType: turn.route.chatType,
    rootMessageId: turn.route.scope === 'thread'
      ? turn.route.canonicalAnchor
      : turn.messageKey,
    scope: turn.route.scope,
    title: facts.title.sessionTitle,
    nativeSessionTitle: facts.title.nativeSessionTitle,
    ...(facts.title.chatDisplayName === undefined
      ? {}
      : { chatDisplayName: facts.title.chatDisplayName }),
    status: 'active',
    createdAt,
    lastMessageAt: createdAt,
    ...(workingDir === undefined ? {} : { workingDir }),
    ...(facts.ownership.ownerOpenId === undefined
      ? {}
      : { ownerOpenId: facts.ownership.ownerOpenId }),
    ...(facts.ownership.ownerUnionId === undefined
      ? {}
      : { ownerUnionId: facts.ownership.ownerUnionId }),
    ...(facts.ownership.creatorOpenId === undefined
      ? {}
      : { creatorOpenId: facts.ownership.creatorOpenId }),
    ...(turn.sender.openId === undefined
      ? {}
      : {
          lastCallerOpenId: turn.sender.openId,
          quoteTargetSenderOpenId: turn.sender.openId,
        }),
    quoteTargetId: turn.messageKey,
    quoteTargetSenderIsBot: turn.sender.kind === 'bot',
    cliId: facts.cli.cliId,
    ...(facts.cli.cliRuntime === undefined
      ? {}
      : { cliRuntime: snapshotCliRuntime(facts.cli.cliRuntime) }),
    ...(facts.cli.cliPathOverride === undefined
      ? {}
      : { cliPathOverride: facts.cli.cliPathOverride }),
    ...(facts.cli.wrapperCli === undefined
      ? {}
      : { wrapperCli: facts.cli.wrapperCli }),
    ...(facts.cli.model === undefined ? {} : { model: facts.cli.model }),
    ...(facts.cli.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: facts.cli.reasoningEffort }),
    agentFrozen: true,
    workerGeneration: 0,
    initialUserTurnPending: true,
    ...(pendingRepository
      ? {
          queued: true,
          queuedPrompt: '',
          pendingRepoSetup: {
            mode: pendingMode,
            prompt: '',
            turnId: turn.messageKey,
            ...(facts.repository.kind === 'autoWorktree'
              ? { baseDir: facts.repository.baseDir }
              : {}),
          },
        }
      : {}),
  };
}

interface PostCommitPlan {
  readonly current: DaemonSession;
  readonly session: Session;
  readonly key: string;
  readonly effect: CurrentOrdinaryRouteOpeningPostCommitEffect;
}

interface RollbackPlan {
  readonly current: DaemonSession;
  readonly session: Session;
  readonly key: string;
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function isThenable(value: unknown): boolean {
  if (!isObject(value)) return false;
  try {
    return typeof value.then === 'function';
  } catch {
    return true;
  }
}

function detachThenable(value: unknown): void {
  if (!isObject(value)) return;
  try {
    void Promise.resolve(value).catch(() => undefined);
  } catch {
    // Post-commit dispatch is already consumed and cannot be replayed safely.
  }
}

function detachedEffect(
  ownerLarkAppId: string,
  turn: NormalizedOrdinaryImTurn,
  current: DaemonSession,
  repository: Exclude<CurrentOrdinaryRouteOpeningRepositoryPolicy, { kind: 'pinned' }>,
): CurrentOrdinaryRouteOpeningPostCommitEffect {
  const route = Object.freeze({ ...turn.route });
  return Object.freeze({
    kind: 'pendingRepo.openingCommitted',
    ownerLarkAppId,
    sessionId: current.session.sessionId,
    turnId: turn.messageKey,
    route,
    mode: repository.kind === 'autoWorktree' ? 'auto_worktree' : 'picker',
    ...(repository.kind === 'autoWorktree' ? { baseDir: repository.baseDir } : {}),
  });
}

function exactDurableSession(ownerLarkAppId: string, expected: Session): boolean {
  const durable = sessionStore.getSessionForOwnerStrict(ownerLarkAppId, expected.sessionId);
  if (!durable) return false;
  const serializedExpected = JSON.parse(JSON.stringify(expected)) as unknown;
  return isDeepStrictEqual(durable, serializedExpected);
}

interface OpeningPolicyPlan {
  readonly turn: NormalizedOrdinaryImTurn;
  readonly turnHash: string;
  readonly effect: CurrentOrdinaryRouteOpeningPolicyEffect;
}

/**
 * Build the opening creator installed in `currentSessionRuntimeHost`. The
 * detached policy effect runs outside every Session lane; resume is the one
 * synchronous publication step and never retains Session authority across I/O.
 */
export function createCurrentOrdinaryRouteOpeningProduction(
  options: CurrentOrdinaryRouteOpeningProductionOptions,
): CurrentOrdinaryRouteOpeningCreator {
  const policyIntents = new WeakMap<object, OpeningPolicyPlan>();
  const policyContinuations = new WeakMap<object, OpeningPolicyPlan>();
  const postCommits = new WeakMap<object, PostCommitPlan>();
  const rollbacks = new WeakMap<object, RollbackPlan>();

  const unknown = (
    policyMessage: string,
  ): Extract<CurrentOrdinaryRouteOpeningCreationResult, { readonly kind: 'unknown' }> => ({
    kind: 'unknown',
    message: policyMessage,
  });

  const publish = (
    plan: OpeningPolicyPlan,
    facts: CurrentOrdinaryRouteOpeningPolicyFacts,
  ): CurrentOrdinaryRouteOpeningCreationResult => {
    const createdAt = new Date().toISOString();
    let session: Session;
    let current: DaemonSession;
    try {
      if (computeInputHash(plan.turn) !== plan.turnHash) {
        return unknown('Current ordinary opening turn changed before publication');
      }
      session = createSession(options.ownerLarkAppId, plan.turn, facts, createdAt);
      current = {
        session,
        worker: null,
        workerPort: null,
        workerToken: null,
        workerGeneration: 0,
        larkAppId: options.ownerLarkAppId,
        chatId: plan.turn.route.chatId,
        chatType: plan.turn.route.chatType,
        scope: plan.turn.route.scope,
        spawnedAt: Date.parse(createdAt),
        cliVersion: facts.cli.cliVersion,
        lastMessageAt: Date.parse(createdAt),
        hasHistory: false,
        ...(facts.repository.kind === 'pinned'
          ? {}
          : { pendingRepo: true, pendingPrompt: '' }),
        ...(session.workingDir === undefined ? {} : { workingDir: session.workingDir }),
        ...(session.ownerOpenId === undefined ? {} : { ownerOpenId: session.ownerOpenId }),
        currentTurnTitle: session.title,
      };
      sessionStore.updateSession(session);
    } catch (error) {
      return unknown(
        `Current ordinary opening publication outcome is unknown: ${message(error)}`,
      );
    }
    const rollbackToken = Object.freeze(
      Object.create(null),
    ) as CurrentOrdinaryRouteOpeningRollbackToken;
    rollbacks.set(rollbackToken, {
      current,
      session,
      key: activeSessionKey(current),
    });
    if (facts.repository.kind === 'pinned') {
      return { kind: 'created', current, rollbackToken };
    }
    const postCommitToken = Object.freeze(
      Object.create(null),
    ) as CurrentOrdinaryRouteOpeningPostCommitToken;
    postCommits.set(postCommitToken, {
      current,
      session,
      key: activeSessionKey(current),
      effect: detachedEffect(
        options.ownerLarkAppId,
        plan.turn,
        current,
        facts.repository,
      ),
    });
    return { kind: 'created', current, rollbackToken, postCommitToken };
  };

  return {
    begin(turn) {
      let turnHash: string;
      try {
        turnHash = computeInputHash(turn);
      } catch (error) {
        return unknown(`Current ordinary opening turn is unreadable: ${message(error)}`);
      }
      const intent = Object.freeze(Object.create(null));
      const continuation = Object.freeze(Object.create(null));
      const plan: OpeningPolicyPlan = {
        turn,
        turnHash,
        effect: Object.freeze({
          kind: 'resolveOpeningPolicy',
          ownerLarkAppId: options.ownerLarkAppId,
          turn,
        }),
      };
      policyIntents.set(intent, plan);
      policyContinuations.set(continuation, plan);
      return { kind: 'effect', intent, continuation };
    },

    async execute(intent) {
      const plan = isObject(intent) ? policyIntents.get(intent) : undefined;
      if (!plan) {
        return unknown('Current ordinary opening policy intent is stale or invalid');
      }
      policyIntents.delete(intent as object);
      return await options.policyEffects.execute(plan.effect);
    },

    resume(continuation, settlement: CurrentOrdinaryRouteOpeningEffectSettlement) {
      const plan = isObject(continuation)
        ? policyContinuations.get(continuation)
        : undefined;
      if (!plan) {
        return unknown('Current ordinary opening continuation is stale or invalid');
      }
      policyContinuations.delete(continuation as object);
      try {
        if (settlement.kind === 'superseded') {
          return {
            kind: 'refused',
            message: 'Current ordinary opening policy was superseded by an exact route owner',
          };
        }
        if (settlement.kind === 'threw') {
          return unknown(
            `Current ordinary opening policy outcome is unknown: ${message(settlement.error)}`,
          );
        }
        if (settlement.kind !== 'returned') {
          return unknown('Current ordinary opening policy settlement is invalid');
        }
        const resolution: unknown = settlement.value;
        if (isThenable(resolution)) {
          detachThenable(resolution);
          return unknown('Current ordinary opening policy returned a nested thenable');
        }
        if (!isObject(resolution)) {
          return unknown('Current ordinary opening policy returned no result');
        }
        const kind = resolution.kind;
        if (kind === 'refused' || kind === 'unknown') {
          const resolutionMessage = resolution.message;
          return typeof resolutionMessage === 'string'
            ? { kind, message: resolutionMessage }
            : unknown(`Current ordinary opening policy returned ${kind} without a message`);
        }
        const facts = resolution.facts as CurrentOrdinaryRouteOpeningPolicyFacts;
        if (kind !== 'resolved' || !policyIsValid(facts)) {
          return unknown('Current ordinary opening policy returned invalid facts');
        }
        return publish(plan, facts);
      } catch (error) {
        return unknown(`Current ordinary opening policy result is unreadable: ${message(error)}`);
      }
    },

    rollback(token) {
      const plan = rollbacks.get(token);
      if (!plan) {
        return {
          kind: 'unknown',
          message: 'Current ordinary opening rollback token is stale or invalid',
        };
      }
      rollbacks.delete(token);
      try {
        const current = options.activeSessions.get(plan.key);
        if (current !== plan.current
            || current.session !== plan.session
            || activeSessionKey(current) !== plan.key
            || !exactDurableSession(options.ownerLarkAppId, plan.session)) {
          return {
            kind: 'unknown',
            message: 'Current ordinary opening changed before exact rollback',
          };
        }
        const rolledBack = sessionStore.rollbackProvisionalSessionForOwnerStrict(
          options.ownerLarkAppId,
          plan.session,
        );
        if (rolledBack.kind === 'unknown') return rolledBack;
        if (options.activeSessions.get(plan.key) !== plan.current
            || plan.current.session !== plan.session) {
          return {
            kind: 'unknown',
            message: 'Current ordinary opening changed while rollback was publishing',
          };
        }
        options.activeSessions.delete(plan.key);
        return { kind: 'rolledBack' };
      } catch (error) {
        return {
          kind: 'unknown',
          message: `Current ordinary opening rollback outcome is unknown: ${message(error)}`,
        };
      }
    },

    dispatchPostCommit(token): void {
      const plan = postCommits.get(token);
      if (!plan) return;
      // One-shot before any adapter code. A throw/thenable crossed the seam and
      // cannot justify a second detached repo/UI launch.
      postCommits.delete(token);
      try {
        const current = options.activeSessions.get(plan.key);
        if (current !== plan.current
          || current.session !== plan.session
          || activeSessionKey(current) !== plan.key
          || current.larkAppId !== options.ownerLarkAppId
          || current.session.larkAppId !== options.ownerLarkAppId
          || current.session.status !== 'active'
          || !current.pendingRepo
          || current.session.pendingRepoSetup?.turnId !== plan.effect.turnId
          || current.session.pendingRepoSetup.cliInput === undefined
          || current.session.pendingRepoSetup.mode !== plan.effect.mode
          || (plan.effect.mode === 'auto_worktree'
            && current.session.pendingRepoSetup.baseDir !== plan.effect.baseDir)
          || !exactDurableSession(options.ownerLarkAppId, plan.session)) {
          return;
        }
        const result: unknown = options.postCommitEffects.dispatch(plan.effect);
        if (isThenable(result)) detachThenable(result);
      } catch {
        // Downstream ordinary input is already committed. The detached launch
        // is consumed fail-closed rather than replayed against uncertain state.
      }
    },
  };
}
