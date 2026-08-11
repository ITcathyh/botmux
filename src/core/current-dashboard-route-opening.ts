/**
 * Current adapter for Dashboard chat-route opening.
 *
 * The route registry owns admission/idempotency. This adapter owns the one
 * staged external effect and exact Current readback, so HTTP never receives a
 * mutable registry or materialized attachment path.
 */

import { isDeepStrictEqual } from 'node:util';

import * as sessionStore from '../services/session-store.js';
import type { Session } from '../types.js';
import {
  cleanupMaterializedDashboardImages,
  materializeDashboardImages,
} from './dashboard-images.js';
import {
  spawnDashboardSession,
  type SpawnDashboardSessionArgs,
} from './session-manager.js';
import type { DashboardSpawnInput, SessionRoute } from './session-runtime.js';
import {
  activeSessionAnchorId,
  activeSessionKey,
  storedActiveSessionAnchorId,
  type DaemonSession,
} from './types.js';

export type CurrentDashboardRouteInspection =
  | { readonly kind: 'vacant' }
  | { readonly kind: 'occupied'; readonly sessionId: string }
  | { readonly kind: 'unknown'; readonly message: string };

export type CurrentDashboardRouteOpeningSettlement =
  | { readonly kind: 'returned'; readonly value: unknown }
  | { readonly kind: 'threw'; readonly error: unknown };

export type CurrentDashboardRouteOpeningBeginResult =
  | {
      readonly kind: 'effect';
      readonly intent: unknown;
      readonly continuation: unknown;
    }
  | { readonly kind: 'refused'; readonly reason: 'invalidCommand'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

export type CurrentDashboardRouteOpeningResult =
  | { readonly kind: 'created'; readonly sessionId: string }
  | {
      readonly kind: 'refused';
      readonly reason: 'sessionExists' | 'transitionRejected';
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: 'unknown'; readonly message: string; readonly sessionId?: string };

export interface CurrentDashboardRouteOpeningPort {
  inspect(route: SessionRoute): CurrentDashboardRouteInspection;
  begin(input: {
    readonly route: SessionRoute;
    readonly command: DashboardSpawnInput;
  }): CurrentDashboardRouteOpeningBeginResult;
  execute(intent: unknown): Promise<unknown>;
  resume(
    continuation: unknown,
    settlement: CurrentDashboardRouteOpeningSettlement,
  ): CurrentDashboardRouteOpeningResult;
}

type SpawnResult = Awaited<ReturnType<typeof spawnDashboardSession>>;

interface OpeningAttempt {
  readonly route: Extract<SessionRoute, { readonly kind: 'chat' }>;
  readonly command: DashboardSpawnInput;
  executed: boolean;
  settled: boolean;
  attachments?: ReturnType<typeof materializeDashboardImages>;
}

type EffectResult =
  | { readonly kind: 'materializeFailed'; readonly error: unknown }
  | { readonly kind: 'spawnReturned'; readonly result: SpawnResult };

export interface CurrentDashboardRouteOpeningOptions {
  readonly ownerLarkAppId: string;
  readonly activeSessions: Map<string, DaemonSession>;
  /** Narrow fault-test seam; production resolves exact Current owner state. */
  readonly inspectRoute?: (route: SessionRoute) => CurrentDashboardRouteInspection;
  readonly materializeImages?: typeof materializeDashboardImages;
  readonly cleanupImages?: typeof cleanupMaterializedDashboardImages;
  readonly spawn?: typeof spawnDashboardSession;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function liveMatchesChatRoute(
  current: DaemonSession,
  ownerLarkAppId: string,
  chatId: string,
): boolean {
  return current.larkAppId === ownerLarkAppId
    && (current.session.larkAppId === undefined
      || current.session.larkAppId === ownerLarkAppId)
    && current.session.status === 'active'
    && current.scope === 'chat'
    && current.session.scope === 'chat'
    && activeSessionAnchorId(current) === chatId
    && current.chatId === chatId
    && current.session.chatId === chatId
    && current.chatType === 'group'
    && (current.session.chatType ?? 'group') === 'group';
}

function storedMatchesChatRoute(
  session: ReturnType<typeof sessionStore.listSessionsForOwnerStrict>[number],
  chatId: string,
): boolean {
  return session.status === 'active'
    && session.scope === 'chat'
    && storedActiveSessionAnchorId(session) === chatId
    && session.chatId === chatId
    && (session.chatType ?? 'group') === 'group';
}

function samePersistedSession(left: Session, right: Session): boolean {
  const persisted = (session: Session): Session => (
    JSON.parse(JSON.stringify(session)) as Session
  );
  return isDeepStrictEqual(persisted(left), persisted(right));
}

/** Exact owner-aware route readback shared by preflight and effect settlement. */
export function inspectCurrentDashboardRoute(input: {
  readonly ownerLarkAppId: string;
  readonly activeSessions: Map<string, DaemonSession>;
  readonly route: SessionRoute;
}): CurrentDashboardRouteInspection {
  if (input.route.kind !== 'chat') {
    return { kind: 'unknown', message: 'Dashboard opening supports only chat routes' };
  }
  const chatId = input.route.chatId;
  try {
    const allPersisted = sessionStore.listSessionsForOwnerStrict(input.ownerLarkAppId);
    const persistedIds = new Set<string>();
    for (const session of allPersisted) {
      if ((session.larkAppId && session.larkAppId !== input.ownerLarkAppId)
        || typeof session.sessionId !== 'string'
        || session.sessionId.length === 0
        || persistedIds.has(session.sessionId)) {
        return {
          kind: 'unknown',
          message: 'Current Dashboard route has malformed durable owner evidence',
        };
      }
      persistedIds.add(session.sessionId);
    }
    const persisted = allPersisted.filter(session => storedMatchesChatRoute(session, chatId));
    const ownerLive: DaemonSession[] = [];
    const ownerLiveIds = new Set<string>();
    for (const [key, current] of input.activeSessions) {
      const ownerRelated = current.larkAppId === input.ownerLarkAppId
        || current.session.larkAppId === input.ownerLarkAppId;
      if (!ownerRelated) continue;
      let canonical = false;
      try { canonical = key === activeSessionKey(current); }
      catch { /* malformed owner evidence is not a vacant route */ }
      if (!canonical
        || current.larkAppId !== input.ownerLarkAppId
        || (!!current.session.larkAppId
          && current.session.larkAppId !== input.ownerLarkAppId)
        || typeof current.session.sessionId !== 'string'
        || current.session.sessionId.length === 0
        || current.session.status !== 'active'
        || current.session.chatId !== current.chatId
        || (!!current.session.chatType && current.session.chatType !== current.chatType)
        || (current.session.scope ?? 'thread') !== current.scope
        || ownerLiveIds.has(current.session.sessionId)) {
        return {
          kind: 'unknown',
          message: 'Current Dashboard route has malformed live owner evidence',
        };
      }
      ownerLiveIds.add(current.session.sessionId);
      ownerLive.push(current);
    }
    const live = new Map<string, DaemonSession>();
    for (const current of ownerLive) {
      if (!liveMatchesChatRoute(current, input.ownerLarkAppId, chatId)) continue;
      live.set(current.session.sessionId, current);
    }

    const persistedById = new Map(persisted.map(session => [session.sessionId, session]));
    const candidates = new Set([...live.keys(), ...persistedById.keys()]);
    if (candidates.size === 0) return { kind: 'vacant' };
    if (candidates.size !== 1) {
      return {
        kind: 'unknown',
        message: 'Current Dashboard route has multiple active owner bindings',
      };
    }
    const [sessionId] = candidates;
    const current = live.get(sessionId!);
    const durable = persistedById.get(sessionId!);
    if (!current || !durable) {
      return {
        kind: 'unknown',
        message: 'Current Dashboard route live and durable owners are incomplete',
      };
    }
    if (!samePersistedSession(current.session, durable)) {
      return {
        kind: 'unknown',
        message: 'Current Dashboard route live and durable owners disagree',
      };
    }
    return { kind: 'occupied', sessionId: sessionId! };
  } catch (error) {
    return {
      kind: 'unknown',
      message: `Current Dashboard route owner is unreadable: ${errorMessage(error)}`,
    };
  }
}

export function createCurrentDashboardRouteOpeningPort(
  options: CurrentDashboardRouteOpeningOptions,
): CurrentDashboardRouteOpeningPort {
  const inspect = options.inspectRoute ?? (route => inspectCurrentDashboardRoute({
    ownerLarkAppId: options.ownerLarkAppId,
    activeSessions: options.activeSessions,
    route,
  }));
  const materializeImages = options.materializeImages ?? materializeDashboardImages;
  const cleanupImages = options.cleanupImages ?? cleanupMaterializedDashboardImages;
  const spawn = options.spawn ?? spawnDashboardSession;
  const intents = new WeakMap<object, OpeningAttempt>();
  const continuations = new WeakMap<object, OpeningAttempt>();
  const results = new WeakMap<object, EffectResult>();

  const unknownFor = (
    attempt: OpeningAttempt,
    message: string,
  ): CurrentDashboardRouteOpeningResult => {
    const readback = inspect(attempt.route);
    return {
      kind: 'unknown',
      message: readback.kind === 'unknown' ? `${message}; ${readback.message}` : message,
      ...(readback.kind === 'occupied' ? { sessionId: readback.sessionId } : {}),
    };
  };

  return {
    inspect,

    begin(input) {
      if (input.route.kind !== 'chat') {
        return {
          kind: 'refused',
          reason: 'invalidCommand',
          message: 'Dashboard opening requires a chat route',
        };
      }
      const attempt: OpeningAttempt = {
        route: Object.freeze({ ...input.route }),
        command: input.command,
        executed: false,
        settled: false,
      };
      const intent = Object.freeze(Object.create(null)) as object;
      const continuation = Object.freeze(Object.create(null)) as object;
      intents.set(intent, attempt);
      continuations.set(continuation, attempt);
      return { kind: 'effect', intent, continuation };
    },

    async execute(intent) {
      if (!intent || typeof intent !== 'object') {
        throw new Error('invalid Current Dashboard opening intent');
      }
      const attempt = intents.get(intent);
      if (!attempt || attempt.executed) {
        throw new Error('stale Current Dashboard opening intent');
      }
      attempt.executed = true;

      let attachments: ReturnType<typeof materializeDashboardImages>;
      try {
        attachments = materializeImages(
          options.ownerLarkAppId,
          [...attempt.command.images],
        );
      } catch (error) {
        const result = Object.freeze(Object.create(null)) as object;
        results.set(result, { kind: 'materializeFailed', error });
        return result;
      }
      attempt.attachments = attachments;
      const args: SpawnDashboardSessionArgs = {
        larkAppId: options.ownerLarkAppId,
        chatId: attempt.route.chatId,
        content: attempt.command.content,
        column: attempt.command.column,
        role: attempt.command.role,
        coworkers: [...attempt.command.coworkers],
        attachments,
        postBanner: attempt.command.postBanner,
        ...(attempt.command.title === undefined ? {} : { title: attempt.command.title }),
        ...(attempt.command.ownerOpenId === undefined
          ? {}
          : { ownerOpenId: attempt.command.ownerOpenId }),
        ...(attempt.command.ownerUnionId === undefined
          ? {}
          : { ownerUnionId: attempt.command.ownerUnionId }),
      };
      const spawnResult = await spawn(options.activeSessions, undefined, args);
      const result = Object.freeze(Object.create(null)) as object;
      results.set(result, { kind: 'spawnReturned', result: spawnResult });
      return result;
    },

    resume(continuation, settlement) {
      if (!continuation || typeof continuation !== 'object') {
        return { kind: 'unknown', message: 'invalid Current Dashboard opening continuation' };
      }
      const attempt = continuations.get(continuation);
      if (!attempt || attempt.settled) {
        return { kind: 'unknown', message: 'stale Current Dashboard opening continuation' };
      }
      attempt.settled = true;
      if (!attempt.executed) {
        return { kind: 'unknown', message: 'Current Dashboard opening effect did not execute' };
      }
      if (settlement.kind === 'threw') {
        return unknownFor(
          attempt,
          `Current Dashboard opening outcome is unknown: ${errorMessage(settlement.error)}`,
        );
      }
      if (!settlement.value || typeof settlement.value !== 'object') {
        return unknownFor(attempt, 'Current Dashboard opening returned an invalid effect result');
      }
      const effect = results.get(settlement.value);
      if (!effect) {
        return unknownFor(attempt, 'Current Dashboard opening returned a foreign effect result');
      }
      const readback = inspect(attempt.route);
      if (effect.kind === 'materializeFailed') {
        if (readback.kind !== 'vacant') {
          return unknownFor(
            attempt,
            'Current Dashboard image materialization failed while route ownership changed',
          );
        }
        return {
          kind: 'refused',
          reason: 'transitionRejected',
          code: 'image_store_failed',
          message: 'image_store_failed',
        };
      }
      if (effect.result.ok) {
        if (readback.kind === 'occupied'
            && readback.sessionId === effect.result.sessionId) {
          return { kind: 'created', sessionId: effect.result.sessionId };
        }
        return unknownFor(
          attempt,
          readback.kind === 'occupied'
            ? 'Current Dashboard opening readback resolved a different Session'
            : 'Current Dashboard opening has no exact Current route readback',
        );
      }
      if (readback.kind !== 'vacant') {
        return unknownFor(
          attempt,
          `Current Dashboard opening reported ${effect.result.error} after route publication`,
        );
      }
      try {
        cleanupImages(options.ownerLarkAppId, attempt.attachments ?? []);
      } catch (error) {
        return {
          kind: 'unknown',
          message: `Current Dashboard opening cleanup is unknown: ${errorMessage(error)}`,
        };
      }
      return {
        kind: 'refused',
        reason: effect.result.error === 'session_exists'
          ? 'sessionExists'
          : 'transitionRejected',
        code: effect.result.error,
        message: effect.result.error,
      };
    },
  };
}
