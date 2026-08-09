/**
 * Storage-agnostic command/query boundary for one daemon-owned Session host.
 *
 * Target-A deliberately keeps the current persistence guarantees. `applied`
 * is therefore a process-local/domain outcome, never a durable commit receipt.
 * The runtime owns opaque address epochs and command-specific replay policy;
 * current JSON/journal adapters remain behind the injected ports.
 */

import { computeInputHash } from '../utils/canonical-input-hash.js';
import type { ExternalTriggerBusinessInput } from './external-trigger-envelope.js';
import type {
  SessionStore,
  StoredSessionState,
  StoredSessionTitleSource,
} from './session-store.js';
import type {
  DispatchInputCommitEvidence,
  DispatchInputCommitEvidencePort,
  DispatchInputCommitInspection,
} from './dispatch-input-commit-evidence.js';

declare const sessionAddressBrand: unique symbol;
declare const executorAddressBrand: unique symbol;

/** Runtime-local, non-serializable handle. Only SessionProjection can mint it. */
export type SessionAddress = Readonly<Record<never, never>> & {
  readonly [sessionAddressBrand]: true;
};

/** Adapter-minted, runtime-epoch-local handle for one exact Executor activation. */
export type ExecutorAddress = Readonly<Record<never, never>> & {
  readonly [executorAddressBrand]: true;
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
  | { kind: 'failed' }
  | { kind: 'completed' }
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

export interface KeyedTriggerStartInput {
  /** The sole canonical input for both idempotency hashing and rendering. */
  business: ExternalTriggerBusinessInput;
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

export type SessionCommandValue =
  | null
  | boolean
  | number
  | string
  | readonly SessionCommandValue[]
  | { readonly [key: string]: SessionCommandValue | undefined };

export interface OrdinaryIngressInput {
  /** Stable business input after transport normalization. */
  semantic: SessionCommandValue;
}

export type OrdinaryIngressCommitResult =
  | { kind: 'committed' }
  | { kind: 'notCommitted'; message: string }
  | { kind: 'unknown'; message: string };

/**
 * Current ingress effect seam. It can prove only this process' hand-off to the
 * current input path; it is deliberately not a durable mailbox Adapter.
 */
export interface OrdinaryIngressPort {
  commit(input: {
    sessionId: string;
    idempotencyKey: string;
    semantic: SessionCommandValue;
  }): OrdinaryIngressCommitResult;
}

export type ExecutorBindingObservation =
  | {
      kind: 'current';
      token: unknown;
      sessionId: string;
      generation: number;
    }
  | { kind: 'staleAddress'; message: string }
  | { kind: 'unreadable'; message: string };

export type ExecutorInputCommitReconcileResult =
  | { kind: 'committed' }
  | { kind: 'notCommitted'; message: string }
  | { kind: 'unknown'; message: string }
  | { kind: 'unreadable'; message: string };

/** Reconcile seam for an Agent CLI effect that must never be blindly replayed. */
export interface ExecutorObservationPort {
  inspect(address: ExecutorAddress): ExecutorBindingObservation;
  reconcileInputCommit(input: {
    token: unknown;
    turnId: string;
    executorGeneration: number;
  }): ExecutorInputCommitReconcileResult;
}

export type KeyedTriggerCommand = {
  kind: 'keyedTrigger.start';
  input: KeyedTriggerStartInput;
};

export type OrdinaryIngressCommand = {
  kind: 'ordinary.ingress';
  input: OrdinaryIngressInput;
};

export interface ControlRenameInput {
  title: string;
  updatedAt: string;
  source: StoredSessionTitleSource;
}

export type ControlRenameCommand = {
  kind: 'control.rename';
  input: ControlRenameInput;
};

export interface ExecutorInputCommittedInput {
  executor: ExecutorAddress;
  turnId: string;
  committedAt: string;
}

export type ExecutorInputCommittedCommand = {
  kind: 'executor.inputCommitted';
  input: ExecutorInputCommittedInput;
};

export type SessionCommand =
  | KeyedTriggerCommand
  | OrdinaryIngressCommand
  | ControlRenameCommand
  | ExecutorInputCommittedCommand;

export interface SessionCommandRequest<C extends SessionCommand = SessionCommand> {
  target:
    | { kind: 'session'; address: SessionAddress }
    | { kind: 'route'; route: SessionCommandRoute };
  idempotencyKey: string;
  command: C;
}

export type KeyedTriggerCommandOutcome =
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

export type OrdinaryIngressCommandOutcome =
  | {
      kind: 'applied';
      action: 'ordinary.inputCommitted';
      policy: 'ordinary-replayable';
      durability: 'processLocal';
      sessionId: string;
    }
  | {
      kind: 'duplicate';
      state: 'received' | 'inputCommitted';
      policy: 'ordinary-replayable';
      durability: 'processLocal';
      sessionId: string;
      message: string;
    }
  | {
      kind: 'ambiguous';
      state: 'commitUnknown';
      policy: 'ordinary-replayable';
      durability: 'processLocal';
      sessionId: string;
      message: string;
      idempotent: boolean;
    }
  | { kind: 'rejected'; reason: 'idempotencyConflict' | 'invalidCommand'; message: string }
  | { kind: 'staleAddress' }
  | { kind: 'notWired'; command: 'ordinary.ingress'; message: string }
  | { kind: 'retryable'; message: string }
  | { kind: 'quarantined'; message: string };

export type ControlRenameCommandOutcome =
  | {
      kind: 'applied';
      action: 'control.renamed';
      policy: 'control-semantic-transition';
      sessionId: string;
      title: string;
    }
  | {
      kind: 'duplicate';
      state: 'received' | 'controlApplied';
      policy: 'control-semantic-transition';
      sessionId: string;
      message: string;
    }
  | {
      kind: 'ambiguous';
      policy: 'control-semantic-transition';
      sessionId: string;
      message: string;
    }
  | {
      kind: 'rejected';
      reason: 'idempotencyConflict' | 'invalidCommand' | 'sessionNotFound' | 'transitionRejected';
      message: string;
    }
  | { kind: 'staleAddress' }
  | { kind: 'notWired'; command: 'control.rename'; message: string }
  | { kind: 'retryable'; message: string }
  | { kind: 'quarantined'; message: string };

export type ExecutorInputCommittedCommandOutcome =
  | {
      kind: 'applied';
      action: 'executor.inputCommitRecorded';
      policy: 'executor-reconcile-first';
      sessionId: string;
      turnId: string;
      executorGeneration: number;
    }
  | {
      kind: 'duplicate';
      state: 'inputCommitted';
      policy: 'executor-reconcile-first';
      sessionId: string;
      turnId: string;
      executorGeneration: number;
      message: string;
    }
  | {
      kind: 'ambiguous';
      policy: 'executor-reconcile-first';
      sessionId: string;
      turnId: string;
      executorGeneration: number;
      message: string;
    }
  | {
      kind: 'staleExecutor';
      sessionId: string;
      turnId: string;
      message: string;
    }
  | {
      kind: 'rejected';
      reason: 'idempotencyConflict' | 'invalidCommand' | 'sessionNotFound' | 'transitionRejected';
      message: string;
    }
  | { kind: 'staleAddress' }
  | { kind: 'notWired'; command: 'executor.inputCommitted'; message: string }
  | { kind: 'retryable'; message: string }
  | { kind: 'quarantined'; message: string };

export type CommandOutcome =
  | KeyedTriggerCommandOutcome
  | OrdinaryIngressCommandOutcome
  | ControlRenameCommandOutcome
  | ExecutorInputCommittedCommandOutcome;

export type CommandOutcomeFor<C extends SessionCommand> =
  C extends KeyedTriggerCommand
    ? KeyedTriggerCommandOutcome
    : C extends OrdinaryIngressCommand
      ? OrdinaryIngressCommandOutcome
      : C extends ControlRenameCommand
        ? ControlRenameCommandOutcome
        : C extends ExecutorInputCommittedCommand
          ? ExecutorInputCommittedCommandOutcome
          : never;

export interface SessionRuntime {
  submit<C extends SessionCommand>(request: SessionCommandRequest<C>): Promise<CommandOutcomeFor<C>>;
}

interface AddressSlot {
  sessionId: string;
}

type AdmissionDecision =
  | { kind: 'continue'; candidate: unknown }
  | { kind: 'settleAttempting'; observation: PresentKeyedTriggerObservation }
  | { kind: 'outcome'; outcome: CommandOutcome };

function opaque<T>(): T {
  return Object.freeze({}) as T;
}

function reflectsRename(state: StoredSessionState, input: ControlRenameInput): boolean {
  return state.title === input.title
    && state.titleUpdatedAt === input.updatedAt
    && state.titleSource === input.source;
}

function inputCommitMatches(
  evidence: DispatchInputCommitEvidence,
  input: Pick<ExecutorInputCommittedInput, 'turnId'> & { executorGeneration: number },
): boolean {
  return evidence.turnId === input.turnId
    && evidence.executorGeneration === input.executorGeneration;
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
    return { kind: 'settleAttempting', observation };
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
  ordinaryIngress?: OrdinaryIngressPort;
  sessionStore?: SessionStore;
  executorObservations?: ExecutorObservationPort;
  dispatchInputCommits?: DispatchInputCommitEvidencePort;
}): { runtime: SessionRuntime; projection: SessionProjection } {
  const addresses = new Map<string, SessionAddress>();
  const addressSlots = new WeakMap<object, AddressSlot>();
  const ordinaryInputs = new Map<string, {
    requestHash: string;
    state: 'received' | 'inputCommitted' | 'commitUnknown';
  }>();
  const controlCommands = new Map<string, {
    requestHash: string;
    sessionId: string;
    state: 'received' | 'applied' | 'unknown';
  }>();
  const executorCommands = new Map<string, {
    requestHash: string;
    sessionId: string;
    executor: ExecutorAddress;
  }>();
  const sessionCommandIdentities = new Map<string, {
    kind: OrdinaryIngressCommand['kind'] | ControlRenameCommand['kind'] | ExecutorInputCommittedCommand['kind'];
    requestHash: string;
  }>();
  const scopedCommandKey = (sessionId: string, idempotencyKey: string): string => (
    `${sessionId}\u0000${idempotencyKey}`
  );

  const addressFor = (key: string, sessionId: string): SessionAddress => {
    const existing = addresses.get(key);
    if (existing) return existing;
    const address = opaque<SessionAddress>();
    addresses.set(key, address);
    addressSlots.set(address, { sessionId });
    return address;
  };

  const view = (row: SessionDirectoryRow): SessionView => ({
    address: addressFor(row.key, row.sessionId),
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

  const settleObservedAttempt = (
    observation: PresentKeyedTriggerObservation,
  ): CriticalResult => {
    let settled: KeyedTriggerSettlementResult;
    try {
      settled = options.keyedTriggers.settleDispatchUnknown(observation.token);
    } catch (error) {
      return outcome({
        kind: 'quarantined',
        message: `interrupted dispatch could not be settled: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (settled.kind === 'unreadable') {
      return outcome({ kind: 'quarantined', message: settled.message });
    }
    if (settled.kind === 'completed') {
      return outcome(duplicate(
        observation,
        'completed',
        'completion became authoritative while interrupted dispatch was being reconciled',
      ));
    }
    return outcome({
      kind: 'ambiguous',
      sessionId: observation.sessionId,
      triggerId: observation.triggerId,
      chatId: observation.chatId,
      message: 'previous dispatch was interrupted with unknown outcome; persisted dispatch_unknown and did not re-run',
      durable: true,
      idempotent: true,
    });
  };

  const run = (request: SessionCommandRequest): CriticalResult => {
    if (!request.idempotencyKey.trim()) {
      return outcome({
        kind: 'rejected',
        reason: 'invalidCommand',
        message: 'idempotency key must not be blank',
      });
    }
    if (request.target.kind === 'session' && !addressSlots.has(request.target.address)) {
      return outcome({ kind: 'staleAddress' });
    }
    if (request.command.kind === 'executor.inputCommitted') {
      if (request.target.kind !== 'session') {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: 'executor observation requires an address resolved by this SessionRuntime epoch',
        });
      }
      const slot = addressSlots.get(request.target.address)!;
      const command = request.command.input;
      if (!options.executorObservations || !options.sessionStore || !options.dispatchInputCommits) {
        return outcome({
          kind: 'notWired',
          command: 'executor.inputCommitted',
          message: 'executor observations are not connected to Executor, SessionStore generation, and named input-commit evidence ports',
        });
      }
      let requestHash: string;
      try {
        requestHash = computeInputHash({
          turnId: command.turnId,
        });
      } catch (error) {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: `Executor observation is not canonicalizable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const executorKey = scopedCommandKey(slot.sessionId, request.idempotencyKey);
      const priorCommand = executorCommands.get(executorKey);
      if (priorCommand
        && (priorCommand.executor !== command.executor
          || priorCommand.requestHash !== requestHash)) {
        return outcome({
          kind: 'rejected',
          reason: 'idempotencyConflict',
          message: 'idempotency key already used with a different Executor observation',
        });
      }
      const existingIdentity = sessionCommandIdentities.get(executorKey);
      if (existingIdentity
          && (existingIdentity.kind !== request.command.kind
            || existingIdentity.requestHash !== requestHash)) {
        return outcome({
          kind: 'rejected',
          reason: 'idempotencyConflict',
          message: 'Session idempotency key already belongs to a different semantic command',
        });
      }
      if (!existingIdentity) {
        sessionCommandIdentities.set(executorKey, { kind: request.command.kind, requestHash });
      }
      let binding: ExecutorBindingObservation;
      try {
        binding = options.executorObservations.inspect(command.executor);
      } catch (error) {
        return outcome({
          kind: 'quarantined',
          message: `Executor address inspection failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (binding.kind === 'staleAddress') {
        return outcome({
          kind: 'staleExecutor',
          sessionId: slot.sessionId,
          turnId: command.turnId,
          message: binding.message,
        });
      }
      if (binding.kind === 'unreadable') return outcome({ kind: 'quarantined', message: binding.message });
      if (binding.sessionId !== slot.sessionId) {
        return outcome({
          kind: 'staleExecutor',
          sessionId: slot.sessionId,
          turnId: command.turnId,
          message: 'Executor address does not match the target Session and exact generation',
        });
      }

      let loaded: ReturnType<SessionStore['load']>;
      try {
        loaded = options.sessionStore.load(slot.sessionId);
      } catch (error) {
        return outcome({
          kind: 'quarantined',
          message: `SessionStore load failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (loaded.kind === 'notFound') {
        return outcome({ kind: 'rejected', reason: 'sessionNotFound', message: 'Session is not present in the Current Store' });
      }
      if (loaded.kind === 'unavailable') return outcome({ kind: 'retryable', message: loaded.message });
      if (loaded.kind === 'corrupt' || loaded.kind === 'futureVersion') {
        return outcome({ kind: 'quarantined', message: loaded.message });
      }
      const executorGeneration = binding.generation;
      if (loaded.state.executorGeneration !== executorGeneration) {
        return outcome({
          kind: 'staleExecutor',
          sessionId: slot.sessionId,
          turnId: command.turnId,
          message: 'Executor report generation is stale relative to the Current Store',
        });
      }
      let existingEvidence: DispatchInputCommitInspection;
      try {
        existingEvidence = options.dispatchInputCommits.read({
          sessionId: slot.sessionId,
          turnId: command.turnId,
        });
      } catch (error) {
        return outcome({
          kind: 'quarantined',
          message: `input-commit evidence inspection failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (existingEvidence.kind === 'unreadable') {
        return outcome({ kind: 'quarantined', message: existingEvidence.message });
      }
      if (existingEvidence.kind === 'committed'
          && inputCommitMatches(existingEvidence.evidence, { ...command, executorGeneration })) {
        executorCommands.set(executorKey, {
          requestHash,
          sessionId: slot.sessionId,
          executor: command.executor,
        });
        return outcome({
          kind: 'duplicate',
          state: 'inputCommitted',
          policy: 'executor-reconcile-first',
          sessionId: slot.sessionId,
          turnId: command.turnId,
          executorGeneration,
          message: 'input commitment is already recorded for this exact Executor generation',
        });
      }

      executorCommands.set(executorKey, {
        requestHash,
        sessionId: slot.sessionId,
        executor: command.executor,
      });

      let reconciled: ExecutorInputCommitReconcileResult;
      try {
        reconciled = options.executorObservations.reconcileInputCommit({
          token: binding.token,
          turnId: command.turnId,
          executorGeneration,
        });
      } catch (error) {
        reconciled = {
          kind: 'unknown',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (reconciled.kind === 'unreadable') return outcome({ kind: 'quarantined', message: reconciled.message });
      if (reconciled.kind === 'notCommitted') {
        executorCommands.delete(executorKey);
        return outcome({ kind: 'retryable', message: reconciled.message });
      }
      if (reconciled.kind === 'unknown') {
        return outcome({
          kind: 'ambiguous',
          policy: 'executor-reconcile-first',
          sessionId: slot.sessionId,
          turnId: command.turnId,
          executorGeneration,
          message: reconciled.message,
        });
      }

      const evidence: DispatchInputCommitEvidence = {
        sessionId: slot.sessionId,
        turnId: command.turnId,
        executorGeneration,
        committedAt: command.committedAt,
      };
      let recorded: ReturnType<DispatchInputCommitEvidencePort['record']>;
      try {
        recorded = options.dispatchInputCommits.record(evidence);
      } catch (error) {
        return outcome({
          kind: 'quarantined',
          message: `input-commit evidence write failed outside its typed contract: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (recorded.kind === 'recorded') {
        return outcome({
          kind: 'applied',
          action: 'executor.inputCommitRecorded',
          policy: 'executor-reconcile-first',
          sessionId: slot.sessionId,
          turnId: command.turnId,
          executorGeneration,
        });
      }
      if (recorded.kind === 'conflict') {
        if (recorded.current && inputCommitMatches(recorded.current, { ...command, executorGeneration })) {
          return outcome({
            kind: 'duplicate',
            state: 'inputCommitted',
            policy: 'executor-reconcile-first',
            sessionId: slot.sessionId,
            turnId: command.turnId,
            executorGeneration,
            message: 'input commitment is already recorded for this exact Executor generation',
          });
        }
        return outcome({
          kind: 'ambiguous',
          policy: 'executor-reconcile-first',
          sessionId: slot.sessionId,
          turnId: command.turnId,
          executorGeneration,
          message: 'input-commit evidence conflicts with this exact Executor report',
        });
      }
      if (recorded.kind === 'notRecorded') return outcome({ kind: 'retryable', message: recorded.message });
      if (recorded.kind === 'unreadable') return outcome({ kind: 'quarantined', message: recorded.message });

      let readback: DispatchInputCommitInspection;
      try {
        readback = options.dispatchInputCommits.read({
          sessionId: slot.sessionId,
          turnId: command.turnId,
        });
      } catch (error) {
        return outcome({
          kind: 'ambiguous',
          policy: 'executor-reconcile-first',
          sessionId: slot.sessionId,
          turnId: command.turnId,
          executorGeneration,
          message: `${recorded.message}; strict readback failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (readback.kind === 'committed'
          && inputCommitMatches(readback.evidence, { ...command, executorGeneration })) {
        return outcome({
          kind: 'applied',
          action: 'executor.inputCommitRecorded',
          policy: 'executor-reconcile-first',
          sessionId: slot.sessionId,
          turnId: command.turnId,
          executorGeneration,
        });
      }
      if (readback.kind === 'unreadable') {
        return outcome({ kind: 'quarantined', message: readback.message });
      }
      return outcome({
        kind: 'ambiguous',
        policy: 'executor-reconcile-first',
        sessionId: slot.sessionId,
        turnId: command.turnId,
        executorGeneration,
        message: recorded.message,
      });
    }
    if (request.command.kind === 'control.rename') {
      if (request.target.kind !== 'session') {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: 'control rename requires an address resolved by this SessionRuntime epoch',
        });
      }
      const slot = addressSlots.get(request.target.address)!;
      if (!options.sessionStore) {
        return outcome({
          kind: 'notWired',
          command: 'control.rename',
          message: 'control rename is not connected to a SessionStore in this Current host',
        });
      }
      let requestHash: string;
      try {
        requestHash = computeInputHash(request.command.input);
      } catch (error) {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: `control command is not canonicalizable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const controlKey = scopedCommandKey(slot.sessionId, request.idempotencyKey);
      const priorCommand = controlCommands.get(controlKey);
      if (priorCommand
        && priorCommand.requestHash !== requestHash) {
        return outcome({
          kind: 'rejected',
          reason: 'idempotencyConflict',
          message: 'idempotency key already used with a different control command',
        });
      }
      const existingIdentity = sessionCommandIdentities.get(controlKey);
      if (existingIdentity
          && (existingIdentity.kind !== request.command.kind
            || existingIdentity.requestHash !== requestHash)) {
        return outcome({
          kind: 'rejected',
          reason: 'idempotencyConflict',
          message: 'Session idempotency key already belongs to a different semantic command',
        });
      }
      if (!existingIdentity) {
        sessionCommandIdentities.set(controlKey, { kind: request.command.kind, requestHash });
      }
      if (priorCommand?.state === 'received') {
        return outcome({
          kind: 'duplicate',
          state: 'received',
          policy: 'control-semantic-transition',
          sessionId: slot.sessionId,
          message: 'rename transition is already being evaluated in this runtime epoch',
        });
      }
      if (priorCommand?.state === 'applied') {
        return outcome({
          kind: 'duplicate',
          state: 'controlApplied',
          policy: 'control-semantic-transition',
          sessionId: slot.sessionId,
          message: 'rename transition is already reflected by the Current Store',
        });
      }
      if (!priorCommand) {
        controlCommands.set(controlKey, {
          requestHash,
          sessionId: slot.sessionId,
          state: 'received',
        });
      }
      let loaded: ReturnType<SessionStore['load']>;
      try {
        loaded = options.sessionStore.load(slot.sessionId);
      } catch (error) {
        if (priorCommand?.state === 'unknown') {
          return outcome({
            kind: 'ambiguous',
            policy: 'control-semantic-transition',
            sessionId: slot.sessionId,
            message: `rename publication remains unknown and strict readback failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        controlCommands.delete(controlKey);
        return outcome({
          kind: 'quarantined',
          message: `SessionStore load failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (loaded.kind === 'notFound') {
        if (priorCommand?.state === 'unknown') {
          return outcome({
            kind: 'ambiguous',
            policy: 'control-semantic-transition',
            sessionId: slot.sessionId,
            message: 'rename publication remains unknown because strict readback no longer finds the Session',
          });
        }
        controlCommands.delete(controlKey);
        return outcome({ kind: 'rejected', reason: 'sessionNotFound', message: 'Session is not present in the Current Store' });
      }
      if (loaded.kind === 'unavailable') {
        if (priorCommand?.state === 'unknown') {
          return outcome({
            kind: 'ambiguous',
            policy: 'control-semantic-transition',
            sessionId: slot.sessionId,
            message: `rename publication remains unknown: ${loaded.message}`,
          });
        }
        controlCommands.delete(controlKey);
        return outcome({ kind: 'retryable', message: loaded.message });
      }
      if (loaded.kind === 'corrupt' || loaded.kind === 'futureVersion') {
        if (priorCommand?.state !== 'unknown') controlCommands.delete(controlKey);
        return outcome({ kind: 'quarantined', message: loaded.message });
      }
      if (reflectsRename(loaded.state, request.command.input)) {
        controlCommands.set(controlKey, {
          requestHash,
          sessionId: slot.sessionId,
          state: 'applied',
        });
        return outcome({
          kind: 'duplicate',
          state: 'controlApplied',
          policy: 'control-semantic-transition',
          sessionId: slot.sessionId,
          message: 'rename transition is already reflected by the Current Store',
        });
      }
      if (priorCommand?.state === 'unknown') {
        return outcome({
          kind: 'ambiguous',
          policy: 'control-semantic-transition',
          sessionId: slot.sessionId,
          message: 'rename publication remains unknown after strict readback; do not apply it again',
        });
      }
      let applied: ReturnType<SessionStore['apply']>;
      try {
        applied = options.sessionStore.apply({
          sessionId: slot.sessionId,
          expected: loaded.version,
          transition: { kind: 'rename', ...request.command.input },
        });
      } catch (error) {
        controlCommands.set(controlKey, {
          requestHash,
          sessionId: slot.sessionId,
          state: 'unknown',
        });
        return outcome({
          kind: 'quarantined',
          message: `SessionStore apply failed outside its typed contract: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (applied.kind === 'applied') {
        controlCommands.set(controlKey, {
          requestHash,
          sessionId: slot.sessionId,
          state: 'applied',
        });
        return outcome({
          kind: 'applied',
          action: 'control.renamed',
          policy: 'control-semantic-transition',
          sessionId: slot.sessionId,
          title: applied.state.title,
        });
      }
      if (applied.kind === 'conflict') {
        if (applied.current && reflectsRename(applied.current.state, request.command.input)) {
          controlCommands.set(controlKey, {
            requestHash,
            sessionId: slot.sessionId,
            state: 'applied',
          });
          return outcome({
            kind: 'duplicate',
            state: 'controlApplied',
            policy: 'control-semantic-transition',
            sessionId: slot.sessionId,
            message: 'rename transition is already reflected by the Current Store',
          });
        }
        controlCommands.delete(controlKey);
        return outcome({ kind: 'retryable', message: 'SessionStore version conflict; retry the same rename command' });
      }
      if (applied.kind === 'rejected') {
        controlCommands.delete(controlKey);
        return outcome({ kind: 'rejected', reason: 'transitionRejected', message: applied.message });
      }
      if (applied.kind === 'notApplied') {
        controlCommands.delete(controlKey);
        return outcome({ kind: 'retryable', message: applied.message });
      }
      let readback: ReturnType<SessionStore['load']>;
      try {
        readback = options.sessionStore.load(slot.sessionId);
      } catch (error) {
        controlCommands.set(controlKey, {
          requestHash,
          sessionId: slot.sessionId,
          state: 'unknown',
        });
        return outcome({
          kind: 'ambiguous',
          policy: 'control-semantic-transition',
          sessionId: slot.sessionId,
          message: `${applied.message}; strict readback failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (readback.kind === 'loaded' && reflectsRename(readback.state, request.command.input)) {
        controlCommands.set(controlKey, {
          requestHash,
          sessionId: slot.sessionId,
          state: 'applied',
        });
        return outcome({
          kind: 'applied',
          action: 'control.renamed',
          policy: 'control-semantic-transition',
          sessionId: slot.sessionId,
          title: readback.state.title,
        });
      }
      if (readback.kind === 'corrupt' || readback.kind === 'futureVersion') {
        controlCommands.set(controlKey, {
          requestHash,
          sessionId: slot.sessionId,
          state: 'unknown',
        });
        return outcome({ kind: 'quarantined', message: readback.message });
      }
      controlCommands.set(controlKey, {
        requestHash,
        sessionId: slot.sessionId,
        state: 'unknown',
      });
      return outcome({
        kind: 'ambiguous',
        policy: 'control-semantic-transition',
        sessionId: slot.sessionId,
        message: applied.message,
      });
    }
    if (request.command.kind === 'ordinary.ingress') {
      if (request.target.kind !== 'session') {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: 'ordinary ingress requires an address resolved by this SessionRuntime epoch',
        });
      }
      const slot = addressSlots.get(request.target.address)!;
      if (!options.ordinaryIngress) {
        return outcome({
          kind: 'notWired',
          command: 'ordinary.ingress',
          message: 'ordinary ingress is not connected to this Current SessionRuntime host',
        });
      }
      let requestHash: string;
      try {
        requestHash = computeInputHash(request.command.input.semantic);
      } catch (error) {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: `ordinary ingress semantic input is not canonicalizable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const ordinaryKey = scopedCommandKey(slot.sessionId, request.idempotencyKey);
      const prior = ordinaryInputs.get(ordinaryKey);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          return outcome({
            kind: 'rejected',
            reason: 'idempotencyConflict',
            message: 'idempotency key already used with a different ordinary ingress',
          });
        }
        if (prior.state === 'commitUnknown') {
          return outcome({
            kind: 'ambiguous',
            state: 'commitUnknown',
            policy: 'ordinary-replayable',
            durability: 'processLocal',
            sessionId: slot.sessionId,
            message: 'ordinary input commitment is unknown in this runtime epoch; do not blindly re-submit',
            idempotent: true,
          });
        }
        return outcome({
          kind: 'duplicate',
          state: prior.state,
          policy: 'ordinary-replayable',
          durability: 'processLocal',
          sessionId: slot.sessionId,
          message: prior.state === 'received'
            ? 'ordinary input was already received in this runtime epoch'
            : 'ordinary input was already committed in this runtime epoch',
        });
      }
      const existingIdentity = sessionCommandIdentities.get(ordinaryKey);
      if (existingIdentity
          && (existingIdentity.kind !== request.command.kind
            || existingIdentity.requestHash !== requestHash)) {
        return outcome({
          kind: 'rejected',
          reason: 'idempotencyConflict',
          message: 'Session idempotency key already belongs to a different semantic command',
        });
      }
      if (!existingIdentity) {
        sessionCommandIdentities.set(ordinaryKey, { kind: request.command.kind, requestHash });
      }
      ordinaryInputs.set(ordinaryKey, {
        requestHash,
        state: 'received',
      });
      let committed: OrdinaryIngressCommitResult;
      try {
        committed = options.ordinaryIngress.commit({
          sessionId: slot.sessionId,
          idempotencyKey: request.idempotencyKey,
          semantic: request.command.input.semantic,
        });
      } catch (error) {
        committed = {
          kind: 'unknown',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (committed.kind === 'notCommitted') {
        ordinaryInputs.delete(ordinaryKey);
        return outcome({ kind: 'retryable', message: committed.message });
      }
      if (committed.kind === 'unknown') {
        ordinaryInputs.set(ordinaryKey, {
          requestHash,
          state: 'commitUnknown',
        });
        return outcome({
          kind: 'ambiguous',
          state: 'commitUnknown',
          policy: 'ordinary-replayable',
          durability: 'processLocal',
          sessionId: slot.sessionId,
          message: committed.message,
          idempotent: false,
        });
      }
      ordinaryInputs.set(ordinaryKey, {
        requestHash,
        state: 'inputCommitted',
      });
      return outcome({
        kind: 'applied',
        action: 'ordinary.inputCommitted',
        policy: 'ordinary-replayable',
        durability: 'processLocal',
        sessionId: slot.sessionId,
      });
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
      requestHash = computeInputHash({
        business: command.input.business,
        persistInputHistory: command.input.persistInputHistory,
      });
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
    if (admission.kind === 'settleAttempting') {
      return settleObservedAttempt(admission.observation);
    }

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
      if (raced.kind === 'outcome') return outcome(raced.outcome);
      if (raced.kind === 'settleAttempting') return settleObservedAttempt(raced.observation);
      return outcome({ kind: 'quarantined', message: 'keyed-trigger reserve returned a non-terminal existing observation' });
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
      if (settled.kind === 'completed') {
        return outcome({
          kind: 'duplicate',
          state: 'completed',
          sessionId: candidate.sessionId,
          triggerId: candidate.triggerId,
          chatId: candidate.chatId,
          message: 'completion became authoritative while dispatch failure was being reconciled',
        });
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

  const submit = async <C extends SessionCommand>(
    request: SessionCommandRequest<C>,
  ): Promise<CommandOutcomeFor<C>> => {
    // run() finishes the dispatch-critical segment before the first await, so
    // callers cannot interleave a freeze between the final fence and fork.
    const result = run(request as SessionCommandRequest);
    if (result.kind === 'outcome') return result.outcome as CommandOutcomeFor<C>;
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
      } as CommandOutcomeFor<C>;
    }
    return result.outcome as CommandOutcomeFor<C>;
  };
  const runtime: SessionRuntime = { submit };

  return { runtime, projection };
}
