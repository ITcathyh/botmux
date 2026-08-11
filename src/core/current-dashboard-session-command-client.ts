/**
 * Host-scoped Dashboard command client.
 *
 * External Session IDs are transport selectors, not Runtime addresses. This
 * client owns their process-epoch operation receipts so a retry is recognized
 * before projection lookup (including after a successful close removes the
 * Session). Route-target commands keep their own admission/receipt policy in
 * the Current route registry and are delegated unchanged.
 */

import { computeInputHash } from '../utils/canonical-input-hash.js';
import { withBotTurnAdmission } from './bot-turn-mutation-gate.js';
import type { CurrentSessionRuntimeHost } from './current-session-runtime.js';
import type {
  CommandOutcomeFor,
  ControlMutationCommand,
  ControlMutationCommandOutcome,
  ControlRenameCommand,
  ControlRenameCommandOutcome,
  DashboardSpawnCommand,
  SessionRoute,
} from './session-runtime.js';

export type CurrentDashboardSessionRuntimeCommand =
  | ControlMutationCommand
  | ControlRenameCommand
  | DashboardSpawnCommand;

export type CurrentDashboardSessionRuntimeTarget =
  | { readonly kind: 'externalSession'; readonly sessionId: string }
  | { readonly kind: 'route'; readonly route: SessionRoute };

export type CurrentDashboardSessionCommandSubmitter =
  <C extends CurrentDashboardSessionRuntimeCommand>(input: {
    readonly target: CurrentDashboardSessionRuntimeTarget;
    readonly idempotencyKey: string;
    readonly command: C;
  }) => Promise<CommandOutcomeFor<C>>;

type ExternalCommand = ControlMutationCommand | ControlRenameCommand;
type ExternalOutcome = ControlMutationCommandOutcome | ControlRenameCommandOutcome;

type ExternalAttempt =
  | {
      readonly requestHash: string;
      readonly state: 'running';
      readonly terminal: Promise<ExternalOutcome>;
    }
  | {
      readonly requestHash: string;
      readonly state: 'terminal';
      readonly outcome: ExternalOutcome;
    }
  | {
      readonly requestHash: string;
      readonly state: 'retryable';
    };

function operationKey(sessionId: string, idempotencyKey: string): string {
  return `${sessionId}\0${idempotencyKey}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outcomeIsRetryable(outcome: ExternalOutcome): boolean {
  return outcome.kind === 'retryable'
    || outcome.kind === 'notWired'
    || outcome.kind === 'staleAddress'
    || (outcome.kind === 'rejected'
      && outcome.reason === 'transitionRejected'
      && outcome.code === 'session_transferring');
}

function replayOutcome(
  command: ExternalCommand,
  sessionId: string,
  outcome: ExternalOutcome,
): ExternalOutcome {
  if (outcome.kind !== 'applied') return outcome;
  if (command.kind === 'control.rename') {
    const renamed = outcome as Extract<ControlRenameCommandOutcome, { kind: 'applied' }>;
    return {
      kind: 'duplicate',
      state: 'controlApplied',
      policy: 'control-semantic-transition',
      sessionId,
      result: {
        title: renamed.title,
        updatedAt: renamed.updatedAt,
        source: renamed.source,
        agentSync: renamed.agentSync,
      },
      message: 'Dashboard rename operation already completed in this daemon epoch',
    };
  }
  const mutated = outcome as Extract<ControlMutationCommandOutcome, { kind: 'applied' }>;
  return {
    kind: 'duplicate',
    state: 'controlApplied',
    policy: 'control-staged-transition',
    sessionId,
    result: mutated.result,
    message: 'Dashboard control operation already completed in this daemon epoch',
  };
}

function conflictOutcome(): ExternalOutcome {
  return {
    kind: 'rejected',
    reason: 'idempotencyConflict',
    message: 'Dashboard operation identity already belongs to different semantic input',
  };
}

function invalidOutcome(error: unknown): ExternalOutcome {
  return {
    kind: 'rejected',
    reason: 'invalidCommand',
    message: `Dashboard command is not canonicalizable: ${message(error)}`,
  };
}

async function executeExternal(
  hostForAttempt: () => CurrentSessionRuntimeHost,
  input: {
    readonly target: Extract<CurrentDashboardSessionRuntimeTarget, { kind: 'externalSession' }>;
    readonly idempotencyKey: string;
    readonly command: ExternalCommand;
  },
): Promise<ExternalOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let host: CurrentSessionRuntimeHost;
    try {
      host = hostForAttempt();
    } catch (error) {
      return {
        kind: 'retryable',
        message: `Dashboard SessionRuntime host is not ready: ${message(error)}`,
      };
    }

    let projected: Awaited<ReturnType<CurrentSessionRuntimeHost['projection']['read']>>;
    try {
      projected = await host.projection.read({
        kind: 'byExternalSession',
        sessionId: input.target.sessionId,
      });
    } catch (error) {
      return {
        kind: 'retryable',
        message: `Dashboard Session projection failed before dispatch: ${message(error)}`,
      };
    }

    if (projected.kind === 'notFound') {
      if (input.command.kind === 'control.mutate'
          && input.command.input.kind === 'close') {
        return {
          kind: 'applied',
          action: 'control.mutated',
          policy: 'control-staged-transition',
          sessionId: input.target.sessionId,
          result: { kind: 'closed', alreadyClosed: true, known: false },
        };
      }
      return {
        kind: 'rejected',
        reason: 'sessionNotFound',
        message: 'Session is not owned by this Runtime Host',
      };
    }
    if (projected.kind === 'notReady') {
      return { kind: 'retryable', message: projected.message };
    }
    if (projected.kind !== 'one') {
      return {
        kind: 'quarantined',
        message: 'Session projection did not resolve exactly one owner',
      };
    }

    let outcome: ExternalOutcome;
    try {
      outcome = await host.runtime.submit({
        target: { kind: 'session', address: projected.session.address },
        idempotencyKey: input.idempotencyKey,
        command: input.command,
      }) as ExternalOutcome;
    } catch (error) {
      return {
        kind: 'quarantined',
        message: `Dashboard Runtime dispatch outcome is unknown: ${message(error)}`,
      };
    }
    if (outcome.kind !== 'staleAddress' || attempt === 1) return outcome;
  }
  return { kind: 'staleAddress' };
}

export function createCurrentDashboardSessionCommandClient(options: {
  readonly ownerLarkAppId: () => string;
  /** Resolve the current leased Host. Operation receipts remain on this client. */
  readonly host: () => CurrentSessionRuntimeHost;
}): CurrentDashboardSessionCommandSubmitter {
  // Intentionally retained for the entire daemon epoch. Current has no durable
  // operation evidence that could safely back an LRU eviction.
  const externalAttempts = new Map<string, ExternalAttempt>();

  const submit = async <C extends CurrentDashboardSessionRuntimeCommand>(input: {
    readonly target: CurrentDashboardSessionRuntimeTarget;
    readonly idempotencyKey: string;
    readonly command: C;
  }): Promise<CommandOutcomeFor<C>> => {
    if (input.target.kind === 'route') {
      let host: CurrentSessionRuntimeHost;
      try {
        host = options.host();
      } catch (error) {
        return {
          kind: 'retryable',
          message: `Dashboard SessionRuntime host is not ready: ${message(error)}`,
        } as CommandOutcomeFor<C>;
      }
      try {
        return await host.runtime.submit({
          target: { kind: 'route', route: input.target.route },
          idempotencyKey: input.idempotencyKey,
          command: input.command,
        }) as CommandOutcomeFor<C>;
      } catch (error) {
        return {
          kind: 'quarantined',
          message: `Dashboard route dispatch outcome is unknown: ${message(error)}`,
        } as CommandOutcomeFor<C>;
      }
    }

    if (input.command.kind === 'dashboard.spawn') {
      return {
        kind: 'rejected',
        reason: 'invalidCommand',
        message: 'Dashboard spawn requires a route target',
      } as CommandOutcomeFor<C>;
    }

    let requestHash: string;
    try {
      requestHash = computeInputHash(input.command);
    } catch (error) {
      return invalidOutcome(error) as CommandOutcomeFor<C>;
    }
    const key = operationKey(input.target.sessionId, input.idempotencyKey);
    const prior = externalAttempts.get(key);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        return conflictOutcome() as CommandOutcomeFor<C>;
      }
      if (prior.state !== 'retryable') {
        const priorOutcome = prior.state === 'running'
          ? await prior.terminal
          : prior.outcome;
        return replayOutcome(
          input.command,
          input.target.sessionId,
          priorOutcome,
        ) as CommandOutcomeFor<C>;
      }
    }

    const externalInput = {
      target: input.target,
      idempotencyKey: input.idempotencyKey,
      command: input.command,
    } as {
      readonly target: Extract<CurrentDashboardSessionRuntimeTarget, { kind: 'externalSession' }>;
      readonly idempotencyKey: string;
      readonly command: ExternalCommand;
    };
    // Queue execution only after the running record is visible. A projection
    // Adapter is allowed to resolve synchronously and may re-enter the client
    // through instrumentation/hooks; starting executeExternal inline would let
    // that callback miss the receipt and drive the same operation twice.
    const terminal = Promise.resolve().then(() => executeExternal(options.host, externalInput));
    externalAttempts.set(key, { requestHash, state: 'running', terminal });
    const outcome = await terminal;
    if (externalAttempts.get(key)?.requestHash === requestHash) {
      externalAttempts.set(key, outcomeIsRetryable(outcome)
        ? { requestHash, state: 'retryable' }
        : { requestHash, state: 'terminal', outcome });
    }
    return outcome as CommandOutcomeFor<C>;
  };

  return async <C extends CurrentDashboardSessionRuntimeCommand>(input: {
    readonly target: CurrentDashboardSessionRuntimeTarget;
    readonly idempotencyKey: string;
    readonly command: C;
  }): Promise<CommandOutcomeFor<C>> => {
    let ownerLarkAppId: string;
    try {
      ownerLarkAppId = options.ownerLarkAppId();
      if (!ownerLarkAppId) throw new Error('owner Bot is not ready');
    } catch (error) {
      return {
        kind: 'retryable',
        message: `Dashboard SessionRuntime owner is not ready: ${message(error)}`,
      } as CommandOutcomeFor<C>;
    }
    return withBotTurnAdmission(ownerLarkAppId, () => submit(input));
  };
}
