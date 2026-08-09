/**
 * Storage-agnostic command/query boundary for one daemon-owned Session host.
 *
 * Target-A deliberately keeps the current persistence guarantees. `applied`
 * is therefore a process-local/domain outcome, never a durable commit receipt.
 * The runtime owns opaque address epochs and command-specific replay policy;
 * current JSON/journal adapters remain behind the injected ports.
 */

import { computeInputHash } from '../utils/canonical-input-hash.js';

declare const sessionAddressBrand: unique symbol;

/** Runtime-local, non-serializable handle. Only SessionProjection can mint it. */
export type SessionAddress = Readonly<Record<never, never>> & {
  readonly [sessionAddressBrand]: true;
};

export type SessionRoute =
  | { kind: 'thread'; anchorId: string }
  | { kind: 'chat'; chatId: string };

export type SessionCommandRoute = SessionRoute | { kind: 'idempotency'; key: string };

export interface SessionDirectoryRow {
  /** Stable only inside the bound Host; never exposed by SessionProjection. */
  key: string;
  sessionId: string;
  route: SessionRoute;
  recordStatus: 'active' | 'closed';
  executorStatus: 'working' | 'idle' | 'dormant';
}

export type SessionDirectoryQuery =
  | { kind: 'byRoute'; route: SessionRoute }
  | { kind: 'byExternalSession'; sessionId: string }
  | { kind: 'list' };

export type SessionDirectoryRead =
  | { kind: 'one'; row: SessionDirectoryRow }
  | { kind: 'list'; rows: SessionDirectoryRow[] }
  | { kind: 'notFound' }
  | { kind: 'notReady'; message: string };

/** Internal read port. Implementations return detached rows, never Session. */
export interface SessionDirectory {
  read(query: SessionDirectoryQuery): Promise<SessionDirectoryRead>;
}

export interface SessionView {
  address: SessionAddress;
  sessionId: string;
  route: SessionRoute;
  recordStatus: SessionDirectoryRow['recordStatus'];
  executorStatus: SessionDirectoryRow['executorStatus'];
}

export type ProjectionResult =
  | { kind: 'one'; session: SessionView }
  | { kind: 'list'; sessions: SessionView[] }
  | { kind: 'notFound' }
  | { kind: 'notReady'; message: string };

export interface SessionProjection {
  read(query: SessionDirectoryQuery): Promise<ProjectionResult>;
}

export type KeyedTriggerObservation =
  | { kind: 'absent'; token: unknown }
  | { kind: 'blocked'; message: string }
  | { kind: 'unreadable'; message: string }
  | {
      kind: 'present';
      token: unknown;
      requestHash: string;
      sessionId: string;
      triggerId: string;
      chatId: string;
      leaseState: 'reserved' | 'attempting';
      ownerBoot: 'current' | 'other';
      terminal: 'pending' | 'completed' | 'failed';
      executorLive: boolean;
    };

type PresentKeyedTriggerObservation = Extract<KeyedTriggerObservation, { kind: 'present' }>;

export type KeyedTriggerReserveResult =
  | { kind: 'reserved'; token: unknown }
  | { kind: 'existing'; observation: PresentKeyedTriggerObservation }
  | { kind: 'conflict'; message: string }
  | { kind: 'retryable'; message: string }
  | { kind: 'ambiguous'; message: string; durable: boolean }
  | { kind: 'unreadable'; message: string };

export type KeyedTriggerBeginResult =
  | { kind: 'started'; token: unknown; pendingCreatedAt: number }
  | { kind: 'retryable'; message: string }
  | { kind: 'ambiguous'; message: string; durable: boolean }
  | { kind: 'unreadable'; message: string };

export type KeyedTriggerSettlementResult =
  | { kind: 'recorded' }
  | { kind: 'unreadable'; message: string };

/**
 * Path-specific authority port. The dispatch-critical methods are deliberately
 * synchronous: final admission/freeze readback, the reserved→attempting fence,
 * and synchronous executor acceptance execute in one JS run-to-completion
 * segment. An async Adapter would reopen the exact freeze race this seam owns.
 */
export interface KeyedTriggerAuthority {
  inspect(key: string): KeyedTriggerObservation;
  reserve(input: {
    key: string;
    requestHash: string;
    sessionId: string;
    triggerId: string;
    chatId: string;
    candidate: unknown;
  }): KeyedTriggerReserveResult;
  begin(token: unknown): KeyedTriggerBeginResult;
  settleDispatchUnknown(token: unknown): KeyedTriggerSettlementResult;
}

export interface KeyedTriggerSemanticInput {
  instruction: string | null;
  envelope: unknown;
  source: unknown;
  presentation: unknown;
  /** Normalized options with the idempotency key removed. */
  options: Record<string, unknown>;
}

export interface KeyedTriggerStartInput {
  semantic: KeyedTriggerSemanticInput;
  triggerId: string;
  title: string;
  prompt: string;
  codexAppText: string;
  codexAppApplicationContext: string;
  codexAppMessageContext: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  persistInputHistory: boolean;
}

export interface PreparedKeyedTriggerTurn {
  token: unknown;
  sessionId: string;
  triggerId: string;
  chatId: string;
}

export type KeyedTriggerTurnPrepareResult =
  | { kind: 'prepared'; turn: PreparedKeyedTriggerTurn }
  | { kind: 'retryable'; message: string }
  | { kind: 'unreadable'; message: string };

export type KeyedTriggerTurnAcceptResult =
  | { kind: 'accepted' }
  | { kind: 'refused'; message: string };

export type KeyedTriggerTurnCloseResult =
  | { kind: 'closed' }
  | { kind: 'unreadable'; message: string };

/**
 * Runtime-private Current execution port. The public command carries business
 * input only: Session identity, mutable DaemonSession state, generation
 * prediction, `atMostOnce`, and worker acceptance all stay behind this seam.
 */
export interface KeyedTriggerTurnPort {
  prepare(input: KeyedTriggerStartInput): KeyedTriggerTurnPrepareResult;
  acceptAtMostOnce(
    token: unknown,
    context: { key: string; pendingCreatedAt: number },
  ): KeyedTriggerTurnAcceptResult;
  failClose(token: unknown): Promise<KeyedTriggerTurnCloseResult>;
}

export type SessionCommand = {
  kind: 'keyedTrigger.start';
  input: KeyedTriggerStartInput;
};

export interface SessionCommandRequest {
  target:
    | { kind: 'session'; address: SessionAddress }
    | { kind: 'route'; route: SessionCommandRoute };
  idempotencyKey: string;
  command: SessionCommand;
}

export type CommandOutcome =
  | {
      kind: 'applied';
      action: 'keyedTrigger.started';
      sessionId: string;
      triggerId: string;
      chatId: string;
    }
  | {
      kind: 'duplicate';
      state: 'reserved' | 'inFlight' | 'completed';
      sessionId: string;
      triggerId: string;
      chatId: string;
      message: string;
    }
  | { kind: 'rejected'; reason: 'idempotencyConflict' | 'invalidCommand'; message: string }
  | { kind: 'staleAddress' }
  | { kind: 'retryable'; message: string }
  | {
      kind: 'ambiguous';
      sessionId: string;
      triggerId: string;
      chatId: string;
      message: string;
      durable: boolean;
      /** False only when this submit crossed the attempt fence itself. */
      idempotent: boolean;
    }
  | { kind: 'quarantined'; message: string };

export interface SessionRuntime {
  submit(request: SessionCommandRequest): Promise<CommandOutcome>;
}

interface AddressSlot {
  key: string;
}

type AdmissionDecision =
  | { kind: 'continue'; candidate: unknown }
  | { kind: 'outcome'; outcome: CommandOutcome };

function opaque<T>(): T {
  return Object.freeze({}) as T;
}

function duplicate(
  observation: PresentKeyedTriggerObservation,
  state: 'reserved' | 'inFlight' | 'completed',
  message: string,
): CommandOutcome {
  return {
    kind: 'duplicate',
    state,
    sessionId: observation.sessionId,
    triggerId: observation.triggerId,
    chatId: observation.chatId,
    message,
  };
}

function decideKeyedAdmission(
  requestHash: string,
  observation: KeyedTriggerObservation,
  allowTakeover: boolean,
): AdmissionDecision {
  if (observation.kind === 'blocked') {
    return { kind: 'outcome', outcome: { kind: 'retryable', message: observation.message } };
  }
  if (observation.kind === 'unreadable') {
    return { kind: 'outcome', outcome: { kind: 'quarantined', message: observation.message } };
  }
  if (observation.kind === 'absent') return { kind: 'continue', candidate: observation.token };
  if (observation.requestHash !== requestHash) {
    return {
      kind: 'outcome',
      outcome: {
        kind: 'rejected',
        reason: 'idempotencyConflict',
        message: 'idempotency key already used with a different request payload',
      },
    };
  }
  if (observation.terminal === 'completed') {
    return {
      kind: 'outcome',
      outcome: duplicate(
        observation,
        'completed',
        'idempotency key already completed; reuse the session (poll trigger-result)',
      ),
    };
  }
  if (observation.terminal === 'failed') {
    return {
      kind: 'outcome',
      outcome: {
        kind: 'ambiguous',
        sessionId: observation.sessionId,
        triggerId: observation.triggerId,
        chatId: observation.chatId,
        message: 'previous dispatch outcome is unknown (ambiguous crash); not re-run (at-most-once)',
        durable: true,
        idempotent: true,
      },
    };
  }
  if (observation.leaseState === 'attempting') {
    if (observation.executorLive) {
      return {
        kind: 'outcome',
        outcome: duplicate(
          observation,
          'inFlight',
          'idempotency key in flight; reuse the session (poll trigger-result)',
        ),
      };
    }
    return {
      kind: 'outcome',
      outcome: {
        kind: 'ambiguous',
        sessionId: observation.sessionId,
        triggerId: observation.triggerId,
        chatId: observation.chatId,
        message: 'previous dispatch was interrupted with unknown outcome; not re-run (at-most-once)',
        durable: false,
        idempotent: true,
      },
    };
  }
  if (observation.ownerBoot === 'current') {
    if (observation.executorLive) {
      return {
        kind: 'outcome',
        outcome: duplicate(
          observation,
          'reserved',
          'idempotency key reserved and being dispatched; reuse the session',
        ),
      };
    }
    return {
      kind: 'outcome',
      outcome: {
        kind: 'ambiguous',
        sessionId: observation.sessionId,
        triggerId: observation.triggerId,
        chatId: observation.chatId,
        message: 'previous reservation was abandoned pre-dispatch with unknown outcome; not re-run (at-most-once)',
        durable: false,
        idempotent: true,
      },
    };
  }
  if (allowTakeover) return { kind: 'continue', candidate: observation.token };
  return {
    kind: 'outcome',
    outcome: duplicate(
      observation,
      'reserved',
      'idempotency key already claimed; reusing the winning session (no new dispatch)',
    ),
  };
}

function ambiguousFor(
  candidate: Pick<PreparedKeyedTriggerTurn, 'sessionId' | 'triggerId' | 'chatId'>,
  message: string,
  durable: boolean,
): CommandOutcome {
  return {
    kind: 'ambiguous',
    sessionId: candidate.sessionId,
    triggerId: candidate.triggerId,
    chatId: candidate.chatId,
    message,
    durable,
    idempotent: false,
  };
}

export function createSessionRuntimeHost(options: {
  directory: SessionDirectory;
  keyedTriggers: KeyedTriggerAuthority;
  keyedTriggerTurns: KeyedTriggerTurnPort;
}): { runtime: SessionRuntime; projection: SessionProjection } {
  const addresses = new Map<string, SessionAddress>();
  const addressSlots = new WeakMap<object, AddressSlot>();

  const addressFor = (key: string): SessionAddress => {
    const existing = addresses.get(key);
    if (existing) return existing;
    const address = opaque<SessionAddress>();
    addresses.set(key, address);
    addressSlots.set(address, { key });
    return address;
  };

  const view = (row: SessionDirectoryRow): SessionView => ({
    address: addressFor(row.key),
    sessionId: row.sessionId,
    route: { ...row.route },
    recordStatus: row.recordStatus,
    executorStatus: row.executorStatus,
  });

  const projection: SessionProjection = {
    async read(query) {
      let result: SessionDirectoryRead;
      try {
        result = await options.directory.read(query);
      } catch (error) {
        return { kind: 'notReady', message: error instanceof Error ? error.message : String(error) };
      }
      if (result.kind === 'one') return { kind: 'one', session: view(result.row) };
      if (result.kind === 'list') return { kind: 'list', sessions: result.rows.map(view) };
      return result;
    },
  };

  type CriticalResult =
    | { kind: 'outcome'; outcome: CommandOutcome }
    | {
        kind: 'failClose';
        token: unknown;
        candidate: PreparedKeyedTriggerTurn;
        outcome: CommandOutcome;
      };

  const outcome = (value: CommandOutcome): CriticalResult => ({ kind: 'outcome', outcome: value });

  const run = (request: SessionCommandRequest): CriticalResult => {
    if (request.target.kind === 'session' && !addressSlots.has(request.target.address)) {
      return outcome({ kind: 'staleAddress' });
    }
    if (request.target.kind !== 'route'
      || request.target.route.kind !== 'idempotency'
      || request.target.route.key !== request.idempotencyKey) {
      return outcome({
        kind: 'rejected',
        reason: 'invalidCommand',
        message: 'keyed-trigger commands require the exact owner-scoped idempotency route',
      });
    }

    const { command } = request;
    let requestHash: string;
    try {
      requestHash = computeInputHash(command.input.semantic);
    } catch (error) {
      return outcome({
        kind: 'rejected',
        reason: 'invalidCommand',
        message: `keyed-trigger semantic input is not canonicalizable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    let observation: KeyedTriggerObservation;
    try {
      observation = options.keyedTriggers.inspect(request.idempotencyKey);
    } catch (error) {
      return outcome({ kind: 'quarantined', message: error instanceof Error ? error.message : String(error) });
    }
    const admission = decideKeyedAdmission(requestHash, observation, true);
    if (admission.kind === 'outcome') return outcome(admission.outcome);

    let prepared: KeyedTriggerTurnPrepareResult;
    try {
      prepared = options.keyedTriggerTurns.prepare(command.input);
    } catch (error) {
      return outcome({ kind: 'quarantined', message: error instanceof Error ? error.message : String(error) });
    }
    if (prepared.kind === 'retryable') return outcome({ kind: 'retryable', message: prepared.message });
    if (prepared.kind === 'unreadable') return outcome({ kind: 'quarantined', message: prepared.message });
    const candidate = prepared.turn;

    let reserved: KeyedTriggerReserveResult;
    try {
      reserved = options.keyedTriggers.reserve({
        key: request.idempotencyKey,
        requestHash,
        sessionId: candidate.sessionId,
        triggerId: candidate.triggerId,
        chatId: candidate.chatId,
        candidate: admission.candidate,
      });
    } catch (error) {
      return outcome({ kind: 'quarantined', message: error instanceof Error ? error.message : String(error) });
    }
    if (reserved.kind === 'existing') {
      const raced = decideKeyedAdmission(requestHash, reserved.observation, false);
      return outcome(raced.kind === 'outcome'
        ? raced.outcome
        : { kind: 'quarantined', message: 'keyed-trigger reserve returned a non-terminal existing observation' });
    }
    if (reserved.kind === 'conflict') {
      return outcome({ kind: 'rejected', reason: 'idempotencyConflict', message: reserved.message });
    }
    if (reserved.kind === 'retryable') return outcome({ kind: 'retryable', message: reserved.message });
    if (reserved.kind === 'unreadable') return outcome({ kind: 'quarantined', message: reserved.message });
    if (reserved.kind === 'ambiguous') {
      return outcome(ambiguousFor(candidate, reserved.message, reserved.durable));
    }

    let begun: KeyedTriggerBeginResult;
    try {
      begun = options.keyedTriggers.begin(reserved.token);
    } catch (error) {
      return outcome({ kind: 'quarantined', message: error instanceof Error ? error.message : String(error) });
    }
    if (begun.kind === 'retryable') return outcome({ kind: 'retryable', message: begun.message });
    if (begun.kind === 'unreadable') return outcome({ kind: 'quarantined', message: begun.message });
    if (begun.kind === 'ambiguous') {
      return outcome(ambiguousFor(candidate, begun.message, begun.durable));
    }

    try {
      const accepted = options.keyedTriggerTurns.acceptAtMostOnce(candidate.token, {
        key: request.idempotencyKey,
        pendingCreatedAt: begun.pendingCreatedAt,
      });
      if (accepted.kind === 'refused') throw new Error(accepted.message);
    } catch (dispatchError) {
      let settled: KeyedTriggerSettlementResult;
      try {
        settled = options.keyedTriggers.settleDispatchUnknown(begun.token);
      } catch (settlementError) {
        return {
          kind: 'failClose',
          token: candidate.token,
          candidate,
          outcome: {
            kind: 'quarantined',
            message: `dispatch failed and terminal outcome could not be persisted: ${settlementError instanceof Error ? settlementError.message : String(settlementError)}`,
          },
        };
      }
      const failedOutcome = settled.kind === 'unreadable'
        ? { kind: 'quarantined' as const, message: settled.message }
        : ambiguousFor(
            candidate,
            `dispatch failed with unknown outcome: ${dispatchError instanceof Error ? dispatchError.message : String(dispatchError)}`,
            true,
          );
      return { kind: 'failClose', token: candidate.token, candidate, outcome: failedOutcome };
    }

    return outcome({
      kind: 'applied',
      action: 'keyedTrigger.started',
      sessionId: candidate.sessionId,
      triggerId: candidate.triggerId,
      chatId: candidate.chatId,
    });
  };

  const runtime: SessionRuntime = {
    async submit(request) {
      // run() finishes the dispatch-critical segment before the first await, so
      // callers cannot interleave a freeze between the final fence and fork.
      const result = run(request);
      if (result.kind === 'outcome') return result.outcome;
      let closed: KeyedTriggerTurnCloseResult;
      try {
        closed = await options.keyedTriggerTurns.failClose(result.token);
      } catch (error) {
        closed = { kind: 'unreadable', message: error instanceof Error ? error.message : String(error) };
      }
      if (closed.kind === 'unreadable') {
        return {
          kind: 'quarantined',
          message: `${result.outcome.kind === 'quarantined' ? result.outcome.message : 'dispatch outcome is ambiguous'}; fail-close did not converge: ${closed.message}`,
        };
      }
      return result.outcome;
    },
  };

  return { runtime, projection };
}
