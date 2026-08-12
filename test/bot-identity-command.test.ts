import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBotIdentityCommand } from '../src/cli/bot-identity-command.js';
import { createBotIdentityControlPlane } from '../src/services/bot-identity-control-plane.js';

describe('bot identity operator command', () => {
  let root: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-identity-cli-'));
    configPath = join(root, 'bots.json');
    writeFileSync(configPath, `${JSON.stringify([{
      larkAppId: 'cli_identity_command',
      larkAppSecret: 'must-not-leak',
    }])}\n`);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('provides explicit report/apply/status without leaking config snapshots', () => {
    const control = createBotIdentityControlPlane({
      dataDir: root,
      configPath,
      allocateBotId: () => 'bot_identity_command',
      allocateOperationId: () => 'op_identity_command',
    });
    const reported = runBotIdentityCommand(['report'], { control });
    expect(reported).toMatchObject({ code: 0 });
    expect(reported.stdout).toContain('op_identity_command');
    expect(reported.stdout).not.toContain('must-not-leak');

    expect(runBotIdentityCommand(['apply', 'op_identity_command'], { control }))
      .toMatchObject({ code: 2, stderr: expect.stringMatching(/--yes/) });
    expect(runBotIdentityCommand(['apply', 'op_identity_command', '--yes'], {
      control,
      assertMutationSafe: () => { throw new Error('daemon still online'); },
    })).toMatchObject({ code: 1, stderr: expect.stringMatching(/daemon still online/) });
    expect(runBotIdentityCommand(['apply', 'op_identity_command', '--yes'], { control }))
      .toMatchObject({ code: 0 });
    expect(JSON.parse(runBotIdentityCommand(['status'], { control }).stdout))
      .toMatchObject({ kind: 'ready', revision: 1 });
  });

  it('rejects the retired --target-config bots.json write entry', () => {
    const control = createBotIdentityControlPlane({ dataDir: root, configPath });
    const target = join(root, 'foreign-bots.json');
    writeFileSync(target, `${JSON.stringify([{ larkAppId: 'cli_injected' }])}\n`);
    const result = runBotIdentityCommand(['report', '--target-config', target], { control });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage:');
    expect(JSON.parse(runBotIdentityCommand(['status'], { control }).stdout))
      .toMatchObject({ kind: 'unmigrated' });
  });

  it('dispatches the repair and rollback recovery subcommands through the same gates', () => {
    const calls: string[] = [];
    const control = createBotIdentityControlPlane({
      dataDir: root,
      configPath,
      allocateBotId: () => 'bot_identity_recover',
      allocateOperationId: () => 'op_identity_recover',
    });
    const spy = new Proxy(control, {
      get(targetControl, prop, receiver) {
        const value = Reflect.get(targetControl, prop, receiver);
        if (prop === 'repair' || prop === 'rollback') {
          return (...args: unknown[]) => {
            calls.push(`${String(prop)}:${String(args[0] ?? '')}`);
            return (value as (...inner: unknown[]) => unknown).apply(targetControl, args);
          };
        }
        return value;
      },
    });

    expect(runBotIdentityCommand(['repair'], { control: spy }))
      .toMatchObject({ code: 2, stderr: expect.stringMatching(/--yes/) });
    expect(runBotIdentityCommand(['rollback'], { control: spy }))
      .toMatchObject({ code: 2, stderr: expect.stringMatching(/--yes/) });
    expect(calls).toEqual([]);

    runBotIdentityCommand(['report'], { control: spy });
    // Pre-receipt rollback of the planned operation goes through rollback().
    const rolledBack = runBotIdentityCommand(['rollback', 'op_identity_recover', '--yes'], { control: spy });
    expect(calls).toEqual(['rollback:op_identity_recover']);
    expect(rolledBack.code).toBe(0);
    expect(JSON.parse(rolledBack.stdout)).toMatchObject({
      kind: 'planned',
      operationId: 'op_identity_recover',
    });

    runBotIdentityCommand(['apply', 'op_identity_recover', '--yes'], { control: spy });
    const repaired = runBotIdentityCommand(['repair', '--yes'], { control: spy });
    expect(calls).toEqual(['rollback:op_identity_recover', 'repair:']);
    expect(repaired).toMatchObject({ code: 0 });
    expect(JSON.parse(repaired.stdout)).toMatchObject({
      kind: 'complete',
      operationId: 'op_identity_recover',
    });
  });
});
