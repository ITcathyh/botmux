import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  setDashboardSessionRuntimeSubmitter,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';

let server: IpcServerHandle | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  setDashboardSessionRuntimeSubmitter(null);
  setLarkAppId('');
  vi.restoreAllMocks();
});

describe('GET /api/sessions/:sessionId/trigger-result Current authority', () => {
  it('returns the owner-bound lane convergence result without mutating in the query handler', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 'session-trigger', larkAppId: 'cli_trigger_owner' },
      larkAppId: 'cli_trigger_owner',
      chatId: 'http_async_chat',
      latestAsyncTriggerId: 'trg_faulted',
      asyncTriggerResults: new Map([['trg_faulted', { status: 'pending', createdAt: 1 }]]),
      idempotentAsyncTurns: new Map([['trg_faulted', {
        ownerLarkAppId: 'cli_trigger_owner',
        postBarrierFault: true,
      }]]),
    } as never);
    const submit = vi.fn(async () => ({
      kind: 'applied' as const,
      action: 'control.mutated' as const,
      policy: 'control-staged-transition' as const,
      sessionId: 'session-trigger',
      result: {
        kind: 'asyncTriggerFaultConverged' as const,
        state: 'failed' as const,
        triggerId: 'trg_faulted',
        chatId: 'http_async_chat',
      },
    }));
    setDashboardSessionRuntimeSubmitter(submit as never);
    setLarkAppId('cli_trigger_owner');
    server = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/session-trigger/trigger-result?triggerId=trg_faulted`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      state: 'failed',
      triggerId: 'trg_faulted',
      target: {
        kind: 'turn',
        sessionId: 'session-trigger',
        chatId: 'http_async_chat',
      },
      errorCode: 'no_output',
    });
    expect(submit).toHaveBeenCalledWith({
      target: { kind: 'externalSession', sessionId: 'session-trigger' },
      idempotencyKey: 'trigger-result-fault:trg_faulted',
      command: {
        kind: 'control.mutate',
        input: { kind: 'convergeAsyncTriggerFault', triggerId: 'trg_faulted' },
      },
    });
  });

  it('keeps an unknown convergence retryable in actor state and serves the ordinary read projection', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 'session-trigger', larkAppId: 'cli_trigger_owner' },
      larkAppId: 'cli_trigger_owner',
      chatId: 'http_async_chat',
      latestAsyncTriggerId: 'trg_faulted',
      asyncTriggerResults: new Map([['trg_faulted', { status: 'pending', createdAt: 1 }]]),
      idempotentAsyncTurns: new Map([['trg_faulted', {
        ownerLarkAppId: 'cli_trigger_owner',
        postBarrierFault: true,
      }]]),
    } as never);
    const submit = vi.fn(async () => ({
      kind: 'retryable' as const,
      message: 'durable settlement unknown',
    }));
    setDashboardSessionRuntimeSubmitter(submit as never);
    setLarkAppId('cli_trigger_owner');
    server = await startIpcServer({ port: 0, host: '127.0.0.1' });

    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions/session-trigger/trigger-result`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      state: 'running',
    });
    expect(submit).toHaveBeenCalledOnce();
  });
});
