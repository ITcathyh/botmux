/**
 * Storage-agnostic command/query boundary for one daemon-owned Session host.
 *
 * Target-A deliberately keeps the current persistence guarantees. `applied`
 * is therefore a process-local/domain outcome, never a durable commit receipt.
 * The runtime owns opaque address epochs and command-specific replay policy;
 * current JSON/journal adapters remain behind the injected ports.
 */

import { types as nodeUtilTypes } from 'node:util';

import { computeInputHash } from '../utils/canonical-input-hash.js';
import type { ExternalTriggerBusinessInput } from './external-trigger-envelope.js';
import {
  normalizeOrdinaryImTurn,
  type NormalizedOrdinaryImTurn,
  type OrdinaryImTransportEnvelope,
} from './ordinary-im-turn.js';
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
import {
  createSessionCommandLaneHost,
  type SessionCommandLane,
  type SessionLaneAddress,
} from './session-command-lane.js';

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

/** Private exact transport binding; SessionProjection never exposes it. */
export type OrdinaryIngressRouteBinding = NormalizedOrdinaryImTurn['route'];

export type SessionCommandRoute = SessionRoute | { kind: 'idempotency'; key: string };

export interface SessionDirectoryRow {
  /** Stable only inside the bound Host; never exposed by SessionProjection. */
  key: string;
  sessionId: string;
  route: SessionRoute;
  ordinaryIngressBinding: OrdinaryIngressRouteBinding;
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

export interface OrdinaryIngressInput {
  /** State-neutral transport-shaped input; Runtime owns exact normalization. */
  readonly turn: OrdinaryImTransportEnvelope;
}

export type OrdinaryIngressTransitionResult =
  | { kind: 'committed' }
  | { kind: 'notCommitted'; message: string }
  | { kind: 'unknown'; message: string }
  | { kind: 'effect'; intent: unknown; continuation: unknown };

export type OrdinaryIngressEffectSettlement =
  | { kind: 'returned'; value: unknown }
  | { kind: 'threw'; error: unknown };

/**
 * Current ingress effect seam. It can prove only this process' hand-off to the
 * current input path; it is deliberately not a durable mailbox Adapter.
 */
export interface OrdinaryIngressPort {
  begin(input: {
    readonly sessionId: string;
    readonly turn: NormalizedOrdinaryImTurn;
  }): OrdinaryIngressTransitionResult;
  execute(intent: unknown): Promise<unknown>;
  resume(
    continuation: unknown,
    settlement: OrdinaryIngressEffectSettlement,
  ): OrdinaryIngressTransitionResult;
}

export type PendingRepoCompletionSelection =
  | {
      readonly kind: 'directory';
      readonly path: string;
      readonly pinWorkingDir: boolean;
      readonly riffRepoDirs?: readonly string[];
    }
  | {
      readonly kind: 'worktree';
      /** Ordered source repositories and their detached display/layout names. */
      readonly repositories: readonly {
        readonly sourcePath: string;
        readonly childName: string;
      }[];
      readonly branch?: string;
      readonly layout:
        | { readonly kind: 'sibling' }
        | { readonly kind: 'group'; readonly parentRoot: string };
    }
  | {
      /** Bot-default auto-worktree policy, including its proven fallback path. */
      readonly kind: 'autoWorktree';
      readonly baseDir: string;
    };

export interface PendingRepoCompletionInput {
  /** Transport-neutral selection; card/text/automatic callers compile to this. */
  readonly selection: PendingRepoCompletionSelection;
}

export type PendingRepoCompletionTransitionResult =
  | { readonly kind: 'committed' }
  | {
      readonly kind: 'rejected';
      readonly reason: 'selectionBusy' | 'notPendingRepo';
      readonly message: string;
    }
  | { readonly kind: 'retryable'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string }
  | { readonly kind: 'staleAddress' }
  | { readonly kind: 'effect'; readonly intent: unknown; readonly continuation: unknown };

export type PendingRepoCompletionEffectSettlement = OrdinaryIngressEffectSettlement;

/** Current staged port; external worktree/roster effects execute outside the Session lane. */
export interface PendingRepoCompletionPort {
  begin(input: {
    readonly sessionId: string;
    readonly selection: PendingRepoCompletionSelection;
  }): PendingRepoCompletionTransitionResult;
  execute(intent: unknown): Promise<unknown>;
  resume(
    continuation: unknown,
    settlement: PendingRepoCompletionEffectSettlement,
  ): PendingRepoCompletionTransitionResult;
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

export type PendingRepoCompletionCommand = {
  kind: 'pendingRepo.complete';
  input: PendingRepoCompletionInput;
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
  | PendingRepoCompletionCommand
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

export type PendingRepoCompletionCommandOutcome =
  | {
      kind: 'applied';
      action: 'pendingRepo.firstStartCommitted';
      sessionId: string;
    }
  | {
      kind: 'duplicate';
      state: 'inFlight' | 'committed';
      sessionId: string;
      message: string;
    }
  | {
      kind: 'rejected';
      reason: 'idempotencyConflict' | 'invalidCommand' | 'selectionBusy' | 'notPendingRepo';
      message: string;
    }
  | { kind: 'staleAddress' }
  | { kind: 'notWired'; command: 'pendingRepo.complete'; message: string }
  | { kind: 'retryable'; message: string }
  | { kind: 'ambiguous'; message: string }
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
  | PendingRepoCompletionCommandOutcome
  | ControlRenameCommandOutcome
  | ExecutorInputCommittedCommandOutcome;

export type CommandOutcomeFor<C extends SessionCommand> =
  C extends KeyedTriggerCommand
    ? KeyedTriggerCommandOutcome
    : C extends OrdinaryIngressCommand
      ? OrdinaryIngressCommandOutcome
      : C extends PendingRepoCompletionCommand
        ? PendingRepoCompletionCommandOutcome
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
  route: SessionRoute;
  ordinaryIngressBinding: OrdinaryIngressRouteBinding;
}

type AdmissionDecision =
  | { kind: 'continue'; candidate: unknown }
  | { kind: 'settleAttempting'; observation: PresentKeyedTriggerObservation }
  | { kind: 'outcome'; outcome: CommandOutcome };

function opaque<T>(): T {
  return Object.freeze({}) as T;
}

class SynchronousPortContractError extends Error {}

function invokeSynchronousPort<T>(label: string, invoke: () => T): T {
  const value = invoke();
  if (value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function') {
    void Promise.resolve(value).catch(() => undefined);
    throw new SynchronousPortContractError(`${label} must return synchronously`);
  }
  return value;
}

function reflectsRename(state: StoredSessionState, input: ControlRenameInput): boolean {
  return state.title === input.title
    && state.titleUpdatedAt === input.updatedAt
    && state.titleSource === input.source;
}

function ordinaryTurnMatchesRoute(
  turn: NormalizedOrdinaryImTurn,
  binding: OrdinaryIngressRouteBinding,
): boolean {
  return turn.route.scope === binding.scope
    && turn.route.canonicalAnchor === binding.canonicalAnchor
    && turn.route.chatId === binding.chatId
    && turn.route.chatType === binding.chatType;
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
  pendingRepoCompletion?: PendingRepoCompletionPort;
  /** Owner/epoch-stable optional ports used by a composition Host upgrade. */
  portBindings?: {
    ordinaryIngress?: OrdinaryIngressPort;
    pendingRepoCompletion?: PendingRepoCompletionPort;
  };
  sessionStore?: SessionStore;
  executorObservations?: ExecutorObservationPort;
  dispatchInputCommits?: DispatchInputCommitEvidencePort;
  /** Internal owner/epoch-scoped lane shared with Executor report routing. */
  commandLane?: SessionCommandLane;
  /** Maps a Host-local Session id to its opaque owner-scoped lane address. */
  sessionLaneAddress?: (sessionId: string) => SessionLaneAddress;
}): { runtime: SessionRuntime; projection: SessionProjection } {
  if (options.portBindings
      && (options.ordinaryIngress !== undefined
        || options.pendingRepoCompletion !== undefined)) {
    throw new Error('SessionRuntime optional ports must use direct options or one binding slot');
  }
  const ordinaryIngressPort = (): OrdinaryIngressPort | undefined => (
    options.portBindings?.ordinaryIngress ?? options.ordinaryIngress
  );
  const pendingRepoCompletionPort = (): PendingRepoCompletionPort | undefined => (
    options.portBindings?.pendingRepoCompletion ?? options.pendingRepoCompletion
  );
  if (!!options.commandLane !== !!options.sessionLaneAddress) {
    throw new Error('SessionRuntime requires both command lane and lane address resolver');
  }
  const localLaneHost = options.commandLane && options.sessionLaneAddress
    ? undefined
    : createSessionCommandLaneHost();
  const commandLane = options.commandLane ?? localLaneHost!.lane;
  const sessionLaneAddress = options.sessionLaneAddress ?? localLaneHost!.addressFor;
  const addresses = new Map<string, {
    address: SessionAddress;
    sessionId: string;
    route: SessionRoute;
    ordinaryIngressBinding: OrdinaryIngressRouteBinding;
  }>();
  const addressSlots = new WeakMap<object, AddressSlot>();
  interface OrdinaryAttempt {
    readonly terminal: Promise<OrdinaryIngressCommandOutcome>;
    settle(outcome: OrdinaryIngressCommandOutcome): void;
  }
  type OrdinaryInputRecord =
    | {
        requestHash: string;
        state: 'received';
        attempt: OrdinaryAttempt;
      }
    | {
        requestHash: string;
        state: 'inputCommitted';
      }
    | {
        requestHash: string;
        state: 'retryable';
        attempt: OrdinaryAttempt;
      }
    | {
        requestHash: string;
        state: 'commitUnknown';
        message: string;
      };
  const ordinaryInputs = new Map<string, OrdinaryInputRecord>();
  interface PendingRepoAttempt {
    readonly terminal: Promise<PendingRepoCompletionCommandOutcome>;
    settle(outcome: PendingRepoCompletionCommandOutcome): void;
  }
  type PendingRepoRecord =
    | { requestHash: string; state: 'received'; attempt: PendingRepoAttempt }
    | { requestHash: string; state: 'committed' }
    | { requestHash: string; state: 'unknown'; message: string };
  const pendingRepoCompletions = new Map<string, PendingRepoRecord>();
  const activePendingRepoCompletion = new Map<string, string>();
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
    kind: OrdinaryIngressCommand['kind'] | PendingRepoCompletionCommand['kind'] | ControlRenameCommand['kind'] | ExecutorInputCommittedCommand['kind'];
    requestHash: string;
  }>();
  const scopedCommandKey = (sessionId: string, idempotencyKey: string): string => (
    `${sessionId}\u0000${idempotencyKey}`
  );

  const createOrdinaryAttempt = (): OrdinaryAttempt => {
    let resolveTerminal!: (outcome: OrdinaryIngressCommandOutcome) => void;
    let settled = false;
    const terminal = new Promise<OrdinaryIngressCommandOutcome>((resolve) => {
      resolveTerminal = resolve;
    });
    return {
      terminal,
      settle(outcome) {
        if (settled) return;
        settled = true;
        resolveTerminal(outcome);
      },
    };
  };

  const createPendingRepoAttempt = (): PendingRepoAttempt => {
    let resolveTerminal!: (outcome: PendingRepoCompletionCommandOutcome) => void;
    let settled = false;
    const terminal = new Promise<PendingRepoCompletionCommandOutcome>((resolve) => {
      resolveTerminal = resolve;
    });
    return {
      terminal,
      settle(outcome) {
        if (settled) return;
        settled = true;
        resolveTerminal(outcome);
      },
    };
  };

  const sameSessionRoute = (left: SessionRoute, right: SessionRoute): boolean => (
    left.kind === right.kind
    && (left.kind === 'thread'
      ? left.anchorId === (right as Extract<SessionRoute, { kind: 'thread' }>).anchorId
      : left.chatId === (right as Extract<SessionRoute, { kind: 'chat' }>).chatId)
  );
  const sameOrdinaryBinding = (
    left: OrdinaryIngressRouteBinding,
    right: OrdinaryIngressRouteBinding,
  ): boolean => left.scope === right.scope
    && left.canonicalAnchor === right.canonicalAnchor
    && left.chatId === right.chatId
    && left.chatType === right.chatType;
  type ExactRecord = ReadonlyMap<string, unknown>;
  const inspectExactRecord = (
    value: unknown,
    expectedKeys: readonly string[],
    optionalKeys: readonly string[] = [],
  ): ExactRecord | undefined => {
    if (!value || typeof value !== 'object' || nodeUtilTypes.isProxy(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const allowed = new Set([...expectedKeys, ...optionalKeys]);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) return undefined;
    if (expectedKeys.some(key => !keys.includes(key))) return undefined;
    const fields = new Map<string, unknown>();
    for (const key of keys) {
      if (typeof key !== 'string') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      fields.set(key, descriptor.value);
    }
    return fields;
  };
  const inspectExactArray = (value: unknown): readonly unknown[] | undefined => {
    if (!Array.isArray(value)
      || nodeUtilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype) {
      return undefined;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor
      || !('value' in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0) {
      return undefined;
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes('length')) return undefined;
    const items: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!keys.includes(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      items.push(descriptor.value);
    }
    return items;
  };
  const nonemptyString = (value: unknown): value is string => (
    typeof value === 'string' && value.length > 0
  );
  const normalizePendingRepoSelection = (
    candidate: unknown,
  ): PendingRepoCompletionSelection | undefined => {
    try {
      const discriminator = inspectExactRecord(candidate, ['kind'], [
        'path',
        'pinWorkingDir',
        'riffRepoDirs',
        'repositories',
        'branch',
        'layout',
        'baseDir',
      ]);
      const kind = discriminator?.get('kind');
      if (kind === 'directory') {
        const record = inspectExactRecord(
          candidate,
          ['kind', 'path', 'pinWorkingDir'],
          ['riffRepoDirs'],
        );
        const path = record?.get('path');
        const pinWorkingDir = record?.get('pinWorkingDir');
        if (!record || !nonemptyString(path) || typeof pinWorkingDir !== 'boolean') {
          return undefined;
        }
        const rawRiffRepoDirs = record.get('riffRepoDirs');
        let riffRepoDirs: readonly string[] | undefined;
        if (rawRiffRepoDirs !== undefined) {
          const values = inspectExactArray(rawRiffRepoDirs);
          if (!values || values.some(value => !nonemptyString(value))) return undefined;
          riffRepoDirs = Object.freeze([...values] as string[]);
        }
        return Object.freeze({
          kind,
          path,
          pinWorkingDir,
          ...(riffRepoDirs ? { riffRepoDirs } : {}),
        });
      }
      if (kind === 'autoWorktree') {
        const record = inspectExactRecord(candidate, ['kind', 'baseDir']);
        const baseDir = record?.get('baseDir');
        if (!record || !nonemptyString(baseDir)) return undefined;
        return Object.freeze({ kind, baseDir });
      }
      if (kind !== 'worktree') return undefined;
      const record = inspectExactRecord(
        candidate,
        ['kind', 'repositories', 'layout'],
        ['branch'],
      );
      if (!record) return undefined;
      const rawRepositories = inspectExactArray(record.get('repositories'));
      if (!rawRepositories || rawRepositories.length === 0) return undefined;
      const repositories: Array<{ readonly sourcePath: string; readonly childName: string }> = [];
      for (const rawRepository of rawRepositories) {
        const repository = inspectExactRecord(rawRepository, ['sourcePath', 'childName']);
        const sourcePath = repository?.get('sourcePath');
        const childName = repository?.get('childName');
        if (!repository || !nonemptyString(sourcePath) || !nonemptyString(childName)) {
          return undefined;
        }
        repositories.push(Object.freeze({ sourcePath, childName }));
      }
      const rawLayout = record.get('layout');
      const layoutDiscriminator = inspectExactRecord(rawLayout, ['kind'], ['parentRoot']);
      const layoutKind = layoutDiscriminator?.get('kind');
      let layout: Extract<PendingRepoCompletionSelection, { readonly kind: 'worktree' }>['layout'];
      if (layoutKind === 'sibling') {
        if (!inspectExactRecord(rawLayout, ['kind'])) return undefined;
        layout = Object.freeze({ kind: layoutKind });
      } else if (layoutKind === 'group') {
        const group = inspectExactRecord(rawLayout, ['kind', 'parentRoot']);
        const parentRoot = group?.get('parentRoot');
        if (!group || !nonemptyString(parentRoot)) return undefined;
        layout = Object.freeze({ kind: layoutKind, parentRoot });
      } else {
        return undefined;
      }
      const branch = record.get('branch');
      if (branch !== undefined && !nonemptyString(branch)) return undefined;
      return Object.freeze({
        kind,
        repositories: Object.freeze(repositories),
        ...(branch === undefined ? {} : { branch }),
        layout,
      });
    } catch {
      return undefined;
    }
  };

  const addressFor = (row: SessionDirectoryRow): SessionAddress => {
    const existing = addresses.get(row.key);
    if (existing
      && existing.sessionId === row.sessionId
      && sameSessionRoute(existing.route, row.route)
      && sameOrdinaryBinding(existing.ordinaryIngressBinding, row.ordinaryIngressBinding)) {
      return existing.address;
    }
    if (existing) addressSlots.delete(existing.address);
    const address = opaque<SessionAddress>();
    const route = { ...row.route } as SessionRoute;
    const ordinaryIngressBinding = { ...row.ordinaryIngressBinding };
    addresses.set(row.key, {
      address,
      sessionId: row.sessionId,
      route,
      ordinaryIngressBinding,
    });
    addressSlots.set(address, {
      sessionId: row.sessionId,
      route,
      ordinaryIngressBinding,
    });
    return address;
  };

  const view = (row: SessionDirectoryRow): SessionView => ({
    address: addressFor(row),
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

  interface OrdinaryEffectStep {
    readonly kind: 'ordinaryEffect';
    readonly sessionId: string;
    readonly ordinaryKey: string;
    readonly requestHash: string;
    readonly attempt: OrdinaryAttempt;
    readonly intent: unknown;
    readonly continuation: unknown;
  }

  interface PendingRepoEffectStep {
    readonly kind: 'pendingRepoEffect';
    readonly sessionId: string;
    readonly completionKey: string;
    readonly requestHash: string;
    readonly attempt: PendingRepoAttempt;
    readonly intent: unknown;
    readonly continuation: unknown;
  }

  type CriticalResult =
    | { kind: 'outcome'; outcome: CommandOutcome }
    | OrdinaryEffectStep
    | PendingRepoEffectStep
    | {
        kind: 'ordinaryJoin';
        sessionId: string;
        attempt: OrdinaryAttempt;
      }
    | {
        kind: 'ordinaryRetryable';
        sessionId: string;
        ordinaryKey: string;
        attempt: OrdinaryAttempt;
        outcome: Extract<OrdinaryIngressCommandOutcome, { kind: 'retryable' }>;
      }
    | {
        kind: 'pendingRepoJoin';
        sessionId: string;
        attempt: PendingRepoAttempt;
      }
    | {
        kind: 'failClose';
        token: unknown;
        candidate: PreparedKeyedTriggerTurn;
        outcome: CommandOutcome;
      };

  const outcome = (value: CommandOutcome): CriticalResult => ({ kind: 'outcome', outcome: value });

  const ordinaryAmbiguous = (
    sessionId: string,
    message: string,
    idempotent: boolean,
  ): OrdinaryIngressCommandOutcome => ({
    kind: 'ambiguous',
    state: 'commitUnknown',
    policy: 'ordinary-replayable',
    durability: 'processLocal',
    sessionId,
    message,
    idempotent,
  });

  const ordinaryDuplicate = (sessionId: string): OrdinaryIngressCommandOutcome => ({
    kind: 'duplicate',
    state: 'inputCommitted',
    policy: 'ordinary-replayable',
    durability: 'processLocal',
    sessionId,
    message: 'ordinary input was already committed in this runtime epoch',
  });

  const settleOrdinaryTransition = (
    step: Pick<OrdinaryEffectStep, 'sessionId' | 'ordinaryKey' | 'requestHash' | 'attempt'>,
    transition: Exclude<OrdinaryIngressTransitionResult, { kind: 'effect' }>,
  ): CriticalResult => {
    let terminal: OrdinaryIngressCommandOutcome;
    if (transition.kind === 'committed') {
      ordinaryInputs.set(step.ordinaryKey, {
        requestHash: step.requestHash,
        state: 'inputCommitted',
      });
      terminal = {
        kind: 'applied',
        action: 'ordinary.inputCommitted',
        policy: 'ordinary-replayable',
        durability: 'processLocal',
        sessionId: step.sessionId,
      };
    } else if (transition.kind === 'notCommitted') {
      ordinaryInputs.set(step.ordinaryKey, {
        requestHash: step.requestHash,
        state: 'retryable',
        attempt: step.attempt,
      });
      terminal = { kind: 'retryable', message: transition.message };
    } else {
      ordinaryInputs.set(step.ordinaryKey, {
        requestHash: step.requestHash,
        state: 'commitUnknown',
        message: transition.message,
      });
      terminal = ordinaryAmbiguous(step.sessionId, transition.message, false);
    }
    step.attempt.settle(terminal);
    if (terminal.kind === 'retryable') {
      return {
        kind: 'ordinaryRetryable',
        sessionId: step.sessionId,
        ordinaryKey: step.ordinaryKey,
        attempt: step.attempt,
        outcome: terminal,
      };
    }
    return outcome(terminal);
  };

  const quarantineOrdinaryAttempt = (
    step: Pick<OrdinaryEffectStep, 'sessionId' | 'ordinaryKey' | 'requestHash' | 'attempt'>,
    message: string,
  ): CriticalResult => {
    ordinaryInputs.set(step.ordinaryKey, {
      requestHash: step.requestHash,
      state: 'commitUnknown',
      message,
    });
    const terminal: OrdinaryIngressCommandOutcome = { kind: 'quarantined', message };
    step.attempt.settle(terminal);
    return outcome(terminal);
  };

  const transitionOrdinaryAttempt = (
    step: Pick<OrdinaryEffectStep, 'sessionId' | 'ordinaryKey' | 'requestHash' | 'attempt'>,
    transition: OrdinaryIngressTransitionResult,
  ): CriticalResult => {
    try {
      if (!transition || typeof transition !== 'object') {
        return quarantineOrdinaryAttempt(step, 'ordinary ingress transition is invalid');
      }
      if (transition.kind === 'effect') {
        return {
          ...step,
          kind: 'ordinaryEffect',
          intent: transition.intent,
          continuation: transition.continuation,
        };
      }
      if (transition.kind === 'committed') {
        return settleOrdinaryTransition(step, transition);
      }
      if ((transition.kind === 'notCommitted' || transition.kind === 'unknown')
          && typeof transition.message === 'string') {
        return settleOrdinaryTransition(step, transition);
      }
      return quarantineOrdinaryAttempt(step, 'ordinary ingress transition is invalid');
    } catch (error) {
      return quarantineOrdinaryAttempt(
        step,
        `ordinary ingress transition could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const settlePendingRepoTransition = (
    step: Pick<PendingRepoEffectStep, 'sessionId' | 'completionKey' | 'requestHash' | 'attempt'>,
    transition: Exclude<PendingRepoCompletionTransitionResult, { kind: 'effect' }>,
  ): CriticalResult => {
    let terminal: PendingRepoCompletionCommandOutcome;
    if (transition.kind === 'committed') {
      pendingRepoCompletions.set(step.completionKey, {
        requestHash: step.requestHash,
        state: 'committed',
      });
      terminal = {
        kind: 'applied',
        action: 'pendingRepo.firstStartCommitted',
        sessionId: step.sessionId,
      };
    } else if (transition.kind === 'rejected') {
      pendingRepoCompletions.delete(step.completionKey);
      sessionCommandIdentities.delete(step.completionKey);
      terminal = {
        kind: 'rejected',
        reason: transition.reason,
        message: transition.message,
      };
    } else if (transition.kind === 'retryable') {
      pendingRepoCompletions.delete(step.completionKey);
      sessionCommandIdentities.delete(step.completionKey);
      terminal = transition;
    } else if (transition.kind === 'staleAddress') {
      pendingRepoCompletions.delete(step.completionKey);
      terminal = transition;
    } else {
      pendingRepoCompletions.set(step.completionKey, {
        requestHash: step.requestHash,
        state: 'unknown',
        message: transition.message,
      });
      terminal = { kind: 'ambiguous', message: transition.message };
    }
    if (activePendingRepoCompletion.get(step.sessionId) === step.completionKey) {
      activePendingRepoCompletion.delete(step.sessionId);
    }
    step.attempt.settle(terminal);
    return outcome(terminal);
  };

  const quarantinePendingRepoAttempt = (
    step: Pick<PendingRepoEffectStep, 'sessionId' | 'completionKey' | 'requestHash' | 'attempt'>,
    message: string,
  ): CriticalResult => {
    pendingRepoCompletions.set(step.completionKey, {
      requestHash: step.requestHash,
      state: 'unknown',
      message,
    });
    if (activePendingRepoCompletion.get(step.sessionId) === step.completionKey) {
      activePendingRepoCompletion.delete(step.sessionId);
    }
    const terminal: PendingRepoCompletionCommandOutcome = { kind: 'quarantined', message };
    step.attempt.settle(terminal);
    return outcome(terminal);
  };

  const transitionPendingRepoAttempt = (
    step: Pick<PendingRepoEffectStep, 'sessionId' | 'completionKey' | 'requestHash' | 'attempt'>,
    transition: PendingRepoCompletionTransitionResult,
  ): CriticalResult => {
    try {
      if (!transition || typeof transition !== 'object') {
        return quarantinePendingRepoAttempt(step, 'pending-repo completion transition is invalid');
      }
      if (transition.kind === 'effect') {
        return {
          ...step,
          kind: 'pendingRepoEffect',
          intent: transition.intent,
          continuation: transition.continuation,
        };
      }
      if (transition.kind === 'committed'
        || transition.kind === 'staleAddress'
        || transition.kind === 'retryable'
        || transition.kind === 'unknown'
        || transition.kind === 'rejected') {
        return settlePendingRepoTransition(step, transition);
      }
      return quarantinePendingRepoAttempt(step, 'pending-repo completion transition is invalid');
    } catch (error) {
      return quarantinePendingRepoAttempt(
        step,
        `pending-repo completion transition could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const settleObservedAttempt = (
    observation: PresentKeyedTriggerObservation,
  ): CriticalResult => {
    let settled: KeyedTriggerSettlementResult;
    try {
      settled = invokeSynchronousPort(
        'KeyedTriggerAuthority.settleDispatchUnknown',
        () => options.keyedTriggers.settleDispatchUnknown(observation.token),
      );
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
        binding = invokeSynchronousPort(
          'ExecutorObservationPort.inspect',
          () => options.executorObservations!.inspect(command.executor),
        );
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
        loaded = invokeSynchronousPort(
          'SessionStore.load',
          () => options.sessionStore!.load(slot.sessionId),
        );
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
        existingEvidence = invokeSynchronousPort(
          'DispatchInputCommitEvidencePort.read',
          () => options.dispatchInputCommits!.read({
            sessionId: slot.sessionId,
            turnId: command.turnId,
          }),
        );
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
        reconciled = invokeSynchronousPort(
          'ExecutorObservationPort.reconcileInputCommit',
          () => options.executorObservations!.reconcileInputCommit({
            token: binding.token,
            turnId: command.turnId,
            executorGeneration,
          }),
        );
      } catch (error) {
        if (error instanceof SynchronousPortContractError) {
          return outcome({ kind: 'quarantined', message: error.message });
        }
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
        recorded = invokeSynchronousPort(
          'DispatchInputCommitEvidencePort.record',
          () => options.dispatchInputCommits!.record(evidence),
        );
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
        readback = invokeSynchronousPort(
          'DispatchInputCommitEvidencePort.read',
          () => options.dispatchInputCommits!.read({
            sessionId: slot.sessionId,
            turnId: command.turnId,
          }),
        );
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
      const renameInput = request.command.input;
      if (!options.sessionStore) {
        return outcome({
          kind: 'notWired',
          command: 'control.rename',
          message: 'control rename is not connected to a SessionStore in this Current host',
        });
      }
      let requestHash: string;
      try {
        requestHash = computeInputHash(renameInput);
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
        loaded = invokeSynchronousPort(
          'SessionStore.load',
          () => options.sessionStore!.load(slot.sessionId),
        );
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
      if (reflectsRename(loaded.state, renameInput)) {
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
        applied = invokeSynchronousPort(
          'SessionStore.apply',
          () => options.sessionStore!.apply({
            sessionId: slot.sessionId,
            expected: loaded.version,
            transition: { kind: 'rename', ...renameInput },
          }),
        );
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
        if (applied.current && reflectsRename(applied.current.state, renameInput)) {
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
        readback = invokeSynchronousPort(
          'SessionStore.load',
          () => options.sessionStore!.load(slot.sessionId),
        );
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
      if (readback.kind === 'loaded' && reflectsRename(readback.state, renameInput)) {
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
    if (request.command.kind === 'pendingRepo.complete') {
      if (request.target.kind !== 'session') {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: 'pending-repo completion requires an address resolved by this SessionRuntime epoch',
        });
      }
      const selection = normalizePendingRepoSelection(request.command.input.selection);
      if (!selection) {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: 'pending-repo completion selection is invalid',
        });
      }
      const pendingRepoCompletion = pendingRepoCompletionPort();
      if (!pendingRepoCompletion) {
        return outcome({
          kind: 'notWired',
          command: 'pendingRepo.complete',
          message: 'pending-repo completion is not connected to this Current SessionRuntime host',
        });
      }
      const slot = addressSlots.get(request.target.address)!;
      let requestHash: string;
      try {
        requestHash = computeInputHash(selection);
      } catch (error) {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: `pending-repo completion selection is not canonicalizable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const completionKey = scopedCommandKey(slot.sessionId, request.idempotencyKey);
      const prior = pendingRepoCompletions.get(completionKey);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          return outcome({
            kind: 'rejected',
            reason: 'idempotencyConflict',
            message: 'idempotency key already used with a different pending-repo selection',
          });
        }
        if (prior.state === 'received') {
          return { kind: 'pendingRepoJoin', sessionId: slot.sessionId, attempt: prior.attempt };
        }
        if (prior.state === 'unknown') {
          return outcome({ kind: 'ambiguous', message: prior.message });
        }
        return outcome({
          kind: 'duplicate',
          state: 'committed',
          sessionId: slot.sessionId,
          message: 'pending-repo first start was already committed in this runtime epoch',
        });
      }
      const activeKey = activePendingRepoCompletion.get(slot.sessionId);
      if (activeKey && activeKey !== completionKey) {
        return outcome({
          kind: 'rejected',
          reason: 'selectionBusy',
          message: 'another pending-repo selection is already being prepared',
        });
      }
      const existingIdentity = sessionCommandIdentities.get(completionKey);
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
        sessionCommandIdentities.set(completionKey, {
          kind: request.command.kind,
          requestHash,
        });
      }
      const attempt = createPendingRepoAttempt();
      pendingRepoCompletions.set(completionKey, {
        requestHash,
        state: 'received',
        attempt,
      });
      activePendingRepoCompletion.set(slot.sessionId, completionKey);
      const step = { sessionId: slot.sessionId, completionKey, requestHash, attempt };
      let transition: PendingRepoCompletionTransitionResult;
      try {
        transition = invokeSynchronousPort(
          'PendingRepoCompletionPort.begin',
          () => pendingRepoCompletion.begin({
            sessionId: slot.sessionId,
            selection,
          }),
        );
      } catch (error) {
        return quarantinePendingRepoAttempt(
          step,
          error instanceof Error ? error.message : String(error),
        );
      }
      return transitionPendingRepoAttempt(step, transition);
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
      const ordinaryInput = request.command.input;
      const normalized = normalizeOrdinaryImTurn(ordinaryInput.turn);
      if (normalized.kind === 'rejected') {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: `ordinary ingress transport turn is invalid: ${normalized.message}`,
        });
      }
      const ordinaryTurn = normalized.turn;
      if (request.idempotencyKey !== ordinaryTurn.messageKey) {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: 'ordinary ingress idempotency key must equal the transport message key',
        });
      }
      if (!ordinaryTurnMatchesRoute(ordinaryTurn, slot.ordinaryIngressBinding)) {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: 'ordinary ingress turn route does not match the target Session address',
        });
      }
      const ordinaryIngress = ordinaryIngressPort();
      if (!ordinaryIngress) {
        return outcome({
          kind: 'notWired',
          command: 'ordinary.ingress',
          message: 'ordinary ingress is not connected to this Current SessionRuntime host',
        });
      }
      let requestHash: string;
      try {
        requestHash = computeInputHash(ordinaryTurn);
      } catch (error) {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: `ordinary ingress transport turn is not canonicalizable: ${error instanceof Error ? error.message : String(error)}`,
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
          return outcome(ordinaryAmbiguous(slot.sessionId, prior.message, true));
        }
        if (prior.state === 'received' || prior.state === 'retryable') {
          return {
            kind: 'ordinaryJoin',
            sessionId: slot.sessionId,
            attempt: prior.attempt,
          };
        }
        return outcome(ordinaryDuplicate(slot.sessionId));
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
      const attempt = createOrdinaryAttempt();
      ordinaryInputs.set(ordinaryKey, {
        requestHash,
        state: 'received',
        attempt,
      });
      const step = {
        sessionId: slot.sessionId,
        ordinaryKey,
        requestHash,
        attempt,
      };
      let transition: OrdinaryIngressTransitionResult;
      try {
        transition = invokeSynchronousPort(
          'OrdinaryIngressPort.begin',
          () => ordinaryIngress.begin({
            sessionId: slot.sessionId,
            turn: ordinaryTurn,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return quarantineOrdinaryAttempt(step, message);
      }
      return transitionOrdinaryAttempt(step, transition);
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
      observation = invokeSynchronousPort(
        'KeyedTriggerAuthority.inspect',
        () => options.keyedTriggers.inspect(request.idempotencyKey),
      );
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
      prepared = invokeSynchronousPort(
        'KeyedTriggerTurnPort.prepare',
        () => options.keyedTriggerTurns.prepare(command.input),
      );
    } catch (error) {
      return outcome({ kind: 'quarantined', message: error instanceof Error ? error.message : String(error) });
    }
    if (prepared.kind === 'retryable') return outcome({ kind: 'retryable', message: prepared.message });
    if (prepared.kind === 'unreadable') return outcome({ kind: 'quarantined', message: prepared.message });
    const candidate = prepared.turn;

    let reserved: KeyedTriggerReserveResult;
    try {
      reserved = invokeSynchronousPort(
        'KeyedTriggerAuthority.reserve',
        () => options.keyedTriggers.reserve({
          key: request.idempotencyKey,
          requestHash,
          sessionId: candidate.sessionId,
          triggerId: candidate.triggerId,
          chatId: candidate.chatId,
          candidate: admission.candidate,
        }),
      );
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
      begun = invokeSynchronousPort(
        'KeyedTriggerAuthority.begin',
        () => options.keyedTriggers.begin(reserved.token),
      );
    } catch (error) {
      return outcome({ kind: 'quarantined', message: error instanceof Error ? error.message : String(error) });
    }
    if (begun.kind === 'retryable') return outcome({ kind: 'retryable', message: begun.message });
    if (begun.kind === 'unreadable') return outcome({ kind: 'quarantined', message: begun.message });
    if (begun.kind === 'ambiguous') {
      return outcome(ambiguousFor(candidate, begun.message, begun.durable));
    }

    try {
      const accepted = invokeSynchronousPort(
        'KeyedTriggerTurnPort.acceptAtMostOnce',
        () => options.keyedTriggerTurns.acceptAtMostOnce(candidate.token, {
          key: request.idempotencyKey,
          pendingCreatedAt: begun.pendingCreatedAt,
        }),
      );
      if (accepted.kind === 'refused') throw new Error(accepted.message);
    } catch (dispatchError) {
      let settled: KeyedTriggerSettlementResult;
      try {
        settled = invokeSynchronousPort(
          'KeyedTriggerAuthority.settleDispatchUnknown',
          () => options.keyedTriggers.settleDispatchUnknown(begun.token),
        );
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

  const resumeOrdinaryAttempt = (
    step: OrdinaryEffectStep,
    settlement: OrdinaryIngressEffectSettlement,
  ): CriticalResult => {
    const current = ordinaryInputs.get(step.ordinaryKey);
    if (current?.state !== 'received' || current.attempt !== step.attempt) {
      const message = 'ordinary ingress continuation no longer owns the Current attempt';
      const terminal: OrdinaryIngressCommandOutcome = { kind: 'quarantined', message };
      step.attempt.settle(terminal);
      return outcome(terminal);
    }
    const ordinaryIngress = ordinaryIngressPort();
    if (!ordinaryIngress) {
      return quarantineOrdinaryAttempt(
        step,
        'ordinary ingress port disappeared during an in-flight attempt',
      );
    }
    let transition: OrdinaryIngressTransitionResult;
    try {
      transition = invokeSynchronousPort(
        'OrdinaryIngressPort.resume',
        () => ordinaryIngress.resume(step.continuation, settlement),
      );
    } catch (error) {
      return quarantineOrdinaryAttempt(
        step,
        error instanceof Error ? error.message : String(error),
      );
    }
    return transitionOrdinaryAttempt(step, transition);
  };

  const runOrdinaryEffects = async (
    initial: OrdinaryEffectStep,
  ): Promise<OrdinaryIngressCommandOutcome> => {
    let step = initial;
    for (;;) {
      const ordinaryIngress = ordinaryIngressPort();
      if (!ordinaryIngress) {
        return {
          kind: 'quarantined',
          message: 'ordinary ingress port disappeared during effect execution',
        };
      }
      let settlement: OrdinaryIngressEffectSettlement;
      try {
        settlement = {
          kind: 'returned',
          value: await ordinaryIngress.execute(step.intent),
        };
      } catch (error) {
        settlement = { kind: 'threw', error };
      }
      const resumed = await commandLane.submit(
        sessionLaneAddress(step.sessionId),
        () => resumeOrdinaryAttempt(step, settlement),
      );
      if (resumed.kind === 'ordinaryEffect') {
        step = resumed;
        continue;
      }
      if (resumed.kind === 'outcome') {
        return resumed.outcome as OrdinaryIngressCommandOutcome;
      }
      if (resumed.kind === 'ordinaryRetryable') {
        await commandLane.submit(sessionLaneAddress(resumed.sessionId), () => {
          const current = ordinaryInputs.get(resumed.ordinaryKey);
          if (current?.state === 'retryable' && current.attempt === resumed.attempt) {
            ordinaryInputs.delete(resumed.ordinaryKey);
          }
        });
        return resumed.outcome;
      }
      return {
        kind: 'quarantined',
        message: 'ordinary ingress continuation produced an invalid Runtime transition',
      };
    }
  };

  const joinOrdinaryAttempt = async (
    sessionId: string,
    attempt: OrdinaryAttempt,
  ): Promise<OrdinaryIngressCommandOutcome> => {
    const terminal = await attempt.terminal;
    if (terminal.kind === 'applied') return ordinaryDuplicate(sessionId);
    if (terminal.kind === 'ambiguous') return { ...terminal, idempotent: true };
    return terminal;
  };

  const resumePendingRepoAttempt = (
    step: PendingRepoEffectStep,
    settlement: PendingRepoCompletionEffectSettlement,
  ): CriticalResult => {
    const current = pendingRepoCompletions.get(step.completionKey);
    if (current?.state !== 'received' || current.attempt !== step.attempt) {
      return quarantinePendingRepoAttempt(
        step,
        'pending-repo continuation no longer owns the Current attempt',
      );
    }
    const pendingRepoCompletion = pendingRepoCompletionPort();
    if (!pendingRepoCompletion) {
      return quarantinePendingRepoAttempt(
        step,
        'pending-repo completion port disappeared during an in-flight attempt',
      );
    }
    let transition: PendingRepoCompletionTransitionResult;
    try {
      transition = invokeSynchronousPort(
        'PendingRepoCompletionPort.resume',
        () => pendingRepoCompletion.resume(step.continuation, settlement),
      );
    } catch (error) {
      return quarantinePendingRepoAttempt(
        step,
        error instanceof Error ? error.message : String(error),
      );
    }
    return transitionPendingRepoAttempt(step, transition);
  };

  const runPendingRepoEffects = async (
    initial: PendingRepoEffectStep,
  ): Promise<PendingRepoCompletionCommandOutcome> => {
    let step = initial;
    for (;;) {
      const pendingRepoCompletion = pendingRepoCompletionPort();
      if (!pendingRepoCompletion) {
        return {
          kind: 'quarantined',
          message: 'pending-repo completion port disappeared during effect execution',
        };
      }
      let settlement: PendingRepoCompletionEffectSettlement;
      try {
        settlement = {
          kind: 'returned',
          value: await pendingRepoCompletion.execute(step.intent),
        };
      } catch (error) {
        settlement = { kind: 'threw', error };
      }
      const resumed = await commandLane.submit(
        sessionLaneAddress(step.sessionId),
        () => resumePendingRepoAttempt(step, settlement),
      );
      if (resumed.kind === 'pendingRepoEffect') {
        step = resumed;
        continue;
      }
      if (resumed.kind === 'outcome') {
        return resumed.outcome as PendingRepoCompletionCommandOutcome;
      }
      return {
        kind: 'quarantined',
        message: 'pending-repo continuation produced an invalid Runtime transition',
      };
    }
  };

  const joinPendingRepoAttempt = async (
    sessionId: string,
    attempt: PendingRepoAttempt,
  ): Promise<PendingRepoCompletionCommandOutcome> => {
    const terminal = await attempt.terminal;
    if (terminal.kind === 'applied') {
      return {
        kind: 'duplicate',
        state: 'committed',
        sessionId,
        message: 'pending-repo completion joined the winning first start',
      };
    }
    return terminal;
  };

  const submit = async <C extends SessionCommand>(
    request: SessionCommandRequest<C>,
  ): Promise<CommandOutcomeFor<C>> => {
    // A Session-targeted reducer enters the one owner-scoped FIFO lane. The
    // drain is synchronous, so the reducer still finishes before this submit
    // reaches its first await; re-entrant submissions queue behind it.
    const addressSlot = request.target.kind === 'session'
      ? addressSlots.get(request.target.address)
      : undefined;
    const result = addressSlot
      ? await commandLane.submit(
          sessionLaneAddress(addressSlot.sessionId),
          () => run(request as SessionCommandRequest),
        )
      // Keyed route admission has no logical Session until it wins creation.
      // Its dispatch-critical fence remains one synchronous run-to-completion
      // segment; C1 moves route creation behind the lane once identity exists.
      : run(request as SessionCommandRequest);
    if (result.kind === 'outcome') return result.outcome as CommandOutcomeFor<C>;
    if (result.kind === 'ordinaryEffect') {
      return await runOrdinaryEffects(result) as CommandOutcomeFor<C>;
    }
    if (result.kind === 'pendingRepoEffect') {
      return await runPendingRepoEffects(result) as CommandOutcomeFor<C>;
    }
    if (result.kind === 'ordinaryJoin') {
      return await joinOrdinaryAttempt(result.sessionId, result.attempt) as CommandOutcomeFor<C>;
    }
    if (result.kind === 'pendingRepoJoin') {
      return await joinPendingRepoAttempt(result.sessionId, result.attempt) as CommandOutcomeFor<C>;
    }
    if (result.kind === 'ordinaryRetryable') {
      await commandLane.submit(sessionLaneAddress(result.sessionId), () => {
        const current = ordinaryInputs.get(result.ordinaryKey);
        if (current?.state === 'retryable' && current.attempt === result.attempt) {
          ordinaryInputs.delete(result.ordinaryKey);
        }
      });
      return result.outcome as CommandOutcomeFor<C>;
    }
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
