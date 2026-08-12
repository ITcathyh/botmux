/**
 * Retire exact disposable route occupants through their own SessionRuntime
 * lanes while one producer holds the shared owner/route admission capability.
 *
 * This module is intentionally producer-agnostic. Relocation, scheduling, and
 * reopen orchestration can share the same child-command protocol without
 * learning how opaque Session addresses, lane ordering, or control receipts
 * work.
 */

import { computeInputHash } from '../utils/canonical-input-hash.js';
import {
  currentRouteAdmissionKey,
  isCurrentRouteAdmissionToken,
  type CurrentRouteAdmissionRoute,
} from './current-route-admission.js';
import type {
  ControlMutationCommandOutcome,
  SessionView,
} from './session-runtime.js';
import type { CurrentSessionRuntimeHost } from './current-session-runtime.js';

export type CurrentRouteScratchRetirementResult =
  | { readonly kind: 'cleared' }
  | { readonly kind: 'occupied'; readonly activeSessionId: string }
  | { readonly kind: 'retryable'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

export interface CurrentRouteScratchRetirementPort {
  retire(input: {
    readonly expectedRoute: CurrentRouteAdmissionRoute;
    readonly source: 'relocate' | 'scheduler' | 'resume';
    readonly parentSessionId: string;
    readonly parentOperationIdentity: string;
    readonly heldRouteAdmissionToken: unknown;
  }): Promise<CurrentRouteScratchRetirementResult>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function matchesRoute(session: SessionView, expected: CurrentRouteAdmissionRoute): boolean {
  // Occupancy is decided by the CANONICAL anchor, the same value the control
  // Adapter's routeScratch close guard compares (sessionAnchorId). Matching on
  // the visible route here would classify a deferredScheduleRun Session —
  // isolated on its own routingAnchor but delivered into the same chat — as
  // the route occupant, and the downstream close guard would then reject it as
  // target_chat_has_session: a phantom `occupied` for an actually-free anchor.
  return (expected.scope === 'chat'
    ? session.route.kind === 'chat'
    : session.route.kind === 'thread')
    && session.canonicalAnchor === expected.canonicalAnchor;
}

function childOperationIdentity(input: {
  readonly source: 'relocate' | 'scheduler' | 'resume';
  readonly parentSessionId: string;
  readonly parentOperationIdentity: string;
}): string {
  return `route-scratch:${computeInputHash(input)}`;
}

export function createCurrentRouteScratchRetirementPort(options: {
  readonly ownerLarkAppId: string;
  /** Resolve the current lease only when an operation runs; construction may
   * happen while the enclosing owner Host is still being composed. */
  readonly downstream: () => CurrentSessionRuntimeHost;
}): CurrentRouteScratchRetirementPort {
  const admissionKey = (route: CurrentRouteAdmissionRoute): string => currentRouteAdmissionKey({
    ownerLarkAppId: options.ownerLarkAppId,
    ...route,
  });
  const admissionIsCurrent = (
    route: CurrentRouteAdmissionRoute,
    token: unknown,
  ): boolean => isCurrentRouteAdmissionToken({ token, key: admissionKey(route) });
  const listActiveRoute = async (
    route: CurrentRouteAdmissionRoute,
  ): Promise<
    | { readonly kind: 'ready'; readonly sessions: SessionView[] }
    | { readonly kind: 'retryable'; readonly message: string }
    | { readonly kind: 'unknown'; readonly message: string }
  > => {
    let host: CurrentSessionRuntimeHost;
    try {
      host = options.downstream();
    } catch (error) {
      return {
        kind: 'retryable',
        message: `Current route scratch Host is not ready: ${message(error)}`,
      };
    }
    let projected: Awaited<ReturnType<CurrentSessionRuntimeHost['projection']['read']>>;
    try {
      projected = await host.projection.read({ kind: 'list' });
    } catch (error) {
      return {
        kind: 'retryable',
        message: `Current route scratch projection failed: ${message(error)}`,
      };
    }
    if (projected.kind === 'notReady') {
      return { kind: 'retryable', message: projected.message };
    }
    if (projected.kind !== 'list') {
      return {
        kind: 'unknown',
        message: 'Current route scratch projection did not return a Session list',
      };
    }
    return {
      kind: 'ready',
      sessions: projected.sessions.filter(session => (
        session.recordStatus === 'active' && matchesRoute(session, route)
      )),
    };
  };

  return {
    async retire(input) {
      const tokenCurrent = (): boolean => admissionIsCurrent(
        input.expectedRoute,
        input.heldRouteAdmissionToken,
      );
      if (!tokenCurrent()) {
        return {
          kind: 'retryable',
          message: 'Current route scratch retirement requires the held exact route admission',
        };
      }
      const initial = await listActiveRoute(input.expectedRoute);
      if (initial.kind !== 'ready') return initial;
      if (!tokenCurrent()) {
        return {
          kind: 'retryable',
          message: 'Current route admission changed before scratch retirement began',
        };
      }

      let applied = false;
      const childIdentity = childOperationIdentity(input);
      for (const candidate of initial.sessions) {
        let settled = false;
        for (let attempt = 0; attempt < 2 && !settled; attempt += 1) {
          if (!tokenCurrent()) {
            return applied
              ? { kind: 'unknown', message: 'Current route admission changed after scratch retirement began' }
              : { kind: 'retryable', message: 'Current route admission changed before scratch retirement' };
          }
          let host: CurrentSessionRuntimeHost;
          try {
            host = options.downstream();
          } catch (error) {
            const detail = `Current route scratch Host is not ready: ${message(error)}`;
            return applied ? { kind: 'unknown', message: detail } : { kind: 'retryable', message: detail };
          }
          let exact: Awaited<ReturnType<CurrentSessionRuntimeHost['projection']['read']>>;
          try {
            exact = await host.projection.read({
              kind: 'byExternalSession',
              sessionId: candidate.sessionId,
            });
          } catch (error) {
            const detail = `Current route scratch projection failed: ${message(error)}`;
            return applied ? { kind: 'unknown', message: detail } : { kind: 'retryable', message: detail };
          }
          if (exact.kind === 'notFound') {
            settled = true;
            break;
          }
          if (exact.kind === 'notReady') {
            return applied
              ? { kind: 'unknown', message: exact.message }
              : { kind: 'retryable', message: exact.message };
          }
          if (exact.kind !== 'one') {
            return {
              kind: 'unknown',
              message: 'Current route scratch did not resolve to one exact Session',
            };
          }
          if (exact.session.sessionId !== candidate.sessionId) {
            return {
              kind: 'unknown',
              message: 'Current route scratch exact projection changed Session identity',
            };
          }
          if (exact.session.recordStatus !== 'active'
              || !matchesRoute(exact.session, input.expectedRoute)) {
            // The initially classified candidate departed before its exact
            // lane admission. Do not misreport that stale identity as the
            // current occupant; the final route census decides what replaced it.
            settled = true;
            break;
          }
          let outcome: ControlMutationCommandOutcome;
          try {
            outcome = await host.runtime.submit({
              target: {
                kind: 'session',
                address: exact.session.address,
                controlRouteReservation: input.heldRouteAdmissionToken,
              },
              idempotencyKey: childIdentity,
              command: {
                kind: 'control.mutate',
                input: {
                  kind: 'close',
                  reason: 'routeScratch',
                  source: input.source,
                  expectedRoute: input.expectedRoute,
                },
              },
            });
          } catch (error) {
            return {
              kind: 'unknown',
              message: `Current route scratch close outcome is unknown: ${message(error)}`,
            };
          }
          if (outcome.kind === 'staleAddress' && attempt === 0) continue;
          if (outcome.kind === 'applied' || outcome.kind === 'duplicate') {
            if (!outcome.result || outcome.result.kind !== 'closed') {
              return {
                kind: 'unknown',
                message: 'Current route scratch close returned a different control result',
              };
            }
            applied = true;
            settled = true;
            break;
          }
          if (outcome.kind === 'retryable'
              || outcome.kind === 'notWired'
              || outcome.kind === 'staleAddress') {
            const detail = 'message' in outcome
              ? outcome.message
              : 'Current route scratch address remained stale';
            return applied ? { kind: 'unknown', message: detail } : { kind: 'retryable', message: detail };
          }
          if (outcome.kind === 'ambiguous' || outcome.kind === 'quarantined') {
            return { kind: 'unknown', message: outcome.message };
          }
          if (outcome.kind === 'rejected') {
            if (outcome.reason === 'sessionNotFound') {
              settled = true;
              break;
            }
            if (outcome.code === 'target_chat_has_session') {
              return { kind: 'occupied', activeSessionId: candidate.sessionId };
            }
            return {
              kind: 'unknown',
              message: `Current route scratch close was rejected: ${outcome.message}`,
            };
          }
        }
      }

      if (!tokenCurrent()) {
        return applied
          ? { kind: 'unknown', message: 'Current route admission changed after scratch retirement' }
          : { kind: 'retryable', message: 'Current route admission changed before route verification' };
      }
      const remaining = await listActiveRoute(input.expectedRoute);
      if (remaining.kind !== 'ready') {
        return applied && remaining.kind === 'retryable'
          ? { kind: 'unknown', message: remaining.message }
          : remaining;
      }
      if (remaining.sessions[0]) {
        return { kind: 'occupied', activeSessionId: remaining.sessions[0].sessionId };
      }
      return { kind: 'cleared' };
    },
  };
}
