import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AutostartState } from '../src/autostart.js';
import {
  createDashboardAutostartController,
  DashboardAutostartError,
  dashboardAutostartErrorStatus,
  parseAutostartWrite,
} from '../src/dashboard/autostart-api.js';

const opts = {
  pkgRoot: '/opt/botmux',
  configDir: '/home/test/.botmux',
  logDir: '/home/test/.botmux/logs',
};

function state(overrides: Partial<AutostartState> = {}): AutostartState {
  return {
    supported: true,
    platform: 'macos',
    manager: 'launchd',
    scope: 'user-login',
    registration: 'disabled',
    enabled: false,
    installed: false,
    loaded: false,
    active: false,
    managerReachable: true,
    manageable: true,
    lingerEnabled: null,
    targetExists: true,
    targetMatchesCurrentRuntime: null,
    localDevTarget: false,
    warnings: [],
    ...overrides,
  };
}

describe('Dashboard autostart API service', () => {
  it('accepts only the exact {enabled:boolean} body', () => {
    expect(parseAutostartWrite({ enabled: true })).toEqual({ ok: true, enabled: true });
    expect(parseAutostartWrite({ enabled: false })).toEqual({ ok: true, enabled: false });
    for (const invalid of [null, [], {}, { enabled: 1 }, { enabled: true, path: '/tmp/x' }]) {
      expect(parseAutostartWrite(invalid)).toEqual({ ok: false, error: 'invalid_body' });
    }
  });

  it('uses the inspector only for GET state', async () => {
    const current = state();
    const inspect = vi.fn(async () => current);
    const runTransaction = vi.fn();
    const controller = createDashboardAutostartController({ opts, inspect, runTransaction });

    await expect(controller.getState()).resolves.toBe(current);
    expect(inspect).toHaveBeenCalledOnce();
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('delegates even a healthy no-op to one lock-scoped CLI transaction', async () => {
    const current = state({
      registration: 'enabled',
      enabled: true,
      installed: true,
      targetMatchesCurrentRuntime: true,
    });
    const inspect = vi.fn(() => {
      throw new Error('PUT must not perform an out-of-transaction inspection');
    });
    const runTransaction = vi.fn(async () => ({ changed: false, state: current }));
    const controller = createDashboardAutostartController({ opts, inspect, runTransaction });

    await expect(controller.setEnabled(true)).resolves.toEqual({ changed: false, state: current });
    expect(runTransaction).toHaveBeenCalledOnce();
    expect(runTransaction).toHaveBeenCalledWith(true);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('returns the authoritative result produced by the transaction child', async () => {
    const enabled = state({
      registration: 'enabled',
      enabled: true,
      installed: true,
      targetMatchesCurrentRuntime: true,
      warnings: ['pending_login'],
    });
    const runTransaction = vi.fn(async () => ({ changed: true, state: enabled }));
    const controller = createDashboardAutostartController({ opts, runTransaction });

    await expect(controller.setEnabled(true)).resolves.toEqual({ changed: true, state: enabled });
    expect(runTransaction).toHaveBeenCalledWith(true);
  });

  it('serializes double-clicks while a mutation is in flight', async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const enabled = state({
      registration: 'enabled',
      enabled: true,
      installed: true,
      targetMatchesCurrentRuntime: true,
    });
    const runTransaction = vi.fn(async () => {
      await barrier;
      return { changed: true, state: enabled };
    });
    const controller = createDashboardAutostartController({ opts, runTransaction });

    const first = controller.setEnabled(true);
    await expect(controller.setEnabled(true)).rejects.toMatchObject({ code: 'operation_in_progress' });
    release();
    await expect(first).resolves.toMatchObject({ changed: true });
  });

  it('preserves stable errors returned by the transaction child', async () => {
    const failure = new DashboardAutostartError(
      'target_unavailable',
      'target unavailable',
      'rebuild first',
    );
    const runTransaction = vi.fn(async () => { throw failure; });
    const controller = createDashboardAutostartController({
      opts,
      runTransaction,
    });

    await expect(controller.setEnabled(true)).rejects.toBe(failure);
    expect(runTransaction).toHaveBeenCalledWith(true);
  });

  it('runs a fixed enable --json child and parses its single success envelope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-dashboard-autostart-child-'));
    const cli = join(dir, 'dist', 'cli.js');
    const enabled = state({
      registration: 'enabled',
      enabled: true,
      installed: true,
      targetMatchesCurrentRuntime: true,
    });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(cli, [
      `const expected = ${JSON.stringify(['autostart', 'enable', '--json'])};`,
      'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(9);',
      `process.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, changed: false, state: enabled }))});`,
    ].join('\n'));

    try {
      const controller = createDashboardAutostartController({
        opts: { pkgRoot: dir, configDir: join(dir, 'config'), logDir: join(dir, 'logs') },
      });
      await expect(controller.setEnabled(true)).resolves.toEqual({ changed: false, state: enabled });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a structured nonzero child failure before stderr fallback text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-dashboard-autostart-error-child-'));
    const cli = join(dir, 'dist', 'cli.js');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(cli, [
      'process.stderr.write("human diagnostic\\n");',
      `process.stdout.write(${JSON.stringify(JSON.stringify({
        ok: false,
        error: 'manager_unavailable',
        detail: 'user manager unavailable',
      }))});`,
      'process.exitCode = 1;',
    ].join('\n'));

    try {
      const controller = createDashboardAutostartController({
        opts: { pkgRoot: dir, configDir: join(dir, 'config'), logDir: join(dir, 'logs') },
      });
      await expect(controller.setEnabled(false)).rejects.toMatchObject({
        code: 'manager_unavailable',
        detail: 'user manager unavailable',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on a malformed mutation response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-dashboard-autostart-malformed-child-'));
    const cli = join(dir, 'dist', 'cli.js');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(cli, 'process.stdout.write("not-json");\n');

    try {
      const controller = createDashboardAutostartController({
        opts: { pkgRoot: dir, configDir: join(dir, 'config'), logDir: join(dir, 'logs') },
      });
      await expect(controller.setEnabled(true)).rejects.toMatchObject({
        code: 'command_failed',
        detail: 'invalid_mutation_response',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps stable error codes to API statuses', () => {
    const cases = [
      ['operation_in_progress', 409],
      ['unsupported_platform', 501],
      ['manager_unavailable', 503],
      ['command_timeout', 504],
      ['command_failed', 500],
      ['state_mismatch', 500],
      ['target_unavailable', 409],
    ] as const;
    for (const [code, status] of cases) {
      expect(dashboardAutostartErrorStatus(new DashboardAutostartError(code, code))).toBe(status);
    }
  });
});
