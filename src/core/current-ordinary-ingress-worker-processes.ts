/**
 * Current Adapter from detached ordinary-ingress worker commands to the
 * synchronous worker-pool primitives.  The Adapter retains only owner and
 * registry authority; every dispatch resolves the current DaemonSession anew.
 */

import type {
  CurrentOrdinaryIngressWorkerProcessCommand,
  CurrentOrdinaryIngressWorkerProcesses,
  CurrentOrdinaryIngressWorkerProcessResult,
} from './current-ordinary-ingress-production.js';
import { activeSessionKey, type DaemonSession } from './types.js';
import type { CliTurnPayload } from '../types.js';
import type { CurrentSessionActivationCoordinator } from './current-session-activation.js';

export interface CurrentOrdinaryIngressWorkerProcessPrimitives {
  sendWorkerInput(
    current: DaemonSession,
    input: CliTurnPayload,
    turnId: string,
    options: { readonly codexAppSteerable?: true },
  ): boolean;
  readonly activation: Pick<CurrentSessionActivationCoordinator, 'ensure'>;
}

export interface CurrentOrdinaryIngressWorkerProcessesOptions
  extends CurrentOrdinaryIngressWorkerProcessPrimitives {
  readonly ownerLarkAppId: string;
  readonly activeSessions: ReadonlyMap<string, DaemonSession>;
}

type ResolvedCurrent =
  | {
      readonly kind: 'one';
      readonly key: string;
      readonly sessionId: string;
      readonly current: DaemonSession;
      readonly session: DaemonSession['session'];
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'unknown'; readonly message: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refused(reason: string): CurrentOrdinaryIngressWorkerProcessResult {
  return { kind: 'refused', message: reason };
}

function unknown(reason: string): CurrentOrdinaryIngressWorkerProcessResult {
  return { kind: 'unknown', message: reason };
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function isThenable(value: unknown): boolean {
  if (!isObject(value)) return false;
  try {
    return typeof value.then === 'function';
  } catch {
    return true;
  }
}

function detachThenable(value: unknown): void {
  if (!isObject(value)) return;
  try {
    void Promise.resolve(value).catch(() => undefined);
  } catch {
    // A hostile `then` accessor is already classified as unknown.
  }
}

function activationResult(
  outcome: Awaited<ReturnType<CurrentSessionActivationCoordinator['ensure']>>,
): CurrentOrdinaryIngressWorkerProcessResult {
  const terminal = outcome.kind === 'duplicate' ? outcome.outcome : outcome;
  if (terminal.kind === 'active') {
    return terminal.action === 'alreadyActive'
      ? { kind: 'stateChanged' }
      : { kind: 'accepted' };
  }
  if (terminal.kind === 'retryable') return refused(terminal.message);
  if (terminal.kind === 'stale') return { kind: 'stateChanged' };
  if (terminal.kind === 'rejected') {
    return terminal.reason === 'conflict'
      ? unknown(terminal.message)
      : refused(terminal.message);
  }
  return unknown(terminal.message);
}

function resolveCurrent(
  options: CurrentOrdinaryIngressWorkerProcessesOptions,
  sessionId: string,
): ResolvedCurrent {
  try {
    const matches: Array<{
      key: string;
      current: DaemonSession;
      session: DaemonSession['session'];
    }> = [];
    for (const [registryKey, current] of options.activeSessions) {
      if (current.session.sessionId !== sessionId
          || current.larkAppId !== options.ownerLarkAppId
          || (current.session.larkAppId !== undefined
            && current.session.larkAppId !== options.ownerLarkAppId)) {
        continue;
      }
      const exactKey = activeSessionKey(current);
      if (registryKey !== exactKey || options.activeSessions.get(exactKey) !== current) continue;
      matches.push({ key: exactKey, current, session: current.session });
    }
    if (matches.length === 0) return { kind: 'missing' };
    if (matches.length > 1) return { kind: 'ambiguous' };
    return { kind: 'one', sessionId, ...matches[0] };
  } catch (error) {
    return {
      kind: 'unknown',
      message: `Current worker binding could not be inspected: ${message(error)}`,
    };
  }
}

function bindingIsStillExact(
  options: CurrentOrdinaryIngressWorkerProcessesOptions,
  resolved: Extract<ResolvedCurrent, { kind: 'one' }>,
): boolean {
  const current = resolveCurrent(options, resolved.sessionId);
  return current.kind === 'one'
    && current.key === resolved.key
    && current.current === resolved.current
    && current.session === resolved.session;
}

function resolvedOrOutcome(
  options: CurrentOrdinaryIngressWorkerProcessesOptions,
  command: CurrentOrdinaryIngressWorkerProcessCommand,
): Extract<ResolvedCurrent, { kind: 'one' }> | CurrentOrdinaryIngressWorkerProcessResult {
  const resolved = resolveCurrent(options, command.sessionId);
  if (resolved.kind === 'one') return resolved;
  if (resolved.kind === 'unknown') return unknown(resolved.message);
  if (resolved.kind === 'ambiguous') {
    return unknown('ordinary ingress worker command has multiple exact Current Session bindings');
  }
  return refused('ordinary ingress worker command targets a stale or unavailable Current Session');
}

/** Build the owner-bound synchronous worker-process Adapter. */
export function createCurrentOrdinaryIngressWorkerProcesses(
  options: CurrentOrdinaryIngressWorkerProcessesOptions,
): CurrentOrdinaryIngressWorkerProcesses {
  return {
    async dispatch(command) {
      const resolved = resolvedOrOutcome(options, command);
      if (!('current' in resolved)) return resolved;

      if (command.kind === 'forkWorker') {
        const durableToken = resolved.current.session.queuedActivationToken;
        const durableAttempt = resolved.current.session.queuedActivationDispatchAttempt;
        if (command.queuedActivationToken !== undefined) {
          if (resolved.current.session.queuedActivationPending !== true
              || durableToken !== command.queuedActivationToken
              || durableAttempt !== command.dispatchAttempt) {
            return refused('ordinary ingress queued activation identity is stale');
          }
        } else if (command.dispatchAttempt !== undefined
            || resolved.current.session.queuedActivationPending === true) {
          return refused('ordinary ingress queued activation command is missing its exact token');
        }

        try {
          const outcome = await options.activation.ensure({
            sessionId: resolved.sessionId,
            requestIdentity: command.turnId,
            cause: 'ordinary',
            promptInput: command.input,
            resumeOrTurnId: {
              resume: command.resume,
              turnId: command.turnId,
              ...(command.dispatchAttempt === undefined
                ? {}
                : { dispatchAttempt: command.dispatchAttempt }),
              ...(command.queuedActivationToken === undefined
                ? {}
                : { codexAppInputGateFrozen: true }),
            },
          });
          if (!bindingIsStillExact(options, resolved)) {
            return unknown('Current Session binding changed during ordinary ingress activation');
          }
          return activationResult(outcome);
        } catch (error) {
          return unknown(`ordinary ingress fork outcome is unknown: ${message(error)}`);
        }
      }

      if (command.kind === 'forkAdoptWorker') {
        if (!resolved.current.adoptedFrom) {
          return refused('ordinary ingress adopt fork targets a non-adopted Current Session');
        }
        try {
          const outcome = await options.activation.ensure({
            sessionId: resolved.sessionId,
            requestIdentity: command.turnId,
            cause: 'ordinary',
            promptInput: command.input,
            resumeOrTurnId: { turnId: command.turnId },
            executor: 'adopt',
          });
          if (!bindingIsStillExact(options, resolved) || !resolved.current.adoptedFrom) {
            return unknown('Current adopted Session binding changed during ordinary ingress activation');
          }
          return activationResult(outcome);
        } catch (error) {
          return unknown(`ordinary ingress adopt fork outcome is unknown: ${message(error)}`);
        }
      }

      if (resolved.current.workerGeneration !== command.workerGeneration) {
        return refused('ordinary ingress worker generation is stale');
      }

      let result: unknown;
      try {
        result = options.sendWorkerInput(
          resolved.current,
          command.input,
          command.turnId,
          command.input.codexAppSteerable === true ? { codexAppSteerable: true } : {},
        );
      } catch (error) {
        return unknown(`ordinary ingress send outcome is unknown: ${message(error)}`);
      }
      if (isThenable(result)) {
        detachThenable(result);
        return unknown('ordinary ingress send primitive must return synchronously');
      }
      if (result === false) return refused('ordinary ingress send primitive refused the input');
      if (result !== true) return unknown('ordinary ingress send primitive returned no acceptance proof');
      if (!bindingIsStillExact(options, resolved)
          || resolved.current.workerGeneration !== command.workerGeneration) {
        return unknown('Current Session binding changed during ordinary ingress send');
      }
      return { kind: 'accepted' };
    },
  };
}
