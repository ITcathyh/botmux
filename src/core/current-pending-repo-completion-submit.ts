/** Stable owner/registry submit helper for pending-repository first starts. */

import { createCurrentPendingRepoCompletionProduction } from './current-pending-repo-completion-production.js';
import { currentSessionRuntimeHost } from './current-session-runtime.js';
import { currentDeviceIsolationFreezeLease } from './device-isolation-activation.js';
import type {
  PendingRepoCompletionCommandOutcome,
  PendingRepoCompletionPort,
  PendingRepoCompletionSelection,
} from './session-runtime.js';
import { activeSessionKey, type DaemonSession } from './types.js';
import { getDaemonBootId } from './worker-pool.js';
import type { BotId } from './bot-identity.js';
import {
  currentSessionActivationCoordinator,
  type CurrentSessionActivationCoordinator,
} from './current-session-activation.js';

export interface CurrentPendingRepoCompletionSubmitInput {
  /** Production callers receive this binding from the daemon's startup gate. */
  readonly ownerBotId: BotId;
  readonly ownerLarkAppId: string;
  readonly activeSessions: Map<string, DaemonSession>;
  readonly sessionId: string;
  /** Exact caller-captured capability; never forwarded into the public command. */
  readonly daemonSession: DaemonSession;
  readonly selection: PendingRepoCompletionSelection;
}

export interface CurrentPendingRepoCompletionPortInput {
  readonly ownerLarkAppId: string;
  readonly activeSessions: Map<string, DaemonSession>;
  readonly ownerBootId: string;
  readonly activation?: Pick<CurrentSessionActivationCoordinator, 'ensure'>;
}

interface CachedPort {
  readonly ownerBootId: string;
  readonly port: PendingRepoCompletionPort;
}

const portsByRegistry = new WeakMap<
  Map<string, DaemonSession>,
  Map<string, CachedPort>
>();

function isExactCurrentOwner(
  input: CurrentPendingRepoCompletionSubmitInput,
  capturedSession: DaemonSession['session'],
): boolean {
  const ds = input.daemonSession;
  if (ds.larkAppId !== input.ownerLarkAppId
    || ds.session !== capturedSession
    || capturedSession.sessionId !== input.sessionId
    || capturedSession.status !== 'active'
    || input.activeSessions.get(activeSessionKey(ds)) !== ds) {
    return false;
  }
  let matchingSessions = 0;
  for (const candidate of input.activeSessions.values()) {
    if (candidate.larkAppId === input.ownerLarkAppId
      && candidate.session.sessionId === input.sessionId) {
      matchingSessions += 1;
      if (candidate !== ds || candidate.session !== capturedSession) return false;
    }
  }
  return matchingSessions === 1;
}

/**
 * Registry + owner + boot scoped production port shared by warm host
 * composition and lazy caller submission.
 */
export function currentPendingRepoCompletionPort(
  input: CurrentPendingRepoCompletionPortInput,
): PendingRepoCompletionPort {
  let byOwner = portsByRegistry.get(input.activeSessions);
  if (!byOwner) {
    byOwner = new Map();
    portsByRegistry.set(input.activeSessions, byOwner);
  }
  const cached = byOwner.get(input.ownerLarkAppId);
  if (cached?.ownerBootId === input.ownerBootId) return cached.port;
  const port = createCurrentPendingRepoCompletionProduction({
    ownerLarkAppId: input.ownerLarkAppId,
    activeSessions: input.activeSessions,
    ...(input.activation === undefined ? {} : { activation: input.activation }),
  });
  byOwner.set(input.ownerLarkAppId, { ownerBootId: input.ownerBootId, port });
  return port;
}

function semanticKey(ds: DaemonSession): string {
  const openingId = ds.session.pendingRepoSetup?.turnId
    ?? ds.pendingTurnId
    ?? ds.session.sessionId;
  return `pending-repo:first-start:${openingId}`;
}

/**
 * Submit one normalized first-start selection through the owner epoch's stable
 * Current SessionRuntime. Every caller for the same durable opening derives the
 * same idempotency key and therefore joins rather than racing a second fork.
 */
export async function submitCurrentPendingRepoCompletion(
  input: CurrentPendingRepoCompletionSubmitInput,
): Promise<PendingRepoCompletionCommandOutcome> {
  const captured = input.daemonSession;
  const capturedSession = captured.session;
  if (!isExactCurrentOwner(input, capturedSession)) return { kind: 'staleAddress' };
  const capturedKey = activeSessionKey(captured);
  const ownerBootId = getDaemonBootId();
  const activation = currentSessionActivationCoordinator({
    ownerBotId: input.ownerBotId,
    ownerLarkAppId: input.ownerLarkAppId,
    runtimeEpoch: ownerBootId,
    activeSessions: input.activeSessions,
  });
  const pendingRepoCompletion = currentPendingRepoCompletionPort({
    ownerLarkAppId: input.ownerLarkAppId,
    activeSessions: input.activeSessions,
    ownerBootId,
    activation,
  });
  let host: ReturnType<typeof currentSessionRuntimeHost>;
  try {
    host = currentSessionRuntimeHost({
      ownerBotId: input.ownerBotId,
      ownerLarkAppId: input.ownerLarkAppId,
      activeSessions: input.activeSessions,
      ownerBootId,
      keyedTriggerAdmissionBlocked: () => currentDeviceIsolationFreezeLease() !== null,
      pendingRepoCompletion,
    });
  } catch (error) {
    return {
      kind: 'notWired',
      command: 'pendingRepo.complete',
      message: `pending-repo Current host composition failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const projected = await host.projection.read({
    kind: 'byExternalSession',
    sessionId: input.sessionId,
  });
  if (input.activeSessions.get(capturedKey) !== captured
    || !isExactCurrentOwner(input, capturedSession)) {
    return { kind: 'staleAddress' };
  }
  if (projected.kind !== 'one') return { kind: 'staleAddress' };
  return host.runtime.submit({
    target: { kind: 'session', address: projected.session.address },
    idempotencyKey: semanticKey(captured),
    command: {
      kind: 'pendingRepo.complete',
      input: { selection: input.selection },
    },
  });
}
