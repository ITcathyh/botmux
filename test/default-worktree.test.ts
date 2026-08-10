import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

let tempRoot: string;
let configPath: string;

async function loadGate(defaultWorkingDir?: string, enabled = false) {
  writeFileSync(configPath, JSON.stringify([{
    larkAppId: 'app_wt',
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    ...(defaultWorkingDir ? { defaultWorkingDir } : {}),
    ...(enabled ? { defaultWorkingDirAutoWorktree: true } : {}),
  }]));
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  registry.loadBotConfigs().forEach(config => registry.registerBot(config));
  return import('../src/services/default-worktree.js');
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'default-worktree-gate-'));
  configPath = join(tempRoot, 'bots.json');
  process.env.BOTS_CONFIG = configPath;
});

afterEach(() => {
  delete process.env.BOTS_CONFIG;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('botAutoWorktreeEnabled', () => {
  it('requires both a default directory and the explicit auto-worktree toggle', async () => {
    await expect(loadGate('/repos/default', true).then(module => (
      module.botAutoWorktreeEnabled('app_wt')
    ))).resolves.toBe(true);
    await expect(loadGate('/repos/default', false).then(module => (
      module.botAutoWorktreeEnabled('app_wt')
    ))).resolves.toBe(false);
    await expect(loadGate(undefined, true).then(module => (
      module.botAutoWorktreeEnabled('app_wt')
    ))).resolves.toBe(false);
  });
});
