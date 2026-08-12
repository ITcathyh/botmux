import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  __testOnly_resetBotRegistry,
  registerBot,
  type BotConfig,
} from '../src/bot-registry.js';
import {
  BotIdentityStartupBlockedError,
  createDaemonBotIdentityControlPlane,
  ensureReadyDaemonBotIdentities,
  requireReadyDaemonBotIdentities,
} from '../src/core/bot-identity-startup.js';
import { parseBotId } from '../src/core/bot-identity.js';
import {
  createBotIdentityControlPlane,
  type BotIdentityBinding,
  type BotIdentityControlPlane,
} from '../src/services/bot-identity-control-plane.js';

describe('I1 production identity cutover', () => {
  let root: string;
  let configPath: string;
  let configs: BotConfig[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-identity-cutover-'));
    configPath = join(root, 'bots.json');
    configs = [{
      larkAppId: 'cli_cutover',
      larkAppSecret: 'secret',
      cliId: 'codex-app',
    }];
    writeFileSync(configPath, `${JSON.stringify(configs, null, 2)}\n`);
  });

  afterEach(() => {
    __testOnly_resetBotRegistry();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the read-only gate free of implicit allocation or plan side effects', () => {
    const control = createBotIdentityControlPlane({ dataDir: root, configPath });

    expect(() => requireReadyDaemonBotIdentities(control, configs)).toThrowError(
      expect.objectContaining<Partial<BotIdentityStartupBlockedError>>({
        name: 'BotIdentityStartupBlockedError',
        action: 'report',
      }),
    );
    expect(existsSync(join(root, 'bot-identities.json'))).toBe(false);
    expect(existsSync(join(root, 'bot-identity-intent.json'))).toBe(false);
    expect(existsSync(join(root, 'bot-identity-ops'))
      ? readdirSync(join(root, 'bot-identity-ops'))
      : []).toEqual([]);
  });

  it('bootstraps a virgin root at first boot and stays stable across restarts', () => {
    const control = createBotIdentityControlPlane({
      dataDir: root,
      configPath,
      allocateBotId: () => 'bot_first_boot',
      allocateOperationId: () => 'op_first_boot',
    });

    const identities = ensureReadyDaemonBotIdentities(control, configs);
    expect(identities.get('cli_cutover')).toMatchObject({
      botId: 'bot_first_boot',
      address: { kind: 'lark', larkAppId: 'cli_cutover' },
    });
    expect(existsSync(join(root, 'bot-identities.json'))).toBe(true);
    expect(control.status()).toMatchObject({ kind: 'ready', revision: 1 });

    // Second boot reuses the promoted identity without minting a new operation.
    expect(ensureReadyDaemonBotIdentities(control, configs).get('cli_cutover')?.botId)
      .toBe('bot_first_boot');
    expect(readdirSync(join(root, 'bot-identity-ops')).sort()).toEqual([
      'op_first_boot.plan.json',
      'op_first_boot.receipt.json',
    ]);
  });

  it('bootstraps a core-only root from its immutable launch authority at first boot', () => {
    rmSync(configPath);
    const coreConfigs: BotConfig[] = [{
      larkAppId: 'local_first_boot',
      larkAppSecret: '',
      apiOnly: true,
      cliId: 'codex-app',
    }];
    const control = createDaemonBotIdentityControlPlane({
      dataDir: root,
      configPath,
      configProvenance: 'synthetic',
      configs: coreConfigs,
    });

    expect(ensureReadyDaemonBotIdentities(control, coreConfigs).get('local_first_boot'))
      .toMatchObject({ address: { kind: 'coreOnly', launchId: 'local_first_boot' } });
    expect(control.status()).toMatchObject({ kind: 'ready', revision: 1 });
    expect(existsSync(configPath)).toBe(false);
  });

  it('first boot allocates the whole config authority even when one daemon gates a single bot', () => {
    const fleetConfigs: BotConfig[] = [
      { larkAppId: 'cli_cutover', larkAppSecret: 'secret', cliId: 'codex-app' },
      { larkAppId: 'cli_cutover_peer', larkAppSecret: 'secret', cliId: 'codex-app' },
    ];
    writeFileSync(configPath, `${JSON.stringify(fleetConfigs, null, 2)}\n`);
    const ids = ['bot_fleet_gate_one', 'bot_fleet_gate_two'];
    const control = createBotIdentityControlPlane({
      dataDir: root,
      configPath,
      allocateBotId: () => ids.shift()!,
      allocateOperationId: () => 'op_fleet_gate',
    });

    // The gate resolves only this daemon's config…
    const identities = ensureReadyDaemonBotIdentities(control, [fleetConfigs[1]!]);
    expect([...identities.keys()]).toEqual(['cli_cutover_peer']);
    // …but the single bootstrap operation covered the entire address set.
    expect(control.resolveActive({ kind: 'lark', larkAppId: 'cli_cutover' }).botId)
      .toBe('bot_fleet_gate_one');
    expect(control.resolveActive({ kind: 'lark', larkAppId: 'cli_cutover_peer' }).botId)
      .toBe('bot_fleet_gate_two');
  });

  it('routes every non-ready lock-free sample through bootstrap so a sibling mid-promotion window cannot brick a boot', () => {
    const binding: BotIdentityBinding = {
      botId: parseBotId('bot_sibling_ready'),
      status: 'active',
      address: { kind: 'lark', larkAppId: 'cli_cutover' },
    };
    let promoted = false;
    const calls: string[] = [];
    const control: BotIdentityControlPlane = {
      report() { throw new Error('startup gate must not call report'); },
      apply() { throw new Error('startup gate must not call apply'); },
      repair() { throw new Error('startup gate must not call repair'); },
      rollback() { throw new Error('startup gate must not call rollback'); },
      bootstrap() {
        calls.push('bootstrap');
        // Emulates the locked re-derivation: by the time this boot acquires
        // the control lock, the sibling's in-flight promotion has completed.
        promoted = true;
        return { kind: 'ready', revision: 1, operationId: 'op_sibling' };
      },
      status() {
        calls.push('status');
        // The lock-free sample lands inside a sibling's intent window first.
        return promoted
          ? { kind: 'ready', revision: 1, operationId: 'op_sibling' }
          : { kind: 'needsRepair', reason: 'bot identity promotion intent is active' };
      },
      resolveActive() { return binding; },
      actorRef() { throw new Error('unused'); },
    };

    expect(ensureReadyDaemonBotIdentities(control, configs).get('cli_cutover')?.botId)
      .toBe('bot_sibling_ready');
    expect(calls).toEqual(['status', 'bootstrap', 'status']);
  });

  it('keeps non-virgin boot states blocked behind explicit operator action', () => {
    const control = createBotIdentityControlPlane({
      dataDir: root,
      configPath,
      allocateBotId: () => 'bot_drift_boot',
      allocateOperationId: () => 'op_drift_boot',
    });
    ensureReadyDaemonBotIdentities(control, configs);

    const movedConfigs: BotConfig[] = [{
      larkAppId: 'cli_moved',
      larkAppSecret: 'secret',
      cliId: 'codex-app',
    }];
    writeFileSync(configPath, `${JSON.stringify(movedConfigs, null, 2)}\n`);

    expect(() => ensureReadyDaemonBotIdentities(control, movedConfigs)).toThrowError(
      expect.objectContaining<Partial<BotIdentityStartupBlockedError>>({
        name: 'BotIdentityStartupBlockedError',
        action: 'report',
      }),
    );
    // The promoted registry stays untouched: address drift is never auto-absorbed.
    expect(JSON.parse(readFileSync(join(root, 'bot-identities.json'), 'utf8')))
      .toMatchObject({ revision: 1, operationId: 'op_drift_boot' });
  });

  it('binds every active config only after explicit report and apply', () => {
    const ids = ['bot_cutover_random'];
    const operations = ['op_cutover'];
    const control = createBotIdentityControlPlane({
      dataDir: root,
      configPath,
      allocateBotId: () => ids.shift()!,
      allocateOperationId: () => operations.shift()!,
    });
    const plan = control.report();

    expect(() => requireReadyDaemonBotIdentities(control, configs)).toThrowError(
      expect.objectContaining<Partial<BotIdentityStartupBlockedError>>({
        action: 'apply',
        operationId: plan.operationId,
      }),
    );
    control.apply(plan.operationId);

    const identities = requireReadyDaemonBotIdentities(control, configs);
    expect(identities.get('cli_cutover')).toMatchObject({
      botId: 'bot_cutover_random',
      address: { kind: 'lark', larkAppId: 'cli_cutover' },
    });
    const state = registerBot(configs[0]!, identities.get('cli_cutover')!.botId);
    expect(state.botId).toBe('bot_cutover_random');
  });

  it('binds a core-only root from its immutable launch authority without touching bots.json', () => {
    rmSync(configPath);
    const coreConfigs: BotConfig[] = [{
      larkAppId: 'local_cutover',
      larkAppSecret: '',
      apiOnly: true,
      cliId: 'codex-app',
    }];
    const control = createDaemonBotIdentityControlPlane({
      dataDir: root,
      configPath,
      configProvenance: 'synthetic',
      configs: coreConfigs,
    });
    const plan = control.report();
    control.apply(plan.operationId);

    expect(requireReadyDaemonBotIdentities(control, coreConfigs).get('local_cutover'))
      .toMatchObject({ address: { kind: 'coreOnly', launchId: 'local_cutover' } });
    expect(existsSync(configPath)).toBe(false);
  });

  it('gates daemon registration through the bootstrap-aware gate and never calls apply directly', () => {
    const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const botIdentityControl = createDaemonBotIdentityControlPlane');
    const gate = source.indexOf('ensureReadyDaemonBotIdentities(botIdentityControl', start);
    const register = source.indexOf('registerBot(cfg, botIdentity.botId)', gate);
    expect(start).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(start);
    expect(register).toBeGreaterThan(gate);
    expect(source.slice(start, register)).not.toMatch(/\.(apply|report|repair|rollback|bootstrap)\s*\(/);
  });
});
