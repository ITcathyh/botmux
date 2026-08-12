import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setDashboardChatRename,
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { createCurrentDashboardChatRename } from '../src/core/current-dashboard-chat-rename.js';
import type { CurrentDashboardSessionCommandSubmitter } from '../src/core/current-dashboard-session-command-client.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import * as workerPool from '../src/core/worker-pool.js';
import { logger } from '../src/utils/logger.js';

const CAP = 'ab12cd34'.repeat(8);
let handle: IpcServerHandle | null = null;
let operationSequence = 0;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  setDashboardChatRename(null);
  vi.restoreAllMocks();
});

function active(ownerLarkAppId: string, chatId: string): DaemonSession {
  return {
    session: {
      sessionId: 's-chat-rename',
      larkAppId: ownerLarkAppId,
      chatId,
      rootMessageId: 'om-chat-rename',
      status: 'active',
      chatDisplayName: 'old',
    },
    managedTurnOrigin: { capability: CAP },
    larkAppId: ownerLarkAppId,
    chatId,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    lastMessageAt: Date.now(),
    hasHistory: true,
    worker: null,
  } as DaemonSession;
}

async function postRename(name: string, operationId?: string): Promise<Response> {
  if (!handle) handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  return fetch(`http://127.0.0.1:${handle.port}/api/sessions/s-chat-rename/chat-rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      proactive: true,
      originCapability: CAP,
      operationId: operationId ?? `test-chat-rename-${++operationSequence}`,
    }),
  });
}

describe('POST /api/sessions/:sessionId/chat-rename', () => {
  it('returns an idempotent success for a proactive same-name retry before applying cooldown', async () => {
    const ownerLarkAppId = 'app-chat-rename-route-test';
    const source = active(ownerLarkAppId, 'oc-chat-rename-route-test');
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(source);

    let currentName = 'old';
    const beforeUpdateCalls: string[] = [];
    const renameChat = vi.fn(async (_appId: string, _chatId: string, newName: string, opts: {
      beforeUpdate?: () => { ok: true } | { ok: false; error: 'rate_limited'; retryAfterSeconds: number };
    }) => {
      if (currentName === newName) {
        return { ok: true as const, oldName: currentName, newName, changed: false };
      }
      beforeUpdateCalls.push(newName);
      const gate = opts?.beforeUpdate?.();
      if (gate && !gate.ok) return { ...gate, oldName: currentName, newName };
      const oldName = currentName;
      currentName = newName;
      return { ok: true as const, oldName, newName, changed: true };
    });
    const submit = vi.fn(async input => ({
      kind: 'applied' as const,
      action: 'control.mutated' as const,
      policy: 'control-staged-transition' as const,
      sessionId: input.target.kind === 'externalSession' ? input.target.sessionId : 'unexpected',
      result: { kind: 'chatDisplayNameUpdated' as const, chatDisplayName: currentName },
    })) as CurrentDashboardSessionCommandSubmitter;
    setDashboardChatRename(createCurrentDashboardChatRename({
      ownerLarkAppId,
      activeSessions: new Map([[activeSessionKey(source), source]]),
      submit,
      renameChat,
      transportEnabled: () => true,
      botOpenId: () => 'ou_test_bot',
    }));

    const first = await postRename('new', 'chat-rename-first');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, changed: true, oldName: 'old', newName: 'new' });

    const sameNameRetry = await postRename('new', 'chat-rename-same-name');
    expect(sameNameRetry.status).toBe(200);
    expect(await sameNameRetry.json()).toMatchObject({ ok: true, changed: false, oldName: 'new', newName: 'new' });

    const differentNameRetry = await postRename('different', 'chat-rename-different-name');
    expect(differentNameRetry.status).toBe(429);
    expect(await differentNameRetry.json()).toMatchObject({
      ok: false,
      error: 'rate_limited',
      oldName: 'new',
      newName: 'different',
    });
    expect(beforeUpdateCalls).toEqual(['new', 'different']);
  });

  it('keeps the rename a success (200) when local cache refresh throws (FR-7)', async () => {
    const ownerLarkAppId = 'app-fr7';
    const source = active(ownerLarkAppId, 'oc-fr7');
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(source);
    const renameChat = vi.fn().mockResolvedValue({
      ok: true, oldName: 'old', newName: 'new', changed: true,
    });
    const submit = vi.fn(async () => {
      throw new Error('ENOSPC: no space left on device');
    }) as CurrentDashboardSessionCommandSubmitter;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    setDashboardChatRename(createCurrentDashboardChatRename({
      ownerLarkAppId,
      activeSessions: new Map([[activeSessionKey(source), source]]),
      submit,
      renameChat,
      transportEnabled: () => true,
      botOpenId: () => 'ou_test_bot',
    }));

    const res = await postRename('new');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true, oldName: 'old', newName: 'new' });
    // The Runtime refresh was actually attempted (proving the catch, not a skip).
    expect(submit).toHaveBeenCalledOnce();
    // FR-7 requires a cache-refresh warning be recorded on failure.
    expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('cache_refresh_failed'))).toBe(true);
  });

  it('replays a stable HTTP operation after response loss without repeating the Lark effect', async () => {
    const ownerLarkAppId = 'app-response-loss';
    const source = active(ownerLarkAppId, 'oc-response-loss');
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(source);
    const renameChat = vi.fn().mockResolvedValue({
      ok: true, oldName: 'old', newName: 'new', changed: true,
    });
    const submit = vi.fn(async () => ({
      kind: 'applied' as const,
      action: 'control.mutated' as const,
      policy: 'control-staged-transition' as const,
      sessionId: 's-chat-rename',
      result: { kind: 'chatDisplayNameUpdated' as const, chatDisplayName: 'new' },
    })) as CurrentDashboardSessionCommandSubmitter;
    setDashboardChatRename(createCurrentDashboardChatRename({
      ownerLarkAppId,
      activeSessions: new Map([[activeSessionKey(source), source]]),
      submit,
      renameChat,
      transportEnabled: () => true,
    }));

    const first = await postRename('new', 'stable-response-loss-op');
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const retry = await postRename('new', 'stable-response-loss-op');
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(firstBody);
    expect(renameChat).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('turns an unauthorized caller away statelessly before any operation receipt is minted', async () => {
    const ownerLarkAppId = 'app-unauthorized-rename';
    const source = active(ownerLarkAppId, 'oc-unauthorized-rename');
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(source);
    const renameChat = vi.fn().mockResolvedValue({
      ok: true, oldName: 'old', newName: 'new', changed: true,
    });
    const submit = vi.fn(async () => ({
      kind: 'applied' as const,
      action: 'control.mutated' as const,
      policy: 'control-staged-transition' as const,
      sessionId: 's-chat-rename',
      result: { kind: 'chatDisplayNameUpdated' as const, chatDisplayName: 'new' },
    })) as CurrentDashboardSessionCommandSubmitter;
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId,
      activeSessions: new Map([[activeSessionKey(source), source]]),
      submit,
      renameChat,
      transportEnabled: () => true,
    });
    const portSubmit = vi.spyOn(port, 'submit');
    setDashboardChatRename(port);
    if (!handle) handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    // Untrusted caller with the WRONG rotating capability: rejected at the
    // route boundary — the adapter must not even see the request, so no
    // durable operation receipt exists for the attacker-chosen id.
    const forged = await fetch(
      `http://127.0.0.1:${handle.port}/api/sessions/s-chat-rename/chat-rename`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'new',
          proactive: true,
          originCapability: 'deadbeef'.repeat(8),
          operationId: 'contested-op',
        }),
      },
    );
    expect(forged.status).toBe(403);
    expect(portSubmit).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();

    // The same operationId stays usable by the legitimate caller: the forged
    // attempt left no receipt to collide with or replay from.
    const legitimate = await postRename('new', 'contested-op');
    expect(legitimate.status).toBe(200);
    expect(renameChat).toHaveBeenCalledTimes(1);
  });
});
