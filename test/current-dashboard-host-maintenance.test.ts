import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCurrentDashboardAgentConfiguration,
  createCurrentDashboardHostMaintenance,
} from '../src/core/current-dashboard-host-maintenance.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';

const agentConfigurationHarness = vi.hoisted(() => ({
  liveConfig: {} as Record<string, unknown>,
  persistedEntry: {} as Record<string, unknown>,
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: agentConfigurationHarness.liveConfig }),
}));

vi.mock('../src/services/config-store.js', () => ({
  rmwBotEntry: async (
    _ownerLarkAppId: string,
    mutate: (entry: Record<string, unknown>, raw: Record<string, unknown>[]) => unknown,
  ) => {
    mutate(agentConfigurationHarness.persistedEntry, [agentConfigurationHarness.persistedEntry]);
    return { ok: true as const, result: null };
  },
}));

const OWNER = 'cli_dashboard_maintenance_owner';

function stored(sessionId: string): Session {
  return {
    sessionId,
    larkAppId: OWNER,
    chatId: `oc_${sessionId}`,
    rootMessageId: `om_${sessionId}`,
    status: 'active',
  } as Session;
}

function active(sessionId: string): DaemonSession {
  const session = stored(sessionId);
  return {
    session,
    larkAppId: OWNER,
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
}

function closedOutcome(sessionId: string) {
  return {
    kind: 'applied' as const,
    action: 'control.mutated' as const,
    policy: 'control-staged-transition' as const,
    sessionId,
    result: { kind: 'closed' as const, alreadyClosed: false, known: true },
  };
}

function stubAgentConfiguration(initial: Record<string, unknown> = { cliId: 'traex' }) {
  let snapshot: any = structuredClone(initial);
  return {
    current: () => structuredClone(snapshot),
    publish: vi.fn(async (input: any) => {
      snapshot = {
        ...snapshot,
        ...input.target,
        model: input.model || undefined,
      };
      return {
        ok: true as const,
        config: structuredClone(snapshot),
        readIsolationCleared: false,
      };
    }),
  };
}

function agentChange(operationId: string, model = '') {
  return {
    operationId,
    cliId: 'codex',
    model,
    cliRuntimePresent: false,
    cliRuntime: undefined,
  };
}

describe('Current Dashboard agent configuration', () => {
  beforeEach(() => {
    agentConfigurationHarness.liveConfig = {};
    agentConfigurationHarness.persistedEntry = {};
  });

  it('publishes a structured runtime as the only executable authority', async () => {
    const runtime = {
      id: 'vendor-codex',
      displayName: 'Vendor Codex',
      executable: '/opt/vendor/bin/vendor-codex',
      update: { provider: 'none' as const },
    };
    agentConfigurationHarness.persistedEntry = {
      cliId: 'codex',
      cliPathOverride: '/opt/legacy/bin/codex',
    };
    agentConfigurationHarness.liveConfig = structuredClone(
      agentConfigurationHarness.persistedEntry,
    );
    const configuration = createCurrentDashboardAgentConfiguration(OWNER);

    const published = await configuration.publish({
      target: { cliId: 'codex', cliRuntime: runtime },
      model: '',
      readIsolationSupported: false,
    });

    expect(published).toMatchObject({
      ok: true,
      config: { cliId: 'codex', cliRuntime: runtime },
    });
    expect(agentConfigurationHarness.persistedEntry).toMatchObject({ cliRuntime: runtime });
    expect(agentConfigurationHarness.persistedEntry).not.toHaveProperty('cliPathOverride');
    expect(agentConfigurationHarness.liveConfig).toMatchObject({ cliRuntime: runtime });
    expect(agentConfigurationHarness.liveConfig).not.toHaveProperty('cliPathOverride');
  });

  it('publishes a legacy executable path without retaining a structured runtime', async () => {
    const staleRuntime = {
      id: 'vendor-codex',
      executable: '/opt/vendor/bin/vendor-codex',
      update: { provider: 'none' as const },
    };
    agentConfigurationHarness.persistedEntry = {
      cliId: 'codex',
      cliRuntime: staleRuntime,
    };
    agentConfigurationHarness.liveConfig = structuredClone(
      agentConfigurationHarness.persistedEntry,
    );
    const configuration = createCurrentDashboardAgentConfiguration(OWNER);

    const published = await configuration.publish({
      target: { cliId: 'codex', cliPathOverride: '/opt/legacy/bin/codex' },
      model: '',
      readIsolationSupported: false,
    });

    expect(published).toMatchObject({
      ok: true,
      config: { cliId: 'codex', cliPathOverride: '/opt/legacy/bin/codex' },
    });
    expect(agentConfigurationHarness.persistedEntry).toMatchObject({
      cliPathOverride: '/opt/legacy/bin/codex',
    });
    expect(agentConfigurationHarness.persistedEntry).not.toHaveProperty('cliRuntime');
    expect(agentConfigurationHarness.liveConfig).toMatchObject({
      cliPathOverride: '/opt/legacy/bin/codex',
    });
    expect(agentConfigurationHarness.liveConfig).not.toHaveProperty('cliRuntime');
  });
});

describe('Current Dashboard host maintenance', () => {
  it('blocks an Agent CLI change when a mismatched exact-owner Session has protected work', async () => {
    const blocked = active('s-protected');
    blocked.session.cliId = 'traex';
    blocked.session.queuedActivationPending = true;
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(blocked), blocked]]),
      listSessions: () => [blocked.session],
      submit: vi.fn(),
      agentConfiguration: stubAgentConfiguration(),
    });

    await expect(maintenance.changeAgent(agentChange('agent-change-protected'))).resolves.toEqual({
      kind: 'blocked',
      error: 'session_mutation_pending',
      blockingSessions: [{
        sessionId: 's-protected',
        cliId: 'traex',
        reasons: ['activation_head'],
      }],
    });
  });

  it('blocks matching live and persisted-only protected Sessions before candidate selection', async () => {
    const matching = active('s-matching-protected');
    matching.session.cliId = 'codex';
    matching.session.queuedActivationPending = true;
    const persistedOnly = stored('s-persisted-protected');
    persistedOnly.larkAppId = undefined;
    persistedOnly.cliId = 'traex';
    persistedOnly.pendingRepoSetup = {} as Session['pendingRepoSetup'];
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(matching), matching]]),
      listSessions: () => [matching.session, persistedOnly],
      submit: vi.fn(),
      agentConfiguration: stubAgentConfiguration(),
    });

    await expect(maintenance.changeAgent(agentChange('agent-change-all-protected'))).resolves.toEqual({
      kind: 'blocked',
      error: 'session_mutation_pending',
      blockingSessions: [
        {
          sessionId: 's-matching-protected',
          cliId: 'codex',
          reasons: ['activation_head'],
        },
        {
          sessionId: 's-persisted-protected',
          cliId: 'traex',
          reasons: ['repository_setup'],
        },
      ],
    });
  });

  it('fails closed before publication for an unbound persisted-only active CLI mismatch', async () => {
    const persistedOnly = stored('s-persisted-mismatch');
    persistedOnly.cliId = 'traex';
    const configuration = stubAgentConfiguration();
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      listSessions: () => [persistedOnly],
      submit: vi.fn(),
      agentConfiguration: configuration,
    });

    await expect(maintenance.changeAgent(agentChange('agent-persisted-only-mismatch')))
      .resolves.toMatchObject({ kind: 'conflict' });
    expect(configuration.publish).not.toHaveBeenCalled();
  });

  it('fails preflight closed on a non-canonical owner registry entry while ignoring foreign entries', async () => {
    const owner = active('s-owner-alias');
    owner.session.cliId = 'traex';
    const foreign = active('s-foreign-alias');
    foreign.larkAppId = 'cli_foreign';
    foreign.session.larkAppId = 'cli_foreign';
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([
        ['non-canonical-owner-key', owner],
        ['non-canonical-foreign-key', foreign],
      ]),
      listSessions: () => [owner.session],
      submit: vi.fn(),
      agentConfiguration: stubAgentConfiguration(),
    });

    await expect(maintenance.changeAgent(agentChange('agent-change-owner-alias')))
      .resolves.toMatchObject({ kind: 'conflict' });
  });

  it('fails preflight closed when one owner has duplicate live bindings for a Session id', async () => {
    const first = active('s-duplicate-owner');
    first.session.cliId = 'traex';
    const second = active('s-duplicate-owner');
    second.session.cliId = 'traex';
    second.session.rootMessageId = 'om_duplicate_owner_second';
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([
        [activeSessionKey(first), first],
        [activeSessionKey(second), second],
      ]),
      listSessions: () => [first.session],
      submit: vi.fn(),
      agentConfiguration: stubAgentConfiguration(),
    });

    await expect(maintenance.changeAgent(agentChange('agent-change-duplicate-owner')))
      .resolves.toMatchObject({ kind: 'conflict' });
  });

  it('fails Agent preflight closed when runtime and persisted owner identities diverge', async () => {
    const mismatched = active('s-owner-mismatch');
    mismatched.session.cliId = 'traex';
    mismatched.session.larkAppId = 'cli_foreign';
    const publish = stubAgentConfiguration();
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(mismatched), mismatched]]),
      listSessions: () => [mismatched.session],
      submit: vi.fn(),
      agentConfiguration: publish,
    });

    await expect(maintenance.changeAgent(agentChange('agent-change-owner-mismatch')))
      .resolves.toMatchObject({ kind: 'conflict' });
    expect(publish.publish).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'a non-canonical owner binding',
      registry() {
        const aliased = active('s-idle-alias');
        return new Map([['non-canonical-owner-key', aliased]]);
      },
    },
    {
      label: 'duplicate owner bindings',
      registry() {
        const first = active('s-idle-duplicate');
        const second = active('s-idle-duplicate');
        second.session.rootMessageId = 'om_idle_duplicate_second';
        return new Map([
          [activeSessionKey(first), first],
          [activeSessionKey(second), second],
        ]);
      },
    },
  ])('does not report or mutate an incomplete idle inventory with $label', async ({ registry }) => {
    const submit = vi.fn();
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: registry(),
      listSessions: () => [],
      submit,
    });

    expect(maintenance.counts()).toMatchObject({ kind: 'notReady' });
    const request = { operationId: 'idle-inventory-malformed', mode: 'suspend_idle' as const };
    const first = await maintenance.sweep(request);
    const replay = await maintenance.sweep(request);
    expect(first).toMatchObject({ kind: 'quarantined' });
    expect(replay).toEqual(first);
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not deduplicate malformed durable owner evidence into a successful maintenance batch', async () => {
    const duplicate = stored('s-stored-duplicate');
    const submit = vi.fn();
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      listSessions: () => [duplicate, { ...duplicate }],
      submit,
    });

    expect(maintenance.counts()).toMatchObject({ kind: 'notReady' });
    await expect(maintenance.sweep({
      operationId: 'stored-owner-duplicate',
      mode: 'clean_stopped',
    })).resolves.toMatchObject({ kind: 'quarantined' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('joins one running Agent-change receipt and rejects the same operation id with another model', async () => {
    const stale = active('s-agent-receipt');
    stale.session.cliId = 'traex';
    const listSessions = vi.fn(() => [stale.session]);
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(stale), stale]]),
      listSessions,
      submit: vi.fn(async () => closedOutcome(stale.session.sessionId)),
      agentConfiguration: stubAgentConfiguration(),
    });
    const request = agentChange('agent-change-one-receipt', 'gpt-5.6');

    const leader = maintenance.changeAgent(request);
    const follower = maintenance.changeAgent(request);
    const conflict = maintenance.changeAgent({
      ...request,
      model: 'gpt-5.5',
    });

    await expect(leader).resolves.toMatchObject({ kind: 'completed' });
    await expect(follower).resolves.toMatchObject({ kind: 'completed' });
    await expect(conflict).resolves.toMatchObject({ kind: 'conflict' });
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it('allows the same Agent operation to retry after a protected preflight clears', async () => {
    const stale = active('s-agent-retry-blocked');
    stale.session.cliId = 'traex';
    stale.session.queuedActivationPending = true;
    const configuration = stubAgentConfiguration();
    const submit = vi.fn(async () => closedOutcome(stale.session.sessionId));
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(stale), stale]]),
      listSessions: () => [stale.session],
      submit,
      agentConfiguration: configuration,
    });
    const request = agentChange('agent-change-retry-blocked');

    await expect(maintenance.changeAgent(request)).resolves.toMatchObject({ kind: 'blocked' });
    stale.session.queuedActivationPending = false;
    await expect(maintenance.changeAgent(request)).resolves.toMatchObject({ kind: 'completed' });
    expect(configuration.publish).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('allows the same Agent operation to retry after a pre-publication snapshot failure', async () => {
    let snapshotAttempts = 0;
    const configuration = stubAgentConfiguration();
    configuration.current = vi.fn(() => {
      snapshotAttempts += 1;
      if (snapshotAttempts === 1) throw new Error('live config temporarily unavailable');
      return { cliId: 'traex' };
    });
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      listSessions: () => [],
      submit: vi.fn(),
      agentConfiguration: configuration,
    });
    const request = agentChange('agent-change-retry-snapshot');

    await expect(maintenance.changeAgent(request)).resolves.toMatchObject({
      kind: 'unavailable',
      error: 'agent_change_config_unavailable',
    });
    await expect(maintenance.changeAgent(request)).resolves.toMatchObject({ kind: 'completed' });
    expect(configuration.current).toHaveBeenCalledTimes(2);
    expect(configuration.publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'throws',
      submit: () => vi.fn().mockRejectedValue(new Error('close response lost')),
    },
    {
      label: 'returns ambiguous',
      submit: () => vi.fn().mockResolvedValue({
        kind: 'ambiguous',
        message: 'close outcome unknown',
      }),
    },
    {
      label: 'returns quarantined',
      submit: () => vi.fn().mockResolvedValue({
        kind: 'quarantined',
        message: 'owner projection ambiguous',
      }),
    },
  ])('quarantines and retains a published Agent change when Session close $label', async ({ label, submit: createSubmit }) => {
    const stale = active('s-agent-unknown-close');
    stale.session.cliId = 'traex';
    const configuration = stubAgentConfiguration();
    const submit = createSubmit();
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(stale), stale]]),
      listSessions: () => [stale.session],
      submit,
      agentConfiguration: configuration,
    });
    const request = agentChange(`agent-change-unknown-${label.replaceAll(' ', '-')}`);

    const first = await maintenance.changeAgent(request);
    const replay = await maintenance.changeAgent(request);

    expect(first).toMatchObject({
      kind: 'quarantined',
      error: 'agent_change_outcome_unknown',
    });
    expect(replay).toEqual(first);
    expect(configuration.publish).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('quarantines an unknown config publication and never republishes the same operation', async () => {
    const configuration = stubAgentConfiguration();
    configuration.publish.mockRejectedValue(new Error('atomic publication acknowledgement lost'));
    const submit = vi.fn();
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      listSessions: () => [],
      submit,
      agentConfiguration: configuration,
    });
    const request = agentChange('agent-change-publish-unknown');

    const first = await maintenance.changeAgent(request);
    const replay = await maintenance.changeAgent(request);

    expect(first).toMatchObject({
      kind: 'quarantined',
      error: 'agent_change_outcome_unknown',
    });
    expect(replay).toEqual(first);
    expect(configuration.publish).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('freezes an Agent CLI mismatch batch at preflight and closes it through Runtime once', async () => {
    const stale = active('s-stale-agent');
    stale.session.cliId = 'traex';
    const registry = new Map([[activeSessionKey(stale), stale]]);
    const submit = vi.fn(async input => closedOutcome(input.target.kind === 'externalSession'
      ? input.target.sessionId
      : 'unexpected'));
    let releasePublish!: () => void;
    const publishGate = new Promise<void>(resolve => { releasePublish = resolve; });
    const configuration = stubAgentConfiguration();
    configuration.publish.mockImplementationOnce(async (input: any) => {
      await publishGate;
      return {
        ok: true as const,
        config: { cliId: input.target.cliId },
        readIsolationCleared: false,
      };
    });
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: registry,
      listSessions: () => [stale.session],
      submit,
      agentConfiguration: configuration,
    });
    const request = agentChange('agent-change-stable');

    const first = maintenance.changeAgent(request);
    await vi.waitFor(() => expect(configuration.publish).toHaveBeenCalledTimes(1));
    const late = active('s-late-agent');
    late.session.cliId = 'traex';
    registry.set(activeSessionKey(late), late);
    releasePublish();

    await expect(first).resolves.toMatchObject({
      kind: 'completed',
      response: { closedMismatchedSessions: 1 },
    });
    await expect(maintenance.changeAgent(request)).resolves.toMatchObject({
      kind: 'completed',
      response: { closedMismatchedSessions: 1 },
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({
      target: { kind: 'externalSession', sessionId: 's-stale-agent' },
      idempotencyKey: 'agent-change-stable:s-stale-agent',
      command: {
        kind: 'control.mutate',
        input: {
          kind: 'close',
          reason: 'agentCliMismatch',
          target: { cliId: 'codex' },
        },
      },
    });
  });

  it('defers a transferring mismatch and resubmits the same child operation after settlement', async () => {
    const transferring = active('s-transferring-agent');
    transferring.session.cliId = 'traex';
    let settleTransfer: (() => void) | undefined;
    const deferTransfer = vi.fn((_session: DaemonSession, callback: () => void) => {
      settleTransfer = callback;
      return true;
    });
    const submit = vi.fn()
      .mockResolvedValueOnce({
        kind: 'rejected',
        reason: 'transitionRejected',
        code: 'session_transferring',
        message: 'session_transferring',
      })
      .mockResolvedValueOnce(closedOutcome('s-transferring-agent'));
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(transferring), transferring]]),
      listSessions: () => [transferring.session],
      submit,
      deferTransfer,
      agentConfiguration: stubAgentConfiguration(),
    });
    const request = agentChange('agent-change-transfer');

    await expect(maintenance.changeAgent(request)).resolves.toMatchObject({
      kind: 'pending',
      error: 'agent_change_pending',
    });
    expect(deferTransfer).toHaveBeenCalledWith(transferring, expect.any(Function));

    settleTransfer!();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    await expect(maintenance.changeAgent(request)).resolves.toMatchObject({
      kind: 'completed',
      response: { closedMismatchedSessions: 1 },
    });
    expect(submit.mock.calls[0]![0].idempotencyKey)
      .toBe('agent-change-transfer:s-transferring-agent');
    expect(submit.mock.calls[1]![0].idempotencyKey)
      .toBe('agent-change-transfer:s-transferring-agent');
  });

  it.each([
    {
      label: 'retryable',
      resumed: { kind: 'retryable', message: 'owner projection restoring' },
      expected: 'completed',
    },
    {
      label: 'throw',
      resumed: new Error('deferred close response lost'),
      expected: 'quarantined',
    },
  ])('keeps a transfer-deferred Agent change nonterminal when callback is $label', async ({
    label,
    resumed,
    expected,
  }) => {
    const transferring = active(`s-transfer-${label}`);
    transferring.session.cliId = 'traex';
    let settleTransfer: (() => void) | undefined;
    const submit = vi.fn()
      .mockResolvedValueOnce({
        kind: 'rejected',
        reason: 'transitionRejected',
        code: 'session_transferring',
        message: 'session_transferring',
      });
    if (resumed instanceof Error) submit.mockRejectedValueOnce(resumed);
    else submit.mockResolvedValueOnce(resumed);
    submit.mockResolvedValueOnce(closedOutcome(transferring.session.sessionId));
    const configuration = stubAgentConfiguration();
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(transferring), transferring]]),
      listSessions: () => [transferring.session],
      submit,
      deferTransfer: (_session, callback) => {
        settleTransfer = callback;
        return true;
      },
      agentConfiguration: configuration,
    });
    const request = agentChange(`agent-change-transfer-${label}`);

    await expect(maintenance.changeAgent(request)).resolves.toMatchObject({ kind: 'pending' });
    settleTransfer!();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    const replay = await maintenance.changeAgent(request);
    expect(replay.kind).toBe(expected);
    if (expected === 'completed') expect(submit).toHaveBeenCalledTimes(3);
    else {
      await expect(maintenance.changeAgent(request)).resolves.toEqual(replay);
      expect(submit).toHaveBeenCalledTimes(2);
    }
    expect(configuration.publish).toHaveBeenCalledTimes(1);
  });

  it('replays the complete Agent change response without republishing config or sweeping twice', async () => {
    const stale = active('s-agent-transaction');
    stale.session.cliId = 'traex';
    let currentConfig: any = {
      cliId: 'traex',
      model: 'old-model',
      readIsolation: false,
    };
    const publish = vi.fn(async (input: any) => {
      currentConfig = {
        ...currentConfig,
        ...input.target,
        model: input.model || undefined,
        readIsolation: input.readIsolationSupported
          ? currentConfig.readIsolation
          : false,
      };
      return {
        ok: true as const,
        config: structuredClone(currentConfig),
        readIsolationCleared: false,
      };
    });
    const submit = vi.fn(async () => closedOutcome(stale.session.sessionId));
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([[activeSessionKey(stale), stale]]),
      listSessions: () => [stale.session],
      submit,
      agentConfiguration: {
        current: () => structuredClone(currentConfig),
        publish,
      },
    });
    const request = {
      operationId: 'agent-change-transaction',
      cliId: 'riff',
      model: 'aiden',
      cliRuntimePresent: false,
      cliRuntime: undefined,
    };

    const first = await maintenance.changeAgent(request);
    const replay = await maintenance.changeAgent(request);

    expect(first).toEqual({
      kind: 'completed',
      response: {
        ok: true,
        cliId: 'riff',
        cliRuntime: null,
        cliPathOverride: null,
        wrapperCli: null,
        model: 'aiden',
        selectionKey: 'riff',
        closedMismatchedSessions: 1,
        readIsolation: false,
        readIsolationSupported: false,
        readIsolationCleared: false,
        agentAvailable: true,
        availabilityWarning: undefined,
        requiredCommand: undefined,
        runtimeProbe: undefined,
      },
    });
    expect(replay).toEqual(first);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('rejects a conflicting Agent request before a second config publication', async () => {
    let currentConfig: any = { cliId: 'traex' };
    const publish = vi.fn(async (input: any) => {
      currentConfig = { ...currentConfig, ...input.target, model: input.model || undefined };
      return {
        ok: true as const,
        config: structuredClone(currentConfig),
        readIsolationCleared: false,
      };
    });
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      listSessions: () => [],
      submit: vi.fn(),
      agentConfiguration: {
        current: () => structuredClone(currentConfig),
        publish,
      },
    });

    await expect(maintenance.changeAgent({
      operationId: 'agent-change-conflict',
      cliId: 'riff',
      model: 'first',
      cliRuntimePresent: false,
      cliRuntime: undefined,
    })).resolves.toMatchObject({ kind: 'completed' });
    await expect(maintenance.changeAgent({
      operationId: 'agent-change-conflict',
      cliId: 'riff',
      model: 'second',
      cliRuntimePresent: false,
      cliRuntime: undefined,
    })).resolves.toMatchObject({ kind: 'conflict' });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('normalizes a queued model-only change after the preceding runtime publication', async () => {
    const runtime = {
      id: 'node-codex',
      displayName: 'Node Codex',
      executable: process.execPath,
      update: { provider: 'none' as const },
    };
    let currentConfig: any = { cliId: 'codex', model: 'old-model' };
    let releaseFirst!: () => void;
    const firstPublishGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const current = vi.fn(() => structuredClone(currentConfig));
    const publish = vi.fn(async (input: any) => {
      if (publish.mock.calls.length === 1) await firstPublishGate;
      currentConfig = {
        ...currentConfig,
        ...input.target,
        model: input.model || undefined,
      };
      return {
        ok: true as const,
        config: structuredClone(currentConfig),
        readIsolationCleared: false,
      };
    });
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      listSessions: () => [],
      submit: vi.fn(),
      agentConfiguration: { current, publish },
    });

    const runtimeChange = maintenance.changeAgent({
      operationId: 'agent-runtime-first',
      cliId: 'codex',
      model: 'runtime-model',
      cliRuntimePresent: true,
      cliRuntime: runtime,
    });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    const modelOnlyChange = maintenance.changeAgent({
      operationId: 'agent-model-second',
      cliId: 'codex',
      model: 'model-only',
      cliRuntimePresent: false,
      cliRuntime: undefined,
    });
    expect(current).toHaveBeenCalledTimes(1);

    releaseFirst();

    await expect(runtimeChange).resolves.toMatchObject({ kind: 'completed' });
    await expect(modelOnlyChange).resolves.toMatchObject({
      kind: 'completed',
      response: {
        cliRuntime: runtime,
        model: 'model-only',
      },
    });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]![0].target).toMatchObject({ cliRuntime: runtime });
    expect(currentConfig).toMatchObject({ cliRuntime: runtime, model: 'model-only' });
  });

  it('freezes one candidate set and replays the same batch result', async () => {
    const rows = [stored('s-1')];
    const submit = vi.fn(async input => closedOutcome(input.target.kind === 'externalSession'
      ? input.target.sessionId
      : 'unexpected'));
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      listSessions: () => rows,
      submit,
    });

    await expect(maintenance.sweep({ operationId: 'batch-1', mode: 'clean_stopped' }))
      .resolves.toEqual({ kind: 'completed', mode: 'clean_stopped', candidates: 1, affected: 1 });
    rows.push(stored('s-2'));
    await expect(maintenance.sweep({ operationId: 'batch-1', mode: 'clean_stopped' }))
      .resolves.toEqual({ kind: 'completed', mode: 'clean_stopped', candidates: 1, affected: 1 });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('retries a pre-candidate Store read with the same frozen semantic reservation', async () => {
    let reads = 0;
    const listSessions = vi.fn(() => {
      reads += 1;
      if (reads === 1) throw new Error('session store temporarily unavailable');
      return [stored('s-after-store-retry')];
    });
    const submit = vi.fn(async () => closedOutcome('s-after-store-retry'));
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      listSessions,
      submit,
    });
    const request = { operationId: 'batch-store-retry', mode: 'clean_stopped' as const };

    await expect(maintenance.sweep(request)).resolves.toMatchObject({
      kind: 'retryable',
      candidates: 0,
      affected: 0,
    });
    await expect(maintenance.sweep({
      operationId: request.operationId,
      mode: 'suspend_idle',
    })).resolves.toMatchObject({ kind: 'conflict' });
    await expect(maintenance.sweep(request)).resolves.toEqual({
      kind: 'completed',
      mode: 'clean_stopped',
      candidates: 1,
      affected: 1,
    });
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('quarantines an ambiguous candidate outcome and replays it without resubmission', async () => {
    const rows = [stored('s-ambiguous')];
    const submit = vi.fn().mockResolvedValue({
      kind: 'ambiguous',
      policy: 'control-staged-transition',
      sessionId: 's-ambiguous',
      message: 'close effect outcome is unknown',
    });
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      listSessions: () => rows,
      submit,
    });
    const request = { operationId: 'batch-ambiguous', mode: 'clean_stopped' as const };

    const first = await maintenance.sweep(request);
    const replay = await maintenance.sweep(request);

    expect(first).toEqual({
      kind: 'quarantined',
      message: 'Host maintenance clean_stopped outcome is unknown for s-ambiguous: close effect outcome is unknown',
    });
    expect(replay).toEqual(first);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('quarantines a quarantined candidate outcome and replays it without resubmission', async () => {
    const rows = [stored('s-quarantined')];
    const submit = vi.fn().mockResolvedValue({
      kind: 'quarantined',
      message: 'owner projection is unreadable',
    });
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      listSessions: () => rows,
      submit,
    });
    const request = { operationId: 'batch-quarantined', mode: 'clean_stopped' as const };

    const first = await maintenance.sweep(request);
    const replay = await maintenance.sweep(request);

    expect(first).toEqual({
      kind: 'quarantined',
      message: 'Host maintenance clean_stopped outcome is unknown for s-quarantined: owner projection is unreadable',
    });
    expect(replay).toEqual(first);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('quarantines a thrown candidate outcome and replays it without resubmission', async () => {
    const rows = [stored('s-thrown')];
    const submit = vi.fn().mockRejectedValue(new Error('dispatch response lost'));
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      listSessions: () => rows,
      submit,
    });
    const request = { operationId: 'batch-thrown', mode: 'clean_stopped' as const };

    const first = await maintenance.sweep(request);
    const replay = await maintenance.sweep(request);

    expect(first).toEqual({
      kind: 'quarantined',
      message: 'Host maintenance clean_stopped outcome is unknown for s-thrown: dispatch response lost',
    });
    expect(replay).toEqual(first);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('keeps known rejected and stale candidates as a completed best-effort batch', async () => {
    const rows = [stored('s-rejected'), stored('s-stale')];
    const submit = vi.fn().mockImplementation(async input => (
      input.target.kind === 'externalSession' && input.target.sessionId === 's-rejected'
        ? {
            kind: 'rejected',
            reason: 'transitionRejected',
            code: 'host_overload_candidate_changed',
            message: 'host_overload_candidate_changed',
          }
        : { kind: 'staleAddress' }
    ));
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      listSessions: () => rows,
      submit,
    });

    await expect(maintenance.sweep({
      operationId: 'batch-known-refusals',
      mode: 'clean_stopped',
    })).resolves.toEqual({
      kind: 'completed',
      mode: 'clean_stopped',
      candidates: 2,
      affected: 0,
    });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('retries only unresolved candidates from the original frozen batch', async () => {
    const rows = [stored('s-applied'), stored('s-retryable')];
    const submit = vi.fn().mockImplementation(async input => {
      const sessionId = input.target.kind === 'externalSession'
        ? input.target.sessionId
        : 'unexpected';
      if (sessionId === 's-retryable' && submit.mock.calls.length === 2) {
        return { kind: 'retryable', message: 'owner projection is temporarily unavailable' };
      }
      return closedOutcome(sessionId);
    });
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      listSessions: () => rows,
      submit,
    });
    const request = { operationId: 'batch-retryable', mode: 'clean_stopped' as const };

    await expect(maintenance.sweep(request)).resolves.toEqual({
      kind: 'retryable',
      mode: 'clean_stopped',
      candidates: 2,
      affected: 1,
      message: 'Host maintenance clean_stopped has 1 retryable candidate(s)',
    });
    rows.push(stored('s-late'));
    await expect(maintenance.sweep(request)).resolves.toEqual({
      kind: 'completed',
      mode: 'clean_stopped',
      candidates: 2,
      affected: 2,
    });

    expect(submit.mock.calls.map(([input]) => (
      input.target.kind === 'externalSession' ? input.target.sessionId : 'unexpected'
    ))).toEqual(['s-applied', 's-retryable', 's-retryable']);
  });

  it('registers a running receipt before candidate lookup can re-enter', async () => {
    const submit = vi.fn(async () => closedOutcome('s-1'));
    let maintenance: ReturnType<typeof createCurrentDashboardHostMaintenance>;
    let follower: Promise<unknown> | undefined;
    const listSessions = vi.fn(() => {
      follower = maintenance.sweep({ operationId: 'reentrant', mode: 'clean_stopped' });
      return [stored('s-1')];
    });
    maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      listSessions,
      submit,
    });

    const leader = maintenance.sweep({ operationId: 'reentrant', mode: 'clean_stopped' });
    await expect(leader).resolves.toMatchObject({ kind: 'completed', candidates: 1 });
    await expect(follower).resolves.toMatchObject({ kind: 'completed', candidates: 1 });
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('rejects reusing one operation identity for another maintenance mode', async () => {
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map(),
      listSessions: () => [],
      submit: vi.fn(),
    });
    await maintenance.sweep({ operationId: 'same', mode: 'clean_stopped' });
    await expect(maintenance.sweep({ operationId: 'same', mode: 'suspend_idle' }))
      .resolves.toMatchObject({ kind: 'conflict' });
  });

  it('dispatches different Session candidates without a host-wide serial wait', async () => {
    const first = active('s-1');
    const second = active('s-2');
    const releases = new Map<string, () => void>();
    const submit = vi.fn(input => new Promise(resolve => {
      const sessionId = input.target.kind === 'externalSession' ? input.target.sessionId : 'unexpected';
      releases.set(sessionId, () => resolve({
        kind: 'applied',
        action: 'control.mutated',
        policy: 'control-staged-transition',
        sessionId,
        result: { kind: 'suspended', suspended: true },
      }));
    }));
    const maintenance = createCurrentDashboardHostMaintenance({
      ownerLarkAppId: OWNER,
      activeSessions: new Map([
        [activeSessionKey(first), first],
        [activeSessionKey(second), second],
      ]),
      listSessions: () => [],
      submit,
    });

    const sweep = maintenance.sweep({ operationId: 'parallel', mode: 'suspend_idle' });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    releases.get('s-1')!();
    releases.get('s-2')!();
    await expect(sweep).resolves.toEqual({
      kind: 'completed',
      mode: 'suspend_idle',
      candidates: 2,
      affected: 2,
    });
  });
});
