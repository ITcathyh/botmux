/**
 * Owner-bound Session/Executor activation coordinator.
 *
 * The coordinator owns process-local singleflight, lifecycle supersession and
 * the lane -> external effect -> lane pump. Backend/CLI policy remains behind
 * the injected Current Adapter; the public SessionRuntime never exposes a PID,
 * pane handle, mutable Session, or provider-specific continuation.
 */

import { computeInputHash } from '../utils/canonical-input-hash.js';
import type {
  SessionCommandLane,
  SessionLaneAddress,
} from './session-command-lane.js';

export type SessionActivationCause =
  | 'ordinary'
  | 'dashboard'
  | 'scheduler'
  | 'restore'
  | 'terminal'
  | 'replacement';

export type SessionActivationGoal =
  | {
      readonly kind: 'ensure';
      readonly cause: SessionActivationCause;
      readonly input?: unknown;
    }
  | {
      readonly kind: 'reconcile';
      readonly cause: 'restore';
      readonly observation: 'exists' | 'missing' | 'unknown';
      readonly input?: unknown;
    };

export interface SessionActivationRequest {
  readonly sessionId: string;
  readonly requestIdentity: string;
  readonly goal: SessionActivationGoal;
}

export type SessionActivationTerminal =
  | { readonly kind: 'active'; readonly action: 'alreadyActive' | 'activated' | 'reattached' | 'deferred' }
  | { readonly kind: 'rejected'; readonly reason: 'notFound' | 'closed' | 'conflict'; readonly message: string }
  | { readonly kind: 'retryable'; readonly message: string }
  | { readonly kind: 'ambiguous'; readonly message: string }
  | { readonly kind: 'stale'; readonly message: string }
  | { readonly kind: 'quarantined'; readonly message: string };

export type SessionActivationOutcome = SessionActivationTerminal | {
  readonly kind: 'duplicate';
  readonly state: 'joined' | 'completed';
  readonly outcome: SessionActivationTerminal;
};

export type SessionActivationTransition = SessionActivationTerminal | {
  readonly kind: 'effect';
  readonly intent: unknown;
  readonly continuation: unknown;
};

export type SessionActivationEffectSettlement =
  | { readonly kind: 'returned'; readonly value: unknown }
  | { readonly kind: 'threw'; readonly error: unknown };

export type SessionRetirementReason =
  | 'explicitClose'
  | 'replacement'
  | 'transfer'
  | 'shutdown';

export type SessionRetirementOutcome =
  | { readonly kind: 'retired'; readonly action: 'retired' | 'alreadyRetired' }
  | { readonly kind: 'retryable'; readonly message: string }
  | { readonly kind: 'quarantined'; readonly message: string };

/**
 * Synchronous begin/resume/retire methods run inside the shared Session lane.
 * Only execute may await, and it always runs outside the lane.
 */
export interface SessionActivationPort {
  begin(request: SessionActivationRequest): SessionActivationTransition;
  execute(intent: unknown): Promise<unknown>;
  resume(
    continuation: unknown,
    settlement: SessionActivationEffectSettlement,
  ): SessionActivationTransition;
  retire(request: {
    readonly sessionId: string;
    readonly requestIdentity: string;
    readonly reason: SessionRetirementReason;
  }): SessionRetirementOutcome;
}

export interface SessionActivationRuntime {
  ensure(request: SessionActivationRequest): Promise<SessionActivationOutcome>;
  retire(request: {
    readonly sessionId: string;
    readonly requestIdentity: string;
    readonly reason: SessionRetirementReason;
  }): Promise<SessionRetirementOutcome>;
}

interface ActivationAttempt {
  readonly requestHash: string;
  readonly terminal: Promise<SessionActivationTerminal>;
}

function exactNonempty(value: string, label: string): void {
  if (!value || value.trim() !== value || value.includes('\0')) {
    throw new Error(`${label} must be an exact non-empty identity`);
  }
}

function terminalTransition(
  transition: SessionActivationTransition,
): SessionActivationTerminal | undefined {
  switch (transition.kind) {
    case 'active':
    case 'rejected':
    case 'retryable':
    case 'ambiguous':
    case 'stale':
    case 'quarantined':
      return transition;
    case 'effect':
      return undefined;
  }
}

export function createSessionActivationRuntime(options: {
  readonly commandLane: SessionCommandLane;
  readonly laneAddress: (sessionId: string) => SessionLaneAddress;
  readonly port: SessionActivationPort;
}): SessionActivationRuntime {
  const lifecycleRevision = new Map<string, number>();
  const attempts = new Map<string, ActivationAttempt>();
  const tails = new Map<string, Promise<void>>();

  const attemptKey = (sessionId: string, requestIdentity: string): string => (
    `${sessionId}\0${requestIdentity}`
  );
  const revisionFor = (sessionId: string): number => lifecycleRevision.get(sessionId) ?? 0;

  const inspectTransition = (
    transition: SessionActivationTransition,
  ): SessionActivationTransition => {
    if (!transition || typeof transition !== 'object') {
      return { kind: 'quarantined', message: 'activation Adapter returned an invalid transition' };
    }
    if (transition.kind === 'effect') {
      if (!Object.prototype.hasOwnProperty.call(transition, 'intent')
          || !Object.prototype.hasOwnProperty.call(transition, 'continuation')) {
        return { kind: 'quarantined', message: 'activation effect transition is incomplete' };
      }
      return transition;
    }
    return terminalTransition(transition)
      ?? { kind: 'quarantined', message: 'activation Adapter returned an unknown transition' };
  };

  const runAttempt = async (
    request: SessionActivationRequest,
  ): Promise<SessionActivationTerminal> => {
    const lane = options.laneAddress(request.sessionId);
    let revision = 0;
    let transition = await options.commandLane.submit(lane, () => {
      revision = revisionFor(request.sessionId);
      try {
        return inspectTransition(options.port.begin(request));
      } catch (error) {
        return {
          kind: 'quarantined' as const,
          message: `activation begin failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });

    for (;;) {
      if (transition.kind !== 'effect') return transition;

      let settlement: SessionActivationEffectSettlement;
      try {
        settlement = { kind: 'returned', value: await options.port.execute(transition.intent) };
      } catch (error) {
        settlement = { kind: 'threw', error };
      }
      const continuation = transition.continuation;
      transition = await options.commandLane.submit(lane, () => {
        if (revisionFor(request.sessionId) !== revision) {
          return {
            kind: 'stale' as const,
            message: 'activation continuation was superseded by a lifecycle transition',
          };
        }
        try {
          return inspectTransition(options.port.resume(continuation, settlement));
        } catch (error) {
          return {
            kind: 'quarantined' as const,
            message: `activation resume failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      });
    }
  };

  const ensure = async (request: SessionActivationRequest): Promise<SessionActivationOutcome> => {
    exactNonempty(request.sessionId, 'sessionId');
    exactNonempty(request.requestIdentity, 'requestIdentity');
    let requestHash: string;
    try {
      requestHash = computeInputHash(request.goal);
    } catch (error) {
      return {
        kind: 'rejected',
        reason: 'conflict',
        message: `activation goal is not canonicalizable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const key = attemptKey(request.sessionId, request.requestIdentity);
    const prior = attempts.get(key);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        return {
          kind: 'rejected',
          reason: 'conflict',
          message: 'activation request identity already belongs to a different goal',
        };
      }
      const outcome = await prior.terminal;
      return { kind: 'duplicate', state: 'joined', outcome };
    }

    const previousTail = tails.get(request.sessionId);
    let releaseTail!: () => void;
    const nextTail = new Promise<void>((resolve) => { releaseTail = resolve; });
    tails.set(request.sessionId, nextTail);
    const terminal = (previousTail
      ? previousTail.catch(() => undefined).then(() => runAttempt(request))
      : runAttempt(request))
      .finally(() => {
        releaseTail();
        if (tails.get(request.sessionId) === nextTail) tails.delete(request.sessionId);
      });
    attempts.set(key, { requestHash, terminal });
    return terminal;
  };

  const retire: SessionActivationRuntime['retire'] = async (request) => {
    exactNonempty(request.sessionId, 'sessionId');
    exactNonempty(request.requestIdentity, 'requestIdentity');
    return options.commandLane.submit(options.laneAddress(request.sessionId), () => {
      lifecycleRevision.set(request.sessionId, revisionFor(request.sessionId) + 1);
      try {
        return options.port.retire(request);
      } catch (error) {
        return {
          kind: 'quarantined',
          message: `activation retirement failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  };

  return { ensure, retire };
}
