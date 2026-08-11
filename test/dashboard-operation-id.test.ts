import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_OPERATION_PROXY_BODY_MAX_BYTES,
  SessionOperationProxyBodyTooLargeError,
  sessionOperationProxyInit,
} from '../src/dashboard/http.js';
import {
  createSessionOperationId,
  SemanticOperationCoordinator,
  semanticOperationDisposition,
} from '../src/dashboard/web/operation-id.js';

function incoming(body: string, headers: IncomingMessage['headers'] = {}): IncomingMessage {
  const request = Readable.from(body.length > 0 ? [Buffer.from(body)] : []) as unknown as IncomingMessage;
  request.headers = headers;
  return request;
}

describe('createSessionOperationId', () => {
  it('uses randomUUID when the browser exposes it', () => {
    const randomUUID = vi.fn(() => 'uuid-value');
    expect(createSessionOperationId('close', 's-1', { randomUUID }))
      .toBe('close:s-1:uuid-value');
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it('falls back to getRandomValues when randomUUID is unavailable', () => {
    const getRandomValues = vi.fn((array: Uint8Array) => {
      array.fill(0xab);
      return array;
    });
    expect(createSessionOperationId('restart', 's-2', { getRandomValues } as any))
      .toBe(`restart:s-2:${'ab'.repeat(16)}`);
  });

  it('still creates distinct IDs when browser crypto is unavailable', () => {
    const first = createSessionOperationId('resume', 's-3', {});
    const second = createSessionOperationId('resume', 's-3', {});
    expect(first).toMatch(/^resume:s-3:/);
    expect(second).toMatch(/^resume:s-3:/);
    expect(second).not.toBe(first);
  });
});

describe('SemanticOperationCoordinator', () => {
  it('reuses retryable identities and clears known terminal outcomes', () => {
    let sequence = 0;
    const operations = new SemanticOperationCoordinator(
      (kind, target) => `${kind}:${target}:${++sequence}`,
    );
    const first = operations.begin('restart', 's-1', { reason: 'operator' });
    expect(first.kind).toBe('ready');
    operations.finish(first, 'retryable');
    const retry = operations.begin('restart', 's-1', { reason: 'operator' });
    expect(retry).toMatchObject({ kind: 'ready', operationId: first.operationId });
    operations.finish(retry, 'completed');
    expect(operations.begin('restart', 's-1', { reason: 'operator' }).operationId)
      .not.toBe(first.operationId);
  });

  it('locks an unknown semantic request until reconciliation or semantic change', () => {
    let sequence = 0;
    const operations = new SemanticOperationCoordinator(
      (kind, target) => `${kind}:${target}:${++sequence}`,
    );
    const first = operations.begin('close', 's-1', {});
    operations.finish(first, 'unknown');

    expect(operations.begin('close', 's-1', {})).toEqual({
      kind: 'blocked',
      operationId: first.operationId,
      reason: 'outcome_unknown',
    });
    const changed = operations.begin('close', 's-1', { lifecycle: 2 });
    expect(changed.kind).toBe('ready');
    expect(changed.operationId).not.toBe(first.operationId);

    operations.finish(changed, 'unknown');
    operations.reconcile('close', 's-1');
    expect(operations.begin('close', 's-1', { lifecycle: 2 }).operationId)
      .not.toBe(changed.operationId);
  });

  it('classifies response-loss and quarantined outcomes without allowing a new key', () => {
    expect(semanticOperationDisposition({ status: 200, body: { ok: true } }))
      .toBe('completed');
    expect(semanticOperationDisposition({ status: 503, body: { ok: false, error: 'dispatch_retryable' } }))
      .toBe('retryable');
    expect(semanticOperationDisposition({ status: 503, body: { ok: false, error: 'session_runtime_not_ready' } }))
      .toBe('retryable');
    expect(semanticOperationDisposition({ status: 503, body: { ok: false, error: 'agent_change_pending' } }))
      .toBe('retryable');
    expect(semanticOperationDisposition({ status: 409, body: { ok: false, error: 'session_transferring' } }))
      .toBe('retryable');
    expect(semanticOperationDisposition({ status: 503, body: { ok: false, error: 'dispatch_unknown' } }))
      .toBe('unknown');
    expect(semanticOperationDisposition({ status: 503, body: { ok: false, error: 'agent_change_outcome_unknown' } }))
      .toBe('unknown');
    expect(semanticOperationDisposition({ transportError: true })).toBe('unknown');
    expect(semanticOperationDisposition({ status: 500, body: null }))
      .toBe('unknown');
    expect(semanticOperationDisposition({ status: 409, body: { ok: false, error: 'not_closed' } }))
      .toBe('completed');
  });

  it('keeps a 200 idle-cleanup partial unknown locked and a partial retryable on the same key', () => {
    let sequence = 0;
    const unknownOperations = new SemanticOperationCoordinator(
      (kind, target) => `${kind}:${target}:${++sequence}`,
    );
    const unknown = unknownOperations.begin('cleanup-idle', 'selection', {
      olderThanHours: 24,
      sessionIds: ['s-1', 's-2'],
    });
    unknownOperations.finish(unknown, semanticOperationDisposition({
      status: 200,
      body: {
        closed: 1,
        failed: 1,
        results: [
          { sessionId: 's-1', ok: true },
          { sessionId: 's-2', ok: false, error: 'dispatch_unknown' },
        ],
      },
    }));
    expect(unknownOperations.begin('cleanup-idle', 'selection', {
      olderThanHours: 24,
      sessionIds: ['s-1', 's-2'],
    })).toMatchObject({ kind: 'blocked', operationId: unknown.operationId });

    const retryOperations = new SemanticOperationCoordinator(
      (kind, target) => `${kind}:${target}:${++sequence}`,
    );
    const retryable = retryOperations.begin('cleanup-idle', 'selection', {
      olderThanHours: 24,
      sessionIds: ['s-3'],
    });
    retryOperations.finish(retryable, semanticOperationDisposition({
      status: 200,
      body: {
        closed: 0,
        failed: 1,
        results: [{ sessionId: 's-3', ok: false, error: 'dispatch_retryable' }],
      },
    }));
    expect(retryOperations.begin('cleanup-idle', 'selection', {
      olderThanHours: 24,
      sessionIds: ['s-3'],
    })).toMatchObject({ kind: 'ready', operationId: retryable.operationId });
  });

  it('treats a 200 opaque failure as unknown but clears explicit success and known rejection', () => {
    expect(semanticOperationDisposition({ status: 200, body: { ok: false } }))
      .toBe('unknown');
    expect(semanticOperationDisposition({
      status: 200,
      body: { ok: false, error: 'not_closed' },
    })).toBe('completed');
    expect(semanticOperationDisposition({ status: 200, body: { error: 'not_closed' } }))
      .toBe('completed');
    expect(semanticOperationDisposition({ status: 200, body: { ok: true } }))
      .toBe('completed');
  });

  it.each([
    ['create', 'dashboard', { request: 'new Session' }, { ok: false }],
    ['close', 's-1', {}, { ok: false, error: 'dispatch_unknown' }],
  ] as const)('keeps the %s caller identity locked after a 200 unknown body', (
    kind,
    target,
    semantic,
    body,
  ) => {
    const operations = new SemanticOperationCoordinator((k, t) => `${k}:${t}:stable`);
    const first = operations.begin(kind, target, semantic);
    operations.finish(first, semanticOperationDisposition({ status: 200, body }));

    expect(operations.begin(kind, target, semantic)).toMatchObject({
      kind: 'blocked',
      operationId: first.operationId,
    });
  });
});

describe('sessionOperationProxyInit', () => {
  it('forwards the JSON body, content type, and operation header exactly', async () => {
    const raw = ' {\n  "operationId": "browser-op-1"\n}\n';
    const init = await sessionOperationProxyInit(incoming(raw, {
      'content-type': 'application/json; charset=utf-8',
      'x-botmux-operation-id': 'header-op-1',
    }), true);
    const headers = new Headers(init.headers);

    expect(init).toMatchObject({ method: 'POST', body: raw });
    expect(headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(headers.get('x-botmux-operation-id')).toBe('header-op-1');
  });

  it('can preserve a bounded Agent mutation as PUT', async () => {
    const raw = '{"operationId":"agent-op-1","cliId":"codex"}';
    const init = await sessionOperationProxyInit(incoming(raw, {
      'content-type': 'application/json',
      'x-botmux-operation-id': 'agent-op-1',
    }), true, 'PUT');

    expect(init).toMatchObject({ method: 'PUT', body: raw });
    expect(new Headers(init.headers).get('x-botmux-operation-id')).toBe('agent-op-1');
  });

  it('preserves a bodyless request only with its explicit operation header', async () => {
    const init = await sessionOperationProxyInit(incoming('', {
      'x-botmux-operation-id': 'bodyless-explicit-op',
    }), true);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-botmux-operation-id')).toBe('bodyless-explicit-op');
  });

  it('keeps locate bodyless while forwarding an explicit operation header', async () => {
    const init = await sessionOperationProxyInit(incoming('{"ignored":true}', {
      'content-type': 'application/json',
      'x-botmux-operation-id': 'locate-op',
    }), false);
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get('x-botmux-operation-id')).toBe('locate-op');
  });

  it('rejects an oversized chunked forwarded body without unbounded buffering', async () => {
    const body = 'x'.repeat(SESSION_OPERATION_PROXY_BODY_MAX_BYTES + 1);
    await expect(sessionOperationProxyInit(incoming(body), true))
      .rejects.toBeInstanceOf(SessionOperationProxyBodyTooLargeError);
  });

  it('is used by both dashboard session-mutation proxy families', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/dashboard.ts', import.meta.url)), 'utf8');
    const simpleOperations = source.match(
      /\(close\|locate\|resume\|restart\|start\)[\s\S]*?sessionOperationProxyInit\(req, op !== 'locate'\)/,
    );
    const jsonOperations = source.match(
      /\(board\|rename\|lock\)[\s\S]*?sessionOperationProxyInit\(req, true\)/,
    );
    const agentOperation = source.match(
      /mBotAgent[\s\S]*?sessionOperationProxyInit\(req, true, 'PUT'\)/,
    );

    expect(simpleOperations).not.toBeNull();
    expect(jsonOperations).not.toBeNull();
    expect(agentOperation).not.toBeNull();
  });

  it('wires the shared semantic coordinator through all interactive Session and Agent mutations', () => {
    const sessionsSource = readFileSync(
      fileURLToPath(new URL('../src/dashboard/web/sessions-page.tsx', import.meta.url)),
      'utf8',
    );
    for (const kind of ['board', 'rename', 'close', 'lock', 'restart', 'resume', 'start']) {
      expect(sessionsSource).toContain(`beginSemanticOperation('${kind}'`);
    }
    for (const kind of ['bulk-close', 'bulk-lock', 'cleanup-idle']) {
      expect(sessionsSource).toContain(`beginSemanticOperation('${kind}'`);
    }
    expect(sessionsSource).toContain("createOperations.current.begin('create', 'dashboard', request)");
    expect(sessionsSource).toContain("'x-botmux-operation-id': operation.operationId");
    expect(sessionsSource).not.toContain("createSessionOperationId('bulk-");
    const agentSource = readFileSync(
      fileURLToPath(new URL('../src/dashboard/web/bot-defaults-page.tsx', import.meta.url)),
      'utf8',
    );
    expect(agentSource.match(/agentOperations\.current\.begin\(/g)).toHaveLength(2);
  });
});
