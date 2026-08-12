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
  | { readonly kind: 'staleBeforeEffect'; readonly message: string }
  | { readonly kind: 'unknownAfterEffect'; readonly message: string }
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
  | 'passivation'
  | 'replacement'
  | 'transfer'
  | 'shutdown';

export interface SessionRetirementRequest {
  readonly sessionId: string;
  readonly requestIdentity: string;
  readonly reason: SessionRetirementReason;
}

export type SessionRetirementDisposition = 'applied' | 'notApplied' | 'unknown';

export interface SessionRetirementSettlementRequest extends SessionRetirementRequest {
  readonly disposition: SessionRetirementDisposition;
}

export type SessionRetirementOutcome =
  | { readonly kind: 'retired'; readonly action: 'retired' | 'alreadyRetired' }
  | { readonly kind: 'retryable'; readonly message: string }
  | { readonly kind: 'quarantined'; readonly message: string };

export type SessionRetirementSettlementOutcome =
  | { readonly kind: 'settled'; readonly disposition: 'applied' | 'notApplied' }
  | { readonly kind: 'quarantined'; readonly message: string };

/**
 * Synchronous begin/resume/retire/settleRetirement methods run inside the
 * shared Session lane. Only execute may await, and it always runs outside the
 * lane.
 */
export interface SessionActivationPort {
  begin(request: SessionActivationRequest): SessionActivationTransition;
  execute(intent: unknown): Promise<unknown>;
  resume(
    continuation: unknown,
    settlement: SessionActivationEffectSettlement,
  ): SessionActivationTransition;
  retire(request: SessionRetirementRequest): SessionRetirementOutcome;
  settleRetirement(
    request: SessionRetirementSettlementRequest,
  ): SessionRetirementSettlementOutcome;
}

export interface SessionActivationRuntime {
  ensure(request: SessionActivationRequest): Promise<SessionActivationOutcome>;
  retire(request: SessionRetirementRequest): Promise<SessionRetirementOutcome>;
  settleRetirement(
    request: SessionRetirementSettlementRequest,
  ): Promise<SessionRetirementSettlementOutcome>;
}

type ActivationAttempt =
  | {
      readonly requestHash: string;
      terminal: Promise<SessionActivationTerminal>;
      state: 'running' | 'completed';
    }
  | {
      readonly requestHash: string;
      readonly state: 'retryable';
    };

type RetirementReceipt =
  | {
      readonly reason: SessionRetirementReason;
      readonly state: 'retryable';
    }
  | {
      readonly reason: SessionRetirementReason;
      readonly state: 'terminal';
      readonly outcome: Exclude<SessionRetirementOutcome, { kind: 'retryable' }>;
    };

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
    case 'staleBeforeEffect':
    case 'unknownAfterEffect':
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
  const retirementReceipts = new Map<string, RetirementReceipt>();
  const retirementSettlements = new Map<string, {
    readonly reason: SessionRetirementReason;
    readonly disposition: SessionRetirementDisposition;
    readonly outcome: SessionRetirementSettlementOutcome;
  }>();
  const unknownEffectQuarantines = new Set<string>();
  const tails = new Map<string, Promise<void>>();

  const attemptKey = (
    sessionId: string,
    lifecycle: number,
    requestIdentity: string,
  ): string => (
    `${sessionId}\0${lifecycle}\0${requestIdentity}`
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
    admittedRevision: number,
  ): Promise<SessionActivationTerminal> => {
    const lane = options.laneAddress(request.sessionId);
    const revision = admittedRevision;
    let transition = await options.commandLane.submit(lane, () => {
      if (revisionFor(request.sessionId) !== revision) {
        return {
          kind: 'staleBeforeEffect' as const,
          message: 'activation attempt was superseded before admission',
        };
      }
      const fenced = unknownEffectQuarantines.has(request.sessionId);
      if (fenced && (request.goal.kind !== 'reconcile' || request.goal.observation === 'unknown')) {
        return {
          kind: 'quarantined' as const,
          message: 'activation effect outcome is quarantined pending an explicit re-probe',
        };
      }
      try {
        const opened = inspectTransition(options.port.begin(request));
        // The fence promises "an effect may already have spawned something for
        // this session". Only a re-probe the port actually ACCEPTED on the
        // exact binding ('active', or a fresh 'effect' now tracked by this
        // attempt) produces the evidence that promise demands — a rejected or
        // quarantined begin proved nothing, so the fence must survive it.
        if (fenced && (opened.kind === 'active' || opened.kind === 'effect')) {
          unknownEffectQuarantines.delete(request.sessionId);
        }
        return opened;
      } catch (error) {
        return {
          kind: 'quarantined' as const,
          message: `activation begin failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });

    for (;;) {
      if (transition.kind !== 'effect') return transition;

      const intent = transition.intent;
      const started = await options.commandLane.submit(lane, () => {
        if (revisionFor(request.sessionId) !== revision) {
          return {
            kind: 'staleBeforeEffect' as const,
            message: 'activation attempt was superseded before effect invocation',
          };
        }
        try {
          return {
            kind: 'started' as const,
            effect: options.port.execute(intent),
          };
        } catch (error) {
          return {
            kind: 'threw' as const,
            error,
          };
        }
      });
      if (started.kind === 'staleBeforeEffect') return started;
      let settlement: SessionActivationEffectSettlement;
      if (started.kind === 'threw') {
        settlement = { kind: 'threw', error: started.error };
      } else {
        try {
          settlement = { kind: 'returned', value: await started.effect };
        } catch (error) {
          settlement = { kind: 'threw', error };
        }
      }
      const continuation = transition.continuation;
      transition = await options.commandLane.submit(lane, () => {
        if (revisionFor(request.sessionId) !== revision) {
          unknownEffectQuarantines.add(request.sessionId);
          return {
            kind: 'unknownAfterEffect' as const,
            message: 'activation effect outcome was superseded by a lifecycle transition',
          };
        }
        try {
          const resumed = inspectTransition(options.port.resume(continuation, settlement));
          if (resumed.kind === 'unknownAfterEffect') {
            unknownEffectQuarantines.add(request.sessionId);
          }
          return resumed;
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
    const lifecycle = revisionFor(request.sessionId);
    const key = attemptKey(request.sessionId, lifecycle, request.requestIdentity);
    const prior = attempts.get(key);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        return {
          kind: 'rejected',
          reason: 'conflict',
          message: 'activation request identity already belongs to a different goal',
        };
      }
      if (prior.state !== 'retryable') {
        const duplicateState = prior.state === 'running' ? 'joined' : 'completed';
        const outcome = await prior.terminal;
        return { kind: 'duplicate', state: duplicateState, outcome };
      }
    }

    const previousTail = tails.get(request.sessionId);
    let releaseTail!: () => void;
    const nextTail = new Promise<void>((resolve) => { releaseTail = resolve; });
    tails.set(request.sessionId, nextTail);
    const attempt: Extract<ActivationAttempt, { state: 'running' | 'completed' }> = {
      requestHash,
      state: 'running',
      terminal: Promise.resolve({
        kind: 'quarantined',
        message: 'activation attempt was not initialized',
      }),
    };
    const terminal = (previousTail
      ? previousTail.catch(() => undefined).then(() => runAttempt(request, lifecycle))
      : runAttempt(request, lifecycle))
      .then((result) => {
        attempt.state = 'completed';
        // `retryable` promises that no commit is known and the same identity
        // may be re-driven, but its semantic hash remains reserved for this
        // runtime epoch so a different goal cannot reuse the business key.
        if (result.kind === 'retryable' && attempts.get(key) === attempt) {
          attempts.set(key, { requestHash, state: 'retryable' });
        }
        return result;
      }, (error) => {
        if (attempts.get(key) === attempt) attempts.delete(key);
        throw error;
      })
      .finally(() => {
        releaseTail();
        if (tails.get(request.sessionId) === nextTail) tails.delete(request.sessionId);
      });
    attempt.terminal = terminal;
    attempts.set(key, attempt);
    return terminal;
  };

  const retire: SessionActivationRuntime['retire'] = async (request) => {
    exactNonempty(request.sessionId, 'sessionId');
    exactNonempty(request.requestIdentity, 'requestIdentity');
    return options.commandLane.submit(options.laneAddress(request.sessionId), () => {
      const receiptKey = `${request.sessionId}\0${request.requestIdentity}`;
      const prior = retirementReceipts.get(receiptKey);
      if (prior) {
        if (prior.reason !== request.reason) {
          return {
            kind: 'quarantined' as const,
            message: 'retirement request identity already belongs to a different reason',
          };
        }
        if (prior.state === 'terminal') return prior.outcome;
      }
      let outcome: SessionRetirementOutcome;
      try {
        outcome = options.port.retire(request);
      } catch (error) {
        outcome = {
          kind: 'quarantined',
          message: `activation retirement failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!outcome || typeof outcome !== 'object'
          || (outcome.kind !== 'retired'
            && outcome.kind !== 'retryable'
            && outcome.kind !== 'quarantined')) {
        outcome = {
          kind: 'quarantined',
          message: 'activation Adapter returned an invalid retirement outcome',
        };
      }
      if (outcome.kind === 'retryable') {
        retirementReceipts.set(receiptKey, { reason: request.reason, state: 'retryable' });
        return outcome;
      }
      // Only a committed or ambiguous fence supersedes the current lifecycle.
      // A retryable result explicitly proves that no fence was published.
      lifecycleRevision.set(request.sessionId, revisionFor(request.sessionId) + 1);
      retirementReceipts.set(receiptKey, {
        reason: request.reason,
        state: 'terminal',
        outcome,
      });
      return outcome;
    });
  };

  const settleRetirement: SessionActivationRuntime['settleRetirement'] = async (request) => {
    exactNonempty(request.sessionId, 'sessionId');
    exactNonempty(request.requestIdentity, 'requestIdentity');
    return options.commandLane.submit(options.laneAddress(request.sessionId), () => {
      const receiptKey = `${request.sessionId}\0${request.requestIdentity}`;
      const retirement = retirementReceipts.get(receiptKey);
      if (!retirement || retirement.state !== 'terminal' || retirement.outcome.kind !== 'retired') {
        return {
          kind: 'quarantined' as const,
          message: 'retirement settlement has no committed activation fence',
        };
      }
      if (retirement.reason !== request.reason) {
        return {
          kind: 'quarantined' as const,
          message: 'retirement settlement reason does not match its activation fence',
        };
      }
      const prior = retirementSettlements.get(receiptKey);
      if (prior) {
        if (prior.reason !== request.reason || prior.disposition !== request.disposition) {
          return {
            kind: 'quarantined' as const,
            message: 'retirement settlement identity already belongs to different evidence',
          };
        }
        return prior.outcome;
      }
      let outcome: SessionRetirementSettlementOutcome;
      try {
        outcome = options.port.settleRetirement(request);
      } catch (error) {
        outcome = {
          kind: 'quarantined',
          message: `activation retirement settlement failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!outcome || typeof outcome !== 'object'
          || (outcome.kind !== 'settled' && outcome.kind !== 'quarantined')
          || (outcome.kind === 'settled'
            && (request.disposition === 'unknown' || outcome.disposition !== request.disposition))) {
        outcome = {
          kind: 'quarantined',
          message: 'activation Adapter returned an invalid retirement settlement',
        };
      }
      if (request.disposition === 'applied' && outcome.kind === 'settled') {
        unknownEffectQuarantines.delete(request.sessionId);
      } else if (request.disposition === 'unknown') {
        unknownEffectQuarantines.add(request.sessionId);
      }
      retirementSettlements.set(receiptKey, {
        reason: request.reason,
        disposition: request.disposition,
        outcome,
      });
      return outcome;
    });
  };

  return { ensure, retire, settleRetirement };
}
