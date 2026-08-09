/**
 * Generation-fenced observation boundary for one Session Executor activation.
 *
 * This is an internal SessionRuntime Module, not an ingress command surface.
 * The worker Adapter commits a generation before spawn, activates the opaque
 * commitment for one concrete process identity, and can thereafter report only
 * through the minted lease. Backend I/O and long-running callbacks remain
 * outside this short synchronous boundary.
 */

import {
  createSessionCommandLaneHost,
  type SessionCommandLane,
  type SessionLaneAddress,
} from './session-command-lane.js';

declare const executorGenerationCommitBrand: unique symbol;
declare const executorLeaseBrand: unique symbol;
declare const executorContinuationBrand: unique symbol;

export interface ExecutorGenerationAuthority {
  /** Stable owner-scoped identity, available before any durable publication. */
  readonly sessionKey: string;
  readonly sessionId: string;
  /** Persist the next generation before a replacement process may be spawned. */
  commitNext(): {
    token: unknown;
    generation: number;
  };
  /** Exact Current binding check: owner, Session, process identity, generation. */
  owns(token: unknown, identity: object): boolean;
  /** Persist the dead-generation fence before any current lifecycle effect. */
  fenceExit(token: unknown, identity: object):
    | { kind: 'fenced'; generation: number }
    | { kind: 'stale' }
    | { kind: 'unreadable'; message: string };
}

export type ExecutorGenerationCommit = Readonly<{
  generation: number;
  [executorGenerationCommitBrand]: true;
}>;

export type ExecutorLease = Readonly<Record<never, never>> & {
  readonly [executorLeaseBrand]: true;
};

export type ExecutorContinuation = Readonly<Record<never, never>> & {
  readonly [executorContinuationBrand]: true;
};

export type ExecutorObservation =
  | { kind: 'inputReceived'; turnId: string }
  | { kind: 'inputRejected'; turnId: string }
  | { kind: 'inputCommitted'; turnId: string }
  | { kind: 'turnTerminal'; turnId: string }
  | { kind: 'cliExit' }
  | { kind: 'workerExit' };

type CurrentObservation = {
  kind: 'current';
  sessionId: string;
  executorGeneration: number;
  continuation?: ExecutorContinuation;
};

export type ExecutorObservationDecision =
  | CurrentObservation
  | {
      kind: 'currentExit';
      sessionId: string;
      executorGeneration: number;
      fencedGeneration: number;
    }
  | {
      kind: 'retiringExit';
      sessionId: string;
      executorGeneration: number;
    }
  | {
      kind: 'stale';
      sessionId: string;
      executorGeneration: number;
    }
  | {
      kind: 'unreadable';
      sessionId: string;
      executorGeneration: number;
      current: true;
      message: string;
    };

export type ExecutorContinuationDecision =
  | Pick<CurrentObservation, 'kind' | 'sessionId' | 'executorGeneration'>
  | Extract<ExecutorObservationDecision, { kind: 'stale' }>;

interface CommitSlot {
  authority: ExecutorGenerationAuthority;
  token: unknown;
  sessionKey: string;
  sessionId: string;
  generation: number;
  laneAddress: SessionLaneAddress;
  activated: boolean;
}

interface LeaseSlot extends CommitSlot {
  identity: object;
  ended: boolean;
  /** Durable exit classification awaiting one successful short transition. */
  pendingExitDecision?: ExecutorObservationDecision;
}

interface ContinuationSlot {
  lease: ExecutorLease;
}

function opaque<T>(): T {
  return Object.freeze({}) as T;
}

function invokeSynchronousAuthority<T>(label: string, invoke: () => T): T {
  const value = invoke();
  if (value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function') {
    void Promise.resolve(value).catch(() => undefined);
    throw new Error(`${label} must return synchronously`);
  }
  return value;
}

export interface SessionExecutorRuntime {
  commitGeneration(authority: ExecutorGenerationAuthority): ExecutorGenerationCommit;
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
  /** Long-lived effect guard for delayed named Adapters; carries no generation bytes. */
  isCurrent(lease: ExecutorLease): boolean;
}

export function createSessionExecutorRuntime(options: {
  commandLane?: SessionCommandLane;
  laneAddressForSessionKey?: (sessionKey: string) => SessionLaneAddress;
} = {}): SessionExecutorRuntime {
  if (!!options.commandLane !== !!options.laneAddressForSessionKey) {
    throw new Error('Executor Runtime requires both command lane and lane address resolver');
  }
  const localLaneHost = options.commandLane ? undefined : createSessionCommandLaneHost();
  const commandLane = options.commandLane ?? localLaneHost!.lane;
  const laneAddressForSessionKey = options.laneAddressForSessionKey ?? localLaneHost!.addressFor;
  const commits = new WeakMap<object, CommitSlot>();
  const leases = new WeakMap<object, LeaseSlot>();
  const continuations = new WeakMap<object, ContinuationSlot>();
  const currentCommitBySessionKey = new Map<string, CommitSlot>();
  const generationFloorBySessionKey = new Map<string, number>();

  const stale = (slot: Pick<LeaseSlot, 'sessionId' | 'generation'>): ExecutorObservationDecision => ({
    kind: 'stale',
    sessionId: slot.sessionId,
    executorGeneration: slot.generation,
  });

  const decideReport = (
    slot: LeaseSlot,
    lease: ExecutorLease,
    observation: ExecutorObservation,
  ): ExecutorObservationDecision => {
    if (slot.ended) {
      if (observation.kind === 'workerExit' && slot.pendingExitDecision) {
        const replacement = currentCommitBySessionKey.get(slot.sessionKey);
        if (replacement && replacement !== slot
          && (slot.pendingExitDecision.kind === 'currentExit'
            || slot.pendingExitDecision.kind === 'unreadable')) {
          // The durable exit/fence fact belongs to this old generation, but a
          // newly committed generation now owns every mutable lifecycle slot.
          // A cleanup retry may reconcile only old-generation named evidence.
          slot.pendingExitDecision = {
            kind: 'retiringExit',
            sessionId: slot.sessionId,
            executorGeneration: slot.generation,
          };
        }
        return slot.pendingExitDecision;
      }
      return stale(slot);
    }

    if (observation.kind === 'workerExit') {
      // Every authentic process identity gets one exit classification. A
      // replaced generation may reconcile its own named receipts, but can
      // never fence or publish lifecycle state for the replacement.
      if (currentCommitBySessionKey.get(slot.sessionKey) !== slot
        || !invokeSynchronousAuthority(
          'ExecutorGenerationAuthority.owns',
          () => slot.authority.owns(slot.token, slot.identity),
        )) {
        const decision: ExecutorObservationDecision = {
          kind: 'retiringExit',
          sessionId: slot.sessionId,
          executorGeneration: slot.generation,
        };
        slot.ended = true;
        slot.pendingExitDecision = decision;
        return decision;
      }
      const fenced = invokeSynchronousAuthority(
        'ExecutorGenerationAuthority.fenceExit',
        () => slot.authority.fenceExit(slot.token, slot.identity),
      );
      if (fenced.kind === 'stale') {
        if (currentCommitBySessionKey.get(slot.sessionKey) === slot) {
          currentCommitBySessionKey.delete(slot.sessionKey);
        }
        const decision = stale(slot);
        slot.ended = true;
        slot.pendingExitDecision = decision;
        return decision;
      }
      if (fenced.kind === 'unreadable') {
        const decision: ExecutorObservationDecision = {
          kind: 'unreadable',
          sessionId: slot.sessionId,
          executorGeneration: slot.generation,
          current: true,
          message: fenced.message,
        };
        slot.ended = true;
        slot.pendingExitDecision = decision;
        return decision;
      }
      const generationFloor = generationFloorBySessionKey.get(slot.sessionKey) ?? slot.generation;
      if (!Number.isSafeInteger(fenced.generation)
        || fenced.generation <= slot.generation
        || fenced.generation <= generationFloor) {
        const decision: ExecutorObservationDecision = {
          kind: 'unreadable',
          sessionId: slot.sessionId,
          executorGeneration: slot.generation,
          current: true,
          message: 'Executor generation authority returned an invalid exit fence',
        };
        slot.ended = true;
        slot.pendingExitDecision = decision;
        return decision;
      }
      generationFloorBySessionKey.set(
        slot.sessionKey,
        Math.max(generationFloorBySessionKey.get(slot.sessionKey) ?? 0, fenced.generation),
      );
      if (currentCommitBySessionKey.get(slot.sessionKey) === slot) {
        currentCommitBySessionKey.delete(slot.sessionKey);
      }
      const decision: ExecutorObservationDecision = {
        kind: 'currentExit',
        sessionId: slot.sessionId,
        executorGeneration: slot.generation,
        fencedGeneration: fenced.generation,
      };
      slot.ended = true;
      slot.pendingExitDecision = decision;
      return decision;
    }

    if (currentCommitBySessionKey.get(slot.sessionKey) !== slot
      || !invokeSynchronousAuthority(
        'ExecutorGenerationAuthority.owns',
        () => slot.authority.owns(slot.token, slot.identity),
      )) return stale(slot);

    if (observation.kind === 'turnTerminal' || observation.kind === 'cliExit') {
      const continuation = opaque<ExecutorContinuation>();
      continuations.set(continuation, { lease });
      return {
        kind: 'current',
        sessionId: slot.sessionId,
        executorGeneration: slot.generation,
        continuation,
      };
    }
    return {
      kind: 'current',
      sessionId: slot.sessionId,
      executorGeneration: slot.generation,
    };
  };

  return {
    commitGeneration(authority) {
      const authoritySessionKey = authority.sessionKey;
      const authoritySessionId = authority.sessionId;
      if (!authoritySessionKey || !authoritySessionId) {
        throw new Error('Executor generation authority has an invalid Session identity');
      }
      // Resolve the infallible ordering capability before the Adapter is
      // allowed to publish a new generation. A post-publication lookup failure
      // would otherwise strand a durable generation without a returned lease.
      const laneAddress = laneAddressForSessionKey(authoritySessionKey);
      const committed = invokeSynchronousAuthority(
        'ExecutorGenerationAuthority.commitNext',
        () => authority.commitNext(),
      );
      if (!Number.isSafeInteger(committed.generation)
        || committed.generation <= 0) {
        throw new Error('Executor generation authority returned an invalid commitment');
      }
      const generationFloor = generationFloorBySessionKey.get(authoritySessionKey) ?? 0;
      if (committed.generation <= generationFloor) {
        // The Adapter has already attempted publication. Preserve safety by
        // revoking the old in-process lease instead of pretending its lower
        // generation is still current.
        currentCommitBySessionKey.delete(authoritySessionKey);
        throw new Error('Executor generation authority returned a non-monotonic commitment');
      }
      const commit = Object.freeze({
        generation: committed.generation,
      }) as ExecutorGenerationCommit;
      const slot: CommitSlot = {
        authority,
        token: committed.token,
        sessionKey: authoritySessionKey,
        sessionId: authoritySessionId,
        generation: committed.generation,
        laneAddress,
        activated: false,
      };
      commits.set(commit, slot);
      generationFloorBySessionKey.set(authoritySessionKey, committed.generation);
      // Publication of a newer generation is itself the revocation boundary;
      // the replacement process need not already be spawned/activated.
      currentCommitBySessionKey.set(authoritySessionKey, slot);
      return commit;
    },

    activate(commit, identity) {
      const slot = commits.get(commit);
      if (!slot) throw new Error('Executor generation commitment belongs to another Runtime epoch');
      if (slot.activated) throw new Error('Executor generation commitment was already activated');
      if (currentCommitBySessionKey.get(slot.sessionKey) !== slot) {
        throw new Error('Executor generation commitment was superseded before activation');
      }
      slot.activated = true;
      const lease = opaque<ExecutorLease>();
      const leaseSlot: LeaseSlot = { ...slot, identity, ended: false };
      leases.set(lease, leaseSlot);
      currentCommitBySessionKey.set(slot.sessionKey, leaseSlot);
      return lease;
    },

    report(lease, observation, transition) {
      const slot = leases.get(lease);
      if (!slot) return Promise.reject(new Error('Executor lease belongs to another Runtime epoch'));
      return commandLane.submit(
        slot.laneAddress,
        () => {
          const decision = decideReport(slot, lease, observation);
          try {
            const result = invokeSynchronousAuthority(
              'Executor report transition',
              () => transition(decision),
            );
            if (observation.kind === 'workerExit'
              && slot.pendingExitDecision === decision) {
              slot.pendingExitDecision = undefined;
            }
            return result;
          } catch (error) {
            if (decision.kind === 'current' && decision.continuation) {
              continuations.delete(decision.continuation);
            }
            throw error;
          }
        },
      );
    },

    resume(continuation, transition) {
      const continuationSlot = continuations.get(continuation);
      if (!continuationSlot) {
        return Promise.reject(new Error('Executor continuation belongs to another Runtime epoch'));
      }
      const slot = leases.get(continuationSlot.lease)!;
      return commandLane.submit(slot.laneAddress, () => {
        if (continuations.get(continuation) !== continuationSlot) {
          throw new Error('Executor continuation was already consumed');
        }
        let decision: ExecutorContinuationDecision;
        if (slot.ended
          || currentCommitBySessionKey.get(slot.sessionKey) !== slot
          || !invokeSynchronousAuthority(
            'ExecutorGenerationAuthority.owns',
            () => slot.authority.owns(slot.token, slot.identity),
          )) {
          decision = {
            kind: 'stale',
            sessionId: slot.sessionId,
            executorGeneration: slot.generation,
          };
        } else {
          decision = {
            kind: 'current',
            sessionId: slot.sessionId,
            executorGeneration: slot.generation,
          };
        }
        const result = invokeSynchronousAuthority(
          'Executor continuation transition',
          () => transition(decision),
        );
        // Consume only after the short transition succeeds. A reducer failure
        // can be retried without re-running the external effect that minted it.
        continuations.delete(continuation);
        return result;
      });
    },

    isCurrent(lease) {
      const slot = leases.get(lease);
      if (!slot
        || slot.ended
        || currentCommitBySessionKey.get(slot.sessionKey) !== slot) return false;
      try {
        return invokeSynchronousAuthority(
          'ExecutorGenerationAuthority.owns',
          () => slot.authority.owns(slot.token, slot.identity),
        );
      } catch {
        return false;
      }
    },
  };
}
