/**
 * Generation-fenced observation boundary for one Session Executor activation.
 *
 * This is an internal SessionRuntime Module, not an ingress command surface.
 * The worker Adapter commits a generation before spawn, activates the opaque
 * commitment for one concrete process identity, and can thereafter report only
 * through the minted lease. Backend I/O and long-running callbacks remain
 * outside this short synchronous boundary.
 */

declare const executorGenerationCommitBrand: unique symbol;
declare const executorLeaseBrand: unique symbol;
declare const executorContinuationBrand: unique symbol;

export interface ExecutorGenerationAuthority {
  /** Persist the next generation before a replacement process may be spawned. */
  commitNext(): {
    token: unknown;
    /** Owner-scoped logical Session identity; never exposed to report callers. */
    sessionKey: string;
    sessionId: string;
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
  activated: boolean;
}

interface LeaseSlot extends CommitSlot {
  identity: object;
  ended: boolean;
}

interface ContinuationSlot {
  lease: ExecutorLease;
}

function opaque<T>(): T {
  return Object.freeze({}) as T;
}

export interface SessionExecutorRuntime {
  commitGeneration(authority: ExecutorGenerationAuthority): ExecutorGenerationCommit;
  activate(commit: ExecutorGenerationCommit, identity: object): ExecutorLease;
  report(lease: ExecutorLease, observation: ExecutorObservation): ExecutorObservationDecision;
  resume(continuation: ExecutorContinuation): ExecutorContinuationDecision;
  /** Long-lived effect guard for delayed named Adapters; carries no generation bytes. */
  isCurrent(lease: ExecutorLease): boolean;
}

export function createSessionExecutorRuntime(): SessionExecutorRuntime {
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

  return {
    commitGeneration(authority) {
      const committed = authority.commitNext();
      if (!committed.sessionKey
        || !committed.sessionId
        || !Number.isSafeInteger(committed.generation)
        || committed.generation <= 0) {
        throw new Error('Executor generation authority returned an invalid commitment');
      }
      const generationFloor = generationFloorBySessionKey.get(committed.sessionKey) ?? 0;
      if (committed.generation <= generationFloor) {
        // The Adapter has already attempted publication. Preserve safety by
        // revoking the old in-process lease instead of pretending its lower
        // generation is still current.
        currentCommitBySessionKey.delete(committed.sessionKey);
        throw new Error('Executor generation authority returned a non-monotonic commitment');
      }
      const commit = Object.freeze({
        generation: committed.generation,
      }) as ExecutorGenerationCommit;
      const slot: CommitSlot = {
        authority,
        token: committed.token,
        sessionKey: committed.sessionKey,
        sessionId: committed.sessionId,
        generation: committed.generation,
        activated: false,
      };
      commits.set(commit, slot);
      generationFloorBySessionKey.set(committed.sessionKey, committed.generation);
      // Publication of a newer generation is itself the revocation boundary;
      // the replacement process need not already be spawned/activated.
      currentCommitBySessionKey.set(committed.sessionKey, slot);
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

    report(lease, observation) {
      const slot = leases.get(lease);
      if (!slot) throw new Error('Executor lease belongs to another Runtime epoch');
      if (slot.ended) return stale(slot);

      if (observation.kind === 'workerExit') {
        // Every authentic process identity gets one exit classification. A
        // replaced generation may reconcile its own named receipts, but can
        // never fence or publish lifecycle state for the replacement.
        slot.ended = true;
        if (currentCommitBySessionKey.get(slot.sessionKey) !== slot
          || !slot.authority.owns(slot.token, slot.identity)) {
          return {
            kind: 'retiringExit',
            sessionId: slot.sessionId,
            executorGeneration: slot.generation,
          };
        }
        const fenced = slot.authority.fenceExit(slot.token, slot.identity);
        if (fenced.kind === 'stale') {
          if (currentCommitBySessionKey.get(slot.sessionKey) === slot) {
            currentCommitBySessionKey.delete(slot.sessionKey);
          }
          return stale(slot);
        }
        if (fenced.kind === 'unreadable') {
          return {
            kind: 'unreadable',
            sessionId: slot.sessionId,
            executorGeneration: slot.generation,
            current: true,
            message: fenced.message,
          };
        }
        const generationFloor = generationFloorBySessionKey.get(slot.sessionKey) ?? slot.generation;
        if (!Number.isSafeInteger(fenced.generation)
          || fenced.generation <= slot.generation
          || fenced.generation <= generationFloor) {
          return {
            kind: 'unreadable',
            sessionId: slot.sessionId,
            executorGeneration: slot.generation,
            current: true,
            message: 'Executor generation authority returned an invalid exit fence',
          };
        }
        generationFloorBySessionKey.set(
          slot.sessionKey,
          Math.max(generationFloorBySessionKey.get(slot.sessionKey) ?? 0, fenced.generation),
        );
        if (currentCommitBySessionKey.get(slot.sessionKey) === slot) {
          currentCommitBySessionKey.delete(slot.sessionKey);
        }
        return {
          kind: 'currentExit',
          sessionId: slot.sessionId,
          executorGeneration: slot.generation,
          fencedGeneration: fenced.generation,
        };
      }

      if (currentCommitBySessionKey.get(slot.sessionKey) !== slot
        || !slot.authority.owns(slot.token, slot.identity)) return stale(slot);

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
    },

    resume(continuation) {
      const continuationSlot = continuations.get(continuation);
      if (!continuationSlot) throw new Error('Executor continuation belongs to another Runtime epoch');
      // A continuation is a one-shot authority proof. Async consumers must
      // acquire a fresh observation if they need another external effect.
      continuations.delete(continuation);
      const slot = leases.get(continuationSlot.lease)!;
      if (slot.ended
        || currentCommitBySessionKey.get(slot.sessionKey) !== slot
        || !slot.authority.owns(slot.token, slot.identity)) {
        return {
          kind: 'stale',
          sessionId: slot.sessionId,
          executorGeneration: slot.generation,
        };
      }
      return {
        kind: 'current',
        sessionId: slot.sessionId,
        executorGeneration: slot.generation,
      };
    },

    isCurrent(lease) {
      const slot = leases.get(lease);
      return !!slot
        && !slot.ended
        && currentCommitBySessionKey.get(slot.sessionKey) === slot
        && slot.authority.owns(slot.token, slot.identity);
    },
  };
}
