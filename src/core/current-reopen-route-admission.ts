/**
 * Current owner-strict admission for reopening one closed Session route.
 *
 * The Dashboard client registers its external operation receipt first, then
 * resolves the closed row here and acquires the same route admission used by
 * ordinary, scheduled, and relocation producers. The lease stays opaque to
 * callers; its token is meaningful only to the shared admission authority.
 */

import type { Session } from '../types.js';
import * as sessionStore from '../services/session-store.js';
import {
  currentRouteAdmissionKey,
  isCurrentRouteAdmissionToken,
  reserveCurrentRouteAdmission,
  type CurrentRouteAdmissionRoute,
} from './current-route-admission.js';
import type { SessionView } from './session-runtime.js';

export type CurrentReopenRouteAdmissionFailure =
  | {
      readonly kind: 'rejected';
      readonly reason: 'sessionNotFound' | 'transitionRejected';
      readonly message: string;
      readonly code?: string;
    }
  | { readonly kind: 'retryable'; readonly message: string }
  | { readonly kind: 'quarantined'; readonly message: string };

export interface CurrentReopenRouteAdmissionLease {
  readonly kind: 'reserved';
  readonly route: CurrentRouteAdmissionRoute;
  readonly ready: Promise<void>;
  readonly token: object;
  /** Re-read the owner-strict row after this lease becomes current. */
  revalidate(): CurrentReopenRouteAdmissionFailure | { readonly kind: 'current' };
  release(): void;
}

export interface CurrentReopenRouteAdmissionPort {
  reserve(input: {
    readonly session: Pick<SessionView, 'sessionId' | 'route' | 'recordStatus'>;
  }): CurrentReopenRouteAdmissionLease | CurrentReopenRouteAdmissionFailure;
}

function exactRoute(session: Session): CurrentRouteAdmissionRoute | undefined {
  const scope = session.scope === 'chat' ? 'chat' : 'thread';
  const canonicalAnchor = scope === 'chat' ? session.chatId : session.rootMessageId;
  const chatType = session.chatType ?? 'group';
  if (!session.chatId || !canonicalAnchor || (chatType !== 'group' && chatType !== 'p2p')) {
    return undefined;
  }
  return {
    scope,
    canonicalAnchor,
    chatId: session.chatId,
    chatType,
  };
}

function projectedRouteMatches(
  route: SessionView['route'],
  expected: CurrentRouteAdmissionRoute,
): boolean {
  return expected.scope === 'chat'
    ? route.kind === 'chat' && route.chatId === expected.canonicalAnchor
    : route.kind === 'thread' && route.anchorId === expected.canonicalAnchor;
}

export function createCurrentReopenRouteAdmissionPort(options: {
  readonly ownerLarkAppId: () => string;
  /** Internal fault-test seam; production reads the owner-strict JSON row. */
  readonly resolveStoredSession?: (ownerLarkAppId: string, sessionId: string) => Session | undefined;
}): CurrentReopenRouteAdmissionPort {
  const resolveStored = options.resolveStoredSession
    ?? sessionStore.getSessionForOwnerStrict;

  const resolve = (
    projected: Pick<SessionView, 'sessionId' | 'route' | 'recordStatus'>,
  ):
    | { readonly kind: 'resolved'; readonly ownerLarkAppId: string; readonly route: CurrentRouteAdmissionRoute }
    | CurrentReopenRouteAdmissionFailure => {
    let ownerLarkAppId: string;
    let stored: Session | undefined;
    try {
      ownerLarkAppId = options.ownerLarkAppId();
      if (!ownerLarkAppId) throw new Error('owner Bot is not ready');
      stored = resolveStored(ownerLarkAppId, projected.sessionId);
    } catch (error) {
      return {
        kind: 'retryable',
        message: `Current reopen route is not readable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!stored) {
      return {
        kind: 'rejected',
        reason: 'sessionNotFound',
        message: 'Session is not owned by this Runtime Host',
      };
    }
    if (projected.recordStatus !== 'closed' || stored.status !== 'closed') {
      return {
        kind: 'rejected',
        reason: 'transitionRejected',
        code: 'not_closed',
        message: 'Current Session is not closed',
      };
    }
    const route = exactRoute(stored);
    if (!route) {
      return {
        kind: 'quarantined',
        message: 'Current reopen target has malformed route metadata',
      };
    }
    if (!projectedRouteMatches(projected.route, route)) {
      return {
        kind: 'retryable',
        message: 'Current reopen target route changed before admission',
      };
    }
    return { kind: 'resolved', ownerLarkAppId, route };
  };

  return {
    reserve({ session }) {
      const resolved = resolve(session);
      if (resolved.kind !== 'resolved') return resolved;
      const key = currentRouteAdmissionKey({
        ownerLarkAppId: resolved.ownerLarkAppId,
        ...resolved.route,
      });
      const admission = reserveCurrentRouteAdmission(key);
      return {
        kind: 'reserved',
        route: resolved.route,
        ready: admission.ready,
        token: admission.token,
        revalidate() {
          if (!isCurrentRouteAdmissionToken({ token: admission.token, key })) {
            return {
              kind: 'retryable',
              message: 'Current reopen route admission is no longer held',
            };
          }
          const current = resolve(session);
          if (current.kind !== 'resolved') return current;
          if (current.ownerLarkAppId !== resolved.ownerLarkAppId
              || current.route.scope !== resolved.route.scope
              || current.route.canonicalAnchor !== resolved.route.canonicalAnchor
              || current.route.chatId !== resolved.route.chatId
              || current.route.chatType !== resolved.route.chatType) {
            return {
              kind: 'retryable',
              message: 'Current reopen target route changed while awaiting admission',
            };
          }
          return { kind: 'current' };
        },
        release: admission.release,
      };
    },
  };
}
