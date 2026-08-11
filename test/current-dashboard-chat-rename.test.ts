import { describe, expect, it, vi } from 'vitest';

import {
  createCurrentDashboardChatRename,
} from '../src/core/current-dashboard-chat-rename.js';
import type { CurrentDashboardSessionCommandSubmitter } from '../src/core/current-dashboard-session-command-client.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const OWNER = 'cli_chat_rename_owner';
const CAPABILITY = 'ab12cd34'.repeat(8);

function active(
  sessionId: string,
  chatId = 'oc_chat_rename',
  ownerLarkAppId = OWNER,
): DaemonSession {
  return {
    session: {
      sessionId,
      larkAppId: ownerLarkAppId,
      chatId,
      rootMessageId: `om_${sessionId}`,
      status: 'active',
    },
    larkAppId: ownerLarkAppId,
    chatId,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    lastMessageAt: Date.now(),
    hasHistory: true,
    worker: null,
    managedTurnOrigin: { capability: CAPABILITY },
  } as DaemonSession;
}

function appliedRefresh(sessionId: string, chatDisplayName: string) {
  return {
    kind: 'applied' as const,
    action: 'control.mutated' as const,
    policy: 'control-staged-transition' as const,
    sessionId,
    result: { kind: 'chatDisplayNameUpdated' as const, chatDisplayName },
  };
}

function request(operationId = 'rename-op') {
  return {
    sessionId: 's-source',
    operationId,
    name: 'New chat name',
    proactive: false,
    requester: {
      trustedHost: false as const,
      originCapability: CAPABILITY,
    },
  };
}

describe('Current Dashboard chat rename', () => {
  it('replays a completed outer receipt after HTTP response loss without renaming or repairing twice', async () => {
    const source = active('s-source');
    const activeSessions = new Map([[activeSessionKey(source), source]]);
    const renameChat = vi.fn(async () => ({
      ok: true as const,
      oldName: 'Old chat name',
      newName: 'New chat name',
      changed: true,
    }));
    const submit = vi.fn(async input => appliedRefresh(
      input.target.kind === 'externalSession' ? input.target.sessionId : 'unexpected',
      'New chat name',
    )) as CurrentDashboardSessionCommandSubmitter;
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions,
      submit,
      renameChat,
      transportEnabled: () => true,
      botOpenId: () => 'ou_bot',
    });

    const first = await port.submit(request());
    const replay = await port.submit(request());

    expect(first).toEqual({
      kind: 'completed',
      result: {
        ok: true,
        oldName: 'Old chat name',
        newName: 'New chat name',
        changed: true,
        chatId: 'oc_chat_rename',
      },
    });
    expect(replay).toEqual(first);
    expect(renameChat).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('joins a concurrent duplicate to the published outer receipt', async () => {
    const source = active('s-source');
    let releaseRename!: () => void;
    const renameGate = new Promise<void>(resolve => { releaseRename = resolve; });
    const renameChat = vi.fn(async () => {
      await renameGate;
      return {
        ok: true as const,
        oldName: 'Old chat name',
        newName: 'New chat name',
        changed: true,
      };
    });
    const submit = vi.fn(async () => appliedRefresh('s-source', 'New chat name')) as
      CurrentDashboardSessionCommandSubmitter;
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(source), source]]),
      submit,
      renameChat,
      transportEnabled: () => true,
    });

    const leader = port.submit(request('concurrent-op'));
    const follower = port.submit(request('concurrent-op'));
    await vi.waitFor(() => expect(renameChat).toHaveBeenCalledTimes(1));
    releaseRename();

    const [first, second] = await Promise.all([leader, follower]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ kind: 'completed' });
    expect(renameChat).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('publishes the receipt before a projection lookup can synchronously re-enter', async () => {
    const source = active('s-source');
    class ReentrantRegistry extends Map<string, DaemonSession> {
      onEntries?: () => void;

      override entries(): MapIterator<[string, DaemonSession]> {
        const callback = this.onEntries;
        this.onEntries = undefined;
        callback?.();
        return super.entries();
      }
    }
    const activeSessions = new ReentrantRegistry([[activeSessionKey(source), source]]);
    const renameChat = vi.fn(async () => ({
      ok: true as const,
      oldName: 'Old chat name',
      newName: 'New chat name',
      changed: true,
    }));
    const submit = vi.fn(async () => appliedRefresh('s-source', 'New chat name')) as
      CurrentDashboardSessionCommandSubmitter;
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions,
      submit,
      renameChat,
      transportEnabled: () => true,
    });
    let follower: Promise<unknown> | undefined;
    activeSessions.onEntries = () => {
      follower = port.submit(request('reentrant-op'));
    };

    const leader = port.submit(request('reentrant-op'));
    await expect(leader).resolves.toMatchObject({ kind: 'completed' });
    await expect(follower).resolves.toMatchObject({ kind: 'completed' });
    expect(renameChat).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('rejects semantic input reuse while the original operation is in flight', async () => {
    const source = active('s-source');
    let releaseRename!: () => void;
    const renameGate = new Promise<void>(resolve => { releaseRename = resolve; });
    const renameChat = vi.fn(async () => {
      await renameGate;
      return {
        ok: true as const,
        oldName: 'Old chat name',
        newName: 'New chat name',
        changed: true,
      };
    });
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(source), source]]),
      submit: vi.fn(async () => appliedRefresh('s-source', 'New chat name')) as
        CurrentDashboardSessionCommandSubmitter,
      renameChat,
      transportEnabled: () => true,
    });

    const leader = port.submit(request('conflict-op'));
    await vi.waitFor(() => expect(renameChat).toHaveBeenCalledTimes(1));
    await expect(port.submit({ ...request('conflict-op'), name: 'Another name' }))
      .resolves.toMatchObject({ kind: 'conflict' });
    releaseRename();
    await expect(leader).resolves.toMatchObject({ kind: 'completed' });
    expect(renameChat).toHaveBeenCalledTimes(1);
  });

  it('retains an ambiguous Lark failure so the same operation cannot issue a second rename', async () => {
    const source = active('s-source');
    const renameChat = vi.fn(async () => ({
      ok: false as const,
      error: 'lark_api_error' as const,
      detail: 'socket closed after request write',
      oldName: 'Old chat name',
      newName: 'New chat name',
    }));
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(source), source]]),
      submit: vi.fn() as CurrentDashboardSessionCommandSubmitter,
      renameChat,
      transportEnabled: () => true,
    });

    const first = await port.submit(request('ambiguous-op'));
    const replay = await port.submit(request('ambiguous-op'));

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      kind: 'larkRejected',
      result: { error: 'lark_api_error' },
    });
    expect(renameChat).toHaveBeenCalledTimes(1);
  });

  it('keeps the semantic reservation after a retryable Lark rejection and redrives only the same request', async () => {
    const source = active('s-source');
    const renameChat = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: 'rate_limited' as const,
        retryAfterSeconds: 1,
        oldName: 'Old chat name',
        newName: 'New chat name',
      })
      .mockResolvedValueOnce({
        ok: true as const,
        oldName: 'Old chat name',
        newName: 'New chat name',
        changed: true,
      });
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(source), source]]),
      submit: vi.fn(async () => appliedRefresh('s-source', 'New chat name')) as
        CurrentDashboardSessionCommandSubmitter,
      renameChat,
      transportEnabled: () => true,
    });

    await expect(port.submit(request('retryable-reservation'))).resolves.toMatchObject({
      kind: 'larkRejected',
      result: { error: 'rate_limited' },
    });
    await expect(port.submit({
      ...request('retryable-reservation'),
      name: 'Different chat name',
    })).resolves.toMatchObject({ kind: 'conflict' });
    await expect(port.submit(request('retryable-reservation'))).resolves.toMatchObject({
      kind: 'completed',
    });
    expect(renameChat).toHaveBeenCalledTimes(2);
  });

  it('keeps a hash-only reservation after a deterministic rejection', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions,
      submit: vi.fn() as CurrentDashboardSessionCommandSubmitter,
      renameChat: vi.fn(async () => ({
        ok: true as const,
        oldName: 'Old chat name',
        newName: 'New chat name',
        changed: true,
      })),
      transportEnabled: () => true,
    });

    await expect(port.submit({
      ...request('deterministic-reservation'),
      requester: { trustedHost: true },
    })).resolves.toMatchObject({ kind: 'rejected', reason: 'sessionNotActive' });
    await expect(port.submit({
      ...request('deterministic-reservation'),
      name: 'Different chat name',
      requester: { trustedHost: true },
    })).resolves.toMatchObject({ kind: 'conflict' });

    const source = active('s-source');
    activeSessions.set(activeSessionKey(source), source);
    await expect(port.submit({
      ...request('deterministic-reservation'),
      requester: { trustedHost: true },
    })).resolves.toMatchObject({ kind: 'completed' });
  });

  it('uses a fresh operation to repair local state when an ambiguous retry observes changed=false', async () => {
    const source = active('s-source');
    const renameChat = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: 'lark_api_error' as const,
        detail: 'response lost after write',
        oldName: 'Old chat name',
        newName: 'New chat name',
      })
      .mockResolvedValueOnce({
        ok: true as const,
        oldName: 'New chat name',
        newName: 'New chat name',
        changed: false,
      });
    const submit = vi.fn(async () => appliedRefresh('s-source', 'New chat name')) as
      CurrentDashboardSessionCommandSubmitter;
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(source), source]]),
      submit,
      renameChat,
      transportEnabled: () => true,
    });

    await expect(port.submit(request('lost-response-op'))).resolves.toMatchObject({
      kind: 'larkRejected',
      result: { error: 'lark_api_error' },
    });
    await expect(port.submit(request('repair-after-loss-op'))).resolves.toMatchObject({
      kind: 'completed',
      result: { changed: false },
    });
    expect(renameChat).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('fails closed before Lark rename when bot identity lookup is unreadable', async () => {
    const source = active('s-source');
    const submit = vi.fn(async () => appliedRefresh('s-source', 'New chat name')) as
      CurrentDashboardSessionCommandSubmitter;
    const renameChat = vi.fn(async () => ({
      ok: true as const,
      oldName: 'Old chat name',
      newName: 'New chat name',
      changed: true,
    }));
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(source), source]]),
      submit,
      renameChat,
      transportEnabled: () => true,
      botOpenId: () => { throw new Error('audit registry unavailable'); },
    });

    await expect(port.submit(request('identity-unreadable-op'))).resolves.toMatchObject({
      kind: 'quarantined',
      message: expect.stringContaining('audit registry unavailable'),
    });
    expect(renameChat).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('fails closed before Lark rename when bot transport configuration is unreadable', async () => {
    const source = active('s-source');
    const renameChat = vi.fn();
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(source), source]]),
      submit: vi.fn() as CurrentDashboardSessionCommandSubmitter,
      renameChat,
      transportEnabled: () => { throw new Error('bot config unreadable'); },
      botOpenId: () => 'ou_bot',
    });

    const first = await port.submit(request('config-unreadable-op'));
    const replay = await port.submit(request('config-unreadable-op'));
    expect(first).toMatchObject({
      kind: 'quarantined',
      message: expect.stringContaining('bot config unreadable'),
    });
    expect(replay).toEqual(first);
    expect(renameChat).not.toHaveBeenCalled();
  });

  it('repairs every canonical owner Session through Runtime when Lark reports changed=false', async () => {
    const source = active('s-source');
    const sibling = active('s-sibling');
    const foreign = active('s-foreign', 'oc_chat_rename', 'cli_foreign');
    const activeSessions = new Map([
      [activeSessionKey(source), source],
      [activeSessionKey(sibling), sibling],
      [activeSessionKey(foreign), foreign],
    ]);
    const submit = vi.fn(async input => appliedRefresh(
      input.target.kind === 'externalSession' ? input.target.sessionId : 'unexpected',
      'New chat name',
    )) as CurrentDashboardSessionCommandSubmitter;
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions,
      submit,
      renameChat: vi.fn(async () => ({
        ok: true as const,
        oldName: 'New chat name',
        newName: 'New chat name',
        changed: false,
      })),
      transportEnabled: () => true,
    });

    await expect(port.submit(request('repair-op'))).resolves.toMatchObject({
      kind: 'completed',
      result: { changed: false },
    });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls.map(([input]) => input)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: { kind: 'externalSession', sessionId: 's-source' },
        idempotencyKey: 'repair-op:s-source',
      }),
      expect.objectContaining({
        target: { kind: 'externalSession', sessionId: 's-sibling' },
        idempotencyKey: 'repair-op:s-sibling',
      }),
    ]));
  });

  it.each([
    {
      label: 'a non-canonical source key',
      registry() {
        const source = active('s-source');
        return new Map([['non-canonical-source', source]]);
      },
    },
    {
      label: 'duplicate canonical source bindings',
      registry() {
        const source = active('s-source');
        const duplicate = active('s-source');
        duplicate.session.rootMessageId = 'om_s-source-duplicate';
        return new Map([
          [activeSessionKey(source), source],
          [activeSessionKey(duplicate), duplicate],
        ]);
      },
    },
    {
      label: 'a runtime/session owner mismatch',
      registry() {
        const source = active('s-source');
        source.session.larkAppId = 'cli_foreign';
        return new Map([[activeSessionKey(source), source]]);
      },
    },
    {
      label: 'a malformed same-chat sibling',
      registry() {
        const source = active('s-source');
        const sibling = active('s-sibling');
        sibling.session.chatId = 'oc_persisted_drift';
        return new Map([
          [activeSessionKey(source), source],
          [activeSessionKey(sibling), sibling],
        ]);
      },
    },
  ])('fails closed before Lark rename for $label', async ({ registry }) => {
    const renameChat = vi.fn();
    const submit = vi.fn() as CurrentDashboardSessionCommandSubmitter;
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions: registry(),
      submit,
      renameChat,
      transportEnabled: () => true,
    });

    await expect(port.submit({
      ...request('malformed-owner-binding'),
      requester: { trustedHost: true },
    })).resolves.toMatchObject({ kind: 'quarantined' });
    expect(renameChat).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('fails closed when the exact source binding is replaced before the Lark effect', async () => {
    const source = active('s-source');
    const activeSessions = new Map([[activeSessionKey(source), source]]);
    const replacement = active('s-source');
    const renameChat = vi.fn();
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions,
      submit: vi.fn() as CurrentDashboardSessionCommandSubmitter,
      renameChat,
      transportEnabled: () => {
        activeSessions.set(activeSessionKey(replacement), replacement);
        return true;
      },
    });

    await expect(port.submit(request('replacement-op'))).resolves.toEqual({
      kind: 'rejected',
      reason: 'sessionNotActive',
      message: 'session_not_active',
    });
    expect(renameChat).not.toHaveBeenCalled();
  });

  it('revalidates rotating managed-origin authority after waiting for the chat effect lane', async () => {
    const source = active('s-source');
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const renameChat = vi.fn(async () => {
      await firstGate;
      return {
        ok: true as const,
        oldName: 'Old chat name',
        newName: 'New chat name',
        changed: true,
      };
    });
    const transportEnabled = vi.fn(() => true);
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(source), source]]),
      submit: vi.fn(async () => appliedRefresh('s-source', 'New chat name')) as
        CurrentDashboardSessionCommandSubmitter,
      renameChat,
      transportEnabled,
    });

    const first = port.submit(request('lane-leader-op'));
    await vi.waitFor(() => expect(renameChat).toHaveBeenCalledTimes(1));
    const staleFollower = port.submit(request('stale-authority-op'));
    await vi.waitFor(() => expect(transportEnabled.mock.calls.length).toBeGreaterThanOrEqual(3));
    source.managedTurnOrigin = { capability: 'f00d'.repeat(16) };
    releaseFirst();

    await expect(first).resolves.toMatchObject({ kind: 'completed' });
    await expect(staleFollower).resolves.toEqual({
      kind: 'rejected',
      reason: 'originUnproven',
      message: 'origin_unproven',
    });
    expect(renameChat).toHaveBeenCalledTimes(1);
  });

  it('keeps owner and canonical lookup plus managed-origin authorization inside the port', async () => {
    const foreign = active('s-source', 'oc_chat_rename', 'cli_foreign');
    const aliased = active('s-source');
    const renameChat = vi.fn();
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([
        [activeSessionKey(foreign), foreign],
        ['non-canonical-alias', aliased],
      ]),
      submit: vi.fn() as CurrentDashboardSessionCommandSubmitter,
      renameChat,
      transportEnabled: () => true,
    });

    await expect(port.submit(request('owner-policy-op'))).resolves.toMatchObject({
      kind: 'quarantined',
    });
    expect(renameChat).not.toHaveBeenCalled();
  });

  it('rejects a wrong managed-origin capability before the Lark effect', async () => {
    const source = active('s-source');
    const renameChat = vi.fn();
    const port = createCurrentDashboardChatRename({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(source), source]]),
      submit: vi.fn() as CurrentDashboardSessionCommandSubmitter,
      renameChat,
      transportEnabled: () => true,
    });

    await expect(port.submit({
      ...request('wrong-capability-op'),
      requester: { trustedHost: false, originCapability: 'f00d'.repeat(16) },
    })).resolves.toEqual({
      kind: 'rejected',
      reason: 'originUnproven',
      message: 'origin_unproven',
    });
    expect(renameChat).not.toHaveBeenCalled();
  });
});
