import { describe, expect, it, vi } from 'vitest';

import { createCurrentControlRenameEffectPort } from '../src/core/current-session-runtime.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

function active(owner: string, sessionId: string): DaemonSession {
  return {
    session: {
      sessionId,
      larkAppId: owner,
      chatId: 'oc_effect',
      rootMessageId: 'om_effect',
      status: 'active',
      cliId: 'codex',
      scope: 'thread',
    },
    larkAppId: owner,
    chatId: 'oc_effect',
    chatType: 'group',
    scope: 'thread',
    worker: { killed: false, connected: true, send: vi.fn() },
  } as unknown as DaemonSession;
}

describe('Current native Session rename effect', () => {
  it('captures and revalidates the exact canonical owner before touching a worker', async () => {
    const ds = active('cli_owner', 's-1');
    const port = createCurrentControlRenameEffectPort({
      ownerLarkAppId: 'cli_owner',
      activeSessions: new Map([[activeSessionKey(ds), ds]]),
    });

    const begun = port.begin({
      operationIdentity: 'rename-effect-1',
      sessionId: 's-1',
      title: 'New title',
    });
    if (begun.kind !== 'effect') throw new Error('expected native rename effect');

    await expect(port.execute(begun.intent)).resolves.toMatchObject({ status: 'requested' });
    expect(ds.worker?.send).toHaveBeenCalledWith({ type: 'rename_session', title: 'New title' });
    await expect(port.execute(begun.intent)).resolves.toEqual({
      status: 'failed',
      error: 'stale_native_rename_intent',
    });
    expect(ds.worker?.send).toHaveBeenCalledTimes(1);
  });

  it('does not send to either worker when the captured owner binding is replaced', async () => {
    const original = active('cli_owner', 's-replaced');
    const replacement = active('cli_owner', 's-replaced');
    const registry = new Map([[activeSessionKey(original), original]]);
    const port = createCurrentControlRenameEffectPort({
      ownerLarkAppId: 'cli_owner',
      activeSessions: registry,
    });
    const begun = port.begin({
      operationIdentity: 'rename-effect-replaced',
      sessionId: 's-replaced',
      title: 'Ignored by replacement',
    });
    if (begun.kind !== 'effect') throw new Error('expected native rename effect');
    registry.set(activeSessionKey(replacement), replacement);

    await expect(port.execute(begun.intent)).resolves.toMatchObject({ status: 'not_running' });
    expect(original.worker?.send).not.toHaveBeenCalled();
    expect(replacement.worker?.send).not.toHaveBeenCalled();
  });

  it('fails closed before creating an effect for malformed or duplicate owner evidence', () => {
    const valid = active('cli_owner', 's-valid');
    const nestedForeign = active('cli_owner', 's-nested-foreign');
    nestedForeign.session.larkAppId = 'cli_foreign';
    const inactive = active('cli_owner', 's-inactive');
    inactive.session.status = 'closed';
    const routeDrift = active('cli_owner', 's-route-drift');
    routeDrift.chatId = 'oc_other';
    const chatTypeDrift = active('cli_owner', 's-chat-type-drift');
    chatTypeDrift.session.chatType = 'p2p';

    for (const registry of [
      new Map([[activeSessionKey(nestedForeign), nestedForeign]]),
      new Map([[activeSessionKey(inactive), inactive]]),
      new Map([[activeSessionKey(routeDrift), routeDrift]]),
      new Map([[activeSessionKey(chatTypeDrift), chatTypeDrift]]),
      new Map([
        [activeSessionKey(valid), valid],
        ['om_duplicate::cli_owner', valid],
      ]),
    ]) {
      const port = createCurrentControlRenameEffectPort({
        ownerLarkAppId: 'cli_owner',
        activeSessions: registry,
      });
      expect(port.begin({
        operationIdentity: 'rename-effect-malformed',
        sessionId: valid.session.sessionId,
        title: 'Ignored',
      })).toMatchObject({ kind: 'unknown' });
    }

    expect(nestedForeign.worker?.send).not.toHaveBeenCalled();
    expect(inactive.worker?.send).not.toHaveBeenCalled();
    expect(routeDrift.worker?.send).not.toHaveBeenCalled();
    expect(chatTypeDrift.worker?.send).not.toHaveBeenCalled();
    expect(valid.worker?.send).not.toHaveBeenCalled();
  });
});
