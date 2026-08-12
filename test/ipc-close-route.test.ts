// POST /api/sessions/:sessionId/close route-level authorization matrix.
// Trusted host callers retain dashboard/admin behavior; an untrusted in-session
// caller may only close the exact live session whose rotating capability it owns.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as currentActivation from '../src/core/current-session-activation.js';
import {
  currentDashboardSessionRegistry,
  installCurrentDashboardSessionRuntimeForTest,
  resetCurrentDashboardSessionRuntimeForTest,
} from './helpers/current-dashboard-session-runtime.js';

const CAP = 'c0ffee12'.repeat(8);
const HOST_SECRET = 'test-ipc-close-host-secret';
let handle: IpcServerHandle | null = null;
let operationSequence = 0;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  resetCurrentDashboardSessionRuntimeForTest();
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

async function postClose(sessionId: string, opts: {
  auth?: 'capability' | 'signed' | 'none';
  authRequired?: boolean;
  capability?: string;
  operationId?: string;
} = {}): Promise<Response> {
  if (!handle) {
    if (opts.authRequired) setIpcAuthSecret(HOST_SECRET);
    handle = await startIpcServer({
      port: 0,
      host: '127.0.0.1',
      ...(opts.authRequired ? { authRequired: true } : {}),
    });
  }
  const auth = opts.auth ?? 'capability';
  const path = `/api/sessions/${sessionId}/close`;
  const body: Record<string, unknown> = {};
  if (auth === 'capability') body.originCapability = opts.capability ?? CAP;
  body.operationId = opts.operationId ?? `test-close-${++operationSequence}`;
  const headers: HeadersInit = auth === 'signed'
    ? daemonIpcAuthHeaders({
      secret: HOST_SECRET,
      port: handle.port,
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
    })
    : { 'content-type': 'application/json' };
  return fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function postPrune(sessionId: string, operationId: string): Promise<Response> {
  if (!handle) {
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  }
  return fetch(`http://127.0.0.1:${handle.port}/api/sessions/${sessionId}/prune`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId }),
  });
}

describe('POST /api/sessions/:sessionId/close', () => {
  it('fails closed when the daemon has not composed its SessionRuntime', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);

    const res = await postClose('missing', {
      auth: 'signed',
      authRequired: true,
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'session_runtime_not_ready',
    });
  });

  it('accepts the exact live session capability and delegates to canonical closeSession', async () => {
    const active = {
      session: {
        sessionId: 's-close',
        chatId: 'oc_close',
        rootMessageId: 'om_close',
        scope: 'thread',
        status: 'active',
      },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-1',
      chatId: 'oc_close',
      scope: 'thread',
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(active);
    const closeSpy = vi.spyOn(workerPool, 'closeSession')
      .mockResolvedValue({ ok: true, alreadyClosed: false, known: true });
    const registry = currentDashboardSessionRegistry(active);
    installCurrentDashboardSessionRuntimeForTest(
      'app-1',
      registry,
    );

    const res = await postClose('s-close', { authRequired: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyClosed: false, known: true });
    expect(closeSpy).toHaveBeenCalledWith('s-close', {
      owner: {
        larkAppId: 'app-1',
        activeSessions: registry,
      },
      isCurrent: expect.any(Function),
    });
  });

  it('translates and replays an unknown backend close failure without running the effect twice', async () => {
    const active = {
      session: {
        sessionId: 's-close-riff-failure',
        chatId: 'oc_close_riff_failure',
        rootMessageId: 'om_close_riff_failure',
        scope: 'thread',
        status: 'active',
        backendType: 'riff',
        riffParentTaskId: 'task-close-riff-failure',
      },
      larkAppId: 'app-1',
      chatId: 'oc_close_riff_failure',
      scope: 'thread',
    } as any;
    const failure = {
      ok: false as const,
      alreadyClosed: false as const,
      error: 'riff_cancel_failed' as const,
      closeDisposition: 'unknown' as const,
      taskId: 'task-close-riff-failure',
    };
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(active);
    const closeSpy = vi.spyOn(workerPool, 'closeSession').mockResolvedValue(failure);
    installCurrentDashboardSessionRuntimeForTest(
      'app-1',
      currentDashboardSessionRegistry(active),
    );
    const request = {
      auth: 'signed' as const,
      authRequired: true,
      operationId: 'close-riff-failure-operation',
    };

    const first = await postClose(active.session.sessionId, request);
    const replay = await postClose(active.session.sessionId, request);

    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ ok: false, error: 'dispatch_unknown' });
    expect(replay.status).toBe(503);
    expect(await replay.json()).toEqual({ ok: false, error: 'dispatch_unknown' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('quarantines a fresh caller operation after an unknown close without driving a second effect', async () => {
    const active = {
      session: {
        sessionId: 's-close-cross-operation-failure',
        chatId: 'oc_close_cross_operation_failure',
        rootMessageId: 'om_close_cross_operation_failure',
        scope: 'thread',
        status: 'active',
        backendType: 'riff',
        riffParentTaskId: 'task-close-cross-operation-failure',
      },
      larkAppId: 'app-1',
      chatId: 'oc_close_cross_operation_failure',
      scope: 'thread',
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(active);
    const closeSpy = vi.spyOn(workerPool, 'closeSession').mockResolvedValue({
      ok: false,
      alreadyClosed: false,
      error: 'riff_cancel_failed',
      closeDisposition: 'unknown',
      taskId: 'task-close-cross-operation-failure',
    } as any);
    installCurrentDashboardSessionRuntimeForTest(
      'app-1',
      currentDashboardSessionRegistry(active),
    );

    const singleClose = await postClose(active.session.sessionId, {
      auth: 'signed',
      authRequired: true,
      operationId: 'close-cross-operation-single',
    });
    const bulkOrCardClose = await postClose(active.session.sessionId, {
      auth: 'signed',
      authRequired: true,
      operationId: 'close-cross-operation-alternate-caller',
    });

    expect(singleClose.status).toBe(503);
    expect(await singleClose.json()).toEqual({ ok: false, error: 'dispatch_unknown' });
    expect(bulkOrCardClose.status).toBe(503);
    expect(await bulkOrCardClose.json()).toEqual({ ok: false, error: 'dispatch_unknown' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('re-drives the same close operation after a proven-open refusal and re-fences a replacement binding', async () => {
    const active = {
      session: {
        sessionId: 's-close-proven-open',
        chatId: 'oc_close_proven_open',
        rootMessageId: 'om_close_proven_open',
        scope: 'thread',
        status: 'active',
        backendType: 'riff',
        riffParentTaskId: 'task-close-proven-open',
      },
      larkAppId: 'app-1',
      chatId: 'oc_close_proven_open',
      scope: 'thread',
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(active);
    const events: string[] = [];
    const closeSpy = vi.spyOn(workerPool, 'closeSession')
      .mockImplementationOnce(async () => {
        events.push('close:first');
        return {
          ok: false,
          alreadyClosed: false,
          error: 'riff_shutdown_fence_in_progress',
          closeDisposition: 'notApplied',
          taskId: 'task-close-proven-open',
        } as any;
      })
      .mockImplementationOnce(async () => {
        events.push('close:replacement');
        return { ok: true, alreadyClosed: false, known: true };
      });
    const retirementRequests: Array<{ requestIdentity: string }> = [];
    const realCoordinator = currentActivation.currentSessionActivationCoordinator;
    vi.spyOn(currentActivation, 'currentSessionActivationCoordinator')
      .mockImplementation((options) => {
        const coordinator = realCoordinator(options);
        return {
          ...coordinator,
          retire: async (request) => {
            events.push(retirementRequests.length === 0 ? 'retire:first' : 'retire:replacement');
            retirementRequests.push(request);
            return coordinator.retire(request);
          },
        };
      });
    const registry = currentDashboardSessionRegistry(active);
    installCurrentDashboardSessionRuntimeForTest('app-1', registry);
    const request = {
      auth: 'signed' as const,
      authRequired: true,
      operationId: 'close-proven-open-operation',
    };

    const first = await postClose(active.session.sessionId, request);
    const replacement = {
      ...active,
      session: { ...active.session },
    } as any;
    registry.clear();
    for (const [key, value] of currentDashboardSessionRegistry(replacement)) {
      registry.set(key, value);
    }
    const replay = await postClose(active.session.sessionId, request);

    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ ok: false, error: 'dispatch_retryable' });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, alreadyClosed: false, known: true });
    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect(retirementRequests).toHaveLength(2);
    expect(retirementRequests[1]!.requestIdentity)
      .not.toBe(retirementRequests[0]!.requestIdentity);
    expect(events).toEqual([
      'retire:first',
      'close:first',
      'retire:replacement',
      'close:replacement',
    ]);
  });

  it('reports an unknown close outcome without a contradictory retryable field and keeps it sticky', async () => {
    const active = {
      session: {
        sessionId: 's-close-unknown',
        chatId: 'oc_close_unknown',
        rootMessageId: 'om_close_unknown',
        scope: 'thread',
        status: 'active',
        backendType: 'riff',
        riffParentTaskId: 'task-close-unknown',
      },
      larkAppId: 'app-1',
      chatId: 'oc_close_unknown',
      scope: 'thread',
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(active);
    const closeSpy = vi.spyOn(workerPool, 'closeSession').mockResolvedValue({
      ok: false,
      alreadyClosed: false,
      error: 'riff_cancel_failed',
      closeDisposition: 'unknown',
      taskId: 'task-close-unknown',
    } as any);
    installCurrentDashboardSessionRuntimeForTest(
      'app-1',
      currentDashboardSessionRegistry(active),
    );
    const request = {
      auth: 'signed' as const,
      authRequired: true,
      operationId: 'close-unknown-operation',
    };

    const first = await postClose(active.session.sessionId, request);
    const replay = await postClose(active.session.sessionId, request);
    const expected = { ok: false, error: 'dispatch_unknown' };

    expect(first.status).toBe(503);
    expect(await first.json()).toEqual(expected);
    expect(replay.status).toBe(503);
    expect(await replay.json()).toEqual(expected);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('fails closed when one close operation identity is reused through another caller payload', async () => {
    const active = {
      session: {
        sessionId: 's-close-payload-conflict',
        chatId: 'oc_close_payload_conflict',
        rootMessageId: 'om_close_payload_conflict',
        scope: 'thread',
        status: 'active',
      },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-1',
      chatId: 'oc_close_payload_conflict',
      scope: 'thread',
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(active);
    const closeSpy = vi.spyOn(workerPool, 'closeSession').mockResolvedValue({
      ok: false,
      alreadyClosed: false,
      error: 'executor_generation_stale',
      closeDisposition: 'notApplied',
    });
    installCurrentDashboardSessionRuntimeForTest(
      'app-1',
      currentDashboardSessionRegistry(active),
    );
    const operationId = 'close-caller-payload-conflict';

    const first = await postClose(active.session.sessionId, {
      auth: 'capability',
      authRequired: true,
      operationId,
    });
    const conflict = await postClose(active.session.sessionId, {
      auth: 'signed',
      authRequired: true,
      operationId,
    });

    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ ok: false, error: 'dispatch_retryable' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ ok: false, error: 'idempotency_conflict' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps a thrown close effect unknown and sticky for the same operation', async () => {
    const active = {
      session: {
        sessionId: 's-close-throw',
        chatId: 'oc_close_throw',
        rootMessageId: 'om_close_throw',
        scope: 'thread',
        status: 'active',
      },
      larkAppId: 'app-1',
      chatId: 'oc_close_throw',
      scope: 'thread',
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(active);
    const closeSpy = vi.spyOn(workerPool, 'closeSession')
      .mockRejectedValue(new Error('close result channel lost'));
    installCurrentDashboardSessionRuntimeForTest(
      'app-1',
      currentDashboardSessionRegistry(active),
    );
    const request = {
      auth: 'signed' as const,
      authRequired: true,
      operationId: 'close-throw-operation',
    };

    const first = await postClose(active.session.sessionId, request);
    const replay = await postClose(active.session.sessionId, request);
    const firstBody = await first.json();

    expect(first.status).toBe(503);
    expect(replay.status).toBe(503);
    expect(await replay.json()).toEqual(firstBody);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing or stale capability without closing anything', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-close-denied' },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-1',
    } as any);
    const closeSpy = vi.spyOn(workerPool, 'closeSession')
      .mockResolvedValue({ ok: true, alreadyClosed: false });

    const missing = await postClose('s-close-denied', {
      auth: 'none',
      authRequired: true,
    });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ ok: false, error: 'origin_unproven' });

    const stale = await postClose('s-close-denied', {
      capability: 'bad0'.repeat(16),
    });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ ok: false, error: 'origin_unproven' });
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('does not reveal whether an unproven target session exists', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);
    const closeSpy = vi.spyOn(workerPool, 'closeSession')
      .mockResolvedValue({ ok: true, alreadyClosed: true });

    const res = await postClose('missing', { authRequired: true });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'origin_unproven' });
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('keeps trusted-host close idempotent for an already missing session', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);
    const closeSpy = vi.spyOn(workerPool, 'closeSession')
      .mockResolvedValue({ ok: true, alreadyClosed: true });
    installCurrentDashboardSessionRuntimeForTest('');

    const res = await postClose('missing', {
      auth: 'signed',
      authRequired: true,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyClosed: true, known: false });
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('denies receiver-session self-close through the ordinary capability aperture', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-receiver', vcMeetingReceiver: { meetingId: 'm' } },
      managedTurnOrigin: { capability: CAP },
      larkAppId: 'app-1',
    } as any);
    const closeSpy = vi.spyOn(workerPool, 'closeSession')
      .mockResolvedValue({ ok: true, alreadyClosed: false });

    const res = await postClose('s-receiver', { authRequired: true });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'managed_action_required' });
    expect(closeSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/:sessionId/prune', () => {
  it('keeps a missing Session at 404 and replays the same operation result', async () => {
    installCurrentDashboardSessionRuntimeForTest('');

    const first = await postPrune('missing-prune', 'missing-prune-operation');
    const replay = await postPrune('missing-prune', 'missing-prune-operation');

    expect(first.status).toBe(404);
    expect(await first.json()).toEqual({ ok: false, error: 'session_not_found' });
    expect(replay.status).toBe(404);
    expect(await replay.json()).toEqual({ ok: false, error: 'session_not_found' });
  });

  it('returns and replays a structured backend refusal as 502', async () => {
    const active = {
      session: {
        sessionId: 's-prune-riff-failure',
        chatId: 'oc_prune_riff_failure',
        rootMessageId: 'om_prune_riff_failure',
        scope: 'thread',
        status: 'active',
        backendType: 'riff',
        riffParentTaskId: 'task-prune-riff-failure',
      },
      larkAppId: 'app-1',
      chatId: 'oc_prune_riff_failure',
      scope: 'thread',
    } as any;
    const failure = {
      ok: false as const,
      alreadyClosed: false as const,
      error: 'riff_close_reconciliation_required' as const,
      closeDisposition: 'unknown' as const,
      taskId: 'task-prune-riff-failure',
    };
    const closeSpy = vi.spyOn(workerPool, 'closeSession').mockResolvedValue(failure);
    installCurrentDashboardSessionRuntimeForTest(
      'app-1',
      currentDashboardSessionRegistry(active),
    );

    const first = await postPrune(active.session.sessionId, 'prune-riff-failure-operation');
    const replay = await postPrune(active.session.sessionId, 'prune-riff-failure-operation');

    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ ok: false, error: 'dispatch_unknown' });
    expect(replay.status).toBe(503);
    expect(await replay.json()).toEqual({ ok: false, error: 'dispatch_unknown' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
