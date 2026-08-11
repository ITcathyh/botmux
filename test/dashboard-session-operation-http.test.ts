import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  setDashboardSessionRuntimeSubmitter,
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { cliAuthBind, signCliAuth } from '../src/dashboard/auth.js';

let server: IpcServerHandle;

beforeAll(async () => {
  server = await startIpcServer({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  setDashboardSessionRuntimeSubmitter(null);
  setIpcAuthSecret(null);
});

function request(
  method: 'POST' | 'PUT',
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  });
}

function post(path: string, body?: string, headers: Record<string, string> = {}): Promise<Response> {
  return request('POST', path, body, headers);
}

const mutationRoutes = [
  ['POST', '/api/sessions/s/close'],
  ['POST', '/api/sessions/s/prune'],
  ['POST', '/api/sessions/s/restart'],
  ['POST', '/api/sessions/s/suspend'],
  ['POST', '/api/sessions/s/resume'],
  ['POST', '/api/sessions/s/rename'],
  ['POST', '/api/sessions/s/chat-rename'],
  ['POST', '/api/sessions/s/board'],
  ['POST', '/api/sessions/s/whiteboard'],
  ['POST', '/api/sessions/s/start'],
  ['POST', '/api/sessions/s/lock'],
  ['POST', '/api/sessions/s/cd'],
  ['POST', '/api/sessions/s/slash'],
  ['POST', '/api/sessions/spawn'],
  ['POST', '/api/sessions/migrate-to-chat'],
  ['POST', '/api/host-overload/sweep'],
  ['PUT', '/api/bot-agent'],
] as const;

describe('Dashboard session operation request hardening', () => {
  it.each(mutationRoutes)('%s %s rejects a non-empty malformed JSON body', async (method, path) => {
    const response = await request(method, path, '{not-json');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it.each(mutationRoutes)('%s %s rejects an explicit invalid body operation ID', async (method, path) => {
    const response = await request(method, path, JSON.stringify({ operationId: 42 }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'bad_operation_id' });
  });

  it.each(mutationRoutes)('%s %s requires an explicit body or header operation ID', async (method, path) => {
    const response = await request(method, path, JSON.stringify({}));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'bad_operation_id' });
  });

  it('rejects an explicit invalid operation header instead of replacing it', async () => {
    const response = await post('/api/sessions/s/restart', undefined, {
      'x-botmux-operation-id': 'x'.repeat(257),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'bad_operation_id' });
  });

  it('rejects valid but conflicting body and header operation IDs', async () => {
    const response = await post(
      '/api/sessions/s/restart',
      JSON.stringify({ operationId: 'body-operation' }),
      { 'x-botmux-operation-id': 'header-operation' },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'bad_operation_id' });
  });

  it('accepts a valid header-only operation identity', async () => {
    const response = await post('/api/sessions/s/restart', undefined, {
      'x-botmux-operation-id': 'header-only-operation',
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'session_runtime_not_ready' });
  });
});

describe('Dashboard Session mutation wire contract', () => {
  const operationId = 'wire-contract-operation';
  const details = { owner: 'cli_owner', lifecycle: 'active' };

  async function invoke(
    path: string,
    fields: Record<string, unknown>,
    outcome: Record<string, unknown>,
    authenticated = false,
  ): Promise<Response> {
    setDashboardSessionRuntimeSubmitter(vi.fn(async () => outcome as any));
    const body = JSON.stringify({ operationId, ...fields });
    if (!authenticated) return post(path, body);

    const secret = 'wire-contract-secret';
    setIpcAuthSecret(secret);
    const trusted = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    try {
      const auth = signCliAuth(secret, cliAuthBind('POST', path, trusted.port));
      return await fetch(`http://127.0.0.1:${trusted.port}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Botmux-Cli-Ts': auth.ts,
          'X-Botmux-Cli-Nonce': auth.nonce,
          'X-Botmux-Cli-Auth': auth.sig,
        },
        body,
      });
    } finally {
      await trusted.close();
    }
  }

  it.each([
    ['/api/sessions/s/board', { column: 'backlog' }, false],
    ['/api/sessions/s/whiteboard', { whiteboardId: 'wb-1' }, false],
    ['/api/sessions/s/start', {}, false],
    ['/api/sessions/s/rename', { title: 'renamed' }, true],
    ['/api/sessions/s/lock', { locked: true }, false],
  ] as const)('%s maps missing Runtime binding to 404 session_not_found with details', async (
    path,
    fields,
    authenticated,
  ) => {
    const response = await invoke(path, fields, {
      kind: 'rejected',
      reason: 'sessionNotFound',
      message: 'Current Session is not owned by this Runtime Host',
      details,
    }, authenticated);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'session_not_found', ...details });
  });

  it.each([
    ['/api/sessions/s/restart', {}],
    ['/api/sessions/s/suspend', {}],
  ] as const)('%s maps a non-active Runtime binding to 404 session_not_active', async (path, fields) => {
    const response = await invoke(path, fields, {
      kind: 'rejected',
      reason: 'transitionRejected',
      code: 'session_not_active',
      message: 'Current Session is not active in the owner registry',
      details,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'session_not_active', ...details });
  });

  it('maps a missing resume target to 404 not_found', async () => {
    const response = await invoke('/api/sessions/s/resume', {}, {
      kind: 'rejected',
      reason: 'sessionNotFound',
      message: 'Current Session is not owned by this Runtime Host',
      details,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'not_found', ...details });
  });

  it('maps a non-closed resume target to 409 not_closed', async () => {
    const response = await invoke('/api/sessions/s/resume', {}, {
      kind: 'rejected',
      reason: 'transitionRejected',
      code: 'not_closed',
      message: 'Current Session is not closed',
      details,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'not_closed', ...details });
  });

  it('maps unknown Runtime delivery to a stable code without exposing its message', async () => {
    const response = await invoke('/api/sessions/s/board', { column: 'backlog' }, {
      kind: 'quarantined',
      message: 'worker response disappeared after the write',
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'dispatch_unknown' });
  });
});
