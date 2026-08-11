import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../src/config.js';
import {
  setDashboardSessionRuntimeSubmitter,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import {
  __testOnly_resetBotTurnMutationGates,
  withBotTurnAdmission,
} from '../src/core/bot-turn-mutation-gate.js';
import { createCurrentDashboardHostMaintenance } from '../src/core/current-dashboard-host-maintenance.js';

const APP = 'cli_spawn_route_test';
const CHAT = 'oc_spawn_route_test';
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZVQAAAAASUVORK5CYII=';

let server: IpcServerHandle;
let dataDir: string;
let previousDataDir: string;

function post(body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/sessions/spawn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function postFleetOperation(kind: 'start' | 'spawn'): Promise<Response> {
  if (kind === 'spawn') {
    return post({
      operationId: 'fleet-gate-spawn',
      chatId: CHAT,
      content: 'fleet gate',
      column: 'backlog',
      role: 'solo',
    });
  }
  return fetch(`http://127.0.0.1:${server.port}/api/sessions/s-fleet-gate/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'fleet-gate-start' }),
  });
}

function fleetOutcome(kind: 'start' | 'spawn') {
  return kind === 'spawn'
    ? {
        kind: 'applied' as const,
        action: 'dashboard.spawned' as const,
        policy: 'route-staged-opening' as const,
        sessionId: 's-fleet-gate-spawned',
      }
    : {
        kind: 'applied' as const,
        action: 'control.mutated' as const,
        policy: 'control-staged-transition' as const,
        sessionId: 's-fleet-gate',
        result: {
          kind: 'queuedActivated' as const,
          queued: false,
          column: 'in_progress' as const,
        },
      };
}

function installFleetAdmittedSubmitter(submit: (...args: any[]) => Promise<any>): void {
  setDashboardSessionRuntimeSubmitter(((input: any) => (
    withBotTurnAdmission(APP, () => submit(input))
  )) as never);
}

function agentMutationWithPublish(publish: (input: any) => Promise<any>) {
  return createCurrentDashboardHostMaintenance({
    ownerLarkAppId: APP,
    activeSessions: new Map(),
    listSessions: () => [],
    submit: vi.fn(),
    agentConfiguration: {
      current: () => ({ cliId: 'traex' }),
      publish,
    },
  }).changeAgent({
    operationId: 'agent-fleet-mutation',
    cliId: 'codex',
    model: 'fleet-model',
    cliRuntimePresent: false,
    cliRuntime: undefined,
  });
}

beforeEach(async () => {
  previousDataDir = config.session.dataDir;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-ipc-spawn-route-'));
  config.session.dataDir = dataDir;
  setLarkAppId(APP);
  server = await startIpcServer({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  setDashboardSessionRuntimeSubmitter(null);
  setLarkAppId('');
  await server.close();
  config.session.dataDir = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  __testOnly_resetBotTurnMutationGates();
});

describe('Dashboard spawn route command', () => {
  it('validates at HTTP and submits the normalized business input to the chat route', async () => {
    const submit = vi.fn(async () => ({
      kind: 'applied' as const,
      action: 'dashboard.spawned' as const,
      policy: 'route-staged-opening' as const,
      sessionId: 'session-spawned',
    }));
    setDashboardSessionRuntimeSubmitter(submit as never);

    const response = await post({
      operationId: 'dashboard-spawn:stable-attempt',
      chatId: ` ${CHAT} `,
      content: 'ship stage two   ',
      column: 'backlog',
      role: 'lead',
      coworkers: [{ name: ' peer ', openId: ' ou_peer ' }],
      images: [{ name: '../shot.PNG', mimeType: 'IMAGE/PNG', dataBase64: PNG_1X1 }],
      postBanner: true,
      title: '  explicit title  ',
      ownerOpenId: ' ou_owner ',
      ownerUnionId: ' on_owner ',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sessionId: 'session-spawned' });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({
      target: { kind: 'route', route: { kind: 'chat', chatId: CHAT } },
      idempotencyKey: 'dashboard-spawn:stable-attempt',
      command: {
        kind: 'dashboard.spawn',
        input: {
          content: 'ship stage two',
          column: 'backlog',
          role: 'lead',
          coworkers: [{ name: 'peer', openId: 'ou_peer' }],
          images: [{ name: 'shot.png', mimeType: 'image/png', dataBase64: PNG_1X1 }],
          postBanner: true,
          title: 'explicit title',
          ownerOpenId: 'ou_owner',
          ownerUnionId: 'on_owner',
        },
      },
    });
    expect(existsSync(join(dataDir, 'attachments'))).toBe(false);
  });

  it('returns a duplicate receipt without needing a mutable registry in the handler', async () => {
    const submit = vi.fn(async () => ({
      kind: 'duplicate' as const,
      state: 'routeOpened' as const,
      policy: 'route-staged-opening' as const,
      sessionId: 'session-existing-receipt',
      message: 'already opened',
    }));
    setDashboardSessionRuntimeSubmitter(submit as never);

    const response = await post({
      operationId: 'dashboard-spawn:duplicate',
      chatId: CHAT,
      content: 'same logical opening',
      column: 'in_progress',
      role: 'solo',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sessionId: 'session-existing-receipt' });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['{not-json', 'invalid_json'],
    [JSON.stringify({ operationId: 42, chatId: CHAT, content: 'x', column: 'backlog', role: 'solo' }), 'bad_operation_id'],
  ])('rejects malformed transport input before submit (%s)', async (body, error) => {
    const submit = vi.fn();
    setDashboardSessionRuntimeSubmitter(submit as never);

    const response = await post(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error });
    expect(submit).not.toHaveBeenCalled();
  });

  it('maps an occupied exact owner route to the existing conflict response', async () => {
    setDashboardSessionRuntimeSubmitter((async () => ({
      kind: 'rejected',
      reason: 'sessionExists',
      message: 'session_exists',
    })) as never);

    const response = await post({
      operationId: 'dashboard-spawn:occupied',
      chatId: CHAT,
      content: 'do not replace',
      column: 'backlog',
      role: 'solo',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'session_exists' });
  });

  it.each(['start', 'spawn'] as const)(
    'does not let %s enter Runtime while a Bot-wide Agent mutation owns the fleet gate',
    async kind => {
      let releasePublish!: () => void;
      const hold = new Promise<void>(resolve => { releasePublish = resolve; });
      const publish = vi.fn(async (input: any) => {
        await hold;
        return {
          ok: true as const,
          config: { cliId: input.target.cliId },
          readIsolationCleared: false,
        };
      });
      const mutation = agentMutationWithPublish(publish);
      await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
      const submit = vi.fn(async () => fleetOutcome(kind));
      installFleetAdmittedSubmitter(submit);

      const response = postFleetOperation(kind);
      await new Promise<void>(resolve => setImmediate(resolve));
      const callsWhileMutationHeld = submit.mock.calls.length;

      releasePublish();
      await expect(mutation).resolves.toMatchObject({ kind: 'completed' });
      expect((await response).status).toBe(200);
      expect(callsWhileMutationHeld).toBe(0);
      expect(submit).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['start', 'spawn'] as const)(
    'makes a Bot-wide Agent mutation wait for an admitted %s Runtime operation',
    async kind => {
      let releaseSubmit!: () => void;
      const submitGate = new Promise<void>(resolve => { releaseSubmit = resolve; });
      const submit = vi.fn(async () => {
        await submitGate;
        return fleetOutcome(kind);
      });
      installFleetAdmittedSubmitter(submit);

      const response = postFleetOperation(kind);
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
      const publish = vi.fn(async (input: any) => ({
        ok: true as const,
        config: { cliId: input.target.cliId },
        readIsolationCleared: false,
      }));
      const mutation = agentMutationWithPublish(publish);
      await new Promise<void>(resolve => setImmediate(resolve));
      const enteredWhileSubmitHeld = publish.mock.calls.length;

      releaseSubmit();
      expect((await response).status).toBe(200);
      await expect(mutation).resolves.toMatchObject({ kind: 'completed' });
      expect(enteredWhileSubmitHeld).toBe(0);
      expect(publish).toHaveBeenCalledTimes(1);
    },
  );
});
