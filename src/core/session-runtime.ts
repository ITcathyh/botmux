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
import type { DashboardSessionSnapshot } from './dashboard-projection.js';
import {
  sessionActorRef,
  type ActorRef,
  type BotId,
} from './bot-identity.js';
import type { ExternalTriggerBusinessInput } from './external-trigger-envelope.js';
import type { DashboardImageUpload } from './dashboard-images.js';
import type { Coworker, CreateSessionColumn, SpawnRole } from './session-create.js';
import type { SessionCliSelectionTarget } from './session-cli-selection.js';
import type { AgentSessionRenameRequest } from './session-rename.js';
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
import {
  scheduledRunId,
  type ScheduledFireEnvelope,
} from './scheduled-fire.js';

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

export type SessionCommandRoute = SessionRoute
  | { kind: 'idempotency'; key: string }
  | { kind: 'schedule'; runId: string };

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
  | { kind: 'list' }
  | { kind: 'dashboardSnapshot' };

export type SessionDirectoryRead =
  | { kind: 'one'; row: SessionDirectoryRow }
  | { kind: 'list'; rows: SessionDirectoryRow[] }
  | { kind: 'dashboardSnapshot'; snapshot: DashboardSessionSnapshot }
  | { kind: 'notFound' }
  | { kind: 'notReady'; message: string };

/** Internal read port. Implementations return detached rows, never Session. */
export interface SessionDirectory {
  read(query: SessionDirectoryQuery): Promise<SessionDirectoryRead>;
}

export interface SessionView {
  address: SessionAddress;
  /** Stable cross-restart owner address; present on I1-bound production Hosts. */
  actorRef?: ActorRef;
  sessionId: string;
  route: SessionRoute;
  recordStatus: SessionDirectoryRow['recordStatus'];
  executorStatus: SessionDirectoryRow['executorStatus'];
}

export type ProjectionResult =
  | { kind: 'one'; session: SessionView }
  | { kind: 'list'; sessions: SessionView[] }
  | { kind: 'dashboardSnapshot'; snapshot: DashboardSessionSnapshot }
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
  ): Promise<KeyedTriggerTurnAcceptResult>;
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

export type ScheduledFireTransitionResult =
  | { readonly kind: 'committed' }
  | {
      readonly kind: 'rejected';
      readonly reason: 'routeBusy' | 'definitionSuperseded';
      readonly message: string;
    }
  | { readonly kind: 'retryable'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string }
  | { readonly kind: 'effect'; readonly intent: unknown; readonly continuation: unknown };

export type ScheduledFireEffectSettlement = OrdinaryIngressEffectSettlement;

/** Current scheduled execution seam. Long Lark/Agent CLI/filesystem effects
 * execute through `execute`, outside the owner-scoped Session lane. */
export interface ScheduledFirePort {
  begin(input: {
    readonly sessionId: string;
    readonly fire: ScheduledFireEnvelope;
  }): ScheduledFireTransitionResult;
  execute(intent: unknown): Promise<unknown>;
  resume(
    continuation: unknown,
    settlement: ScheduledFireEffectSettlement,
  ): ScheduledFireTransitionResult;
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

export type ScheduledFireCommand = {
  kind: 'scheduled.fire';
  input: ScheduledFireEnvelope;
};

/** Validated Dashboard business input. Route ownership and operation identity
 * stay in SessionCommandRequest so callers cannot smuggle a second target. */
export interface DashboardSpawnInput {
  readonly content: string;
  readonly column: CreateSessionColumn;
  readonly role: SpawnRole;
  readonly coworkers: readonly Coworker[];
  readonly images: readonly DashboardImageUpload[];
  readonly postBanner: boolean;
  readonly title?: string;
  readonly ownerOpenId?: string;
  readonly ownerUnionId?: string;
}

export type DashboardSpawnCommand = {
  kind: 'dashboard.spawn';
  input: DashboardSpawnInput;
};

export type PendingRepoCompletionCommand = {
  kind: 'pendingRepo.complete';
  input: PendingRepoCompletionInput;
};

export interface ControlRenameInput {
  title: string;
  /** Optional caller timestamp; Runtime freezes the winning value per idempotency key. */
  updatedAt?: string;
  source: StoredSessionTitleSource;
}

export interface ControlRenameAppliedResult {
  readonly title: string;
  readonly updatedAt: string;
  readonly source: StoredSessionTitleSource;
  readonly agentSync: AgentSessionRenameRequest;
}

export type ControlRenameEffectBeginResult =
  | { readonly kind: 'effect'; readonly intent: unknown }
  | { readonly kind: 'settled'; readonly result: AgentSessionRenameRequest }
  | { readonly kind: 'unknown'; readonly message: string };

/**
 * Owner-bound native Agent rename seam. `begin` executes in the Session lane
 * and must capture the exact Current worker binding. `execute` is the only
 * lane-external native side effect and may consume that opaque intent once.
 */
export interface ControlRenameEffectPort {
  begin(input: {
    readonly sessionId: string;
    readonly operationIdentity: string;
    readonly title: string;
  }): ControlRenameEffectBeginResult;
  execute(intent: unknown): Promise<AgentSessionRenameRequest>;
}

export type ControlRenameCommand = {
  kind: 'control.rename';
  input: ControlRenameInput;
};

export type ControlMutationInput =
  | {
      readonly kind: 'close';
      readonly reason: 'dashboard' | 'cli' | 'prune';
    }
  | {
      readonly kind: 'close';
      readonly reason: 'agentCliMismatch';
      readonly target: SessionCliSelectionTarget;
    }
  | {
      /** A route producer may retire only the exact still-disposable scratch
       * classified under its held owner/route admission capability. */
      readonly kind: 'close';
      readonly reason: 'routeScratch';
      readonly source: 'relocate' | 'scheduler' | 'resume';
      readonly expectedRoute: {
        readonly scope: 'thread' | 'chat';
        readonly canonicalAnchor: string;
        readonly chatId: string;
        readonly chatType: 'group' | 'p2p';
      };
    }
  | {
      readonly kind: 'activateQueued';
      readonly source: 'dashboard';
    }
  | {
      readonly kind: 'reopen';
      readonly source: 'dashboard';
      readonly wake: boolean;
    }
  | {
      readonly kind: 'setBoardPlacement';
      readonly column?: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';
      readonly position?: number;
    }
  | {
      readonly kind: 'setLocked';
      readonly locked: boolean;
    }
  | {
      readonly kind: 'bindWhiteboard';
      readonly whiteboardId: string;
    }
  | {
      readonly kind: 'setChatDisplayName';
      readonly chatDisplayName: string;
    }
  | {
      readonly kind: 'bindOwnerUnionId';
      readonly ownerUnionId: string;
    }
  | {
      readonly kind: 'restart';
      readonly source: 'dashboard';
    }
  | {
      readonly kind: 'suspend';
      readonly source: 'dashboard' | 'hostOverload';
    }
  | {
      /** Move one peer-owned source route into a newly-created flat group. */
      readonly kind: 'relocate';
      readonly sourceAnchor: string;
      readonly targetChatId: string;
      readonly targetRootMessageId: string;
      readonly requester: {
        readonly larkAppId: string;
        readonly openId: string;
        readonly unionId?: string;
      };
    }
  | {
      /** Canonical absolute path already authorized by the transport caller. */
      readonly kind: 'changeWorkingDirectory';
      readonly resolvedPath: string;
    }
  | {
      /** Validated single-line Agent CLI command queued for the current worker. */
      readonly kind: 'injectCommand';
      readonly command: string;
    }
  | {
      /** Poll-side convergence for one already-flagged async turn. */
      readonly kind: 'convergeAsyncTriggerFault';
      readonly triggerId: string;
    };

export type ControlMutationCommand = {
  kind: 'control.mutate';
  input: ControlMutationInput;
};

export interface ControlSessionSnapshot {
  readonly title?: string;
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly workingDir?: string;
  readonly cliId?: string;
}

export type ControlMutationAppliedResult =
  | { readonly kind: 'closed'; readonly alreadyClosed: boolean; readonly known: boolean }
  | {
      readonly kind: 'queuedActivated';
      readonly column?: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';
      readonly queued: false;
    }
  | {
      readonly kind: 'reopened';
      readonly wake: boolean;
      readonly executor: 'lazy' | 'active' | 'deferred' | 'unknown';
      readonly session: ControlSessionSnapshot;
    }
  | {
      readonly kind: 'boardPlacementUpdated';
      readonly column?: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';
      readonly position?: number;
      readonly queued: boolean;
    }
  | { readonly kind: 'lockUpdated'; readonly locked: boolean }
  | { readonly kind: 'whiteboardBound'; readonly whiteboardId: string }
  | { readonly kind: 'chatDisplayNameUpdated'; readonly chatDisplayName: string }
  | { readonly kind: 'ownerUnionIdBound'; readonly ownerUnionId: string }
  | {
      readonly kind: 'restarted';
      readonly revived: boolean;
      readonly session: ControlSessionSnapshot;
    }
  | { readonly kind: 'suspended'; readonly suspended: boolean }
  | {
      readonly kind: 'relocated';
      readonly targetChatId: string;
      readonly targetRootMessageId: string;
    }
  | {
      readonly kind: 'workingDirectoryChanged';
      readonly mode: 'respawn-resume' | 'cold-restart';
      readonly workingDir: string;
    }
  | { readonly kind: 'commandInjected'; readonly command: string }
  | {
      readonly kind: 'asyncTriggerFaultConverged';
      readonly state: 'noChange' | 'failed';
      readonly triggerId: string;
      readonly chatId?: string;
    };

export type ControlMutationTransitionResult =
  | { readonly kind: 'committed'; readonly result: ControlMutationAppliedResult }
  | {
      readonly kind: 'rejected';
      readonly reason: 'sessionNotFound' | 'transitionRejected' | 'invalidCommand';
      readonly message: string;
      readonly code?: string;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'retryable'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string }
  | { readonly kind: 'quarantined'; readonly message: string }
  | { readonly kind: 'staleAddress' }
  | { readonly kind: 'effect'; readonly intent: unknown; readonly continuation: unknown };

export interface ControlMutationPort {
  begin(input: {
    readonly sessionId: string;
    readonly operationIdentity: string;
    readonly command: ControlMutationInput;
    /** Opaque Current route-registry capability. Only route-targeted control
     * orchestration may attach it; storage-agnostic Runtime never inspects it. */
    readonly routeReservation?: unknown;
  }): ControlMutationTransitionResult;
  execute(intent: unknown): Promise<unknown>;
  resume(
    continuation: unknown,
    settlement: ControlMutationEffectSettlement,
  ): ControlMutationTransitionResult;
}

export type ControlMutationEffectSettlement = OrdinaryIngressEffectSettlement;

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
  | ScheduledFireCommand
  | DashboardSpawnCommand
  | PendingRepoCompletionCommand
  | ControlRenameCommand
  | ControlMutationCommand
  | ExecutorInputCommittedCommand;

export interface SessionCommandRequest<C extends SessionCommand = SessionCommand> {
  target:
    | {
        kind: 'session';
        address: SessionAddress;
        /** Opaque transport-to-Current capability for a reserved target route. */
        controlRouteReservation?: unknown;
      }
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

export type ScheduledFireCommandOutcome =
  | {
      kind: 'applied';
      action: 'scheduled.inputAccepted';
      policy: 'scheduled-process-local';
      durability: 'processLocal';
      sessionId: string;
    }
  | {
      kind: 'duplicate';
      state: 'inFlight' | 'inputAccepted';
      policy: 'scheduled-process-local';
      durability: 'processLocal';
      sessionId: string;
      message: string;
    }
  | {
      kind: 'ambiguous';
      state: 'dispatchUnknown';
      policy: 'scheduled-process-local';
      durability: 'processLocal';
      sessionId: string;
      message: string;
      idempotent: boolean;
    }
  | {
      kind: 'rejected';
      reason: 'idempotencyConflict' | 'invalidCommand' | 'routeBusy' | 'definitionSuperseded';
      message: string;
    }
  | { kind: 'staleAddress' }
  | { kind: 'notWired'; command: 'scheduled.fire'; message: string }
  | { kind: 'retryable'; message: string }
  | { kind: 'quarantined'; message: string };

export type DashboardSpawnCommandOutcome =
  | {
      readonly kind: 'applied';
      readonly action: 'dashboard.spawned';
      readonly policy: 'route-staged-opening';
      readonly sessionId: string;
    }
  | {
      readonly kind: 'duplicate';
      readonly state: 'inFlight' | 'routeOpened';
      readonly policy: 'route-staged-opening';
      readonly sessionId: string;
      readonly message: string;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'idempotencyConflict' | 'invalidCommand' | 'sessionExists' | 'transitionRejected';
      readonly message: string;
      readonly code?: string;
    }
  | { readonly kind: 'notWired'; readonly command: 'dashboard.spawn'; readonly message: string }
  | { readonly kind: 'retryable'; readonly message: string }
  | {
      readonly kind: 'ambiguous';
      readonly policy: 'route-staged-opening';
      readonly message: string;
      readonly sessionId?: string;
    }
  | { readonly kind: 'quarantined'; readonly message: string };

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
      updatedAt: string;
      source: StoredSessionTitleSource;
      agentSync: AgentSessionRenameRequest;
    }
  | {
      kind: 'duplicate';
      state: 'received' | 'controlApplied';
      policy: 'control-semantic-transition';
      sessionId: string;
      result?: ControlRenameAppliedResult;
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
      code?: string;
      details?: Readonly<Record<string, unknown>>;
    }
  | { kind: 'staleAddress' }
  | { kind: 'notWired'; command: 'control.rename'; message: string }
  | { kind: 'retryable'; message: string }
  | { kind: 'quarantined'; message: string };

export type ControlMutationCommandOutcome =
  | {
      kind: 'applied';
      action: 'control.mutated';
      policy: 'control-staged-transition';
      sessionId: string;
      result: ControlMutationAppliedResult;
    }
  | {
      kind: 'duplicate';
      state: 'inFlight' | 'controlApplied';
      policy: 'control-staged-transition';
      sessionId: string;
      result?: ControlMutationAppliedResult;
      message: string;
    }
  | {
      kind: 'rejected';
      reason: 'idempotencyConflict' | 'invalidCommand' | 'sessionNotFound' | 'transitionRejected';
      message: string;
      code?: string;
      details?: Readonly<Record<string, unknown>>;
    }
  | { kind: 'staleAddress' }
  | { kind: 'notWired'; command: 'control.mutate'; message: string }
  | { kind: 'retryable'; message: string }
  | {
      kind: 'ambiguous';
      policy: 'control-staged-transition';
      sessionId: string;
      message: string;
    }
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
  | ScheduledFireCommandOutcome
  | DashboardSpawnCommandOutcome
  | PendingRepoCompletionCommandOutcome
  | ControlRenameCommandOutcome
  | ControlMutationCommandOutcome
  | ExecutorInputCommittedCommandOutcome;

export type CommandOutcomeFor<C extends SessionCommand> =
  C extends KeyedTriggerCommand
    ? KeyedTriggerCommandOutcome
    : C extends OrdinaryIngressCommand
      ? OrdinaryIngressCommandOutcome
      : C extends ScheduledFireCommand
        ? ScheduledFireCommandOutcome
        : C extends DashboardSpawnCommand
          ? DashboardSpawnCommandOutcome
          : C extends PendingRepoCompletionCommand
            ? PendingRepoCompletionCommandOutcome
            : C extends ControlRenameCommand
              ? ControlRenameCommandOutcome
              : C extends ControlMutationCommand
                ? ControlMutationCommandOutcome
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

type FrozenControlRenameInput = ControlRenameInput & { readonly updatedAt: string };

function reflectsRename(state: StoredSessionState, input: FrozenControlRenameInput): boolean {
  return state.title === input.title
    && state.titleUpdatedAt === input.updatedAt
    && state.titleSource === input.source;
}

function controlRenameResult(
  state: StoredSessionState,
  input: FrozenControlRenameInput,
): Omit<ControlRenameAppliedResult, 'agentSync'> {
  return {
    title: state.title,
    updatedAt: state.titleUpdatedAt ?? input.updatedAt,
    source: state.titleSource ?? input.source,
  };
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
  /** Stable owner identity. Optional only for pre-I1 test/adapter Hosts. */
  ownerBotId?: BotId;
  directory: SessionDirectory;
  keyedTriggers: KeyedTriggerAuthority;
  keyedTriggerTurns: KeyedTriggerTurnPort;
  ordinaryIngress?: OrdinaryIngressPort;
  scheduledFire?: ScheduledFirePort;
  pendingRepoCompletion?: PendingRepoCompletionPort;
  controlMutation?: ControlMutationPort;
  controlRenameEffect?: ControlRenameEffectPort;
  /** Owner/epoch-stable optional ports used by a composition Host upgrade. */
  portBindings?: {
    ordinaryIngress?: OrdinaryIngressPort;
    scheduledFire?: ScheduledFirePort;
    pendingRepoCompletion?: PendingRepoCompletionPort;
    controlMutation?: ControlMutationPort;
    controlRenameEffect?: ControlRenameEffectPort;
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
        || options.scheduledFire !== undefined
        || options.pendingRepoCompletion !== undefined
        || options.controlMutation !== undefined
        || options.controlRenameEffect !== undefined)) {
    throw new Error('SessionRuntime optional ports must use direct options or one binding slot');
  }
  const ordinaryIngressPort = (): OrdinaryIngressPort | undefined => (
    options.portBindings?.ordinaryIngress ?? options.ordinaryIngress
  );
  const scheduledFirePort = (): ScheduledFirePort | undefined => (
    options.portBindings?.scheduledFire ?? options.scheduledFire
  );
  const pendingRepoCompletionPort = (): PendingRepoCompletionPort | undefined => (
    options.portBindings?.pendingRepoCompletion ?? options.pendingRepoCompletion
  );
  const controlMutationPort = (): ControlMutationPort | undefined => (
    options.portBindings?.controlMutation ?? options.controlMutation
  );
  const controlRenameEffectPort = (): ControlRenameEffectPort | undefined => (
    options.portBindings?.controlRenameEffect ?? options.controlRenameEffect
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
  const activeOrdinaryInputs = new Map<string, Set<string>>();
  interface ScheduledAttempt {
    readonly terminal: Promise<ScheduledFireCommandOutcome>;
    settle(outcome: ScheduledFireCommandOutcome): void;
  }
  type ScheduledFireRecord =
    | { requestHash: string; state: 'received'; attempt: ScheduledAttempt }
    | { requestHash: string; state: 'inputAccepted' }
    | { requestHash: string; state: 'dispatchUnknown'; message: string };
  const scheduledFires = new Map<string, ScheduledFireRecord>();
  const activeScheduledFires = new Map<string, Set<string>>();
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
  interface WaitingControlReservation {
    readonly sessionId: string;
    readonly controlKey: string;
    readonly commandKind: 'control.mutate' | 'control.rename';
    readonly requestHash: string;
    readonly terminal: Promise<void>;
    settle(): void;
  }
  const waitingControlReservations = new Map<string, WaitingControlReservation>();
  interface ControlMutationAttempt {
    readonly terminal: Promise<ControlMutationCommandOutcome>;
    settle(outcome: ControlMutationCommandOutcome): void;
  }
  type ControlMutationRecord =
    | {
        requestHash: string;
        state: 'received';
        attempt: ControlMutationAttempt;
      }
    | {
        requestHash: string;
        state: 'applied';
        result: ControlMutationAppliedResult;
      }
    | {
        requestHash: string;
        state: 'unknown';
        message: string;
      };
  const controlMutations = new Map<string, ControlMutationRecord>();
  const activeControlMutation = new Map<string, string>();
  interface ControlRenameAttempt {
    readonly terminal: Promise<ControlRenameCommandOutcome>;
    settle(outcome: ControlRenameCommandOutcome): void;
  }
  type ControlRenameRecord =
    | {
        requestHash: string;
        sessionId: string;
        updatedAt: string;
        state: 'received';
        attempt: ControlRenameAttempt;
      }
    | {
        requestHash: string;
        sessionId: string;
        updatedAt: string;
        state: 'applied';
        result: ControlRenameAppliedResult;
      }
    | {
        requestHash: string;
        sessionId: string;
        updatedAt: string;
        state: 'unknown';
        message: string;
      };
  const controlCommands = new Map<string, ControlRenameRecord>();
  const activeControlRename = new Map<string, string>();
  const executorCommands = new Map<string, {
    requestHash: string;
    sessionId: string;
    executor: ExecutorAddress;
  }>();
  const sessionCommandIdentities = new Map<string, {
    kind: SessionCommand['kind'];
    requestHash: string;
  }>();
  const scopedCommandKey = (sessionId: string, idempotencyKey: string): string => (
    `${sessionId}\u0000${idempotencyKey}`
  );
  const rememberActiveOrdinaryInput = (sessionId: string, ordinaryKey: string): void => {
    const active = activeOrdinaryInputs.get(sessionId) ?? new Set<string>();
    active.add(ordinaryKey);
    activeOrdinaryInputs.set(sessionId, active);
  };
  const releaseActiveOrdinaryInput = (sessionId: string, ordinaryKey: string): void => {
    const active = activeOrdinaryInputs.get(sessionId);
    if (!active) return;
    active.delete(ordinaryKey);
    if (active.size === 0) activeOrdinaryInputs.delete(sessionId);
  };
  const rememberActiveScheduledFire = (sessionId: string, scheduledKey: string): void => {
    const active = activeScheduledFires.get(sessionId) ?? new Set<string>();
    active.add(scheduledKey);
    activeScheduledFires.set(sessionId, active);
  };
  const releaseActiveScheduledFire = (sessionId: string, scheduledKey: string): void => {
    const active = activeScheduledFires.get(sessionId);
    if (!active) return;
    active.delete(scheduledKey);
    if (active.size === 0) activeScheduledFires.delete(sessionId);
  };
  const createWaitingControlReservation = (input: {
    readonly sessionId: string;
    readonly controlKey: string;
    readonly commandKind: WaitingControlReservation['commandKind'];
    readonly requestHash: string;
  }): WaitingControlReservation => {
    let resolveTerminal!: () => void;
    let settled = false;
    const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve; });
    return {
      ...input,
      terminal,
      settle() {
        if (settled) return;
        settled = true;
        resolveTerminal();
      },
    };
  };
  const releaseWaitingControlReservation = (
    reservation: WaitingControlReservation,
  ): void => {
    if (waitingControlReservations.get(reservation.sessionId) === reservation) {
      waitingControlReservations.delete(reservation.sessionId);
    }
    reservation.settle();
  };

  // Ordinary, scheduled, and pending-repo receipts have downstream evidence
  // beyond this bounded transport window. Control effects do not, so their
  // terminal records deliberately live for the entire Runtime epoch and never
  // enter this eviction queue. Received/active records are never evicted.
  const TERMINAL_IDEMPOTENCY_CAP = 1024;
  const terminalIdempotencyKeys: string[] = [];
  const retainTerminalIdempotency = (key: string): void => {
    terminalIdempotencyKeys.push(key);
    if (terminalIdempotencyKeys.length <= TERMINAL_IDEMPOTENCY_CAP) return;
    const evicted = terminalIdempotencyKeys.splice(
      0,
      terminalIdempotencyKeys.length - TERMINAL_IDEMPOTENCY_CAP,
    );
    for (const old of evicted) {
      const ordinary = ordinaryInputs.get(old);
      if (ordinary
        && (ordinary.state === 'inputCommitted' || ordinary.state === 'commitUnknown')) {
        ordinaryInputs.delete(old);
        sessionCommandIdentities.delete(old);
      }
      const scheduled = scheduledFires.get(old);
      if (scheduled
          && (scheduled.state === 'inputAccepted' || scheduled.state === 'dispatchUnknown')
          && ![...activeScheduledFires.values()].some(active => active.has(old))) {
        scheduledFires.delete(old);
        sessionCommandIdentities.delete(old);
      }
      const completion = pendingRepoCompletions.get(old);
      if (completion
        && (completion.state === 'committed' || completion.state === 'unknown')
        && ![...activePendingRepoCompletion.values()].includes(old)) {
        pendingRepoCompletions.delete(old);
        sessionCommandIdentities.delete(old);
      }
    }
  };

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

  const createScheduledAttempt = (): ScheduledAttempt => {
    let resolveTerminal!: (outcome: ScheduledFireCommandOutcome) => void;
    let settled = false;
    const terminal = new Promise<ScheduledFireCommandOutcome>((resolve) => {
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

  const createControlMutationAttempt = (): ControlMutationAttempt => {
    let resolveTerminal!: (outcome: ControlMutationCommandOutcome) => void;
    let settled = false;
    const terminal = new Promise<ControlMutationCommandOutcome>((resolve) => {
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

  const createControlRenameAttempt = (): ControlRenameAttempt => {
    let resolveTerminal!: (outcome: ControlRenameCommandOutcome) => void;
    let settled = false;
    const terminal = new Promise<ControlRenameCommandOutcome>((resolve) => {
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
    ...(options.ownerBotId === undefined
      ? {}
      : { actorRef: sessionActorRef(options.ownerBotId, row.sessionId) }),
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
      if (result.kind === 'dashboardSnapshot') return result;
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

  interface ScheduledEffectStep {
    readonly kind: 'scheduledEffect';
    readonly sessionId: string;
    readonly scheduledKey: string;
    readonly requestHash: string;
    readonly attempt: ScheduledAttempt;
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

  interface ControlMutationEffectStep {
    readonly kind: 'controlMutationEffect';
    readonly sessionId: string;
    readonly controlKey: string;
    readonly requestHash: string;
    readonly attempt: ControlMutationAttempt;
    readonly intent: unknown;
    readonly continuation: unknown;
  }

  interface ControlRenameEffectStep {
    readonly kind: 'controlRenameEffect';
    readonly sessionId: string;
    readonly controlKey: string;
    readonly requestHash: string;
    readonly attempt: ControlRenameAttempt;
    readonly metadata: Omit<ControlRenameAppliedResult, 'agentSync'>;
    readonly completion: 'applied' | 'duplicate';
    readonly intent: unknown;
  }

  type CriticalResult =
    | { kind: 'outcome'; outcome: CommandOutcome }
    | OrdinaryEffectStep
    | ScheduledEffectStep
    | PendingRepoEffectStep
    | ControlMutationEffectStep
    | ControlRenameEffectStep
    | {
        kind: 'ordinaryJoin';
        sessionId: string;
        attempt: OrdinaryAttempt;
      }
    | {
        kind: 'scheduledJoin';
        sessionId: string;
        attempt: ScheduledAttempt;
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
        kind: 'controlMutationJoin';
        sessionId: string;
        attempt: ControlMutationAttempt;
      }
    | {
        kind: 'controlMutationBarrier';
        sessionId: string;
        attempt: ControlMutationAttempt;
      }
    | {
        kind: 'controlRenameJoin';
        sessionId: string;
        attempt: ControlRenameAttempt;
      }
    | {
        kind: 'controlRenameBarrier';
        sessionId: string;
        attempt: ControlRenameAttempt;
      }
    | {
        kind: 'sessionEffectBarrier';
        sessionId: string;
        predecessors: Promise<unknown>;
        reservation: WaitingControlReservation;
      }
    | {
        kind: 'waitingControlBarrier';
        sessionId: string;
        reservation: WaitingControlReservation;
      }
    | {
        kind: 'failClose';
        token: unknown;
        candidate: PreparedKeyedTriggerTurn;
        outcome: CommandOutcome;
      }
    | {
        kind: 'keyedDispatch';
        candidate: PreparedKeyedTriggerTurn;
        begun: Extract<KeyedTriggerBeginResult, { kind: 'started' }>;
        dispatch: Promise<KeyedTriggerTurnAcceptResult>;
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
      retainTerminalIdempotency(step.ordinaryKey);
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
      retainTerminalIdempotency(step.ordinaryKey);
      terminal = ordinaryAmbiguous(step.sessionId, transition.message, false);
    }
    releaseActiveOrdinaryInput(step.sessionId, step.ordinaryKey);
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
    retainTerminalIdempotency(step.ordinaryKey);
    releaseActiveOrdinaryInput(step.sessionId, step.ordinaryKey);
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

  const scheduledAmbiguous = (
    sessionId: string,
    message: string,
    idempotent: boolean,
  ): ScheduledFireCommandOutcome => ({
    kind: 'ambiguous',
    state: 'dispatchUnknown',
    policy: 'scheduled-process-local',
    durability: 'processLocal',
    sessionId,
    message,
    idempotent,
  });

  const scheduledDuplicate = (sessionId: string): ScheduledFireCommandOutcome => ({
    kind: 'duplicate',
    state: 'inputAccepted',
    policy: 'scheduled-process-local',
    durability: 'processLocal',
    sessionId,
    message: 'scheduled input was already accepted in this runtime epoch',
  });

  const settleScheduledTransition = (
    step: Pick<ScheduledEffectStep, 'sessionId' | 'scheduledKey' | 'requestHash' | 'attempt'>,
    transition: Exclude<ScheduledFireTransitionResult, { kind: 'effect' }>,
  ): CriticalResult => {
    let terminal: ScheduledFireCommandOutcome;
    if (transition.kind === 'committed') {
      scheduledFires.set(step.scheduledKey, {
        requestHash: step.requestHash,
        state: 'inputAccepted',
      });
      retainTerminalIdempotency(step.scheduledKey);
      terminal = {
        kind: 'applied',
        action: 'scheduled.inputAccepted',
        policy: 'scheduled-process-local',
        durability: 'processLocal',
        sessionId: step.sessionId,
      };
    } else if (transition.kind === 'rejected') {
      scheduledFires.delete(step.scheduledKey);
      sessionCommandIdentities.delete(step.scheduledKey);
      terminal = {
        kind: 'rejected',
        reason: transition.reason,
        message: transition.message,
      };
    } else if (transition.kind === 'retryable') {
      scheduledFires.delete(step.scheduledKey);
      sessionCommandIdentities.delete(step.scheduledKey);
      terminal = { kind: 'retryable', message: transition.message };
    } else {
      scheduledFires.set(step.scheduledKey, {
        requestHash: step.requestHash,
        state: 'dispatchUnknown',
        message: transition.message,
      });
      retainTerminalIdempotency(step.scheduledKey);
      terminal = scheduledAmbiguous(step.sessionId, transition.message, false);
    }
    releaseActiveScheduledFire(step.sessionId, step.scheduledKey);
    step.attempt.settle(terminal);
    return outcome(terminal);
  };

  const quarantineScheduledAttempt = (
    step: Pick<ScheduledEffectStep, 'sessionId' | 'scheduledKey' | 'requestHash' | 'attempt'>,
    message: string,
  ): CriticalResult => {
    scheduledFires.set(step.scheduledKey, {
      requestHash: step.requestHash,
      state: 'dispatchUnknown',
      message,
    });
    retainTerminalIdempotency(step.scheduledKey);
    releaseActiveScheduledFire(step.sessionId, step.scheduledKey);
    const terminal: ScheduledFireCommandOutcome = { kind: 'quarantined', message };
    step.attempt.settle(terminal);
    return outcome(terminal);
  };

  const transitionScheduledAttempt = (
    step: Pick<ScheduledEffectStep, 'sessionId' | 'scheduledKey' | 'requestHash' | 'attempt'>,
    transition: ScheduledFireTransitionResult,
  ): CriticalResult => {
    try {
      if (!transition || typeof transition !== 'object') {
        return quarantineScheduledAttempt(step, 'scheduled fire transition is invalid');
      }
      if (transition.kind === 'effect') {
        return {
          ...step,
          kind: 'scheduledEffect',
          intent: transition.intent,
          continuation: transition.continuation,
        };
      }
      if (transition.kind === 'committed') {
        return settleScheduledTransition(step, transition);
      }
      if ((transition.kind === 'rejected'
          || transition.kind === 'retryable'
          || transition.kind === 'unknown')
          && typeof transition.message === 'string') {
        return settleScheduledTransition(step, transition);
      }
      return quarantineScheduledAttempt(step, 'scheduled fire transition is invalid');
    } catch (error) {
      return quarantineScheduledAttempt(
        step,
        `scheduled fire transition could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
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
      retainTerminalIdempotency(step.completionKey);
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
      retainTerminalIdempotency(step.completionKey);
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
    retainTerminalIdempotency(step.completionKey);
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

  const releaseControlMutation = (
    sessionId: string,
    controlKey: string,
  ): void => {
    if (activeControlMutation.get(sessionId) === controlKey) {
      activeControlMutation.delete(sessionId);
    }
  };

  const controlMutationDuplicate = (
    sessionId: string,
    result: ControlMutationAppliedResult,
  ): ControlMutationCommandOutcome => ({
    kind: 'duplicate',
    state: 'controlApplied',
    policy: 'control-staged-transition',
    sessionId,
    result,
    message: 'control mutation was already applied in this Runtime epoch',
  });

  const settleControlMutationTransition = (
    step: Pick<ControlMutationEffectStep, 'sessionId' | 'controlKey' | 'requestHash' | 'attempt'>,
    transition: Exclude<ControlMutationTransitionResult, { kind: 'effect' }>,
  ): CriticalResult => {
    let terminal: ControlMutationCommandOutcome;
    if (transition.kind === 'committed') {
      controlMutations.set(step.controlKey, {
        requestHash: step.requestHash,
        state: 'applied',
        result: transition.result,
      });
      terminal = {
        kind: 'applied',
        action: 'control.mutated',
        policy: 'control-staged-transition',
        sessionId: step.sessionId,
        result: transition.result,
      };
    } else if (transition.kind === 'unknown') {
      controlMutations.set(step.controlKey, {
        requestHash: step.requestHash,
        state: 'unknown',
        message: transition.message,
      });
      terminal = {
        kind: 'ambiguous',
        policy: 'control-staged-transition',
        sessionId: step.sessionId,
        message: transition.message,
      };
    } else {
      controlMutations.delete(step.controlKey);
      sessionCommandIdentities.delete(step.controlKey);
      if (transition.kind === 'rejected') {
        terminal = {
          kind: 'rejected',
          reason: transition.reason,
          message: transition.message,
          ...(transition.code ? { code: transition.code } : {}),
          ...(transition.details ? { details: transition.details } : {}),
        };
      } else if (transition.kind === 'retryable') {
        terminal = transition;
      } else if (transition.kind === 'quarantined') {
        controlMutations.set(step.controlKey, {
          requestHash: step.requestHash,
          state: 'unknown',
          message: transition.message,
        });
        terminal = transition;
      } else {
        terminal = transition;
      }
    }
    if (transition.kind !== 'unknown' && transition.kind !== 'quarantined') {
      releaseControlMutation(step.sessionId, step.controlKey);
    }
    step.attempt.settle(terminal);
    return outcome(terminal);
  };

  const quarantineControlMutationAttempt = (
    step: Pick<ControlMutationEffectStep, 'sessionId' | 'controlKey' | 'requestHash' | 'attempt'>,
    message: string,
  ): CriticalResult => {
    controlMutations.set(step.controlKey, {
      requestHash: step.requestHash,
      state: 'unknown',
      message,
    });
    const terminal: ControlMutationCommandOutcome = { kind: 'quarantined', message };
    step.attempt.settle(terminal);
    return outcome(terminal);
  };

  const transitionControlMutationAttempt = (
    step: Pick<ControlMutationEffectStep, 'sessionId' | 'controlKey' | 'requestHash' | 'attempt'>,
    transition: ControlMutationTransitionResult,
  ): CriticalResult => {
    try {
      if (!transition || typeof transition !== 'object') {
        return quarantineControlMutationAttempt(step, 'control mutation transition is invalid');
      }
      if (transition.kind === 'effect') {
        return {
          ...step,
          kind: 'controlMutationEffect',
          intent: transition.intent,
          continuation: transition.continuation,
        };
      }
      if (transition.kind === 'committed'
        || transition.kind === 'rejected'
        || transition.kind === 'retryable'
        || transition.kind === 'unknown'
        || transition.kind === 'quarantined'
        || transition.kind === 'staleAddress') {
        return settleControlMutationTransition(step, transition);
      }
      return quarantineControlMutationAttempt(step, 'control mutation transition is invalid');
    } catch (error) {
      return quarantineControlMutationAttempt(
        step,
        `control mutation transition could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const releaseControlRename = (sessionId: string, controlKey: string): void => {
    if (activeControlRename.get(sessionId) === controlKey) {
      activeControlRename.delete(sessionId);
    }
  };

  const validAgentRenameResult = (value: unknown): value is AgentSessionRenameRequest => {
    try {
      if (!value || typeof value !== 'object' || nodeUtilTypes.isProxy(value)) return false;
      const result = value as Partial<AgentSessionRenameRequest>;
      if (result.status === 'requested'
        || result.status === 'not_running'
        || result.status === 'unsupported') {
        return result.cliId === undefined || typeof result.cliId === 'string';
      }
      return result.status === 'failed'
        && typeof result.error === 'string'
        && (result.cliId === undefined || typeof result.cliId === 'string');
    } catch {
      return false;
    }
  };

  const settleControlRename = (
    step: Pick<ControlRenameEffectStep,
      'sessionId' | 'controlKey' | 'requestHash' | 'attempt' | 'metadata' | 'completion'>,
    agentSync: AgentSessionRenameRequest,
  ): CriticalResult => {
    const result: ControlRenameAppliedResult = { ...step.metadata, agentSync };
    controlCommands.set(step.controlKey, {
      requestHash: step.requestHash,
      sessionId: step.sessionId,
      updatedAt: result.updatedAt,
      state: 'applied',
      result,
    });
    releaseControlRename(step.sessionId, step.controlKey);
    const terminal: ControlRenameCommandOutcome = step.completion === 'applied'
      ? {
          kind: 'applied',
          action: 'control.renamed',
          policy: 'control-semantic-transition',
          sessionId: step.sessionId,
          ...result,
        }
      : {
          kind: 'duplicate',
          state: 'controlApplied',
          policy: 'control-semantic-transition',
          sessionId: step.sessionId,
          result,
          message: 'rename transition is already reflected by the Current Store',
        };
    step.attempt.settle(terminal);
    return outcome(terminal);
  };

  const settleControlRenameUnknown = (
    step: Pick<ControlRenameEffectStep,
      'sessionId' | 'controlKey' | 'requestHash' | 'attempt' | 'metadata'>,
    message: string,
    kind: 'ambiguous' | 'quarantined' = 'ambiguous',
  ): CriticalResult => {
    controlCommands.set(step.controlKey, {
      requestHash: step.requestHash,
      sessionId: step.sessionId,
      updatedAt: step.metadata.updatedAt,
      state: 'unknown',
      message,
    });
    const terminal: ControlRenameCommandOutcome = kind === 'ambiguous'
      ? {
          kind: 'ambiguous',
          policy: 'control-semantic-transition',
          sessionId: step.sessionId,
          message,
        }
      : { kind: 'quarantined', message };
    step.attempt.settle(terminal);
    return outcome(terminal);
  };

  const beginControlRenameEffect = (
    step: Pick<ControlRenameEffectStep,
      'sessionId' | 'controlKey' | 'requestHash' | 'attempt' | 'metadata' | 'completion'>,
    operationIdentity: string,
  ): CriticalResult => {
    const port = controlRenameEffectPort();
    if (!port) return settleControlRename(step, { status: 'not_running' });
    let begun: ControlRenameEffectBeginResult;
    try {
      begun = invokeSynchronousPort(
        'ControlRenameEffectPort.begin',
        () => port.begin({
          sessionId: step.sessionId,
          operationIdentity,
          title: step.metadata.title,
        }),
      );
    } catch (error) {
      return settleControlRenameUnknown(
        step,
        `native rename preparation outcome is unknown: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      if (!begun || typeof begun !== 'object' || nodeUtilTypes.isProxy(begun)) {
        return settleControlRenameUnknown(step, 'native rename preparation returned an invalid result', 'quarantined');
      }
      if (begun.kind === 'effect') {
        return { ...step, kind: 'controlRenameEffect', intent: begun.intent };
      }
      if (begun.kind === 'settled' && validAgentRenameResult(begun.result)) {
        return settleControlRename(step, begun.result);
      }
      if (begun.kind === 'unknown' && typeof begun.message === 'string') {
        return settleControlRenameUnknown(step, begun.message);
      }
    } catch (error) {
      return settleControlRenameUnknown(
        step,
        `native rename preparation could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
        'quarantined',
      );
    }
    return settleControlRenameUnknown(step, 'native rename preparation returned an invalid result', 'quarantined');
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

  const run = (
    request: SessionCommandRequest,
    ownedWaitingControl?: WaitingControlReservation,
  ): CriticalResult => {
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
    const targetSlot = request.target.kind === 'session'
      ? addressSlots.get(request.target.address)
      : undefined;
    if (targetSlot) {
      const requestKey = scopedCommandKey(targetSlot.sessionId, request.idempotencyKey);
      const controlCommandKind = request.command.kind === 'control.mutate'
        || request.command.kind === 'control.rename'
        ? request.command.kind
        : undefined;
      const isControlCommand = controlCommandKind !== undefined;
      let controlRequestHash: string | undefined;
      if (request.command.kind === 'control.mutate') {
        try {
          controlRequestHash = computeInputHash(request.command.input);
        } catch (error) {
          return outcome({
            kind: 'rejected',
            reason: 'invalidCommand',
            message: `control mutation is not canonicalizable: ${error instanceof Error
              ? error.message
              : String(error)}`,
          });
        }
      } else if (request.command.kind === 'control.rename') {
        try {
          controlRequestHash = computeInputHash({
            title: request.command.input.title,
            source: request.command.input.source,
          });
        } catch (error) {
          return outcome({
            kind: 'rejected',
            reason: 'invalidCommand',
            message: `control rename is not canonicalizable: ${error instanceof Error
              ? error.message
              : String(error)}`,
          });
        }
      }
      const waitingControl = waitingControlReservations.get(targetSlot.sessionId);
      if (ownedWaitingControl) {
        if (waitingControl !== ownedWaitingControl
          || !isControlCommand
          || ownedWaitingControl.controlKey !== requestKey
          || ownedWaitingControl.commandKind !== request.command.kind
          || ownedWaitingControl.requestHash !== controlRequestHash) {
          return outcome({
            kind: 'rejected',
            reason: 'idempotencyConflict',
            message: 'waiting control reservation no longer matches the exact command',
          });
        }
      } else if (waitingControl) {
        if (isControlCommand
          && waitingControl.controlKey === requestKey
          && (waitingControl.commandKind !== request.command.kind
            || waitingControl.requestHash !== controlRequestHash)) {
          return outcome({
            kind: 'rejected',
            reason: 'idempotencyConflict',
            message: 'idempotency key already belongs to a different waiting control command',
          });
        }
        return {
          kind: 'waitingControlBarrier',
          sessionId: targetSlot.sessionId,
          reservation: waitingControl,
        };
      }
      const activeKey = activeControlMutation.get(targetSlot.sessionId);
      if (activeKey && !(request.command.kind === 'control.mutate' && requestKey === activeKey)) {
        const active = controlMutations.get(activeKey);
        if (active?.state === 'unknown') {
          return outcome({
            kind: 'quarantined',
            message: `Session has an unreconciled control mutation: ${active.message}`,
          });
        }
        if (active?.state !== 'received') {
          return outcome({
            kind: 'quarantined',
            message: 'control mutation barrier lost its active Runtime attempt',
          });
        }
        return {
          kind: 'controlMutationBarrier',
          sessionId: targetSlot.sessionId,
          attempt: active.attempt,
        };
      }
      const activeRenameKey = activeControlRename.get(targetSlot.sessionId);
      if (activeRenameKey && !(request.command.kind === 'control.rename' && requestKey === activeRenameKey)) {
        const active = controlCommands.get(activeRenameKey);
        if (active?.state === 'unknown') {
          return outcome({
            kind: 'quarantined',
            message: `Session has an unreconciled native rename: ${active.message}`,
          });
        }
        if (active?.state !== 'received') {
          return outcome({
            kind: 'quarantined',
            message: 'native rename barrier lost its active Runtime attempt',
          });
        }
        return {
          kind: 'controlRenameBarrier',
          sessionId: targetSlot.sessionId,
          attempt: active.attempt,
        };
      }
      if (isControlCommand && !ownedWaitingControl) {
        const activeTerminals: Promise<unknown>[] = [];
        for (const activeOrdinaryKey of activeOrdinaryInputs.get(targetSlot.sessionId) ?? []) {
          const active = ordinaryInputs.get(activeOrdinaryKey);
          if (active?.state !== 'received') {
            return outcome({
              kind: 'quarantined',
              message: 'ordinary ingress barrier lost its active Runtime attempt',
            });
          }
          activeTerminals.push(active.attempt.terminal);
        }
        for (const activeScheduledKey of activeScheduledFires.get(targetSlot.sessionId) ?? []) {
          const active = scheduledFires.get(activeScheduledKey);
          if (active?.state !== 'received') {
            return outcome({
              kind: 'quarantined',
              message: 'scheduled fire barrier lost its active Runtime attempt',
            });
          }
          activeTerminals.push(active.attempt.terminal);
        }
        const activePendingRepoKey = activePendingRepoCompletion.get(targetSlot.sessionId);
        if (activePendingRepoKey) {
          const active = pendingRepoCompletions.get(activePendingRepoKey);
          if (active?.state !== 'received') {
            return outcome({
              kind: 'quarantined',
              message: 'pending-repo completion barrier lost its active Runtime attempt',
            });
          }
          activeTerminals.push(active.attempt.terminal);
        }
        if (activeTerminals.length > 0) {
          const reservation = createWaitingControlReservation({
            sessionId: targetSlot.sessionId,
            controlKey: requestKey,
            commandKind: controlCommandKind!,
            requestHash: controlRequestHash!,
          });
          waitingControlReservations.set(targetSlot.sessionId, reservation);
          return {
            kind: 'sessionEffectBarrier',
            sessionId: targetSlot.sessionId,
            predecessors: Promise.all(activeTerminals),
            reservation,
          };
        }
      }
    }
    if (request.command.kind === 'control.mutate') {
      const controlInput = request.command.input;
      if (request.target.kind !== 'session') {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: 'control mutation requires an address resolved by this SessionRuntime epoch',
        });
      }
      const slot = addressSlots.get(request.target.address)!;
      const port = controlMutationPort();
      if (!port) {
        return outcome({
          kind: 'notWired',
          command: 'control.mutate',
          message: 'control mutations are not connected to this Current SessionRuntime host',
        });
      }
      let requestHash: string;
      try {
        requestHash = computeInputHash(controlInput);
      } catch (error) {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: `control mutation is not canonicalizable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const controlKey = scopedCommandKey(slot.sessionId, request.idempotencyKey);
      const prior = controlMutations.get(controlKey);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          return outcome({
            kind: 'rejected',
            reason: 'idempotencyConflict',
            message: 'idempotency key already used with a different control mutation',
          });
        }
        if (prior.state === 'received') {
          return {
            kind: 'controlMutationJoin',
            sessionId: slot.sessionId,
            attempt: prior.attempt,
          };
        }
        if (prior.state === 'unknown') {
          return outcome({
            kind: 'ambiguous',
            policy: 'control-staged-transition',
            sessionId: slot.sessionId,
            message: prior.message,
          });
        }
        return outcome(controlMutationDuplicate(slot.sessionId, prior.result));
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
        sessionCommandIdentities.set(controlKey, {
          kind: request.command.kind,
          requestHash,
        });
      }
      const attempt = createControlMutationAttempt();
      controlMutations.set(controlKey, { requestHash, state: 'received', attempt });
      activeControlMutation.set(slot.sessionId, controlKey);
      const step = { sessionId: slot.sessionId, controlKey, requestHash, attempt };
      let transition: ControlMutationTransitionResult;
      try {
        transition = invokeSynchronousPort(
          'ControlMutationPort.begin',
          () => port.begin({
            sessionId: slot.sessionId,
            operationIdentity: request.idempotencyKey,
            command: controlInput,
            ...(request.target.kind !== 'session'
              || request.target.controlRouteReservation === undefined
              ? {}
              : { routeReservation: request.target.controlRouteReservation }),
          }),
        );
      } catch (error) {
        return quarantineControlMutationAttempt(
          step,
          error instanceof Error ? error.message : String(error),
        );
      }
      return transitionControlMutationAttempt(step, transition);
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
      const renameCommandInput = request.command.input;
      if (!options.sessionStore) {
        return outcome({
          kind: 'notWired',
          command: 'control.rename',
          message: 'control rename is not connected to a SessionStore in this Current host',
        });
      }
      let requestHash: string;
      try {
        requestHash = computeInputHash({
          title: renameCommandInput.title,
          source: renameCommandInput.source,
        });
      } catch (error) {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: `control command is not canonicalizable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const controlKey = scopedCommandKey(slot.sessionId, request.idempotencyKey);
      const priorCommand = controlCommands.get(controlKey);
      const suppliedTimestamp = renameCommandInput.updatedAt;
      const updatedAt = priorCommand?.updatedAt
        ?? (suppliedTimestamp && Number.isFinite(Date.parse(suppliedTimestamp))
          ? suppliedTimestamp
          : new Date().toISOString());
      const renameInput: FrozenControlRenameInput = {
        title: renameCommandInput.title,
        source: renameCommandInput.source,
        updatedAt,
      };
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
        return {
          kind: 'controlRenameJoin',
          sessionId: slot.sessionId,
          attempt: priorCommand.attempt,
        };
      }
      if (priorCommand?.state === 'applied') {
        return outcome({
          kind: 'duplicate',
          state: 'controlApplied',
          policy: 'control-semantic-transition',
          sessionId: slot.sessionId,
          result: priorCommand.result,
          message: 'rename transition is already reflected by the Current Store',
        });
      }
      if (priorCommand?.state === 'unknown') {
        return outcome({
          kind: 'ambiguous',
          policy: 'control-semantic-transition',
          sessionId: slot.sessionId,
          message: priorCommand.message,
        });
      }
      const attempt = createControlRenameAttempt();
      controlCommands.set(controlKey, {
        requestHash,
        sessionId: slot.sessionId,
        updatedAt,
        state: 'received',
        attempt,
      });
      activeControlRename.set(slot.sessionId, controlKey);
      const releaseWith = (
        terminal: ControlRenameCommandOutcome,
        retainUnknown = false,
      ): CriticalResult => {
        if (retainUnknown) {
          controlCommands.set(controlKey, {
            requestHash,
            sessionId: slot.sessionId,
            updatedAt,
            state: 'unknown',
            message: 'message' in terminal ? terminal.message : 'rename outcome is unknown',
          });
        } else {
          controlCommands.delete(controlKey);
        }
        if (!retainUnknown) releaseControlRename(slot.sessionId, controlKey);
        attempt.settle(terminal);
        return outcome(terminal);
      };
      const beginNativeEffect = (
        state: StoredSessionState,
        completion: 'applied' | 'duplicate',
      ): CriticalResult => beginControlRenameEffect({
        sessionId: slot.sessionId,
        controlKey,
        requestHash,
        attempt,
        metadata: controlRenameResult(state, renameInput),
        completion,
      }, request.idempotencyKey);
      let loaded: ReturnType<SessionStore['load']>;
      try {
        loaded = invokeSynchronousPort(
          'SessionStore.load',
          () => options.sessionStore!.load(slot.sessionId),
        );
      } catch (error) {
        return releaseWith({
          kind: 'quarantined',
          message: `SessionStore load failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (loaded.kind === 'notFound') {
        return releaseWith({
          kind: 'rejected',
          reason: 'sessionNotFound',
          message: 'Session is not present in the Current Store',
        });
      }
      if (loaded.kind === 'unavailable') {
        return releaseWith({ kind: 'retryable', message: loaded.message });
      }
      if (loaded.kind === 'corrupt' || loaded.kind === 'futureVersion') {
        return releaseWith({ kind: 'quarantined', message: loaded.message });
      }
      if (reflectsRename(loaded.state, renameInput)) {
        return beginNativeEffect(loaded.state, 'duplicate');
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
        return releaseWith({
          kind: 'quarantined',
          message: `SessionStore apply failed outside its typed contract: ${error instanceof Error ? error.message : String(error)}`,
        }, true);
      }
      if (applied.kind === 'applied') {
        return beginNativeEffect(applied.state, 'applied');
      }
      if (applied.kind === 'conflict') {
        if (applied.current && reflectsRename(applied.current.state, renameInput)) {
          return beginNativeEffect(applied.current.state, 'duplicate');
        }
        return releaseWith({
          kind: 'retryable',
          message: 'SessionStore version conflict; retry the same rename command',
        });
      }
      if (applied.kind === 'rejected') {
        return releaseWith({
          kind: 'rejected',
          reason: 'transitionRejected',
          message: applied.message,
        });
      }
      if (applied.kind === 'notApplied') {
        return releaseWith({ kind: 'retryable', message: applied.message });
      }
      let readback: ReturnType<SessionStore['load']>;
      try {
        readback = invokeSynchronousPort(
          'SessionStore.load',
          () => options.sessionStore!.load(slot.sessionId),
        );
      } catch (error) {
        return releaseWith({
          kind: 'ambiguous',
          policy: 'control-semantic-transition',
          sessionId: slot.sessionId,
          message: `${applied.message}; strict readback failed: ${error instanceof Error ? error.message : String(error)}`,
        }, true);
      }
      if (readback.kind === 'loaded' && reflectsRename(readback.state, renameInput)) {
        return beginNativeEffect(readback.state, 'applied');
      }
      if (readback.kind === 'corrupt' || readback.kind === 'futureVersion') {
        return releaseWith({ kind: 'quarantined', message: readback.message }, true);
      }
      return releaseWith({
        kind: 'ambiguous',
        policy: 'control-semantic-transition',
        sessionId: slot.sessionId,
        message: applied.message,
      }, true);
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
    if (request.command.kind === 'scheduled.fire') {
      if (request.target.kind !== 'session') {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: 'scheduled fire requires an address resolved by this SessionRuntime epoch',
        });
      }
      const slot = addressSlots.get(request.target.address)!;
      const fire = request.command.input;
      let canonicalRunId: string;
      try {
        canonicalRunId = scheduledRunId(fire.identity);
      } catch (error) {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: `scheduled identity is invalid: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (request.idempotencyKey !== fire.runId || fire.runId !== canonicalRunId) {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: 'scheduled idempotency key must equal the unchanged logical run id',
        });
      }
      if (fire.task.id !== fire.identity.scheduleId) {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: 'scheduled task snapshot does not match the logical run identity',
        });
      }
      const port = scheduledFirePort();
      if (!port) {
        return outcome({
          kind: 'notWired',
          command: 'scheduled.fire',
          message: 'scheduled execution is not connected to this Current SessionRuntime host',
        });
      }
      let requestHash: string;
      try {
        requestHash = computeInputHash(fire);
      } catch (error) {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: `scheduled fire is not canonicalizable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const scheduledKey = scopedCommandKey(slot.sessionId, request.idempotencyKey);
      const prior = scheduledFires.get(scheduledKey);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          return outcome({
            kind: 'rejected',
            reason: 'idempotencyConflict',
            message: 'logical run id already belongs to a different scheduled fire',
          });
        }
        if (prior.state === 'received') {
          return { kind: 'scheduledJoin', sessionId: slot.sessionId, attempt: prior.attempt };
        }
        if (prior.state === 'dispatchUnknown') {
          return outcome(scheduledAmbiguous(slot.sessionId, prior.message, true));
        }
        return outcome(scheduledDuplicate(slot.sessionId));
      }
      const existingIdentity = sessionCommandIdentities.get(scheduledKey);
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
        sessionCommandIdentities.set(scheduledKey, {
          kind: request.command.kind,
          requestHash,
        });
      }
      const attempt = createScheduledAttempt();
      scheduledFires.set(scheduledKey, { requestHash, state: 'received', attempt });
      rememberActiveScheduledFire(slot.sessionId, scheduledKey);
      const step = { sessionId: slot.sessionId, scheduledKey, requestHash, attempt };
      let transition: ScheduledFireTransitionResult;
      try {
        transition = invokeSynchronousPort(
          'ScheduledFirePort.begin',
          () => port.begin({ sessionId: slot.sessionId, fire }),
        );
      } catch (error) {
        return quarantineScheduledAttempt(
          step,
          error instanceof Error ? error.message : String(error),
        );
      }
      return transitionScheduledAttempt(step, transition);
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
      rememberActiveOrdinaryInput(slot.sessionId, ordinaryKey);
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
    if (request.command.kind === 'dashboard.spawn') {
      if (request.target.kind !== 'route'
          || request.target.route.kind === 'idempotency'
          || request.target.route.kind === 'schedule') {
        return outcome({
          kind: 'rejected',
          reason: 'invalidCommand',
          message: 'Dashboard spawn requires one concrete route target',
        });
      }
      return outcome({
        kind: 'notWired',
        command: 'dashboard.spawn',
        message: 'Dashboard route opening is not connected to this SessionRuntime host',
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

    let dispatch: Promise<KeyedTriggerTurnAcceptResult>;
    try {
      dispatch = Promise.resolve(options.keyedTriggerTurns.acceptAtMostOnce(candidate.token, {
        key: request.idempotencyKey,
        pendingCreatedAt: begun.pendingCreatedAt,
      }));
    } catch (error) {
      dispatch = Promise.reject(error);
    }
    return { kind: 'keyedDispatch', candidate, begun, dispatch };
  };

  const settleKeyedDispatchFailure = (
    candidate: PreparedKeyedTriggerTurn,
    begun: Extract<KeyedTriggerBeginResult, { kind: 'started' }>,
    dispatchError: unknown,
  ): CriticalResult => {
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
  };

  const keyedDispatchApplied = (
    candidate: PreparedKeyedTriggerTurn,
  ): CriticalResult => outcome({
      kind: 'applied',
      action: 'keyedTrigger.started',
      sessionId: candidate.sessionId,
      triggerId: candidate.triggerId,
      chatId: candidate.chatId,
    });

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

  const resumeScheduledAttempt = (
    step: ScheduledEffectStep,
    settlement: ScheduledFireEffectSettlement,
  ): CriticalResult => {
    const current = scheduledFires.get(step.scheduledKey);
    if (current?.state !== 'received' || current.attempt !== step.attempt) {
      return quarantineScheduledAttempt(
        step,
        'scheduled fire continuation no longer owns the Current attempt',
      );
    }
    const port = scheduledFirePort();
    if (!port) {
      return quarantineScheduledAttempt(
        step,
        'scheduled fire port disappeared during an in-flight attempt',
      );
    }
    let transition: ScheduledFireTransitionResult;
    try {
      transition = invokeSynchronousPort(
        'ScheduledFirePort.resume',
        () => port.resume(step.continuation, settlement),
      );
    } catch (error) {
      return quarantineScheduledAttempt(
        step,
        error instanceof Error ? error.message : String(error),
      );
    }
    return transitionScheduledAttempt(step, transition);
  };

  const runScheduledEffects = async (
    initial: ScheduledEffectStep,
  ): Promise<ScheduledFireCommandOutcome> => {
    let step = initial;
    for (;;) {
      const port = scheduledFirePort();
      if (!port) {
        const resumed = await commandLane.submit(
          sessionLaneAddress(step.sessionId),
          () => quarantineScheduledAttempt(
            step,
            'scheduled fire port disappeared during effect execution',
          ),
        );
        return resumed.kind === 'outcome'
          ? resumed.outcome as ScheduledFireCommandOutcome
          : { kind: 'quarantined', message: 'scheduled fire port disappearance did not settle' };
      }
      let settlement: ScheduledFireEffectSettlement;
      try {
        settlement = { kind: 'returned', value: await port.execute(step.intent) };
      } catch (error) {
        settlement = { kind: 'threw', error };
      }
      const resumed = await commandLane.submit(
        sessionLaneAddress(step.sessionId),
        () => resumeScheduledAttempt(step, settlement),
      );
      if (resumed.kind === 'scheduledEffect') {
        step = resumed;
        continue;
      }
      if (resumed.kind === 'outcome') {
        return resumed.outcome as ScheduledFireCommandOutcome;
      }
      return {
        kind: 'quarantined',
        message: 'scheduled fire continuation produced an invalid Runtime transition',
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

  const keyedSubmissionTails = new Map<string, Promise<void>>();

  const resumeControlMutationAttempt = (
    step: ControlMutationEffectStep,
    settlement: ControlMutationEffectSettlement,
  ): CriticalResult => {
    const current = controlMutations.get(step.controlKey);
    if (current?.state !== 'received' || current.attempt !== step.attempt) {
      return quarantineControlMutationAttempt(
        step,
        'control mutation continuation no longer owns the Current attempt',
      );
    }
    const port = controlMutationPort();
    if (!port) {
      return quarantineControlMutationAttempt(
        step,
        'control mutation port disappeared during an in-flight attempt',
      );
    }
    let transition: ControlMutationTransitionResult;
    try {
      transition = invokeSynchronousPort(
        'ControlMutationPort.resume',
        () => port.resume(step.continuation, settlement),
      );
    } catch (error) {
      return quarantineControlMutationAttempt(
        step,
        error instanceof Error ? error.message : String(error),
      );
    }
    return transitionControlMutationAttempt(step, transition);
  };

  const runControlMutationEffects = async (
    initial: ControlMutationEffectStep,
  ): Promise<ControlMutationCommandOutcome> => {
    let step = initial;
    for (;;) {
      const port = controlMutationPort();
      if (!port) {
        const resumed = await commandLane.submit(
          sessionLaneAddress(step.sessionId),
          () => quarantineControlMutationAttempt(
            step,
            'control mutation port disappeared during effect execution',
          ),
        );
        return resumed.kind === 'outcome'
          ? resumed.outcome as ControlMutationCommandOutcome
          : { kind: 'quarantined', message: 'control mutation port disappearance did not settle' };
      }
      let settlement: ControlMutationEffectSettlement;
      try {
        settlement = { kind: 'returned', value: await port.execute(step.intent) };
      } catch (error) {
        settlement = { kind: 'threw', error };
      }
      const resumed = await commandLane.submit(
        sessionLaneAddress(step.sessionId),
        () => resumeControlMutationAttempt(step, settlement),
      );
      if (resumed.kind === 'controlMutationEffect') {
        step = resumed;
        continue;
      }
      if (resumed.kind === 'outcome') {
        return resumed.outcome as ControlMutationCommandOutcome;
      }
      return {
        kind: 'quarantined',
        message: 'control mutation continuation produced an invalid Runtime transition',
      };
    }
  };

  const runControlRenameEffect = async (
    step: ControlRenameEffectStep,
  ): Promise<ControlRenameCommandOutcome> => {
    const port = controlRenameEffectPort();
    if (!port) {
      const resumed = await commandLane.submit(
        sessionLaneAddress(step.sessionId),
        () => settleControlRenameUnknown(
          step,
          'native rename effect port disappeared during execution',
          'quarantined',
        ),
      );
      return resumed.kind === 'outcome'
        ? resumed.outcome as ControlRenameCommandOutcome
        : { kind: 'quarantined', message: 'native rename port disappearance did not settle' };
    }
    let settlement:
      | { readonly kind: 'returned'; readonly value: unknown }
      | { readonly kind: 'threw'; readonly error: unknown };
    try {
      settlement = { kind: 'returned', value: await port.execute(step.intent) };
    } catch (error) {
      settlement = { kind: 'threw', error };
    }
    const resumed = await commandLane.submit(
      sessionLaneAddress(step.sessionId),
      () => settlement.kind === 'threw'
        ? settleControlRenameUnknown(
            step,
            `native rename effect outcome is unknown: ${settlement.error instanceof Error
              ? settlement.error.message
              : String(settlement.error)}`,
          )
        : validAgentRenameResult(settlement.value)
          ? settleControlRename(step, settlement.value)
          : settleControlRenameUnknown(
              step,
              'native rename effect returned an invalid result',
              'quarantined',
            ),
    );
    return resumed.kind === 'outcome'
      ? resumed.outcome as ControlRenameCommandOutcome
      : { kind: 'quarantined', message: 'native rename effect did not settle through its Session lane' };
  };

  const joinControlMutationAttempt = async (
    sessionId: string,
    attempt: ControlMutationAttempt,
  ): Promise<ControlMutationCommandOutcome> => {
    const terminal = await attempt.terminal;
    if (terminal.kind === 'applied') {
      return {
        kind: 'duplicate',
        state: 'inFlight',
        policy: 'control-staged-transition',
        sessionId,
        result: terminal.result,
        message: 'control mutation joined the winning in-flight transition',
      };
    }
    return terminal;
  };

  const joinControlRenameAttempt = async (
    sessionId: string,
    attempt: ControlRenameAttempt,
  ): Promise<ControlRenameCommandOutcome> => {
    const terminal = await attempt.terminal;
    if (terminal.kind !== 'applied') return terminal;
    return {
      kind: 'duplicate',
      state: 'controlApplied',
      policy: 'control-semantic-transition',
      sessionId,
      result: {
        title: terminal.title,
        updatedAt: terminal.updatedAt,
        source: terminal.source,
        agentSync: terminal.agentSync,
      },
      message: 'rename transition joined the winning native effect',
    };
  };

  interface SubmitContext {
    readonly keyedSerialized?: true;
    readonly ownedWaitingControl?: WaitingControlReservation;
  }

  const submit = async <C extends SessionCommand>(
    request: SessionCommandRequest<C>,
    context: SubmitContext = {},
  ): Promise<CommandOutcomeFor<C>> => {
    if (!context.keyedSerialized
        && request.command.kind === 'keyedTrigger.start'
        && request.target.kind === 'route'
        && request.target.route.kind === 'idempotency') {
      const key = request.target.route.key;
      const prior = keyedSubmissionTails.get(key);
      let release!: () => void;
      const tail = new Promise<void>((resolve) => { release = resolve; });
      keyedSubmissionTails.set(key, tail);
      try {
        if (prior) await prior.catch(() => undefined);
        return await submit(request, { ...context, keyedSerialized: true });
      } finally {
        release();
        if (keyedSubmissionTails.get(key) === tail) keyedSubmissionTails.delete(key);
      }
    }
    // A Session-targeted reducer enters the one owner-scoped FIFO lane. The
    // drain is synchronous, so the reducer still finishes before this submit
    // reaches its first await; re-entrant submissions queue behind it.
    const addressSlot = request.target.kind === 'session'
      ? addressSlots.get(request.target.address)
      : undefined;
    const ownedWaitingControl = context.ownedWaitingControl;
    const laneSessionId = addressSlot?.sessionId ?? ownedWaitingControl?.sessionId;
    const enterLane = (): CriticalResult => {
      const result = run(request as SessionCommandRequest, ownedWaitingControl);
      if (ownedWaitingControl
        && result.kind !== 'controlMutationBarrier'
        && result.kind !== 'controlRenameBarrier'
        && result.kind !== 'sessionEffectBarrier'
        && result.kind !== 'waitingControlBarrier') {
        releaseWaitingControlReservation(ownedWaitingControl);
      }
      return result;
    };
    let result = laneSessionId
      ? await commandLane.submit(
          sessionLaneAddress(laneSessionId),
          enterLane,
        )
      // Keyed route admission has no logical Session until it wins creation.
      // Its dispatch-critical fence remains one synchronous run-to-completion
      // segment; C1 moves route creation behind the lane once identity exists.
      : enterLane();
    if (result.kind === 'keyedDispatch') {
      const keyed = result;
      try {
        const accepted = await keyed.dispatch;
        result = accepted.kind === 'accepted'
          ? keyedDispatchApplied(keyed.candidate)
          : settleKeyedDispatchFailure(keyed.candidate, keyed.begun, new Error(accepted.message));
      } catch (error) {
        result = settleKeyedDispatchFailure(keyed.candidate, keyed.begun, error);
      }
    }
    if (result.kind === 'keyedDispatch') {
      throw new Error('keyed dispatch settlement did not reach a terminal state');
    }
    if (result.kind === 'outcome') return result.outcome as CommandOutcomeFor<C>;
    if (result.kind === 'ordinaryEffect') {
      return await runOrdinaryEffects(result) as CommandOutcomeFor<C>;
    }
    if (result.kind === 'scheduledEffect') {
      return await runScheduledEffects(result) as CommandOutcomeFor<C>;
    }
    if (result.kind === 'pendingRepoEffect') {
      return await runPendingRepoEffects(result) as CommandOutcomeFor<C>;
    }
    if (result.kind === 'controlMutationEffect') {
      return await runControlMutationEffects(result) as CommandOutcomeFor<C>;
    }
    if (result.kind === 'controlRenameEffect') {
      return await runControlRenameEffect(result) as CommandOutcomeFor<C>;
    }
    if (result.kind === 'ordinaryJoin') {
      return await joinOrdinaryAttempt(result.sessionId, result.attempt) as CommandOutcomeFor<C>;
    }
    if (result.kind === 'scheduledJoin') {
      const terminal = await result.attempt.terminal;
      if (terminal.kind === 'applied') {
        return scheduledDuplicate(result.sessionId) as CommandOutcomeFor<C>;
      }
      if (terminal.kind === 'ambiguous') {
        return { ...terminal, idempotent: true } as CommandOutcomeFor<C>;
      }
      return terminal as CommandOutcomeFor<C>;
    }
    if (result.kind === 'pendingRepoJoin') {
      return await joinPendingRepoAttempt(result.sessionId, result.attempt) as CommandOutcomeFor<C>;
    }
    if (result.kind === 'controlMutationJoin') {
      return await joinControlMutationAttempt(result.sessionId, result.attempt) as CommandOutcomeFor<C>;
    }
    if (result.kind === 'controlRenameJoin') {
      return await joinControlRenameAttempt(result.sessionId, result.attempt) as CommandOutcomeFor<C>;
    }
    if (result.kind === 'controlMutationBarrier') {
      await result.attempt.terminal;
      return await submit(request, context);
    }
    if (result.kind === 'controlRenameBarrier') {
      await result.attempt.terminal;
      return await submit(request, context);
    }
    if (result.kind === 'sessionEffectBarrier') {
      await result.predecessors;
      return await submit(request, {
        ...context,
        ownedWaitingControl: result.reservation,
      });
    }
    if (result.kind === 'waitingControlBarrier') {
      await result.reservation.terminal;
      return await submit(request, {
        ...(context.keyedSerialized ? { keyedSerialized: true } : {}),
      });
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
