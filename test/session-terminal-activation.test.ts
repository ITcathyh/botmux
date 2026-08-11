import { afterEach, describe, expect, it, vi } from 'vitest';

import * as botRegistry from '../src/bot-registry.js';
import { parseBotId } from '../src/core/bot-identity.js';
import * as currentActivation from '../src/core/current-session-activation.js';
import * as persistentBackend from '../src/core/persistent-backend.js';
import { ensureTerminalWorkerPort } from '../src/core/session-manager.js';
import type { DaemonSession } from '../src/core/types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('terminal activation identity', () => {
  it('joins one missing generation but permits a later generation to wake again', async () => {
    const ds = {
      session: {
        sessionId: 'terminal-session',
        status: 'active',
        backendType: 'tmux',
        workerGeneration: 3,
      },
      worker: null,
      workerPort: null,
      larkAppId: 'app-terminal',
      initConfig: { backendType: 'tmux' },
    } as unknown as DaemonSession;
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      botId: parseBotId('bot_terminal'),
    } as ReturnType<typeof botRegistry.getBot>);
    vi.spyOn(persistentBackend, 'probePersistentBackendTarget').mockReturnValue('exists');
    const identities: string[] = [];
    vi.spyOn(currentActivation, 'ensureCurrentSessionActivation')
      .mockImplementation(async (input) => {
        identities.push(input.requestIdentity);
        ds.workerPort = 4500 + identities.length;
        return { kind: 'active', action: 'activated' };
      });

    await expect(ensureTerminalWorkerPort(ds)).resolves.toBe(4501);
    ds.workerPort = null;
    ds.worker = null;
    ds.session.workerGeneration = 4;
    await expect(ensureTerminalWorkerPort(ds)).resolves.toBe(4502);

    expect(identities).toEqual([
      'terminal:terminal-session:3',
      'terminal:terminal-session:4',
    ]);
  });
});
