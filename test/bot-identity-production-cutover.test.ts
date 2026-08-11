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
  requireReadyDaemonBotIdentities,
} from '../src/core/bot-identity-startup.js';
import { createBotIdentityControlPlane } from '../src/services/bot-identity-control-plane.js';

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

  it('blocks daemon boot without mutating identity truth or implicitly producing a plan', () => {
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

  it('gates daemon registration through status/resolve and never calls apply at startup', () => {
    const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const botIdentityControl = createDaemonBotIdentityControlPlane');
    const gate = source.indexOf('requireReadyDaemonBotIdentities(botIdentityControl', start);
    const register = source.indexOf('registerBot(cfg, botIdentity.botId)', gate);
    expect(start).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(start);
    expect(register).toBeGreaterThan(gate);
    expect(source.slice(start, register)).not.toMatch(/\.apply\s*\(/);
  });
});
