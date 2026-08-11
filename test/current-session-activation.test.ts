import { describe, expect, it, vi } from 'vitest';

import { createCurrentSessionActivationPort } from '../src/core/current-session-activation.js';
import type { SessionActivationRequest } from '../src/core/session-activation-runtime.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

function session(overrides: Partial<DaemonSession> = {}): DaemonSession {
  const value = {
    larkAppId: 'cli_owner',
    chatId: 'oc_chat',
    chatType: 'group',
    rootMessageId: 'om_root',
    scope: 'thread',
    worker: null,
    session: {
      sessionId: 'session-1',
      larkAppId: 'cli_owner',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      scope: 'thread',
      status: 'active',
      workingDir: '/tmp',
      createdAt: new Date(0).toISOString(),
      lastActiveAt: new Date(0).toISOString(),
    },
    ...overrides,
  } as unknown as DaemonSession;
  return value;
}

function request(
  observation: 'exists' | 'missing' | 'unknown',
): SessionActivationRequest {
  return {
    sessionId: 'session-1',
    requestIdentity: `restore-${observation}`,
    goal: {
      kind: 'reconcile',
      cause: 'restore',
      observation,
      input: { promptInput: '', resumeOrTurnId: true },
    },
  };
}

describe('Current Session activation Adapter', () => {
  it('preserves exists, missing and unknown backend observations', async () => {
    const ds = session();
    const registry = new Map([[activeSessionKey(ds), ds]]);
    const fork = vi.fn(() => {
      ds.worker = { killed: false } as DaemonSession['worker'];
      return true;
    });
    const port = createCurrentSessionActivationPort({
      ownerLarkAppId: 'cli_owner',
      activeSessions: registry,
      forkWorker: fork,
    });

    expect(port.begin(request('unknown'))).toEqual({
      kind: 'quarantined',
      message: 'persistent backend observation is unknown',
    });

    for (const [observation, action] of [
      ['exists', 'reattached'],
      ['missing', 'activated'],
    ] as const) {
      ds.worker = null;
      const begun = port.begin(request(observation));
      expect(begun.kind).toBe('effect');
      if (begun.kind !== 'effect') throw new Error('expected effect');
      const value = await port.execute(begun.intent);
      expect(port.resume(begun.continuation, { kind: 'returned', value })).toEqual({
        kind: 'active',
        action,
      });
    }
    expect(fork).toHaveBeenCalledTimes(2);
  });

  it('keeps an unknown backend binding quarantined until an explicit re-probe', async () => {
    const ds = session();
    const registry = new Map([[activeSessionKey(ds), ds]]);
    const fork = vi.fn(() => {
      ds.worker = { killed: false } as DaemonSession['worker'];
      return true;
    });
    const port = createCurrentSessionActivationPort({
      ownerLarkAppId: 'cli_owner',
      activeSessions: registry,
      forkWorker: fork,
    });

    expect(port.begin(request('unknown'))).toEqual({
      kind: 'quarantined',
      message: 'persistent backend observation is unknown',
    });
    expect(port.begin({
      sessionId: 'session-1',
      requestIdentity: 'ordinary-after-unknown',
      goal: {
        kind: 'ensure',
        cause: 'ordinary',
        input: { promptInput: 'must not fork', resumeOrTurnId: true },
      },
    })).toEqual({
      kind: 'quarantined',
      message: 'persistent backend binding is quarantined pending an explicit re-probe',
    });
    expect(fork).not.toHaveBeenCalled();

    const reprobe = port.begin(request('exists'));
    expect(reprobe.kind).toBe('effect');
    if (reprobe.kind !== 'effect') throw new Error('expected effect');
    const value = await port.execute(reprobe.intent);
    expect(port.resume(reprobe.continuation, { kind: 'returned', value })).toEqual({
      kind: 'active',
      action: 'reattached',
    });
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it('passes adapter-specific activation input unchanged and fences replacement', async () => {
    const ds = session();
    const registry = new Map([[activeSessionKey(ds), ds]]);
    const fork = vi.fn(() => true);
    const port = createCurrentSessionActivationPort({
      ownerLarkAppId: 'cli_owner',
      activeSessions: registry,
      forkWorker: fork,
    });
    const activation: SessionActivationRequest = {
      sessionId: 'session-1',
      requestIdentity: 'codex-app-1',
      goal: {
        kind: 'ensure',
        cause: 'ordinary',
        input: {
          promptInput: { content: 'hello', codexAppSteerable: true },
          resumeOrTurnId: {
            resume: true,
            turnId: 'turn-1',
            dispatchAttempt: 7,
            codexAppInputGateFrozen: true,
          },
        },
      },
    };
    const begun = port.begin(activation);
    if (begun.kind !== 'effect') throw new Error('expected effect');
    const value = await port.execute(begun.intent);
    expect(fork).toHaveBeenCalledWith(
      ds,
      { content: 'hello', codexAppSteerable: true },
      {
        resume: true,
        turnId: 'turn-1',
        dispatchAttempt: 7,
        codexAppInputGateFrozen: true,
      },
    );

    const replacement = session();
    registry.set(activeSessionKey(ds), replacement);
    expect(port.resume(begun.continuation, { kind: 'returned', value })).toEqual({
      kind: 'stale',
      message: 'Current Session binding changed during activation',
    });
  });
});
