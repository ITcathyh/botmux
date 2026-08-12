import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type AutostartOpts,
  type AutostartState,
} from '../autostart.js';
import { stripAnsiForLog, tailChars } from '../utils/crash-log.js';

const execFileAsync = promisify(execFile);
const AUTOSTART_ACTION_TIMEOUT_MS = 15_000;
const AUTOSTART_ACTION_OUTPUT_MAX = 64 * 1024;
const AUTOSTART_ERROR_DETAIL_MAX = 2_000;

export type DashboardAutostartErrorCode =
  | 'command_failed'
  | 'command_timeout'
  | 'manager_unavailable'
  | 'operation_in_progress'
  | 'state_mismatch'
  | 'target_unavailable'
  | 'unsupported_platform';

export class DashboardAutostartError extends Error {
  constructor(
    public readonly code: DashboardAutostartErrorCode,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'DashboardAutostartError';
  }
}

export interface DashboardAutostartMutationResult {
  changed: boolean;
  state: AutostartState;
}

export interface DashboardAutostartController {
  getState(): Promise<AutostartState>;
  setEnabled(enabled: boolean): Promise<DashboardAutostartMutationResult>;
}

export type DashboardAutostartTransactionRunner = (
  enabled: boolean,
) => Promise<DashboardAutostartMutationResult>;

export type DashboardAutostartInspector = () => AutostartState | Promise<AutostartState>;

function errorText(error: unknown): string {
  const record = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : {};
  const candidates = [record.stderr, record.stdout, error instanceof Error ? error.message : String(error)];
  const raw = candidates.find(value => typeof value === 'string' && value.trim()) as string | undefined;
  return tailChars(stripAnsiForLog(raw ?? ''), AUTOSTART_ERROR_DETAIL_MAX);
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  return record.code === 'ETIMEDOUT'
    || record.killed === true
    || (typeof record.signal === 'string' && record.signal.length > 0 && record.code === null);
}

function classifyCommandFailure(detail: string): DashboardAutostartErrorCode {
  if (detail.includes('另一个开机自启操作仍在进行')) return 'operation_in_progress';
  if (detail.includes('连不上 user systemd')) return 'manager_unavailable';
  if (detail.includes('暂不支持 botmux autostart')) return 'unsupported_platform';
  return 'command_failed';
}

async function runAutostartCli(opts: AutostartOpts, args: string[]): Promise<string> {
  const cliEntry = join(opts.pkgRoot, 'dist', 'cli.js');
  const result = await execFileAsync(process.execPath, [cliEntry, 'autostart', ...args], {
    cwd: homedir(),
    encoding: 'utf8',
    timeout: AUTOSTART_ACTION_TIMEOUT_MS,
    maxBuffer: AUTOSTART_ACTION_OUTPUT_MAX,
    windowsHide: true,
  });
  return String(result.stdout ?? '');
}

function commandError(error: unknown): DashboardAutostartError {
  if (error instanceof DashboardAutostartError) return error;
  const detail = errorText(error);
  if (isTimeoutError(error)) {
    return new DashboardAutostartError(
      'command_timeout',
      '开机自启操作超时',
      detail || undefined,
    );
  }
  const code = classifyCommandFailure(detail);
  return new DashboardAutostartError(code, '开机自启操作失败', detail || undefined);
}

function parsedMutationFailure(value: unknown): DashboardAutostartError | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  const code = envelope.error;
  if (envelope.ok !== false || typeof code !== 'string' || ![
    'command_failed',
    'manager_unavailable',
    'operation_in_progress',
    'state_mismatch',
    'target_unavailable',
    'unsupported_platform',
  ].includes(code)) return null;
  const detail = typeof envelope.detail === 'string'
    ? tailChars(stripAnsiForLog(envelope.detail), AUTOSTART_ERROR_DETAIL_MAX)
    : undefined;
  return new DashboardAutostartError(
    code as DashboardAutostartErrorCode,
    '开机自启操作失败',
    detail || undefined,
  );
}

function mutationFailureFromCommand(error: unknown): DashboardAutostartError | null {
  if (!error || typeof error !== 'object') return null;
  const stdout = (error as Record<string, unknown>).stdout;
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  try {
    return parsedMutationFailure(JSON.parse(stdout));
  } catch {
    return null;
  }
}

function parsedMutationSuccess(value: unknown): DashboardAutostartMutationResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  const state = parsedAutostartState(envelope.state);
  return envelope.ok === true && typeof envelope.changed === 'boolean' && state
    ? { changed: envelope.changed, state }
    : null;
}

function defaultTransactionRunner(opts: AutostartOpts): DashboardAutostartTransactionRunner {
  return async enabled => {
    let stdout: string;
    try {
      // A single child owns the service lock for inspect -> no-op/mutation ->
      // readback. The boolean only selects one of two fixed argv literals.
      stdout = await runAutostartCli(opts, [enabled ? 'enable' : 'disable', '--json']);
    } catch (error) {
      const structured = mutationFailureFromCommand(error);
      if (structured) throw structured;
      throw commandError(error);
    }
    try {
      const result = parsedMutationSuccess(JSON.parse(stdout));
      if (result) return result;
    } catch {
      // Fall through to the stable invalid-response error below.
    }
    throw new DashboardAutostartError(
      'command_failed',
      '无法解析开机自启操作结果',
      'invalid_mutation_response',
    );
  };
}

function parsedAutostartState(value: unknown): AutostartState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  const nullableBoolean = (candidate: unknown): boolean => (
    candidate === null || typeof candidate === 'boolean'
  );
  const warnings = new Set([
    'manager_unavailable',
    'registration_partial',
    'pending_login',
    'linger_disabled',
    'target_missing',
    'target_mismatch',
    'local_dev_target',
  ]);
  return typeof state.supported === 'boolean'
    && ['macos', 'linux', 'windows', 'unsupported'].includes(String(state.platform))
    && ['launchd', 'systemd-user', 'task-scheduler', 'startup-folder', 'unsupported'].includes(String(state.manager))
    && state.scope === 'user-login'
    && ['enabled', 'disabled', 'partial', 'unknown'].includes(String(state.registration))
    && nullableBoolean(state.enabled)
    && typeof state.installed === 'boolean'
    && nullableBoolean(state.loaded)
    && nullableBoolean(state.active)
    && typeof state.managerReachable === 'boolean'
    && typeof state.manageable === 'boolean'
    && nullableBoolean(state.lingerEnabled)
    && typeof state.targetExists === 'boolean'
    && nullableBoolean(state.targetMatchesCurrentRuntime)
    && typeof state.localDevTarget === 'boolean'
    && Array.isArray(state.warnings)
    && state.warnings.every(warning => typeof warning === 'string' && warnings.has(warning))
    ? value as AutostartState
    : null;
}

function defaultInspector(opts: AutostartOpts): DashboardAutostartInspector {
  return async () => {
    try {
      const stdout = await runAutostartCli(opts, ['status', '--json']);
      const state = parsedAutostartState(JSON.parse(stdout));
      if (!state) {
        throw new DashboardAutostartError(
          'command_failed',
          '无法解析开机自启状态',
          'invalid_status_response',
        );
      }
      return state;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new DashboardAutostartError(
          'command_failed',
          '无法解析开机自启状态',
          'invalid_status_response',
        );
      }
      throw commandError(error);
    }
  };
}

/**
 * Host-level controller used by the private Dashboard endpoint. The existing
 * CLI remains the sole mutation path, but it runs in a bounded child process:
 * its synchronous platform calls and failure exits can never block or kill the
 * long-lived Dashboard HTTP process.
 */
export function createDashboardAutostartController(input: {
  opts: AutostartOpts;
  inspect?: DashboardAutostartInspector;
  runTransaction?: DashboardAutostartTransactionRunner;
}): DashboardAutostartController {
  const inspect = input.inspect ?? defaultInspector(input.opts);
  const runTransaction = input.runTransaction ?? defaultTransactionRunner(input.opts);
  let mutationInFlight = false;

  return {
    async getState() {
      return inspect();
    },

    async setEnabled(enabled) {
      if (mutationInFlight) {
        throw new DashboardAutostartError(
          'operation_in_progress',
          '另一个开机自启操作仍在进行',
        );
      }

      mutationInFlight = true;
      try {
        return await runTransaction(enabled);
      } finally {
        mutationInFlight = false;
      }
    },
  };
}

export type ParseAutostartWriteResult =
  | { ok: true; enabled: boolean }
  | { ok: false; error: 'invalid_body' };

/** Strict body: callers cannot supply executable, path, service name, or any
 * other host-derived input. */
export function parseAutostartWrite(value: unknown): ParseAutostartWriteResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'invalid_body' };
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') {
    return { ok: false, error: 'invalid_body' };
  }
  return { ok: true, enabled: body.enabled };
}

export function dashboardAutostartErrorStatus(error: DashboardAutostartError): number {
  if (error.code === 'operation_in_progress') return 409;
  if (error.code === 'unsupported_platform') return 501;
  if (error.code === 'manager_unavailable') return 503;
  if (error.code === 'target_unavailable') return 409;
  if (error.code === 'command_timeout') return 504;
  return 500;
}
