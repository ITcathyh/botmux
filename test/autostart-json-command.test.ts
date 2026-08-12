import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutostartOperationError, type AutostartState } from '../src/autostart.js';
import { writeAutostartJsonMutation } from '../src/cli/autostart-json.js';

const opts = {
  pkgRoot: '/opt/botmux',
  configDir: '/home/test/.botmux',
  logDir: '/home/test/.botmux/logs',
};

const enabledState: AutostartState = {
  supported: true,
  platform: 'linux',
  manager: 'systemd-user',
  scope: 'user-login',
  registration: 'enabled',
  enabled: true,
  installed: true,
  loaded: false,
  active: false,
  managerReachable: true,
  manageable: true,
  lingerEnabled: false,
  targetExists: true,
  targetMatchesCurrentRuntime: true,
  localDevTarget: false,
  warnings: ['pending_login'],
};

describe('autostart CLI JSON mutation contract', () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it('writes exactly one success JSON line and diverts all diagnostics', () => {
    const stdout: string[] = [];
    const diagnostics: unknown[][] = [];
    const mutate = vi.fn((_opts, enabled: boolean) => {
      expect(enabled).toBe(true);
      console.log('human log');
      console.warn('human warning');
      console.error('human error');
      return { changed: false, state: enabledState };
    });

    const result = writeAutostartJsonMutation(opts, true, {
      mutate,
      writeStdout: line => stdout.push(line),
      writeDiagnostic: (...args) => diagnostics.push(args),
    });

    expect(result).toEqual({ ok: true, changed: false, state: enabledState });
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toEqual(result);
    expect(diagnostics).toEqual([['human log'], ['human warning'], ['human error']]);
    expect(mutate).toHaveBeenCalledWith(opts, true);
  });

  it.each([
    ['operation_in_progress', 'operation_in_progress'],
    ['manager_unavailable', 'manager_unavailable'],
    ['target_unavailable', 'target_unavailable'],
    ['state_mismatch', 'state_mismatch'],
    ['unsupported_platform', 'unsupported_platform'],
    ['mutation_failed', 'command_failed'],
  ] as const)('maps service error %s to stable machine code %s', (serviceCode, machineCode) => {
    const stdout: string[] = [];
    const result = writeAutostartJsonMutation(opts, false, {
      mutate: () => { throw new AutostartOperationError(serviceCode, 'detail'); },
      writeStdout: line => stdout.push(line),
      writeDiagnostic: () => undefined,
    });

    expect(result).toEqual({ ok: false, error: machineCode, detail: 'detail' });
    expect(stdout).toEqual([JSON.stringify(result)]);
  });

  it('maps unexpected failures to command_failed without leaking extra stdout', () => {
    const stdout: string[] = [];
    const result = writeAutostartJsonMutation(opts, true, {
      mutate: () => { throw new Error('unexpected'); },
      writeStdout: line => stdout.push(line),
    });
    expect(result).toEqual({ ok: false, error: 'command_failed', detail: 'unexpected' });
    expect(stdout).toHaveLength(1);
  });

  it.each([
    ['human', []],
    ['json', ['--json']],
  ] as const)('keeps %s status inspection free of runtime directory writes', (_mode, args) => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-autostart-status-'));
    homes.push(home);
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('src/cli.ts'), 'autostart', 'status', ...args],
      {
        cwd: resolve('.'),
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    if (args.length > 0) expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(existsSync(join(home, '.botmux'))).toBe(false);
  }, 20_000);

  it('keeps the machine envelope intact when the transaction directory cannot be created', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-autostart-json-failure-'));
    homes.push(home);
    writeFileSync(join(home, '.botmux'), 'not a directory');

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('src/cli.ts'), 'autostart', 'enable', '--json'],
      {
        cwd: resolve('.'),
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const lines = result.stdout.trim().split(/\r?\n/u);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, error: 'command_failed' });
  }, 20_000);
});
