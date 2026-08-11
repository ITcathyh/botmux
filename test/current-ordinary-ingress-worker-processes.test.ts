import { describe, expect, it, vi } from 'vitest';

import {
  createCurrentOrdinaryIngressWorkerProcesses,
  type CurrentOrdinaryIngressWorkerProcessPrimitives,
} from '../src/core/current-ordinary-ingress-worker-processes.js';
import type { CurrentOrdinaryIngressWorkerProcessCommand } from '../src/core/current-ordinary-ingress-production.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type { CliTurnPayload, Session } from '../src/types.js';

const OWNER = 'app-current-worker-processes';
const SESSION_ID = 'session-current-worker-processes';
const ANCHOR = 'om_current_worker_processes_root';
const CHAT_ID = 'oc_current_worker_processes_chat';

function daemonSession(input: {
  ownerLarkAppId?: string;
  sessionId?: string;
  workerGeneration?: number;
} = {}): DaemonSession {
  const ownerLarkAppId = input.ownerLarkAppId ?? OWNER;
  const session = {
    sessionId: input.sessionId ?? SESSION_ID,
    larkAppId: ownerLarkAppId,
    rootMessageId: ANCHOR,
    chatId: CHAT_ID,
    chatType: 'group',
    scope: 'thread',
    status: 'active',
    title: 'Current worker-process Adapter',
    createdAt: '2026-08-10T00:00:00.000Z',
  } as Session;
  return {
    session,
    worker: { killed: false } as DaemonSession['worker'],
    workerPort: null,
    workerToken: null,
    workerGeneration: input.workerGeneration ?? 7,
    larkAppId: ownerLarkAppId,
    chatId: CHAT_ID,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.parse(session.createdAt),
    cliVersion: 'test',
    lastMessageAt: Date.parse(session.createdAt),
    hasHistory: true,
  } as DaemonSession;
}

function sendCommand(
  input: CliTurnPayload = { content: 'follow-up' },
): CurrentOrdinaryIngressWorkerProcessCommand {
  return {
    kind: 'sendWorkerInput',
    sessionId: SESSION_ID,
    turnId: 'om_worker_send',
    input,
    workerGeneration: 7,
  };
}

function forkCommand(input: {
  payload?: CliTurnPayload;
  queuedActivationToken?: string;
  dispatchAttempt?: number;
  resume?: boolean;
} = {}): CurrentOrdinaryIngressWorkerProcessCommand {
  return {
    kind: 'forkWorker',
    sessionId: SESSION_ID,
    turnId: 'om_worker_fork',
    input: input.payload ?? { content: 'cold replacement' },
    resume: input.resume ?? false,
    ...(input.queuedActivationToken === undefined
      ? {}
      : { queuedActivationToken: input.queuedActivationToken }),
    ...(input.dispatchAttempt === undefined ? {} : { dispatchAttempt: input.dispatchAttempt }),
  };
}

function adoptCommand(
  input: CliTurnPayload = {
    content: 'bridge prompt',
    codexAppInput: { text: 'must not cross the raw adopt primitive' },
  },
): CurrentOrdinaryIngressWorkerProcessCommand {
  return {
    kind: 'forkAdoptWorker',
    sessionId: SESSION_ID,
    turnId: 'om_worker_adopt',
    input,
  };
}

type PrimitiveKind = CurrentOrdinaryIngressWorkerProcessCommand['kind'];

function fixtureFor(kind: PrimitiveKind) {
  const current = daemonSession();
  let command: CurrentOrdinaryIngressWorkerProcessCommand;
  if (kind === 'forkWorker') {
    current.worker = null;
    command = forkCommand();
  } else if (kind === 'forkAdoptWorker') {
    current.worker = null;
    current.adoptedFrom = {
      source: 'tmux',
      tmuxTarget: '0:2.0',
      cwd: '/tmp/current-adopt-fault',
    };
    current.session.adoptedFrom = current.adoptedFrom;
    command = adoptCommand();
  } else {
    command = sendCommand();
  }
  const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(current), current]]);
  return { activeSessions, command, current };
}

function adapterWithSelectedPrimitive(input: {
  kind: PrimitiveKind;
  activeSessions: Map<string, DaemonSession>;
  implementation: (current: DaemonSession) => unknown;
}) {
  const selected = vi.fn(input.implementation);
  const sendWorkerInput = (input.kind === 'sendWorkerInput'
    ? selected
    : vi.fn(() => true)) as unknown as CurrentOrdinaryIngressWorkerProcessPrimitives['sendWorkerInput'];
  const ensure = vi.fn(async () => {
    if (input.kind === 'sendWorkerInput') return { kind: 'active' as const, action: 'activated' as const };
    const current = [...input.activeSessions.values()][0]!;
    let value = selected(current);
    if (value && typeof (value as PromiseLike<unknown>).then === 'function') value = await value;
    if (value === false) return { kind: 'retryable' as const, message: 'activation refused' };
    if (value === true) return { kind: 'active' as const, action: 'activated' as const };
    const live = current.worker !== null && !current.worker.killed;
    return live
      ? { kind: 'active' as const, action: 'activated' as const }
      : { kind: 'ambiguous' as const, message: 'activation returned without a provable worker lifetime' };
  });
  return {
    selected,
    ensure,
    workerProcesses: createCurrentOrdinaryIngressWorkerProcesses({
      ownerLarkAppId: OWNER,
      activeSessions: input.activeSessions,
      sendWorkerInput,
      activation: { ensure },
    }),
  };
}

function activation(
  implementation: () => Promise<
    | { kind: 'active'; action: 'activated' }
    | { kind: 'retryable'; message: string }
  > = async () => ({ kind: 'active', action: 'activated' }),
) {
  return { ensure: vi.fn(implementation) };
}

describe('Current ordinary ingress worker-process Adapter', () => {
  it('re-resolves a same-Session replacement before invoking a worker primitive', async () => {
    const replaced = daemonSession();
    const current = daemonSession();
    const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(replaced), replaced]]);
    const sendWorkerInput = vi.fn(() => true);
    const workerProcesses = createCurrentOrdinaryIngressWorkerProcesses({
      ownerLarkAppId: OWNER,
      activeSessions,
      sendWorkerInput,
      activation: activation(),
    });
    activeSessions.set(activeSessionKey(current), current);

    const result = await workerProcesses.dispatch(sendCommand());

    expect(result).toEqual({ kind: 'accepted' });
    expect(sendWorkerInput).toHaveBeenCalledWith(
      current,
      { content: 'follow-up' },
      'om_worker_send',
      {},
    );
    expect(sendWorkerInput.mock.calls[0]?.[0]).toBe(current);
    expect(sendWorkerInput.mock.calls[0]?.[0]).not.toBe(replaced);
  });

  it('forks the exact queued activation with its structured Codex input', async () => {
    const current = daemonSession();
    current.worker = null;
    current.session.queuedActivationPending = true;
    current.session.queuedActivationToken = 'activation-token-7';
    current.session.queuedActivationDispatchAttempt = 4;
    const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(current), current]]);
    const ownerActivation = activation();
    const workerProcesses = createCurrentOrdinaryIngressWorkerProcesses({
      ownerLarkAppId: OWNER,
      activeSessions,
      sendWorkerInput: vi.fn(() => true),
      activation: ownerActivation,
    });
    const payload: CliTurnPayload = {
      content: '<user_message>legacy fallback</user_message>',
      codexAppInput: {
        text: 'structured Codex turn',
        additionalContext: {
          vc: { kind: 'application', value: 'meeting context' },
        },
      },
      codexAppSteerable: true,
    };

    const result = await workerProcesses.dispatch(forkCommand({
      payload,
      queuedActivationToken: 'activation-token-7',
      dispatchAttempt: 4,
    }));

    expect(result).toEqual({ kind: 'accepted' });
    expect(ownerActivation.ensure).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'om_worker_fork',
      cause: 'ordinary',
      promptInput: payload,
      resumeOrTurnId: {
        resume: false,
        turnId: 'om_worker_fork',
        dispatchAttempt: 4,
        codexAppInputGateFrozen: true,
      },
    });
  });

  it('forks only the current adopted binding and proves a void helper by its new worker lifetime', async () => {
    const current = daemonSession();
    current.worker = null;
    current.adoptedFrom = {
      source: 'tmux',
      tmuxTarget: '0:1.0',
      cwd: '/tmp/current-adopt',
    };
    current.session.adoptedFrom = current.adoptedFrom;
    const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(current), current]]);
    const ownerActivation = activation();
    const workerProcesses = createCurrentOrdinaryIngressWorkerProcesses({
      ownerLarkAppId: OWNER,
      activeSessions,
      sendWorkerInput: vi.fn(() => true),
      activation: ownerActivation,
    });

    const result = await workerProcesses.dispatch(adoptCommand());

    expect(result).toEqual({ kind: 'accepted' });
    expect(ownerActivation.ensure).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestIdentity: 'om_worker_adopt',
      cause: 'ordinary',
      promptInput: expect.objectContaining({ content: 'bridge prompt' }),
      resumeOrTurnId: { turnId: 'om_worker_adopt' },
      executor: 'adopt',
    });
  });

  it('preserves structured Codex send input and its explicit steer authorization', async () => {
    const current = daemonSession();
    const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(current), current]]);
    const sendWorkerInput = vi.fn(() => true);
    const workerProcesses = createCurrentOrdinaryIngressWorkerProcesses({
      ownerLarkAppId: OWNER,
      activeSessions,
      sendWorkerInput,
      activation: activation(),
    });
    const payload: CliTurnPayload = {
      content: '<user_message>fallback</user_message>',
      codexAppInput: {
        text: 'clean Codex input',
        localImages: [{ path: '/tmp/example.png', detail: 'high' }],
      },
      codexAppSteerable: true,
    };

    expect(await workerProcesses.dispatch(sendCommand(payload))).toEqual({ kind: 'accepted' });
    expect(sendWorkerInput).toHaveBeenCalledWith(current, payload, 'om_worker_send', {
      codexAppSteerable: true,
    });
  });

  it('refuses stale owner, registry key, and worker-generation bindings before send', async () => {
    const sendWorkerInput = vi.fn(() => true);
    const foreign = daemonSession({ ownerLarkAppId: 'app-foreign-owner' });
    const wrongKey = daemonSession();
    const staleGeneration = daemonSession({ workerGeneration: 8 });
    const cases = [
      new Map<string, DaemonSession>([[activeSessionKey(foreign), foreign]]),
      new Map<string, DaemonSession>([['wrong-active-key', wrongKey]]),
      new Map<string, DaemonSession>([[activeSessionKey(staleGeneration), staleGeneration]]),
    ];

    for (const activeSessions of cases) {
      const workerProcesses = createCurrentOrdinaryIngressWorkerProcesses({
        ownerLarkAppId: OWNER,
        activeSessions,
        sendWorkerInput,
        activation: activation(),
      });
      expect(await workerProcesses.dispatch(sendCommand())).toMatchObject({ kind: 'refused' });
    }
    expect(sendWorkerInput).not.toHaveBeenCalled();
  });

  it.each([
    ['a stale token', 'stale-token', 4],
    ['a stale dispatch attempt', 'activation-token-9', 3],
    ['a missing token', undefined, undefined],
  ] as const)('refuses queued fork with %s', async (_label, token, dispatchAttempt) => {
    const current = daemonSession();
    current.worker = null;
    current.session.queuedActivationPending = true;
    current.session.queuedActivationToken = 'activation-token-9';
    current.session.queuedActivationDispatchAttempt = 4;
    const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(current), current]]);
    const ownerActivation = activation();
    const workerProcesses = createCurrentOrdinaryIngressWorkerProcesses({
      ownerLarkAppId: OWNER,
      activeSessions,
      sendWorkerInput: vi.fn(() => true),
      activation: ownerActivation,
    });

    const result = await workerProcesses.dispatch(forkCommand({
      ...(token === undefined ? {} : { queuedActivationToken: token }),
      ...(dispatchAttempt === undefined ? {} : { dispatchAttempt }),
    }));

    expect(result).toMatchObject({ kind: 'refused' });
    expect(ownerActivation.ensure).not.toHaveBeenCalled();
  });

  it('refuses adopt dispatch for a current non-adopted Session', async () => {
    const current = daemonSession();
    current.worker = null;
    const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(current), current]]);
    const ownerActivation = activation();
    const workerProcesses = createCurrentOrdinaryIngressWorkerProcesses({
      ownerLarkAppId: OWNER,
      activeSessions,
      sendWorkerInput: vi.fn(() => true),
      activation: ownerActivation,
    });

    expect(await workerProcesses.dispatch(adoptCommand())).toMatchObject({ kind: 'refused' });
    expect(ownerActivation.ensure).not.toHaveBeenCalled();
  });

  it.each([
    'sendWorkerInput',
    'forkWorker',
    'forkAdoptWorker',
  ] as const)('maps an explicit %s primitive refusal to refused', async (kind) => {
    const fixture = fixtureFor(kind);
    const adapter = adapterWithSelectedPrimitive({
      kind,
      activeSessions: fixture.activeSessions,
      implementation: () => false,
    });

    const result = await adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({ kind: 'refused' });
    expect(adapter.selected).toHaveBeenCalledTimes(1);
    expect('current' in result).toBe(false);
    expect('worker' in result).toBe(false);
  });

  it.each([
    'sendWorkerInput',
    'forkWorker',
    'forkAdoptWorker',
  ] as const)('maps a throwing %s primitive to unknown', async (kind) => {
    const fixture = fixtureFor(kind);
    const adapter = adapterWithSelectedPrimitive({
      kind,
      activeSessions: fixture.activeSessions,
      implementation: () => { throw new Error(`${kind} failed after entry`); },
    });

    const result = await adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({
      kind: 'unknown',
      message: expect.stringContaining(`${kind} failed after entry`),
    });
    expect(adapter.selected).toHaveBeenCalledTimes(1);
  });

  it.each([
    'sendWorkerInput',
    'forkWorker',
    'forkAdoptWorker',
  ] as const)('accepts asynchronous activation results only outside the Session lane for %s', async (kind) => {
    const fixture = fixtureFor(kind);
    const adapter = adapterWithSelectedPrimitive({
      kind,
      activeSessions: fixture.activeSessions,
      implementation: () => Promise.resolve(true),
    });

    const result = await adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({ kind: kind === 'sendWorkerInput' ? 'unknown' : 'accepted' });
  });

  it.each([
    'sendWorkerInput',
    'forkWorker',
    'forkAdoptWorker',
  ] as const)('returns unknown when %s replaces its Current binding during the call', async (kind) => {
    const fixture = fixtureFor(kind);
    const replacement = daemonSession();
    const adapter = adapterWithSelectedPrimitive({
      kind,
      activeSessions: fixture.activeSessions,
      implementation: () => {
        fixture.activeSessions.set(activeSessionKey(replacement), replacement);
        return true;
      },
    });

    const result = await adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({ kind: 'unknown' });
    expect(adapter.selected).toHaveBeenCalledTimes(1);
  });

  it('returns unknown when a helper changes the Session identity in place', async () => {
    const fixture = fixtureFor('sendWorkerInput');
    const adapter = adapterWithSelectedPrimitive({
      kind: 'sendWorkerInput',
      activeSessions: fixture.activeSessions,
      implementation: (current) => {
        current.session.sessionId = 'session-replaced-in-place';
        return true;
      },
    });

    const result = await adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({ kind: 'unknown' });
  });

  it.each([
    'sendWorkerInput',
    'forkWorker',
    'forkAdoptWorker',
  ] as const)('returns unknown when %s replaces the Session record with the same id', async (kind) => {
    const fixture = fixtureFor(kind);
    const adapter = adapterWithSelectedPrimitive({
      kind,
      activeSessions: fixture.activeSessions,
      implementation: (current) => {
        current.session = { ...current.session };
        return true;
      },
    });

    const result = await adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({ kind: 'unknown' });
    expect(adapter.selected).toHaveBeenCalledTimes(1);
  });

  it('returns unknown when a helper leaves two exact bindings for the Session identity', async () => {
    const fixture = fixtureFor('sendWorkerInput');
    const duplicate = daemonSession();
    duplicate.session.rootMessageId = 'om_duplicate_current_route';
    const adapter = adapterWithSelectedPrimitive({
      kind: 'sendWorkerInput',
      activeSessions: fixture.activeSessions,
      implementation: () => {
        fixture.activeSessions.set(activeSessionKey(duplicate), duplicate);
        return true;
      },
    });

    const result = await adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({ kind: 'unknown' });
  });

  it('returns unknown when a void adopt helper leaves no provable new worker lifetime', async () => {
    const fixture = fixtureFor('forkAdoptWorker');
    const adapter = adapterWithSelectedPrimitive({
      kind: 'forkAdoptWorker',
      activeSessions: fixture.activeSessions,
      implementation: () => undefined,
    });

    const result = await adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({
      kind: 'unknown',
      message: expect.stringMatching(/without a provable worker lifetime/i),
    });
  });

  it('fail-closes a hostile thenable without leaking it from dispatch', async () => {
    const fixture = fixtureFor('sendWorkerInput');
    const hostile = Object.defineProperty({}, 'then', {
      get() { throw new Error('hostile then getter'); },
    });
    const adapter = adapterWithSelectedPrimitive({
      kind: 'sendWorkerInput',
      activeSessions: fixture.activeSessions,
      implementation: () => hostile,
    });

    const result = await adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({ kind: 'unknown' });
    expect(result).not.toBe(hostile);
  });

  it('never leaks a primitive-returned DaemonSession through the result seam', async () => {
    const fixture = fixtureFor('sendWorkerInput');
    const adapter = adapterWithSelectedPrimitive({
      kind: 'sendWorkerInput',
      activeSessions: fixture.activeSessions,
      implementation: current => current,
    });

    const result = await adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({ kind: 'unknown' });
    expect(result).not.toBe(fixture.current);
    expect('session' in result).toBe(false);
    expect('worker' in result).toBe(false);
  });
});
