import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listOnlineDaemonsMock, fetchDaemonIpcMock } = vi.hoisted(() => ({
  listOnlineDaemonsMock: vi.fn(),
  fetchDaemonIpcMock: vi.fn(),
}));

vi.mock('../src/utils/daemon-discovery.js', () => ({
  listOnlineDaemons: (...args: any[]) => listOnlineDaemonsMock(...args),
}));

vi.mock('../src/core/daemon-ipc-auth.js', () => ({
  fetchDaemonIpc: (...args: any[]) => fetchDaemonIpcMock(...args),
}));

vi.mock('../src/bot-registry.js', async () => {
  const actual = await vi.importActual<typeof import('../src/bot-registry.js')>('../src/bot-registry.js');
  return { ...actual, getOwnerOpenId: vi.fn(() => 'ou_owner') };
});

import {
  countHostOverload,
  handleCardAction,
  sweepHostOverload,
} from '../src/im/lark/card-handler.js';
import {
  OVERLOAD_ACTION_CLEAN_STOPPED,
  type OverloadCardState,
} from '../src/core/host-overload-alert.js';
import {
  _resetOverloadNoncesForTest,
  claimOverloadNonce,
  registerOverloadNonce,
} from '../src/im/lark/overload-nonce.js';

const daemons = [
  { larkAppId: 'cli_a', ipcPort: 7101, bootInstanceId: 'boot-cli-a-1' },
  { larkAppId: 'cli_b', ipcPort: 7102, bootInstanceId: 'boot-cli-b-1' },
];

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  _resetOverloadNoncesForTest();
  listOnlineDaemonsMock.mockReset();
  fetchDaemonIpcMock.mockReset();
  listOnlineDaemonsMock.mockReturnValue(daemons);
});

describe('host-overload card actions across bot-scoped daemons', () => {
  it('retries initial inventory read failure under the same reserved operation hash', async () => {
    listOnlineDaemonsMock
      .mockImplementationOnce(() => { throw new Error('descriptor directory temporarily unreadable'); })
      .mockReturnValueOnce([daemons[0]]);
    fetchDaemonIpcMock.mockResolvedValue(response({ ok: true, affected: 2 }));

    await expect(sweepHostOverload('clean_stopped', 'overload-inventory-read-retry'))
      .rejects.toThrow('temporarily unreadable');
    expect(fetchDaemonIpcMock).not.toHaveBeenCalled();
    await expect(sweepHostOverload('suspend_idle', 'overload-inventory-read-retry'))
      .rejects.toThrow('already belongs to mode clean_stopped');
    expect(listOnlineDaemonsMock).toHaveBeenCalledTimes(1);

    await expect(sweepHostOverload('clean_stopped', 'overload-inventory-read-retry'))
      .resolves.toBe(2);
    expect(listOnlineDaemonsMock).toHaveBeenCalledTimes(2);
    expect(fetchDaemonIpcMock).toHaveBeenCalledTimes(1);
  });

  it('retries an initially empty inventory before any batch has been frozen', async () => {
    listOnlineDaemonsMock
      .mockReturnValueOnce([])
      .mockReturnValueOnce([daemons[0]]);
    fetchDaemonIpcMock.mockResolvedValue(response({ ok: true, affected: 4 }));

    await expect(sweepHostOverload('clean_stopped', 'overload-empty-inventory-retry'))
      .rejects.toThrow('no online daemon');
    expect(fetchDaemonIpcMock).not.toHaveBeenCalled();

    await expect(sweepHostOverload('clean_stopped', 'overload-empty-inventory-retry'))
      .resolves.toBe(4);
    expect(listOnlineDaemonsMock).toHaveBeenCalledTimes(2);
    expect(fetchDaemonIpcMock).toHaveBeenCalledTimes(1);
  });

  it('publishes the operation receipt before daemon discovery can re-enter', async () => {
    let follower: Promise<number> | undefined;
    listOnlineDaemonsMock.mockImplementation(() => {
      follower ??= sweepHostOverload('clean_stopped', 'overload-listing-reentrant');
      return [daemons[0]];
    });
    fetchDaemonIpcMock.mockResolvedValue(response({ ok: true, affected: 3 }));

    await expect(sweepHostOverload('clean_stopped', 'overload-listing-reentrant'))
      .resolves.toBe(3);
    await expect(follower).resolves.toBe(3);
    expect(listOnlineDaemonsMock).toHaveBeenCalledTimes(1);
    expect(fetchDaemonIpcMock).toHaveBeenCalledTimes(1);
  });

  it('reserves one operation identity for exactly one sweep mode', async () => {
    listOnlineDaemonsMock.mockReturnValue([daemons[0]]);
    fetchDaemonIpcMock.mockResolvedValue(errorResponse(503, { ok: false }));

    await expect(sweepHostOverload('clean_stopped', 'overload-mode-conflict'))
      .rejects.toThrow('did not ack');
    const listingsAfterFirstAttempt = listOnlineDaemonsMock.mock.calls.length;
    const sendsAfterFirstAttempt = fetchDaemonIpcMock.mock.calls.length;

    await expect(sweepHostOverload('suspend_idle', 'overload-mode-conflict'))
      .rejects.toThrow('already belongs to mode clean_stopped');
    expect(listOnlineDaemonsMock).toHaveBeenCalledTimes(listingsAfterFirstAttempt);
    expect(fetchDaemonIpcMock).toHaveBeenCalledTimes(sendsAfterFirstAttempt);
  });

  it('sums stopped and idle candidates from every daemon', async () => {
    fetchDaemonIpcMock.mockImplementation(async (port: number, path: string) => {
      expect(path).toBe('/api/host-overload/counts');
      return response(port === 7101
        ? { ok: true, stopped: 2, idle: 4 }
        : { ok: true, stopped: 3, idle: 5 });
    });

    await expect(countHostOverload()).resolves.toEqual({ stopped: 5, idle: 9 });
  });

  it('cleans every daemon and reports the summed affected count', async () => {
    fetchDaemonIpcMock.mockImplementation(async (port: number, path: string) => {
      if (path === '/api/host-overload/sweep') {
        return response({ ok: true, affected: port === 7101 ? 0 : 5 });
      }
      if (path === '/api/host-overload/counts') {
        return response({ ok: true, stopped: 0, idle: port === 7101 ? 4 : 5 });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const state: OverloadCardState = {
      nonce: 'nonce-clean-all',
      load15: 30,
      cpu: 10,
      mem: 0.95,
      reasons: ['load', 'memory'],
      stopped: 5,
      idle: 9,
      cleanedN: -1,
      suspendedN: -1,
    };
    registerOverloadNonce(state.nonce);

    const result = await handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: OVERLOAD_ACTION_CLEAN_STOPPED,
          st: JSON.stringify(state),
        },
      },
    }, {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
    } as any, 'cli_alert');

    const sweepCalls = fetchDaemonIpcMock.mock.calls.filter(([, path]) => path === '/api/host-overload/sweep');
    expect(sweepCalls.map(([port]) => port).sort()).toEqual([7101, 7102]);
    expect(JSON.stringify(result)).toContain('✓ 已清理 5 个僵尸');
    expect(JSON.stringify(result)).toContain('僵尸会话 0 个');
  });

  // Regression: a partial fan-out failure must NOT be reported as a completed
  // sweep. Field scenario — daemon A holds no zombies and acks 0, daemon B holds
  // 5 but its request fails (500 / network reject). If we treat `ok >= 1` as
  // success we'd burn the button to "✓ 已清理 0 个僵尸" (disabled) while B's 5
  // zombies survive, and the one-shot nonce + 15min re-alert gate leave the owner
  // no retry — the very "显示 0、实际没清" symptom this PR exists to kill.
  it('fails the whole action (retriable) when any discovered daemon does not ack', async () => {
    fetchDaemonIpcMock.mockImplementation(async (port: number, path: string) => {
      if (path === '/api/host-overload/sweep') {
        if (port === 7101) return response({ ok: true, affected: 0 });
        return errorResponse(500, { ok: false, error: 'boom' }); // daemon B (holds the zombies) fails
      }
      if (path === '/api/host-overload/counts') {
        return response({ ok: true, stopped: port === 7101 ? 0 : 5, idle: 0 });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const state: OverloadCardState = {
      nonce: 'nonce-partial-fail',
      load15: 30,
      cpu: 10,
      mem: 0.95,
      reasons: ['load', 'memory'],
      stopped: 5,
      idle: 0,
      cleanedN: -1,
      suspendedN: -1,
    };
    registerOverloadNonce(state.nonce);

    const result = await handleCardAction({
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: OVERLOAD_ACTION_CLEAN_STOPPED,
          st: JSON.stringify(state),
        },
      },
    }, {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
    } as any, 'cli_alert');

    // Both daemons were attempted (fan-out still happens).
    const sweepCalls = fetchDaemonIpcMock.mock.calls.filter(([, path]) => path === '/api/host-overload/sweep');
    expect(sweepCalls.map(([port]) => port).sort()).toEqual([7101, 7102]);

    // Must surface as a failure toast, NOT a completed card.
    expect(JSON.stringify(result)).not.toContain('✓ 已清理');
    expect(result?.toast?.type).toBe('error');

    // The nonce must be released so the owner can click the button again.
    expect(claimOverloadNonce(state.nonce, OVERLOAD_ACTION_CLEAN_STOPPED)).toBe(true);
  });

  it('quarantines a partial sweep when its unresolved Bot has moved to another daemon epoch', async () => {
    const state: OverloadCardState = {
      nonce: 'nonce-fixed-daemon-batch',
      load15: 30,
      cpu: 10,
      mem: 0.95,
      reasons: ['load', 'memory'],
      stopped: 3,
      idle: 0,
      cleanedN: -1,
      suspendedN: -1,
    };
    registerOverloadNonce(state.nonce);
    fetchDaemonIpcMock.mockImplementation(async (port: number, path: string) => {
      if (path !== '/api/host-overload/sweep') {
        throw new Error(`unexpected path: ${path}`);
      }
      if (port === 7101) return response({ ok: true, affected: 1 });
      if (port === 7102) return errorResponse(503, { ok: false, error: 'temporarily_unavailable' });
      return response({ ok: true, affected: 99 });
    });
    const action = {
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: OVERLOAD_ACTION_CLEAN_STOPPED,
          st: JSON.stringify(state),
        },
      },
    };
    const deps = {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
    } as any;

    await expect(handleCardAction(action, deps, 'cli_alert'))
      .resolves.toMatchObject({ toast: { type: 'error' } });
    expect(fetchDaemonIpcMock.mock.calls
      .filter(([, path]) => path === '/api/host-overload/sweep')
      .map(([port]) => port)
      .sort()).toEqual([7101, 7102]);

    listOnlineDaemonsMock.mockReturnValue([
      { larkAppId: 'cli_a', ipcPort: 7201, bootInstanceId: 'boot-cli-a-2' },
      { larkAppId: 'cli_b', ipcPort: 7202, bootInstanceId: 'boot-cli-b-2' },
      { larkAppId: 'cli_c', ipcPort: 7301, bootInstanceId: 'boot-cli-c-1' },
    ]);
    await expect(handleCardAction(action, deps, 'cli_alert'))
      .resolves.toMatchObject({ toast: { type: 'error' } });

    // A already ACKed and C was not in the first fixed plan. B's changed boot
    // identity makes the old operation uncertain; none may receive the old id.
    expect(fetchDaemonIpcMock.mock.calls
      .filter(([, path]) => path === '/api/host-overload/sweep')
      .map(([port]) => port)
      .sort()).toEqual([7101, 7102]);
  });

  it('retries only unresolved original epochs and preserves their accumulated count', async () => {
    const state: OverloadCardState = {
      nonce: 'nonce-fixed-daemon-retry',
      load15: 30,
      cpu: 10,
      mem: 0.95,
      reasons: ['load', 'memory'],
      stopped: 6,
      idle: 0,
      cleanedN: -1,
      suspendedN: -1,
    };
    registerOverloadNonce(state.nonce);
    let daemonBAttempts = 0;
    fetchDaemonIpcMock.mockImplementation(async (port: number, path: string) => {
      if (path === '/api/host-overload/counts') {
        return response({ ok: true, stopped: 0, idle: 0 });
      }
      if (path !== '/api/host-overload/sweep') {
        throw new Error(`unexpected path: ${path}`);
      }
      if (port === 7101) return response({ ok: true, affected: 2 });
      if (port === 7102 && daemonBAttempts++ === 0) {
        return errorResponse(503, { ok: false, error: 'temporarily_unavailable' });
      }
      if (port === 7102) return response({ ok: true, affected: 4 });
      return response({ ok: true, affected: 99 });
    });
    const action = {
      operator: { open_id: 'ou_owner' },
      action: {
        value: {
          action: OVERLOAD_ACTION_CLEAN_STOPPED,
          st: JSON.stringify(state),
        },
      },
    };
    const deps = {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      lastRepoScan: new Map(),
    } as any;

    await expect(handleCardAction(action, deps, 'cli_alert'))
      .resolves.toMatchObject({ toast: { type: 'error' } });
    listOnlineDaemonsMock.mockReturnValue([
      { larkAppId: 'cli_a', ipcPort: 7201, bootInstanceId: 'boot-cli-a-2' },
      { larkAppId: 'cli_b', ipcPort: 7102, bootInstanceId: 'boot-cli-b-1' },
      { larkAppId: 'cli_c', ipcPort: 7301, bootInstanceId: 'boot-cli-c-1' },
    ]);

    const retried = await handleCardAction(action, deps, 'cli_alert');
    expect(JSON.stringify(retried)).toContain('✓ 已清理 6 个僵尸');
    expect(fetchDaemonIpcMock.mock.calls
      .filter(([, path]) => path === '/api/host-overload/sweep')
      .map(([port]) => port)).toEqual([7101, 7102, 7102]);
  });
});
