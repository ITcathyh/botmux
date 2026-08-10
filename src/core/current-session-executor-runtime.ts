import { isDeepStrictEqual } from 'node:util';
import * as sessionStore from '../services/session-store.js';
import type { Session } from '../types.js';
import {
  currentSessionCommandLane,
  currentSessionLaneAddressForKey,
} from './current-session-command-lane.js';
import {
  createSessionExecutorRuntime,
  type ExecutorContinuation,
  type ExecutorContinuationDecision,
  type ExecutorGenerationAuthority,
  type ExecutorGenerationCommit,
  type ExecutorLease,
  type ExecutorObservation,
  type ExecutorObservationDecision,
} from './session-executor-runtime.js';
import {
  activeSessionKey,
  sessionAnchorId,
  storedSessionAnchorId,
  type DaemonSession,
} from './types.js';

export interface CurrentSessionExecutorRuntime {
  commitGeneration(session: DaemonSession): ExecutorGenerationCommit;
  activate(commit: ExecutorGenerationCommit, identity: object): ExecutorLease;
  report<T>(
    lease: ExecutorLease,
    observation: ExecutorObservation,
    transition: (decision: ExecutorObservationDecision) => T,
  ): Promise<T>;
  resume<T>(
    continuation: ExecutorContinuation,
    transition: (decision: ExecutorContinuationDecision) => T,
  ): Promise<T>;
  isCurrent(lease: ExecutorLease): boolean;
  /** Process-local fail-closed gate for an unproved generation publication. */
  isQuarantined(session: DaemonSession): boolean;
}

/**
 * Current JSON/worker implementation of the internal Executor Runtime.
 *
 * WorkerPool sees only commit/lease/report. Exact mutable Session ownership,
 * legacy publication, response-loss readback, and exit fencing stay inside
 * this Adapter instead of being reconstructed at each callback site.
 */
export function createCurrentSessionExecutorRuntime(input: {
  activeSessions: () => Map<string, DaemonSession> | undefined;
  runtimeEpoch?: string;
}): CurrentSessionExecutorRuntime {
  const runtimeEpoch = input.runtimeEpoch ?? 'current-session-executor-runtime';
  const runtime = createSessionExecutorRuntime({
    commandLane: currentSessionCommandLane,
    laneAddressForSessionKey: sessionKey => currentSessionLaneAddressForKey(
      runtimeEpoch,
      sessionKey,
    ),
  });
  type PendingGenerationWrite = {
    session: Session;
    ownerLarkAppId: string;
    anchor: string;
    previousGeneration: number;
    intendedGeneration: number;
    previousSnapshot: Session;
    intendedSnapshot: Session;
  };
  const pendingExitFences = new Map<string, PendingGenerationWrite>();
  const pendingReservations = new Map<string, PendingGenerationWrite>();

  const persistedSnapshot = (session: Session): Session => (
    JSON.parse(JSON.stringify(session)) as Session
  );

  const samePersistedRow = (left: Session, right: Session): boolean => (
    isDeepStrictEqual(persistedSnapshot(left), persistedSnapshot(right))
  );

  const logicalSessionKey = (ownerLarkAppId: string, sessionId: string): string => (
    `${ownerLarkAppId}\0${sessionId}`
  );

  const exactBinding = (
    session: Session,
    expected: { ownerLarkAppId: string; sessionId: string; anchor: string },
  ): boolean => session.sessionId === expected.sessionId
    && (!session.larkAppId || session.larkAppId === expected.ownerLarkAppId)
    && storedSessionAnchorId(session) === expected.anchor
    && session.status === 'active';

  const reconcilePendingExitFence = (ds: DaemonSession): PendingGenerationWrite | undefined => {
    const key = logicalSessionKey(ds.larkAppId, ds.session.sessionId);
    const pending = pendingExitFences.get(key);
    if (!pending) return undefined;
    if (pending.session !== ds.session
      || pending.ownerLarkAppId !== ds.larkAppId
      || pending.anchor !== sessionAnchorId(ds)) {
      throw new Error('worker-exit generation fence is quarantined under a different Session binding');
    }
    const readback = sessionStore.getSessionForOwnerStrict(ds.larkAppId, ds.session.sessionId);
    if (!readback || !exactBinding(readback, {
      ownerLarkAppId: ds.larkAppId,
      sessionId: ds.session.sessionId,
      anchor: pending.anchor,
    })) {
      throw new Error('worker-exit generation fence remains quarantined: owner row is absent or rebound');
    }
    if (samePersistedRow(readback, pending.intendedSnapshot)) {
      ds.workerGeneration = pending.intendedGeneration;
      ds.session.workerGeneration = pending.intendedGeneration;
      ds.session.pid = undefined;
      pendingExitFences.delete(key);
      return undefined;
    }
    if (samePersistedRow(readback, pending.previousSnapshot)) {
      // Proven pre-publish failure. The following reservation repairs the dead
      // fence and publishes a still-higher generation in one atomic row write.
      return pending;
    }
    // Whole-row equality is the wrong oracle once other legitimate writers
    // (per-turn metadata, card state) have republished the row between the
    // quarantine and this reconcile. The generation field alone is monotonic
    // and single-writer per owner: at/above the intended fence means the fence
    // (or a stronger one) is durably published; exactly the previous value
    // means this fence provably never landed and can be repaired.
    const fencedbackGeneration = readback.workerGeneration ?? 0;
    if (fencedbackGeneration >= pending.intendedGeneration) {
      const adopted = Math.max(fencedbackGeneration, pending.intendedGeneration);
      ds.workerGeneration = adopted;
      ds.session.workerGeneration = adopted;
      ds.session.pid = undefined;
      pendingExitFences.delete(key);
      return undefined;
    }
    if (fencedbackGeneration === pending.previousGeneration) return pending;
    throw new Error('worker-exit generation fence remains quarantined: unexpected durable generation');
  };

  const reconcilePendingReservation = (ds: DaemonSession): void => {
    const key = logicalSessionKey(ds.larkAppId, ds.session.sessionId);
    const pending = pendingReservations.get(key);
    if (!pending) return;
    if (pending.session !== ds.session
      || pending.ownerLarkAppId !== ds.larkAppId
      || pending.anchor !== sessionAnchorId(ds)) {
      throw new Error('worker generation reservation is quarantined under a different Session binding');
    }
    const readback = sessionStore.getSessionForOwnerStrict(ds.larkAppId, ds.session.sessionId);
    if (!readback || !exactBinding(readback, {
      ownerLarkAppId: ds.larkAppId,
      sessionId: ds.session.sessionId,
      anchor: pending.anchor,
    })) {
      throw new Error('worker generation reservation remains quarantined: owner row is absent or rebound');
    }
    if (samePersistedRow(readback, pending.intendedSnapshot)) {
      ds.workerGeneration = pending.intendedGeneration;
      ds.session.workerGeneration = pending.intendedGeneration;
      pendingReservations.delete(key);
      return;
    }
    if (samePersistedRow(readback, pending.previousSnapshot)) {
      ds.workerGeneration = pending.previousGeneration || undefined;
      ds.session.workerGeneration = pending.previousGeneration || undefined;
      pendingReservations.delete(key);
      return;
    }
    // See reconcilePendingExitFence: interleaved legitimate row writers make
    // whole-row equality unreachable, so fall back to the monotonic generation
    // field before declaring the reservation permanently quarantined.
    const readbackGeneration = readback.workerGeneration ?? 0;
    if (readbackGeneration >= pending.intendedGeneration) {
      const adopted = Math.max(
        ds.workerGeneration ?? 0,
        ds.session.workerGeneration ?? 0,
        readbackGeneration,
      );
      ds.workerGeneration = adopted;
      ds.session.workerGeneration = adopted;
      pendingReservations.delete(key);
      return;
    }
    if (readbackGeneration === pending.previousGeneration) {
      ds.workerGeneration = pending.previousGeneration || undefined;
      ds.session.workerGeneration = pending.previousGeneration || undefined;
      pendingReservations.delete(key);
      return;
    }
    throw new Error('worker generation reservation remains quarantined: unexpected durable generation');
  };

  return {
    commitGeneration(ds) {
      reconcilePendingReservation(ds);
      const repairingExitFence = reconcilePendingExitFence(ds);
      const handlerSession = ds.session;
      const handlerAnchor = sessionAnchorId(ds);
      const handlerLarkAppId = ds.larkAppId;
      const handlerRegistryKey = activeSessionKey(ds);
      const binding = {
        ownerLarkAppId: handlerLarkAppId,
        sessionId: handlerSession.sessionId,
        anchor: handlerAnchor,
      };
      const key = logicalSessionKey(handlerLarkAppId, handlerSession.sessionId);
      let exactToken: object | undefined;
      const authority: ExecutorGenerationAuthority = {
        sessionKey: key,
        sessionId: handlerSession.sessionId,
        commitNext() {
          const previousDaemonGeneration = ds.workerGeneration;
          const previousSessionGeneration = ds.session.workerGeneration;
          const previousSnapshot = persistedSnapshot(ds.session);
          const workerGeneration = Math.max(
            previousDaemonGeneration ?? 0,
            previousSessionGeneration ?? 0,
          ) + 1;
          const token = Object.freeze({ workerGeneration });
          exactToken = token;
          ds.workerGeneration = workerGeneration;
          ds.session.workerGeneration = workerGeneration;
          const intendedSnapshot = persistedSnapshot(ds.session);
          const quarantineReservation = (): void => {
            pendingReservations.set(key, {
              session: handlerSession,
              ownerLarkAppId: handlerLarkAppId,
              anchor: handlerAnchor,
              previousGeneration: previousSessionGeneration ?? 0,
              intendedGeneration: workerGeneration,
              previousSnapshot,
              intendedSnapshot,
            });
          };
          try {
            sessionStore.updateSession(ds.session);
          } catch (error) {
            let readback: Session | undefined;
            try {
              readback = sessionStore.getSessionForOwnerStrict(
                handlerLarkAppId,
                handlerSession.sessionId,
              );
            } catch (readbackError) {
              exactToken = undefined;
              quarantineReservation();
              throw new Error(
                `worker generation reservation outcome is unknown: ${error instanceof Error ? error.message : String(error)}; `
                + `strict readback failed: ${readbackError instanceof Error ? readbackError.message : String(readbackError)}`,
              );
            }
            if (!readback || !exactBinding(readback, binding)) {
              exactToken = undefined;
              quarantineReservation();
              throw new Error('worker generation reservation owner row is absent or rebound');
            }
            if (!samePersistedRow(readback, intendedSnapshot)) {
              // Roll back only when the exact owner file proves this attempt
              // did not publish and the complete prior row is unchanged.
              const observedGeneration = readback.workerGeneration;
              if (!repairingExitFence && samePersistedRow(readback, previousSnapshot)) {
                if (previousDaemonGeneration === undefined) delete ds.workerGeneration;
                else ds.workerGeneration = previousDaemonGeneration;
                if (previousSessionGeneration === undefined) delete ds.session.workerGeneration;
                else ds.session.workerGeneration = previousSessionGeneration;
              } else {
                if (observedGeneration !== undefined) {
                  ds.workerGeneration = Math.max(ds.workerGeneration ?? 0, observedGeneration);
                  ds.session.workerGeneration = Math.max(ds.session.workerGeneration ?? 0, observedGeneration);
                }
                quarantineReservation();
              }
              exactToken = undefined;
              throw error;
            }
            // Atomic publish landed and only its response/fsync tail was lost.
          }
          pendingReservations.delete(key);
          pendingExitFences.delete(key);
          return {
            token,
            generation: workerGeneration,
          };
        },

        owns(token, identity) {
          if (token !== exactToken) return false;
          const generation = (token as { workerGeneration: number }).workerGeneration;
          const registry = input.activeSessions();
          return ds.worker === identity
            && ds.workerGeneration === generation
            && ds.session.workerGeneration === generation
            && ds.session === handlerSession
            && ds.session.status === 'active'
            && ds.larkAppId === handlerLarkAppId
            && sessionAnchorId(ds) === handlerAnchor
            && (
              !registry
              || registry.get(handlerRegistryKey) === ds
            );
        },

        fenceExit(token, identity) {
          if (!authority.owns(token, identity)) return { kind: 'stale' };
          const workerGeneration = (token as { workerGeneration: number }).workerGeneration;
          const previousGeneration = Math.max(
            workerGeneration,
            ds.workerGeneration ?? 0,
            ds.session.workerGeneration ?? 0,
          );
          const previousSnapshot = persistedSnapshot(ds.session);
          const fencedGeneration = Math.max(
            workerGeneration,
            ds.workerGeneration ?? 0,
            ds.session.workerGeneration ?? 0,
          ) + 1;
          ds.workerGeneration = fencedGeneration;
          ds.session.workerGeneration = fencedGeneration;
          ds.session.pid = undefined;
          const intendedSnapshot = persistedSnapshot(ds.session);
          try {
            sessionStore.updateSession(ds.session);
          } catch (error) {
            try {
              const readback = sessionStore.getSessionForOwnerStrict(
                handlerLarkAppId,
                handlerSession.sessionId,
              );
              if (readback
                && exactBinding(readback, binding)
                && samePersistedRow(readback, intendedSnapshot)) {
                return { kind: 'fenced', generation: fencedGeneration };
              }
            } catch {
              // Fall through to the typed unreadable outcome below.
            }
            // The child is already dead. Keep the process-local fence and
            // quarantine current effects; rolling back would resurrect it.
            pendingExitFences.set(key, {
              session: handlerSession,
              ownerLarkAppId: handlerLarkAppId,
              anchor: handlerAnchor,
              previousGeneration,
              intendedGeneration: fencedGeneration,
              previousSnapshot,
              intendedSnapshot,
            });
            return {
              kind: 'unreadable',
              message: `worker-exit generation fence could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          return { kind: 'fenced', generation: fencedGeneration };
        },
      };
      return runtime.commitGeneration(authority);
    },

    activate: runtime.activate,
    report: runtime.report,
    resume: runtime.resume,
    isCurrent: runtime.isCurrent,
    isQuarantined(ds) {
      const key = logicalSessionKey(ds.larkAppId, ds.session.sessionId);
      return pendingReservations.has(key) || pendingExitFences.has(key);
    },
  };
}
