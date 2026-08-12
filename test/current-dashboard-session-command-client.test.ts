import { describe, expect, it, vi } from 'vitest';

import {
  createCurrentDashboardSessionCommandClient,
} from '../src/core/current-dashboard-session-command-client.js';
import { createCurrentDashboardHostMaintenance } from '../src/core/current-dashboard-host-maintenance.js';
import type {
  ControlMutationCommand,
  ControlMutationInput,
  DashboardSpawnCommand,
  SessionAddress,
} from '../src/core/session-runtime.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const SESSION_ID = 'session-dashboard-command-client';
const ADDRESS = Object.freeze(Object.create(null)) as SessionAddress;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

const FLEET_AFFECTING_COMMANDS: readonly {
  readonly label: string;
  readonly input: ControlMutationInput;
}[] = [
  { label: 'board activation', input: { kind: 'setBoardPlacement', column: 'in_progress' } },
  { label: 'queued activation', input: { kind: 'activateQueued', source: 'dashboard' } },
  { label: 'restart', input: { kind: 'restart', source: 'dashboard' } },
  { label: 'suspend', input: { kind: 'suspend', source: 'dashboard' } },
  { label: 'close', input: { kind: 'close', reason: 'dashboard' } },
  { label: 'resume', input: { kind: 'reopen', source: 'dashboard', wake: true } },
];

function closeCommand(reason: 'dashboard' | 'prune' = 'dashboard'): ControlMutationCommand {
  return { kind: 'control.mutate', input: { kind: 'close', reason } };
}

function oneProjection() {
  return {
    kind: 'one' as const,
    session: {
      address: ADDRESS,
      sessionId: SESSION_ID,
      route: { kind: 'thread' as const, anchorId: 'om_dashboard_command_client' },
      recordStatus: 'active' as const,
      executorStatus: 'idle' as const,
    },
  };
}

function closedProjection() {
  return {
    ...oneProjection(),
    session: {
      ...oneProjection().session,
      recordStatus: 'closed' as const,
    },
  };
}

function immediateReopenRouteAdmission() {
  return {
    reserve: vi.fn(() => ({
      kind: 'reserved' as const,
      route: {
        scope: 'thread' as const,
        canonicalAnchor: 'om_dashboard_command_client',
        chatId: 'oc_dashboard_command_client',
        chatType: 'group' as const,
      },
      ready: Promise.resolve(),
      token: Object.freeze({}),
      revalidate: () => ({ kind: 'current' as const }),
      release: vi.fn(),
    })),
  };
}

describe('Current Dashboard Session command client', () => {
  it('acquires the closed target route before reprojecting and holds it through reopen terminal', async () => {
    const admissionReady = deferred<void>();
    const runtimeTerminal = deferred<{
      kind: 'applied';
      action: 'control.mutated';
      policy: 'control-staged-transition';
      sessionId: string;
      result: { kind: 'reopened'; wake: false; executor: 'lazy'; session: {
        chatId: string; rootMessageId: string;
      } };
    }>();
    const token = Object.freeze({ admission: 'reopen-target' });
    const release = vi.fn();
    const projectionRead = vi.fn(async () => closedProjection());
    const runtimeSubmit = vi.fn(async () => runtimeTerminal.promise);
    const reserve = vi.fn(() => ({
      kind: 'reserved' as const,
      route: {
        scope: 'thread' as const,
        canonicalAnchor: 'om_dashboard_command_client',
        chatId: 'oc_dashboard_command_client',
        chatType: 'group' as const,
      },
      ready: admissionReady.promise,
      token,
      revalidate: vi.fn(() => ({ kind: 'current' as const })),
      release,
    }));
    const submit = createCurrentDashboardSessionCommandClient({
      ownerLarkAppId: () => 'owner-dashboard-reopen-admission',
      host: () => ({
        projection: { read: projectionRead },
        runtime: { submit: runtimeSubmit },
      }),
      reopenRouteAdmission: { reserve },
    } as never);

    const reopening = submit({
      target: { kind: 'externalSession', sessionId: SESSION_ID },
      idempotencyKey: 'dashboard-reopen:route-admission',
      command: {
        kind: 'control.mutate',
        input: { kind: 'reopen', source: 'dashboard', wake: false },
      },
    });

    await vi.waitFor(() => expect(reserve).toHaveBeenCalledTimes(1));
    expect(projectionRead).toHaveBeenCalledTimes(1);
    expect(runtimeSubmit).not.toHaveBeenCalled();

    admissionReady.resolve();
    await vi.waitFor(() => expect(runtimeSubmit).toHaveBeenCalledTimes(1));
    expect(projectionRead).toHaveBeenCalledTimes(2);
    expect(runtimeSubmit).toHaveBeenCalledWith(expect.objectContaining({
      target: {
        kind: 'session',
        address: ADDRESS,
        controlRouteReservation: token,
      },
    }));
    expect(release).not.toHaveBeenCalled();

    runtimeTerminal.resolve({
      kind: 'applied',
      action: 'control.mutated',
      policy: 'control-staged-transition',
      sessionId: SESSION_ID,
      result: {
        kind: 'reopened',
        wake: false,
        executor: 'lazy',
        session: {
          chatId: 'oc_dashboard_command_client',
          rootMessageId: 'om_dashboard_command_client',
        },
      },
    });
    await expect(reopening).resolves.toMatchObject({
      kind: 'applied',
      result: { kind: 'reopened' },
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
  it.each(FLEET_AFFECTING_COMMANDS)(
    'does not admit $label while an Agent configuration mutation is published',
    async ({ label, input }) => {
      const owner = `owner-fleet-mutation-first:${label}`;
      const projectionRead = vi.fn(async () => oneProjection());
      const runtimeSubmit = vi.fn(async () => ({
        kind: 'applied' as const,
        action: 'control.mutated' as const,
        policy: 'control-staged-transition' as const,
        sessionId: SESSION_ID,
        result: { kind: 'closed' as const, alreadyClosed: false, known: true },
      }));
      const submit = createCurrentDashboardSessionCommandClient({
        ownerLarkAppId: () => owner,
        reopenRouteAdmission: immediateReopenRouteAdmission(),
        host: () => ({
          projection: { read: projectionRead },
          runtime: { submit: runtimeSubmit },
        }),
      });
      let releasePublish!: () => void;
      const publishGate = new Promise<void>(resolve => { releasePublish = resolve; });
      const publish = vi.fn(async () => {
        await publishGate;
        return {
          ok: true as const,
          config: { cliId: 'codex' as const },
          readIsolationCleared: false,
        };
      });
      const maintenance = createCurrentDashboardHostMaintenance({
        ownerLarkAppId: owner,
        activeSessions: new Map(),
        listSessions: () => [],
        submit,
        agentConfiguration: {
          current: () => ({ cliId: 'traex' }),
          publish,
        },
      });

      const changing = maintenance.changeAgent({
        operationId: `fleet-mutation-first:${label}`,
        cliId: 'codex',
        model: '',
        cliRuntimePresent: false,
        cliRuntime: undefined,
      });
      await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
      const controlling = submit({
        target: { kind: 'externalSession', sessionId: SESSION_ID },
        idempotencyKey: `fleet-command:${label}`,
        command: { kind: 'control.mutate', input },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(projectionRead).not.toHaveBeenCalled();

      releasePublish();
      await expect(changing).resolves.toMatchObject({ kind: 'completed' });
      await expect(controlling).resolves.toMatchObject({ kind: 'applied' });
      expect(runtimeSubmit).toHaveBeenCalledTimes(1);
    },
  );

  it.each(FLEET_AFFECTING_COMMANDS)(
    'waits to mutate Agent configuration until an admitted $label settles',
    async ({ label, input }) => {
      const owner = `owner-fleet-command-first:${label}`;
      let releaseControl!: () => void;
      const controlGate = new Promise<void>(resolve => { releaseControl = resolve; });
      const runtimeSubmit = vi.fn(async () => {
        await controlGate;
        return {
          kind: 'applied' as const,
          action: 'control.mutated' as const,
          policy: 'control-staged-transition' as const,
          sessionId: SESSION_ID,
          result: { kind: 'closed' as const, alreadyClosed: false, known: true },
        };
      });
      const submit = createCurrentDashboardSessionCommandClient({
        ownerLarkAppId: () => owner,
        reopenRouteAdmission: immediateReopenRouteAdmission(),
        host: () => ({
          projection: { read: async () => oneProjection() },
          runtime: { submit: runtimeSubmit },
        }),
      });
      const current = vi.fn(() => ({ cliId: 'traex' as const }));
      const publish = vi.fn(async () => ({
        ok: true as const,
        config: { cliId: 'codex' as const },
        readIsolationCleared: false,
      }));
      const maintenance = createCurrentDashboardHostMaintenance({
        ownerLarkAppId: owner,
        activeSessions: new Map(),
        listSessions: () => [],
        submit,
        agentConfiguration: { current, publish },
      });

      const controlling = submit({
        target: { kind: 'externalSession', sessionId: SESSION_ID },
        idempotencyKey: `fleet-command-first:${label}`,
        command: { kind: 'control.mutate', input },
      });
      await vi.waitFor(() => expect(runtimeSubmit).toHaveBeenCalledTimes(1));
      const changing = maintenance.changeAgent({
        operationId: `fleet-change-after-command:${label}`,
        cliId: 'codex',
        model: '',
        cliRuntimePresent: false,
        cliRuntime: undefined,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(current).not.toHaveBeenCalled();

      releaseControl();
      await expect(controlling).resolves.toMatchObject({ kind: 'applied' });
      await expect(changing).resolves.toMatchObject({ kind: 'completed' });
      expect(publish).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps different Session admissions parallel when no fleet mutation owns the Bot', async () => {
    const owner = 'owner-fleet-parallel-sessions';
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runtimeSubmit = vi.fn(async () => {
      await gate;
      return {
        kind: 'applied' as const,
        action: 'control.mutated' as const,
        policy: 'control-staged-transition' as const,
        sessionId: SESSION_ID,
        result: { kind: 'closed' as const, alreadyClosed: false, known: true },
      };
    });
    const submit = createCurrentDashboardSessionCommandClient({
      ownerLarkAppId: () => owner,
      host: () => ({
        projection: {
          read: async query => ({
            ...oneProjection(),
            session: {
              ...oneProjection().session,
              sessionId: query.kind === 'byExternalSession' ? query.sessionId : SESSION_ID,
            },
          }),
        },
        runtime: { submit: runtimeSubmit },
      }),
    });

    const first = submit({
      target: { kind: 'externalSession', sessionId: 'session-a' },
      idempotencyKey: 'parallel-a',
      command: closeCommand(),
    });
    const second = submit({
      target: { kind: 'externalSession', sessionId: 'session-b' },
      idempotencyKey: 'parallel-b',
      command: closeCommand(),
    });
    await vi.waitFor(() => expect(runtimeSubmit).toHaveBeenCalledTimes(2));
    release();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('publishes the receipt before a synchronously reentrant projection lookup', async () => {
    let submit!: ReturnType<typeof createCurrentDashboardSessionCommandClient>;
    let follower: ReturnType<typeof submit> | undefined;
    let reentered = false;
    const request = {
      target: { kind: 'externalSession' as const, sessionId: SESSION_ID },
      idempotencyKey: 'dashboard-close:projection-reentrant',
      command: closeCommand(),
    };
    const projectionRead = vi.fn(() => {
      if (!reentered) {
        reentered = true;
        follower = submit(request);
      }
      return Promise.resolve(oneProjection());
    });
    const runtimeSubmit = vi.fn(async () => ({
      kind: 'applied' as const,
      action: 'control.mutated' as const,
      policy: 'control-staged-transition' as const,
      sessionId: SESSION_ID,
      result: { kind: 'closed' as const, alreadyClosed: false, known: true },
    }));
    submit = createCurrentDashboardSessionCommandClient({
      ownerLarkAppId: () => 'owner-dashboard-command-client',
      host: () => ({
        projection: { read: projectionRead },
        runtime: { submit: runtimeSubmit },
      }),
    });

    await expect(submit(request)).resolves.toMatchObject({ kind: 'applied' });
    await expect(follower).resolves.toMatchObject({ kind: 'duplicate' });
    expect(projectionRead).toHaveBeenCalledTimes(1);
    expect(runtimeSubmit).toHaveBeenCalledTimes(1);
  });

  it('registers the operation before projection and gives concurrent followers a duplicate receipt', async () => {
    let release!: (value: unknown) => void;
    const terminal = new Promise(resolve => { release = resolve; });
    const projectionRead = vi.fn(async () => oneProjection());
    const runtimeSubmit = vi.fn(async () => await terminal as never);
    const submit = createCurrentDashboardSessionCommandClient({
      ownerLarkAppId: () => 'owner-dashboard-command-client',
      host: () => ({
        projection: { read: projectionRead },
        runtime: { submit: runtimeSubmit },
      }),
    });
    const request = {
      target: { kind: 'externalSession' as const, sessionId: SESSION_ID },
      idempotencyKey: 'dashboard-close:concurrent',
      command: closeCommand(),
    };

    const leader = submit(request);
    const follower = submit(request);
    await vi.waitFor(() => expect(runtimeSubmit).toHaveBeenCalledTimes(1));
    release({
      kind: 'applied',
      action: 'control.mutated',
      policy: 'control-staged-transition',
      sessionId: SESSION_ID,
      result: { kind: 'closed', alreadyClosed: false, known: true },
    });

    await expect(leader).resolves.toMatchObject({ kind: 'applied' });
    await expect(follower).resolves.toEqual({
      kind: 'duplicate',
      state: 'controlApplied',
      policy: 'control-staged-transition',
      sessionId: SESSION_ID,
      result: { kind: 'closed', alreadyClosed: false, known: true },
      message: 'Dashboard control operation already completed in this daemon epoch',
    });
    expect(projectionRead).toHaveBeenCalledTimes(1);
  });

  it('replays a terminal receipt before projection after the Session disappears', async () => {
    const projectionRead = vi.fn(async () => oneProjection());
    const runtimeSubmit = vi.fn(async () => ({
      kind: 'applied' as const,
      action: 'control.mutated' as const,
      policy: 'control-staged-transition' as const,
      sessionId: SESSION_ID,
      result: { kind: 'closed' as const, alreadyClosed: false, known: true },
    }));
    const submit = createCurrentDashboardSessionCommandClient({
      ownerLarkAppId: () => 'owner-dashboard-command-client',
      host: () => ({
        projection: { read: projectionRead },
        runtime: { submit: runtimeSubmit },
      }),
    });
    const request = {
      target: { kind: 'externalSession' as const, sessionId: SESSION_ID },
      idempotencyKey: 'dashboard-close:response-lost',
      command: closeCommand(),
    };

    await expect(submit(request)).resolves.toMatchObject({ kind: 'applied' });
    projectionRead.mockImplementation(async () => ({ kind: 'notFound' as const }));

    await expect(submit(request)).resolves.toMatchObject({
      kind: 'duplicate',
      state: 'controlApplied',
      result: { kind: 'closed', alreadyClosed: false, known: true },
    });
    expect(projectionRead).toHaveBeenCalledTimes(1);
    expect(runtimeSubmit).toHaveBeenCalledTimes(1);
  });

  it('rejects a reused operation identity with different semantic input before projection', async () => {
    const projectionRead = vi.fn(async () => oneProjection());
    const runtimeSubmit = vi.fn(async () => ({
      kind: 'applied' as const,
      action: 'control.mutated' as const,
      policy: 'control-staged-transition' as const,
      sessionId: SESSION_ID,
      result: { kind: 'closed' as const, alreadyClosed: false, known: true },
    }));
    const submit = createCurrentDashboardSessionCommandClient({
      ownerLarkAppId: () => 'owner-dashboard-command-client',
      host: () => ({
        projection: { read: projectionRead },
        runtime: { submit: runtimeSubmit },
      }),
    });

    await submit({
      target: { kind: 'externalSession', sessionId: SESSION_ID },
      idempotencyKey: 'dashboard-close:conflict',
      command: closeCommand('dashboard'),
    });
    await expect(submit({
      target: { kind: 'externalSession', sessionId: SESSION_ID },
      idempotencyKey: 'dashboard-close:conflict',
      command: closeCommand('prune'),
    })).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'idempotencyConflict',
    });
    expect(projectionRead).toHaveBeenCalledTimes(1);
    expect(runtimeSubmit).toHaveBeenCalledTimes(1);
  });

  it('reserves retryable operation semantics while allowing the same input to retry', async () => {
    let projectionReady = false;
    const projectionRead = vi.fn(async () => projectionReady
      ? oneProjection()
      : { kind: 'notReady' as const, message: 'restoring' });
    const runtimeSubmit = vi.fn(async () => ({
      kind: 'applied' as const,
      action: 'control.mutated' as const,
      policy: 'control-staged-transition' as const,
      sessionId: SESSION_ID,
      result: { kind: 'closed' as const, alreadyClosed: false, known: true },
    }));
    const submit = createCurrentDashboardSessionCommandClient({
      ownerLarkAppId: () => 'owner-dashboard-command-client',
      host: () => ({
        projection: { read: projectionRead },
        runtime: { submit: runtimeSubmit },
      }),
    });
    const request = {
      target: { kind: 'externalSession' as const, sessionId: SESSION_ID },
      idempotencyKey: 'dashboard-close:retryable',
      command: closeCommand(),
    };

    await expect(submit(request)).resolves.toEqual({ kind: 'retryable', message: 'restoring' });
    projectionReady = true;
    await expect(submit({
      ...request,
      command: closeCommand('prune'),
    })).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'idempotencyConflict',
    });
    expect(projectionRead).toHaveBeenCalledTimes(1);
    expect(runtimeSubmit).not.toHaveBeenCalled();

    await expect(submit(request)).resolves.toMatchObject({ kind: 'applied' });
    expect(projectionRead).toHaveBeenCalledTimes(2);
    expect(runtimeSubmit).toHaveBeenCalledTimes(1);
  });

  it('replays a terminal rejection and permanently rejects different semantics', async () => {
    const projectionRead = vi.fn(async () => oneProjection());
    const rejected = {
      kind: 'rejected' as const,
      reason: 'transitionRejected' as const,
      code: 'not_queued',
      message: 'not_queued',
    };
    const runtimeSubmit = vi.fn(async () => rejected);
    const submit = createCurrentDashboardSessionCommandClient({
      ownerLarkAppId: () => 'owner-dashboard-command-client',
      host: () => ({
        projection: { read: projectionRead },
        runtime: { submit: runtimeSubmit },
      }),
    });
    const request = {
      target: { kind: 'externalSession' as const, sessionId: SESSION_ID },
      idempotencyKey: 'dashboard-close:terminal-rejected',
      command: closeCommand(),
    };

    await expect(submit(request)).resolves.toEqual(rejected);
    await expect(submit({
      ...request,
      command: closeCommand('prune'),
    })).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'idempotencyConflict',
    });
    await expect(submit(request)).resolves.toEqual(rejected);
    expect(projectionRead).toHaveBeenCalledTimes(1);
    expect(runtimeSubmit).toHaveBeenCalledTimes(1);
  });

  it('lets a transfer-deferred Agent close redrive the same child identity through the real command client', async () => {
    const owner = 'owner-agent-transfer-real-client';
    const session = {
      sessionId: SESSION_ID,
      larkAppId: owner,
      chatId: 'oc_agent_transfer_real_client',
      rootMessageId: 'om_agent_transfer_real_client',
      status: 'active',
      cliId: 'traex',
    } as DaemonSession['session'];
    const daemonSession = {
      session,
      larkAppId: owner,
      chatId: session.chatId,
      chatType: 'group',
      scope: 'thread',
      spawnedAt: Date.now(),
      lastMessageAt: Date.now(),
      hasHistory: true,
      lastScreenStatus: 'idle',
      initConfig: { backendType: 'tmux' },
      worker: { killed: false },
    } as DaemonSession;
    const runtimeSubmit = vi.fn()
      .mockResolvedValueOnce({
        kind: 'rejected',
        reason: 'transitionRejected',
        code: 'session_transferring',
        message: 'session_transferring',
      })
      .mockResolvedValueOnce({
        kind: 'applied',
        action: 'control.mutated',
        policy: 'control-staged-transition',
        sessionId: SESSION_ID,
        result: { kind: 'closed', alreadyClosed: false, known: true },
      });
    const submit = createCurrentDashboardSessionCommandClient({
      ownerLarkAppId: () => owner,
      host: () => ({
        projection: { read: async () => oneProjection() },
        runtime: { submit: runtimeSubmit },
      }),
    });
    let settleTransfer: (() => void) | undefined;
    const publish = vi.fn(async () => ({
      ok: true as const,
      config: { cliId: 'codex' as const },
      readIsolationCleared: false,
    }));
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: owner,
      activeSessions: new Map([[activeSessionKey(daemonSession), daemonSession]]),
      listSessions: () => [session],
      submit,
      deferTransfer: (_session, callback) => {
        settleTransfer = callback;
        return true;
      },
      agentConfiguration: {
        current: () => ({ cliId: 'traex' }),
        publish,
      },
    });
    const request = {
      operationId: 'agent-transfer-real-client',
      cliId: 'codex',
      model: '',
      cliRuntimePresent: false,
      cliRuntime: undefined,
    };

    await expect(maintenance.changeAgent(request)).resolves.toMatchObject({ kind: 'pending' });
    settleTransfer!();
    await vi.waitFor(() => expect(runtimeSubmit).toHaveBeenCalledTimes(2));
    await expect(maintenance.changeAgent(request)).resolves.toMatchObject({
      kind: 'completed',
      response: { closedMismatchedSessions: 1 },
    });
    expect(runtimeSubmit.mock.calls[0]![0].idempotencyKey)
      .toBe('agent-transfer-real-client:session-dashboard-command-client');
    expect(runtimeSubmit.mock.calls[1]![0].idempotencyKey)
      .toBe('agent-transfer-real-client:session-dashboard-command-client');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'not-wired',
      outcome: {
        kind: 'notWired' as const,
        command: 'control.mutate' as const,
        message: 'control port unavailable',
      },
      attemptsPerSubmit: 1,
    },
    {
      label: 'stale-address',
      outcome: { kind: 'staleAddress' as const },
      attemptsPerSubmit: 2,
    },
  ])(
    'reserves a $label operation hash while allowing the same input to retry',
    async ({ outcome, attemptsPerSubmit }) => {
      let runtimeReady = false;
      const projectionRead = vi.fn(async () => oneProjection());
      const runtimeSubmit = vi.fn(async () => runtimeReady
        ? {
            kind: 'applied' as const,
            action: 'control.mutated' as const,
            policy: 'control-staged-transition' as const,
            sessionId: SESSION_ID,
            result: { kind: 'closed' as const, alreadyClosed: false, known: true },
          }
        : outcome);
      const submit = createCurrentDashboardSessionCommandClient({
        ownerLarkAppId: () => 'owner-dashboard-command-client',
        host: () => ({
          projection: { read: projectionRead },
          runtime: { submit: runtimeSubmit },
        }),
      });
      const request = {
        target: { kind: 'externalSession' as const, sessionId: SESSION_ID },
        idempotencyKey: `dashboard-close:${outcome.kind}`,
        command: closeCommand(),
      };

      await expect(submit(request)).resolves.toEqual(outcome);
      runtimeReady = true;
      await expect(submit({
        ...request,
        command: closeCommand('prune'),
      })).resolves.toMatchObject({
        kind: 'rejected',
        reason: 'idempotencyConflict',
      });
      expect(projectionRead).toHaveBeenCalledTimes(attemptsPerSubmit);
      expect(runtimeSubmit).toHaveBeenCalledTimes(attemptsPerSubmit);

      await expect(submit(request)).resolves.toMatchObject({ kind: 'applied' });
      expect(projectionRead).toHaveBeenCalledTimes(attemptsPerSubmit + 1);
      expect(runtimeSubmit).toHaveBeenCalledTimes(attemptsPerSubmit + 1);
    },
  );

  it('keeps an ambiguous operation sticky and never re-resolves or re-drives it', async () => {
    const projectionRead = vi.fn(async () => oneProjection());
    const ambiguous = {
      kind: 'ambiguous' as const,
      policy: 'control-staged-transition' as const,
      sessionId: SESSION_ID,
      message: 'driver outcome unknown',
    };
    const runtimeSubmit = vi.fn(async () => ambiguous);
    const submit = createCurrentDashboardSessionCommandClient({
      ownerLarkAppId: () => 'owner-dashboard-command-client',
      host: () => ({
        projection: { read: projectionRead },
        runtime: { submit: runtimeSubmit },
      }),
    });
    const request = {
      target: { kind: 'externalSession' as const, sessionId: SESSION_ID },
      idempotencyKey: 'dashboard-close:unknown',
      command: closeCommand(),
    };

    await expect(submit(request)).resolves.toEqual(ambiguous);
    await expect(submit(request)).resolves.toEqual(ambiguous);
    expect(projectionRead).toHaveBeenCalledTimes(1);
    expect(runtimeSubmit).toHaveBeenCalledTimes(1);
  });

  it('preserves idempotent unknown-close behavior and retains its process receipt', async () => {
    const projectionRead = vi.fn(async () => ({ kind: 'notFound' as const }));
    const runtimeSubmit = vi.fn();
    const submit = createCurrentDashboardSessionCommandClient({
      ownerLarkAppId: () => 'owner-dashboard-command-client',
      host: () => ({
        projection: { read: projectionRead },
        runtime: { submit: runtimeSubmit },
      }),
    });
    const request = {
      target: { kind: 'externalSession' as const, sessionId: SESSION_ID },
      idempotencyKey: 'dashboard-close:unknown-session',
      command: closeCommand(),
    };

    await expect(submit(request)).resolves.toMatchObject({
      kind: 'applied',
      result: { kind: 'closed', alreadyClosed: true, known: false },
    });
    await expect(submit(request)).resolves.toMatchObject({
      kind: 'duplicate',
      result: { kind: 'closed', alreadyClosed: true, known: false },
    });
    expect(projectionRead).toHaveBeenCalledTimes(1);
    expect(runtimeSubmit).not.toHaveBeenCalled();
  });

  it('delegates route-target commands to the route registry without a parallel receipt', async () => {
    const projectionRead = vi.fn();
    const runtimeSubmit = vi.fn(async () => ({
      kind: 'applied' as const,
      action: 'dashboard.spawned' as const,
      policy: 'route-staged-opening' as const,
      sessionId: 'session-route-created',
    }));
    const submit = createCurrentDashboardSessionCommandClient({
      ownerLarkAppId: () => 'owner-dashboard-command-client',
      host: () => ({
        projection: { read: projectionRead },
        runtime: { submit: runtimeSubmit },
      }),
    });
    const command: DashboardSpawnCommand = {
      kind: 'dashboard.spawn',
      input: {
        content: 'spawn',
        column: 'backlog',
        role: 'solo',
        coworkers: [],
        images: [],
        postBanner: true,
      },
    };

    await expect(submit({
      target: { kind: 'route', route: { kind: 'chat', chatId: 'oc_route' } },
      idempotencyKey: 'dashboard-spawn:route',
      command,
    })).resolves.toMatchObject({ kind: 'applied', sessionId: 'session-route-created' });
    expect(projectionRead).not.toHaveBeenCalled();
    expect(runtimeSubmit).toHaveBeenCalledWith({
      target: { kind: 'route', route: { kind: 'chat', chatId: 'oc_route' } },
      idempotencyKey: 'dashboard-spawn:route',
      command,
    });
  });
});
