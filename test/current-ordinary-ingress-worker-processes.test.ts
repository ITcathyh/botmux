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
  const forkWorker = (input.kind === 'forkWorker'
    ? selected
    : vi.fn(() => true)) as unknown as CurrentOrdinaryIngressWorkerProcessPrimitives['forkWorker'];
  const forkAdoptWorker = (input.kind === 'forkAdoptWorker'
    ? selected
    : vi.fn(() => true)) as unknown as CurrentOrdinaryIngressWorkerProcessPrimitives['forkAdoptWorker'];
  return {
    selected,
    workerProcesses: createCurrentOrdinaryIngressWorkerProcesses({
      ownerLarkAppId: OWNER,
      activeSessions: input.activeSessions,
      sendWorkerInput,
      forkWorker,
      forkAdoptWorker,
    }),
  };
}

describe('Current ordinary ingress worker-process Adapter', () => {
  it('re-resolves a same-Session replacement before invoking a worker primitive', () => {
    const replaced = daemonSession();
    const current = daemonSession();
    const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(replaced), replaced]]);
    const sendWorkerInput = vi.fn(() => true);
    const workerProcesses = createCurrentOrdinaryIngressWorkerProcesses({
      ownerLarkAppId: OWNER,
      activeSessions,
      sendWorkerInput,
      forkWorker: vi.fn(() => true),
      forkAdoptWorker: vi.fn(),
    });
    activeSessions.set(activeSessionKey(current), current);

    const result = workerProcesses.dispatch(sendCommand());

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

  it('forks the exact queued activation with its structured Codex input', () => {
    const current = daemonSession();
    current.worker = null;
    current.session.queuedActivationPending = true;
    current.session.queuedActivationToken = 'activation-token-7';
    current.session.queuedActivationDispatchAttempt = 4;
    const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(current), current]]);
    const forkWorker = vi.fn(() => true);
    const workerProcesses = createCurrentOrdinaryIngressWorkerProcesses({
      ownerLarkAppId: OWNER,
      activeSessions,
      sendWorkerInput: vi.fn(() => true),
      forkWorker,
      forkAdoptWorker: vi.fn(),
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

    const result = workerProcesses.dispatch(forkCommand({
      payload,
      queuedActivationToken: 'activation-token-7',
      dispatchAttempt: 4,
    }));

    expect(result).toEqual({ kind: 'accepted' });
    expect(forkWorker).toHaveBeenCalledWith(current, payload, {
      resume: false,
      turnId: 'om_worker_fork',
      dispatchAttempt: 4,
      codexAppInputGateFrozen: true,
    });
  });

  it('forks only the current adopted binding and proves a void helper by its new worker lifetime', () => {
    const current = daemonSession();
    current.worker = null;
    current.adoptedFrom = {
      source: 'tmux',
      tmuxTarget: '0:1.0',
      cwd: '/tmp/current-adopt',
    };
    current.session.adoptedFrom = current.adoptedFrom;
    const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(current), current]]);
    const forkAdoptWorker = vi.fn((target: DaemonSession) => {
      target.workerGeneration += 1;
      target.worker = { killed: false } as DaemonSession['worker'];
    });
    const workerProcesses = createCurrentOrdinaryIngressWorkerProcesses({
      ownerLarkAppId: OWNER,
      activeSessions,
      sendWorkerInput: vi.fn(() => true),
      forkWorker: vi.fn(() => true),
      forkAdoptWorker,
    });

    const result = workerProcesses.dispatch(adoptCommand());

    expect(result).toEqual({ kind: 'accepted' });
    expect(forkAdoptWorker).toHaveBeenCalledWith(current, {
      prompt: 'bridge prompt',
      turnId: 'om_worker_adopt',
    });
  });

  it('preserves structured Codex send input and its explicit steer authorization', () => {
    const current = daemonSession();
    const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(current), current]]);
    const sendWorkerInput = vi.fn(() => true);
    const workerProcesses = createCurrentOrdinaryIngressWorkerProcesses({
      ownerLarkAppId: OWNER,
      activeSessions,
      sendWorkerInput,
      forkWorker: vi.fn(() => true),
      forkAdoptWorker: vi.fn(),
    });
    const payload: CliTurnPayload = {
      content: '<user_message>fallback</user_message>',
      codexAppInput: {
        text: 'clean Codex input',
        localImages: [{ path: '/tmp/example.png', detail: 'high' }],
      },
      codexAppSteerable: true,
    };

    expect(workerProcesses.dispatch(sendCommand(payload))).toEqual({ kind: 'accepted' });
    expect(sendWorkerInput).toHaveBeenCalledWith(current, payload, 'om_worker_send', {
      codexAppSteerable: true,
    });
  });

  it('refuses stale owner, registry key, and worker-generation bindings before send', () => {
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
        forkWorker: vi.fn(() => true),
        forkAdoptWorker: vi.fn(),
      });
      expect(workerProcesses.dispatch(sendCommand())).toMatchObject({ kind: 'refused' });
    }
    expect(sendWorkerInput).not.toHaveBeenCalled();
  });

  it.each([
    ['a stale token', 'stale-token', 4],
    ['a stale dispatch attempt', 'activation-token-9', 3],
    ['a missing token', undefined, undefined],
  ] as const)('refuses queued fork with %s', (_label, token, dispatchAttempt) => {
    const current = daemonSession();
    current.worker = null;
    current.session.queuedActivationPending = true;
    current.session.queuedActivationToken = 'activation-token-9';
    current.session.queuedActivationDispatchAttempt = 4;
    const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(current), current]]);
    const forkWorker = vi.fn(() => true);
    const workerProcesses = createCurrentOrdinaryIngressWorkerProcesses({
      ownerLarkAppId: OWNER,
      activeSessions,
      sendWorkerInput: vi.fn(() => true),
      forkWorker,
      forkAdoptWorker: vi.fn(),
    });

    const result = workerProcesses.dispatch(forkCommand({
      ...(token === undefined ? {} : { queuedActivationToken: token }),
      ...(dispatchAttempt === undefined ? {} : { dispatchAttempt }),
    }));

    expect(result).toMatchObject({ kind: 'refused' });
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('refuses adopt dispatch for a current non-adopted Session', () => {
    const current = daemonSession();
    current.worker = null;
    const activeSessions = new Map<string, DaemonSession>([[activeSessionKey(current), current]]);
    const forkAdoptWorker = vi.fn(() => true);
    const workerProcesses = createCurrentOrdinaryIngressWorkerProcesses({
      ownerLarkAppId: OWNER,
      activeSessions,
      sendWorkerInput: vi.fn(() => true),
      forkWorker: vi.fn(() => true),
      forkAdoptWorker,
    });

    expect(workerProcesses.dispatch(adoptCommand())).toMatchObject({ kind: 'refused' });
    expect(forkAdoptWorker).not.toHaveBeenCalled();
  });

  it.each([
    'sendWorkerInput',
    'forkWorker',
    'forkAdoptWorker',
  ] as const)('maps an explicit %s primitive refusal to refused', (kind) => {
    const fixture = fixtureFor(kind);
    const adapter = adapterWithSelectedPrimitive({
      kind,
      activeSessions: fixture.activeSessions,
      implementation: () => false,
    });

    const result = adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({ kind: 'refused' });
    expect(adapter.selected).toHaveBeenCalledTimes(1);
    expect('current' in result).toBe(false);
    expect('worker' in result).toBe(false);
  });

  it.each([
    'sendWorkerInput',
    'forkWorker',
    'forkAdoptWorker',
  ] as const)('maps a throwing %s primitive to unknown', (kind) => {
    const fixture = fixtureFor(kind);
    const adapter = adapterWithSelectedPrimitive({
      kind,
      activeSessions: fixture.activeSessions,
      implementation: () => { throw new Error(`${kind} failed after entry`); },
    });

    const result = adapter.workerProcesses.dispatch(fixture.command);

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
  ] as const)('rejects an asynchronous %s primitive result synchronously', (kind) => {
    const fixture = fixtureFor(kind);
    const adapter = adapterWithSelectedPrimitive({
      kind,
      activeSessions: fixture.activeSessions,
      implementation: () => Promise.resolve(true),
    });

    const result = adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({
      kind: 'unknown',
      message: expect.stringMatching(/must return synchronously/i),
    });
    expect(result).not.toBeInstanceOf(Promise);
    expect('then' in result).toBe(false);
  });

  it.each([
    'sendWorkerInput',
    'forkWorker',
    'forkAdoptWorker',
  ] as const)('returns unknown when %s replaces its Current binding during the call', (kind) => {
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

    const result = adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({ kind: 'unknown' });
    expect(adapter.selected).toHaveBeenCalledTimes(1);
  });

  it('returns unknown when a helper changes the Session identity in place', () => {
    const fixture = fixtureFor('sendWorkerInput');
    const adapter = adapterWithSelectedPrimitive({
      kind: 'sendWorkerInput',
      activeSessions: fixture.activeSessions,
      implementation: (current) => {
        current.session.sessionId = 'session-replaced-in-place';
        return true;
      },
    });

    const result = adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({ kind: 'unknown' });
  });

  it.each([
    'sendWorkerInput',
    'forkWorker',
    'forkAdoptWorker',
  ] as const)('returns unknown when %s replaces the Session record with the same id', (kind) => {
    const fixture = fixtureFor(kind);
    const adapter = adapterWithSelectedPrimitive({
      kind,
      activeSessions: fixture.activeSessions,
      implementation: (current) => {
        current.session = { ...current.session };
        return true;
      },
    });

    const result = adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({ kind: 'unknown' });
    expect(adapter.selected).toHaveBeenCalledTimes(1);
  });

  it('returns unknown when a helper leaves two exact bindings for the Session identity', () => {
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

    const result = adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({ kind: 'unknown' });
  });

  it('returns unknown when a void adopt helper leaves no provable new worker lifetime', () => {
    const fixture = fixtureFor('forkAdoptWorker');
    const adapter = adapterWithSelectedPrimitive({
      kind: 'forkAdoptWorker',
      activeSessions: fixture.activeSessions,
      implementation: () => undefined,
    });

    const result = adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({
      kind: 'unknown',
      message: expect.stringMatching(/without a provable worker lifetime/i),
    });
  });

  it('fail-closes a hostile thenable without leaking it from dispatch', () => {
    const fixture = fixtureFor('sendWorkerInput');
    const hostile = Object.defineProperty({}, 'then', {
      get() { throw new Error('hostile then getter'); },
    });
    const adapter = adapterWithSelectedPrimitive({
      kind: 'sendWorkerInput',
      activeSessions: fixture.activeSessions,
      implementation: () => hostile,
    });

    const result = adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({ kind: 'unknown' });
    expect(result).not.toBe(hostile);
  });

  it('never leaks a primitive-returned DaemonSession through the result seam', () => {
    const fixture = fixtureFor('sendWorkerInput');
    const adapter = adapterWithSelectedPrimitive({
      kind: 'sendWorkerInput',
      activeSessions: fixture.activeSessions,
      implementation: current => current,
    });

    const result = adapter.workerProcesses.dispatch(fixture.command);

    expect(result).toMatchObject({ kind: 'unknown' });
    expect(result).not.toBe(fixture.current);
    expect('session' in result).toBe(false);
    expect('worker' in result).toBe(false);
  });
});
