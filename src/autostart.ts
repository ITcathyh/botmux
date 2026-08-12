/**
 * Boot-time autostart integration for the botmux daemon.
 *
 * macOS  — installs a LaunchAgent at ~/Library/LaunchAgents/com.botmux.daemon.plist
 *          for launchd to load at the next login (no sudo).
 * Linux  — installs a user systemd unit at ~/.config/systemd/user/botmux.service
 *          and enables it (no sudo). Reminds the user to run
 *          `loginctl enable-linger` if the unit needs to survive logout.
 * Windows — installs a per-user Task Scheduler task, or falls back to the
 *            current user's Startup folder if task registration is denied.
 *
 * The unit invokes `node <PKG_ROOT>/dist/cli.js start`, which goes through
 * the same pm2 path as `botmux start`. PATH from the install-time shell is
 * captured into the unit so node-pty / claude / codex resolve correctly when
 * launchd or systemd starts us with a minimal environment.
 */
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { atomicWriteFileSync } from './utils/atomic-write.js';
import { withFileLockSync } from './utils/file-lock.js';

export interface AutostartOpts {
  /** Absolute path to the botmux package root (one level up from dist/). */
  pkgRoot: string;
  /** Absolute path to ~/.botmux. */
  configDir: string;
  /** Absolute path to the daemon log dir (used for launchd stdout/err). */
  logDir: string;
}

export type AutostartPlatform = 'macos' | 'linux' | 'windows' | 'unsupported';
export type AutostartManager = 'launchd' | 'systemd-user' | 'task-scheduler' | 'startup-folder' | 'unsupported';
export type AutostartRegistration = 'enabled' | 'disabled' | 'partial' | 'unknown';
export type AutostartWarning =
  | 'manager_unavailable'
  | 'registration_partial'
  | 'pending_login'
  | 'linger_disabled'
  | 'target_missing'
  | 'target_mismatch'
  | 'local_dev_target';

/**
 * Structured, side-effect-free view consumed by the Dashboard. `enabled` is
 * deliberately nullable: an unreachable service manager or a partial
 * registration must never be flattened into a misleading `false` toggle.
 */
export interface AutostartState {
  supported: boolean;
  platform: AutostartPlatform;
  manager: AutostartManager;
  scope: 'user-login';
  registration: AutostartRegistration;
  enabled: boolean | null;
  installed: boolean;
  loaded: boolean | null;
  active: boolean | null;
  managerReachable: boolean;
  manageable: boolean;
  lingerEnabled: boolean | null;
  targetExists: boolean;
  targetMatchesCurrentRuntime: boolean | null;
  localDevTarget: boolean;
  warnings: AutostartWarning[];
}

/** Result of one lock-scoped Dashboard/CLI reconciliation transaction. */
export interface AutostartMutationResult {
  changed: boolean;
  state: AutostartState;
}

export interface AutostartProbeResult {
  status: number | null;
  stdout?: string | Uint8Array;
  stderr?: string | Uint8Array;
}

/** Injectable inspection seam: unit tests cover every OS without touching the
 * caller's real login items or service manager. Runtime callers omit it. */
export interface AutostartInspectionDeps {
  platform?: NodeJS.Platform;
  homeDir?: string;
  appData?: string;
  nodePath?: string;
  pathValue?: string;
  uid?: number;
  username?: string;
  /** Current interactive Windows user's SID. Explicit null means the identity
   * could not be established; omission lets the runtime probe `whoami`. */
  windowsUserSid?: string | null;
  exists?: (path: string) => boolean;
  targetUsable?: (path: string, requirements: AutostartTargetRequirements) => boolean;
  readText?: (path: string) => string | null;
  run?: (command: string, args: string[]) => AutostartProbeResult;
}

export interface AutostartTargetRequirements {
  regularFile: true;
  readable: true;
  executable: boolean;
}

export type AutostartOperationErrorCode =
  | 'manager_unavailable'
  | 'mutation_failed'
  | 'operation_in_progress'
  | 'state_mismatch'
  | 'target_unavailable'
  | 'unsupported_platform';

/** Expected operational failure. CLI callers print a concise message; web
 * callers observe it only through the isolated child-process exit status. */
export class AutostartOperationError extends Error {
  constructor(
    public readonly code: AutostartOperationErrorCode,
    message: string,
    public readonly reported = false,
  ) {
    super(message);
    this.name = 'AutostartOperationError';
  }
}

const LABEL = 'com.botmux.daemon';
const SERVICE_NAME = 'botmux.service';
const WINDOWS_LEGACY_TASK_NAME = 'botmux-daemon';
const WINDOWS_TASK_NAME_PREFIX = 'botmux-daemon-';
const WINDOWS_TASK_XML_NAME = '.autostart-task.xml';

function normalizePlatform(value: NodeJS.Platform): AutostartPlatform {
  if (value === 'darwin') return 'macos';
  if (value === 'linux') return 'linux';
  if (value === 'win32') return 'windows';
  return 'unsupported';
}

function platform(): AutostartPlatform {
  return normalizePlatform(process.platform);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plistPath(homeDir = homedir()): string {
  return join(homeDir, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function unitPath(homeDir = homedir()): string {
  return join(homeDir, '.config', 'systemd', 'user', SERVICE_NAME);
}

function nodeBin(): string {
  // process.execPath is the Node binary that's currently running cli.js.
  // Using its absolute path means launchd/systemd doesn't have to resolve
  // `node` from a stripped PATH (and we keep the same Node version the
  // user installed botmux under, which matters for native modules like
  // node-pty).
  return process.execPath;
}

function cliJs(opts: AutostartOpts): string {
  return join(opts.pkgRoot, 'dist', 'cli.js');
}

function currentPath(): string {
  // Capture PATH from the install-time shell so the unit can find any
  // binaries the user expects (node-pty's `node`, the AI CLI binaries,
  // tmux, etc.). Falls back to a sane default if PATH is empty.
  const p = process.env.PATH || '';
  if (p) return p;
  return process.platform === 'darwin'
    ? '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin'
    : '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
}

// ─── macOS (launchd) ─────────────────────────────────────────────────────────

function plistContent(opts: AutostartOpts): string {
  const node = escapeXml(nodeBin());
  const cli = escapeXml(cliJs(opts));
  const cwd = escapeXml(opts.configDir);
  const path = escapeXml(currentPath());
  const outLog = escapeXml(join(opts.logDir, 'autostart-out.log'));
  const errLog = escapeXml(join(opts.logDir, 'autostart-err.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${node}</string>
        <string>${cli}</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>WorkingDirectory</key>
    <string>${cwd}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${path}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${outLog}</string>
    <key>StandardErrorPath</key>
    <string>${errLog}</string>
</dict>
</plist>
`;
}

function launchctlBootout(): boolean {
  const uid = userInfo().uid;
  const r = spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'pipe' });
  if (r.status === 0) return true;
  // Do not pass legacy `-w`: it persists a disabled override that a later
  // file-only enable would have to clear before the next login.
  const r2 = spawnSync('launchctl', ['unload', plistPath()], { stdio: 'pipe' });
  return r2.status === 0;
}

function launchctlLoadedState(): boolean | null {
  const uid = userInfo().uid;
  const r = spawnSync('launchctl', ['print', `gui/${uid}/${LABEL}`], { stdio: 'pipe' });
  return r.status === 0 ? true : r.status === 113 ? false : null;
}

function launchctlIsLoaded(): boolean {
  return launchctlLoadedState() === true;
}

function enableMac(opts: AutostartOpts): void {
  const path = plistPath();
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(opts.logDir, { recursive: true });
  atomicWriteFileSync(path, plistContent(opts));
  console.log(`✅ 已写入 LaunchAgent: ${path}`);
  // Never reload an existing RunAtLoad=true job here: bootout + bootstrap
  // would immediately execute `botmux start`. The file is the future-login
  // registration; an already-loaded copy stays untouched until that login.
  console.log(`   下次登录时自动启动。立即启动: botmux start`);
}

function disableMac(): void {
  const path = plistPath();
  // bootout removes the agent from launchd's registry. Because the LaunchAgent's
  // ExecStart (`botmux start`) is fire-and-forget — pm2 forks away and the
  // launched process exits immediately — there is no live process for bootout
  // to kill. The pm2 daemon keeps running. To stop the daemon, the user runs
  // `botmux stop` explicitly.
  const loaded = launchctlLoadedState();
  if (loaded === null) {
    console.error(`❌ 无法确认 launchd 注册状态；保留 plist 以避免误报禁用成功`);
    throw new AutostartOperationError(
      'manager_unavailable',
      '无法确认 launchd 注册状态',
      true,
    );
  }
  if (loaded) {
    if (launchctlBootout()) {
      console.log(`✅ 已从 launchd 卸载 ${LABEL}`);
    } else if (launchctlLoadedState() !== false) {
      console.error(`❌ launchctl 卸载失败；保留 plist`);
      throw new AutostartOperationError('mutation_failed', 'launchctl 卸载失败', true);
    }
  }
  if (existsSync(path)) {
    unlinkSync(path);
    console.log(`✅ 已删除 ${path}`);
    console.log(`   pm2 daemon 仍在运行；要停止请跑 botmux stop`);
  } else {
    console.log(`ℹ️  ${path} 不存在，无需删除`);
  }
}

function statusMac(): void {
  const path = plistPath();
  const loaded = launchctlIsLoaded();
  console.log(`平台: macOS (launchd)`);
  console.log(`Plist 路径: ${path}`);
  console.log(`Plist 存在: ${existsSync(path) ? 'yes' : 'no'}`);
  console.log(`launchd 已加载: ${loaded ? 'yes' : 'no'}`);
  if (existsSync(path) && !loaded) {
    console.log(`提示: plist 已注册，将在下次登录时由 launchd 加载`);
  }
}

// ─── Linux (user systemd) ────────────────────────────────────────────────────

function quoteSystemdValue(value: string, expandDollar: boolean): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/%/g, '%%')
    .replace(/\$/g, () => expandDollar ? '$$' : '$');
  return `"${escaped}"`;
}

function systemdExecLine(args: string[]): string {
  return args.map(arg => quoteSystemdValue(arg, true)).join(' ');
}

function unitContent(opts: AutostartOpts): string {
  // Type=oneshot + RemainAfterExit=yes because `botmux start` calls pm2
  // start which forks and returns immediately; without RemainAfterExit
  // systemd would consider the unit "inactive (dead)" right after launch.
  return `[Unit]
Description=botmux daemon (IM <-> AI coding CLI bridge)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${quoteSystemdValue(opts.configDir, false)}
Environment=${quoteSystemdValue(`PATH=${currentPath()}`, false)}
ExecStart=${systemdExecLine([nodeBin(), cliJs(opts), 'start'])}
ExecStop=${systemdExecLine([nodeBin(), cliJs(opts), 'stop'])}

[Install]
WantedBy=default.target
`;
}

function userSystemdAvailable(): boolean {
  // Check the user manager is reachable. In containers / sshd-without-DBus
  // sessions `systemctl --user` will fail with "Failed to connect to bus".
  const r = spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'pipe' });
  return r.status === 0;
}

interface LinuxUnitSnapshot {
  content: Buffer;
  mode: number;
}

function linuxUnitSnapshot(path: string): LinuxUnitSnapshot | null {
  if (!existsSync(path)) return null;
  return {
    content: readFileSync(path),
    mode: statSync(path).mode & 0o7777,
  };
}

function systemdMutationDetail(result: ReturnType<typeof spawnSync>): string {
  return probeText(result.stderr ?? undefined)
    || probeText(result.stdout ?? undefined)
    || `exit=${result.status === null ? 'unknown' : result.status}`;
}

/** Reload after atomically replacing a unit, restoring both disk and manager
 * state if systemd rejects the new definition. This helper always throws on a
 * failed primary reload; rollback success only determines the error detail. */
function reloadSystemdUnitOrRollback(
  path: string,
  previous: LinuxUnitSnapshot | null,
): void {
  const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
  if (reload.status === 0) return;

  const primaryDetail = systemdMutationDetail(reload);
  const primaryMessage = `systemctl --user daemon-reload 失败: ${primaryDetail}`;
  console.error(`❌ ${primaryMessage}；正在回滚 unit`);
  const rollbackFailures: string[] = [];

  try {
    if (previous) {
      atomicWriteFileSync(path, previous.content, { mode: previous.mode });
    } else if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const rollbackDetail = `file restore: ${detail}`;
    console.error(`❌ unit rollback failure: ${rollbackDetail}`);
    // Reloading here would make the failed on-disk rollback authoritative in
    // the manager and can turn a recoverable write failure into active state.
    throw new AutostartOperationError(
      'mutation_failed',
      `${primaryMessage}; unit rollback failure: ${rollbackDetail}`,
      true,
    );
  }

  // Only a completed disk rollback may be published back to systemd. Even a
  // fresh install must reload after removing the rejected unit because the
  // manager may have partially consumed it before returning an error.
  const rollbackReload = spawnSync(
    'systemctl',
    ['--user', 'daemon-reload'],
    { stdio: 'pipe' },
  );
  if (rollbackReload.status !== 0) {
    rollbackFailures.push(`daemon-reload: ${systemdMutationDetail(rollbackReload)}`);
  }

  if (rollbackFailures.length > 0) {
    const rollbackDetail = rollbackFailures.join('; ');
    console.error(`❌ unit rollback failure: ${rollbackDetail}`);
    throw new AutostartOperationError(
      'mutation_failed',
      `${primaryMessage}; unit rollback failure: ${rollbackDetail}`,
      true,
    );
  }

  throw new AutostartOperationError(
    'mutation_failed',
    `${primaryMessage}；${previous ? '已原子恢复原 unit' : '已移除新 unit'}并重新加载旧状态`,
    true,
  );
}

function lingerEnabled(): boolean {
  const username = userInfo().username;
  const r = spawnSync('loginctl', ['show-user', username, '--property=Linger'], { stdio: 'pipe' });
  if (r.status !== 0) return false;
  return r.stdout.toString().trim().endsWith('=yes');
}

function enableLinux(opts: AutostartOpts): void {
  if (!userSystemdAvailable()) {
    console.error(`❌ 当前会话连不上 user systemd（缺少 DBus / 容器环境）。`);
    console.error(``);
    console.error(`   回退方案：把下面这条写入系统级 cron / rc.local / 你常用的 init：`);
    console.error(`     ${nodeBin()} ${cliJs(opts)} start`);
    console.error(``);
    console.error(`   或在有 systemd --user 的桌面环境里再次运行 botmux autostart enable。`);
    throw new AutostartOperationError(
      'manager_unavailable',
      '当前会话连不上 user systemd（缺少 DBus / 容器环境）',
      true,
    );
  }

  const path = unitPath();
  mkdirSync(dirname(path), { recursive: true });
  const previous = linuxUnitSnapshot(path);
  atomicWriteFileSync(path, unitContent(opts));
  console.log(`✅ 已写入 systemd unit: ${path}`);
  reloadSystemdUnitOrRollback(path, previous);

  // No `--now` here on purpose: enable should only register the autostart hook,
  // not interfere with whatever daemon state the user already has. Daemon
  // lifecycle stays under `botmux start`/`stop`. WantedBy=default.target takes
  // effect when the user's systemd manager next starts (normally next login;
  // at boot when linger is enabled).
  const en = spawnSync('systemctl', ['--user', 'enable', SERVICE_NAME], { stdio: 'pipe' });
  if (en.status !== 0) {
    // Unlike daemon-reload, a nonzero `enable` may have partially created the
    // Wants symlink. Blindly restoring/removing the unit could then leave an
    // enabled link targeting stale or missing content. Keep the definition the
    // manager already accepted and report the unknown registration outcome.
    console.error(`❌ systemctl --user enable 失败:`);
    console.error(en.stderr.toString());
    throw new AutostartOperationError('mutation_failed', 'systemctl --user enable 失败', true);
  }
  console.log(`✅ 已启用 ${SERVICE_NAME}`);
  console.log(`   下次用户登录时自动启动（启用 linger 时为开机后）。立即启动: botmux start`);

  if (!lingerEnabled()) {
    const username = userInfo().username;
    console.log(``);
    console.log(`⚠️  Linger 未启用：登出当前会话后服务会停止。`);
    console.log(`   要让服务跨登出/重启常驻，运行（需要 sudo）:`);
    console.log(`     sudo loginctl enable-linger ${username}`);
  }
}

function disableLinux(): void {
  if (!userSystemdAvailable()) {
    console.error(`❌ 当前会话连不上 user systemd。`);
    console.error(`   如曾手工创建过 unit，请手动 rm: ${unitPath()}`);
    throw new AutostartOperationError('manager_unavailable', '当前会话连不上 user systemd', true);
  }
  const path = unitPath();
  // No `--now`: only undo the boot hook. Without --now systemd skips ExecStop,
  // so the running pm2 daemon is left untouched. To stop it, the user runs
  // `botmux stop` (or `systemctl --user stop botmux.service` for a clean
  // ExecStop-mediated shutdown) explicitly.
  const dis = spawnSync('systemctl', ['--user', 'disable', SERVICE_NAME], { stdio: 'pipe' });
  if (dis.status === 0) {
    console.log(`✅ 已禁用 ${SERVICE_NAME}`);
  } else {
    // A failed mutation is idempotent only when a fresh, machine-readable
    // manager probe proves that the unit is already non-enabled. Error text is
    // localized and must never turn access/DBus failures into success.
    const verification = spawnSync(
      'systemctl',
      ['--user', 'is-enabled', SERVICE_NAME],
      { stdio: 'pipe' },
    );
    const registered = verification.status === null
      ? null
      : systemdRegistration(probeText(verification.stdout ?? undefined));
    if (registered !== false) {
      console.error(`❌ systemctl --user disable 失败；保留 unit`);
      const detail = probeText(dis.stderr ?? dis.stdout ?? undefined);
      if (detail) console.error(detail);
      throw new AutostartOperationError(
        'mutation_failed',
        'systemctl --user disable 失败，且无法确认 unit 已禁用',
        true,
      );
    }
    console.log(`ℹ️  ${SERVICE_NAME} 已处于禁用/未注册状态`);
  }

  if (existsSync(path)) {
    // Keep a byte-for-byte snapshot and the exact permission bits until the
    // manager has accepted the removal. If daemon-reload fails, deleting the
    // only unit file would turn an operational error into data loss.
    const originalContent = readFileSync(path);
    const originalMode = statSync(path).mode & 0o7777;
    unlinkSync(path);
    console.log(`✅ 已删除 ${path}`);
    const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
    if (reload.status !== 0) {
      const reloadDetail = probeText(reload.stderr ?? undefined)
        || probeText(reload.stdout ?? undefined);
      console.error(`❌ systemctl --user daemon-reload 失败；正在恢复原 unit`);
      if (reloadDetail) console.error(reloadDetail);
      try {
        atomicWriteFileSync(path, originalContent, { mode: originalMode });
      } catch (rollbackError) {
        const rollbackDetail = rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
        console.error(`❌ unit rollback failure: ${rollbackDetail}`);
        throw new AutostartOperationError(
          'mutation_failed',
          `systemctl --user daemon-reload 失败${reloadDetail ? `: ${reloadDetail}` : ''}; `
            + `unit rollback failure: ${rollbackDetail}`,
          true,
        );
      }
      throw new AutostartOperationError(
        'mutation_failed',
        `systemctl --user daemon-reload 失败${reloadDetail ? `: ${reloadDetail}` : ''}；已原子恢复原 unit`,
        true,
      );
    }
  } else {
    console.log(`ℹ️  ${path} 不存在`);
  }
  console.log(`   pm2 daemon 仍在运行；要停止请跑 botmux stop`);
}

function statusLinux(): void {
  const path = unitPath();
  console.log(`平台: Linux (user systemd)`);
  console.log(`Unit 路径: ${path}`);
  console.log(`Unit 存在: ${existsSync(path) ? 'yes' : 'no'}`);
  if (!userSystemdAvailable()) {
    console.log(`user systemd: 不可用（缺少 DBus / 容器环境）`);
    return;
  }
  const isEnabled = spawnSync('systemctl', ['--user', 'is-enabled', SERVICE_NAME], { stdio: 'pipe' });
  const isActive = spawnSync('systemctl', ['--user', 'is-active', SERVICE_NAME], { stdio: 'pipe' });
  console.log(`enabled: ${isEnabled.stdout.toString().trim() || isEnabled.stderr.toString().trim()}`);
  console.log(`active: ${isActive.stdout.toString().trim() || isActive.stderr.toString().trim()}`);
  console.log(`Linger: ${lingerEnabled() ? 'yes' : 'no（登出后服务会停）'}`);
}

// ─── Windows (Task Scheduler / Startup folder) ─────────────────────────────

function escapeCmdValue(s: string): string {
  // Batch files expand %VAR% while parsing. Keep the captured PATH literal.
  return s.replace(/\^/g, '^^').replace(/%/g, '%%');
}

function decodeEscapedCmdValue(s: string): string | null {
  let decoded = '';
  for (let index = 0; index < s.length; index += 1) {
    const char = s[index] ?? '';
    if (char === '^' || char === '%') {
      if (s[index + 1] !== char) return null;
      decoded += char;
      index += 1;
    } else {
      decoded += char;
    }
  }
  return decoded;
}

function escapeVbsString(s: string): string {
  return s.replace(/"/g, '""');
}

function windowsScriptPath(homeDir = homedir()): string {
  return join(homeDir, '.botmux', 'autostart.cmd');
}

function windowsStartupDir(homeDir = homedir(), appData = process.env.APPDATA): string {
  return join(
    appData || join(homeDir, 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );
}

function windowsStartupLauncherPath(homeDir = homedir(), appData = process.env.APPDATA): string {
  return join(windowsStartupDir(homeDir, appData), 'botmux-autostart.vbs');
}

function windowsLogPath(opts: AutostartOpts, name: string): string {
  return join(opts.logDir, name);
}

function windowsScriptContent(opts: AutostartOpts): string {
  const path = escapeCmdValue(currentPath());
  const cwd = escapeCmdValue(opts.configDir);
  const node = escapeCmdValue(nodeBin());
  const cli = escapeCmdValue(cliJs(opts));
  const outLog = escapeCmdValue(windowsLogPath(opts, 'autostart-out.log'));
  const errLog = escapeCmdValue(windowsLogPath(opts, 'autostart-err.log'));
  return `@echo off
setlocal DisableDelayedExpansion
set "PATH=${path}"
cd /d "${cwd}"
"${node}" "${cli}" start >> "${outLog}" 2>> "${errLog}"
`;
}

function windowsLauncherContent(scriptPath: string): string {
  const script = escapeVbsString(scriptPath);
  return `Set shell = CreateObject("WScript.Shell")
shell.Run Chr(34) & "${script}" & Chr(34), 0, False
`;
}

function windowsTaskPresenceFromProbe(probe: AutostartProbeResult): boolean | null {
  if (probe.status === 0) return true;
  // `/HRESULT` makes FILE_NOT_FOUND locale-independent. No other nonzero
  // status is safe to interpret as absence (notably ACCESS_DENIED and timeout).
  if (probe.status !== null && (probe.status >>> 0) === 0x80070002) return false;
  return null;
}

function windowsTaskNameForSid(userSid: string): string {
  // A normalized SID consists only of ASCII letters, digits and hyphens, all
  // valid in a root Task Scheduler name. Keeping the SID in the name makes the
  // machine-wide namespace collision-free between interactive users.
  return `${WINDOWS_TASK_NAME_PREFIX}${userSid}`;
}

function windowsTaskContent(scriptPath: string, userSid: string): string {
  const sid = escapeXml(userSid);
  const script = escapeXml(scriptPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${sid}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${sid}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>${script}</Command></Exec>
  </Actions>
</Task>
`;
}

function createWindowsTask(
  opts: AutostartOpts,
  scriptPath: string,
  userSid: string,
  taskName: string,
  replaceExisting: boolean,
): ReturnType<typeof spawnSync> {
  const taskXmlPath = join(opts.configDir, WINDOWS_TASK_XML_NAME);
  try {
    atomicWriteFileSync(taskXmlPath, windowsTaskContent(scriptPath, userSid), {
      mode: 0o600,
      followTargetSymlink: false,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AutostartOperationError(
      'mutation_failed',
      `无法写入 Windows 任务计划定义: ${detail}`,
    );
  }

  try {
    const args = ['/Create', '/TN', taskName, '/XML', taskXmlPath];
    // Never use /F after an absent preflight: another user/process winning the
    // race must make Create fail, not let us overwrite their task. Replacement
    // is allowed only after XML proved that the existing scoped task is ours.
    if (replaceExisting) args.push('/F');
    return spawnSync(
      'schtasks',
      args,
      { stdio: 'pipe' },
    );
  } finally {
    try {
      if (existsSync(taskXmlPath)) unlinkSync(taskXmlPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`⚠️  Windows 任务计划临时 XML 清理失败: ${detail}`);
    }
  }
}

function writeWindowsStartupLauncher(scriptPath: string, mode?: number): string {
  const launcher = windowsStartupLauncherPath();
  mkdirSync(dirname(launcher), { recursive: true });
  atomicWriteFileSync(
    launcher,
    windowsLauncherContent(scriptPath),
    mode === undefined ? {} : { mode },
  );
  return launcher;
}

function taskMutationMessage(result: ReturnType<typeof spawnSync>): string {
  return probeText(result.stderr ?? undefined) || probeText(result.stdout ?? undefined);
}

interface WindowsLauncherSnapshot {
  content: Buffer;
  mode: number;
}

interface WindowsRegistrationMutation {
  manager: 'task-scheduler' | 'startup-folder';
  changed: boolean;
  taskName?: string;
}

function windowsLauncherSnapshot(path: string): WindowsLauncherSnapshot | null {
  if (!existsSync(path)) return null;
  return {
    content: readFileSync(path),
    mode: statSync(path).mode & 0o7777,
  };
}

function throwWindowsCreateFailure(
  result: ReturnType<typeof spawnSync>,
  reason: string,
): never {
  const detail = taskMutationMessage(result);
  console.error(`❌ ${reason}`);
  if (detail) console.error(detail);
  throw new AutostartOperationError(
    'mutation_failed',
    `${reason}${detail ? `: ${detail}` : ''}`,
    true,
  );
}

type WindowsTaskOwnership = 'absent' | 'owned' | 'foreign' | 'unknown';

interface WindowsMutationTaskSet {
  userSid: string;
  scopedName: string;
  scoped: WindowsTaskInspection;
  legacy: WindowsTaskInspection;
}

class WindowsTaskDeleteError extends AutostartOperationError {
  constructor(
    message: string,
    public readonly readback: WindowsTaskInspection,
  ) {
    super('mutation_failed', message, true);
    this.name = 'WindowsTaskDeleteError';
  }
}

function windowsTaskOwnership(task: WindowsTaskInspection): WindowsTaskOwnership {
  if (task.exists === false) return 'absent';
  if (task.exists !== true) return 'unknown';
  if (task.principalMatchesCurrentUser === true && task.targetMatchesScript === true) {
    return 'owned';
  }
  if (task.principalMatchesCurrentUser === false || task.targetMatchesScript === false) {
    return 'foreign';
  }
  return 'unknown';
}

function windowsLegacyTaskOwnership(task: WindowsTaskInspection): WindowsTaskOwnership {
  const base = windowsTaskOwnership(task);
  if (base !== 'owned') return base;
  // A current-SID task targeting our canonical script can still have an
  // unrelated trigger. Only the exact historical ONLOGON shape is ours.
  return task.legacyTriggerCompatible === true ? 'owned' : 'unknown';
}

function healthyWindowsTask(task: WindowsTaskInspection): boolean {
  return task.exists === true
    && task.detailsReadable
    && task.enabled === true
    && task.principalMatchesCurrentUser === true
    && task.principalCanonical === true
    && task.triggerMatchesCurrentUser
    && task.targetMatchesScript === true;
}

function mutationWindowsTask(
  taskName: string,
  scriptPath: string,
  userSid: string,
): WindowsTaskInspection {
  return inspectWindowsTaskNamed(defaultInspectionRun, taskName, scriptPath, userSid);
}

function windowsMutationTaskSet(scriptPath: string): WindowsMutationTaskSet {
  const userSid = currentWindowsUserSid({}, defaultInspectionRun);
  if (userSid === null) {
    throw new AutostartOperationError(
      'mutation_failed',
      '无法确认当前 Windows 用户 SID；未修改任务计划或 Startup launcher',
    );
  }
  const scopedName = windowsTaskNameForSid(userSid);
  return {
    userSid,
    scopedName,
    scoped: mutationWindowsTask(scopedName, scriptPath, userSid),
    legacy: mutationWindowsTask(WINDOWS_LEGACY_TASK_NAME, scriptPath, userSid),
  };
}

function taskStateLabel(task: WindowsTaskInspection): string {
  if (task.exists === null) return 'unknown';
  if (!task.exists) return 'absent';
  return windowsTaskOwnership(task) === 'owned' ? 'present-owned' : 'present-unowned';
}

function windowsDeleteFailureReadback(
  error: unknown,
  ownershipOf: (task: WindowsTaskInspection) => WindowsTaskOwnership,
): { definitelyStillOwned: boolean; label: string } {
  if (!(error instanceof WindowsTaskDeleteError)) {
    return { definitelyStillOwned: false, label: 'unknown' };
  }
  const ownership = ownershipOf(error.readback);
  const presence = error.readback.exists === null
    ? 'unknown'
    : error.readback.exists ? 'present' : 'absent';
  return {
    definitelyStillOwned: error.readback.exists === true && ownership === 'owned',
    label: `${presence}/${ownership}`,
  };
}

function deleteOwnedWindowsTask(
  taskName: string,
  scriptPath: string,
  userSid: string,
): void {
  const result = spawnSync(
    'schtasks',
    ['/Delete', '/TN', taskName, '/F'],
    { stdio: 'pipe' },
  );
  // A zero exit is not enough: an authoritative XML readback is what lets us
  // remove another hook without risking a duplicate registration.
  const after = mutationWindowsTask(taskName, scriptPath, userSid);
  if (after.exists === false) return;
  const detail = taskMutationMessage(result);
  throw new WindowsTaskDeleteError(
    `Windows 任务 ${taskName} 删除后状态为 ${taskStateLabel(after)}`
      + `${detail ? `: ${detail}` : ''}`,
    after,
  );
}

function rollbackScopedTask(
  taskName: string,
  scriptPath: string,
  userSid: string,
  originalError: unknown,
): never {
  const originalMessage = originalError instanceof Error ? originalError.message : String(originalError);
  try {
    deleteOwnedWindowsTask(taskName, scriptPath, userSid);
  } catch (rollbackError) {
    const rollbackMessage = rollbackError instanceof Error
      ? rollbackError.message
      : String(rollbackError);
    throw new AutostartOperationError(
      'mutation_failed',
      `${originalMessage}; scoped task rollback failure: ${rollbackMessage}`,
      true,
    );
  }
  throw new AutostartOperationError(
    'mutation_failed',
    `${originalMessage}; 已回滚 scoped task 并保留 owned legacy task`,
    true,
  );
}

function ensureTaskCanBeIgnoredOrOwned(
  task: WindowsTaskInspection,
  taskName: string,
  allowForeign: boolean,
  ownershipOf: (value: WindowsTaskInspection) => WindowsTaskOwnership = windowsTaskOwnership,
): WindowsTaskOwnership {
  const ownership = ownershipOf(task);
  if (ownership === 'unknown') {
    throw new AutostartOperationError(
      'mutation_failed',
      `无法权威确认 Windows 任务 ${taskName} 的所有权；未修改现有注册`,
    );
  }
  if (ownership === 'foreign' && !allowForeign) {
    throw new AutostartOperationError(
      'mutation_failed',
      `Windows scoped 任务 ${taskName} 属于其他目标；拒绝覆盖或删除`,
    );
  }
  return ownership;
}

function refreshAuthoritativeWindowsFallback(
  scriptPath: string,
  snapshot: WindowsLauncherSnapshot,
  tasks: WindowsMutationTaskSet,
): WindowsRegistrationMutation {
  const launcher = windowsStartupLauncherPath();
  // Inspect both names before repairing the launcher or deleting a task. This
  // keeps ownership failures side-effect free; cleanup failures are handled
  // below according to their authoritative readback and committed progress.
  const scopedOwnership = ensureTaskCanBeIgnoredOrOwned(
    tasks.scoped,
    tasks.scopedName,
    false,
  );
  const legacyOwnership = ensureTaskCanBeIgnoredOrOwned(
    tasks.legacy,
    WINDOWS_LEGACY_TASK_NAME,
    true,
    windowsLegacyTaskOwnership,
  );

  const launcherHealthy = normalizedWindowsLauncherText(snapshot.content.toString('utf8'))
    === normalizedWindowsLauncherText(windowsLauncherContent(scriptPath));
  let changed = !launcherHealthy;
  // Repair a stale launcher before task cleanup so ambiguous/partial deletion
  // cannot leave the user without a canonical hook. If the very first delete
  // definitely leaves its owned task present, the snapshot can be restored;
  // after any committed/ambiguous deletion canonical fallback must remain.
  // An already healthy launcher stays byte-for-byte untouched.
  if (!launcherHealthy) writeWindowsStartupLauncher(scriptPath, snapshot.mode);
  const handleDeleteFailure = (
    error: unknown,
    deletedAny: boolean,
    ownershipOf: (task: WindowsTaskInspection) => WindowsTaskOwnership,
  ): never => {
    if (launcherHealthy) throw error;
    const originalMessage = error instanceof Error ? error.message : String(error);
    const failedOwnership = error instanceof WindowsTaskDeleteError
      ? ownershipOf(error.readback)
      : 'unknown';
    if (!deletedAny
      && error instanceof WindowsTaskDeleteError
      && error.readback.exists === true
      && failedOwnership === 'owned') {
      try {
        atomicWriteFileSync(launcher, snapshot.content, { mode: snapshot.mode });
      } catch (rollbackError) {
        const rollbackDetail = rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
        throw new AutostartOperationError(
          'mutation_failed',
          `${originalMessage}; Startup fallback rollback failure: ${rollbackDetail}`,
          true,
        );
      }
      throw new AutostartOperationError(
        'mutation_failed',
        `${originalMessage}; 已原子恢复原 Startup fallback`,
        true,
      );
    }
    const skippedReason = deletedAny
      ? 'another duplicate was already removed'
      : `failed task readback=${error instanceof WindowsTaskDeleteError
        ? `${error.readback.exists === null ? 'unknown' : error.readback.exists ? 'present' : 'absent'}/${failedOwnership}`
        : 'unknown'}`;
    throw new AutostartOperationError(
      'mutation_failed',
      `${originalMessage}; partial convergence; Startup fallback rollback skipped: ${skippedReason}`,
      true,
    );
  };

  let deletedAny = false;
  if (scopedOwnership === 'owned') {
    try {
      deleteOwnedWindowsTask(tasks.scopedName, scriptPath, tasks.userSid);
    } catch (error) {
      handleDeleteFailure(error, deletedAny, windowsTaskOwnership);
    }
    deletedAny = true;
    changed = true;
  }
  if (legacyOwnership === 'owned') {
    try {
      deleteOwnedWindowsTask(WINDOWS_LEGACY_TASK_NAME, scriptPath, tasks.userSid);
    } catch (error) {
      handleDeleteFailure(error, deletedAny, windowsLegacyTaskOwnership);
    }
    deletedAny = true;
    changed = true;
  }
  return { manager: 'startup-folder', changed };
}

function installWindowsFallbackAfterAbsentTask(
  scriptPath: string,
  tasks: WindowsMutationTaskSet,
  legacyOwnership: WindowsTaskOwnership,
): WindowsRegistrationMutation {
  const launcher = writeWindowsStartupLauncher(scriptPath);
  if (legacyOwnership === 'owned') {
    try {
      deleteOwnedWindowsTask(WINDOWS_LEGACY_TASK_NAME, scriptPath, tasks.userSid);
    } catch (error) {
      const original = error instanceof Error ? error.message : String(error);
      const readback = windowsDeleteFailureReadback(error, windowsLegacyTaskOwnership);
      // Only a fresh, authoritative owned/present readback proves that the
      // legacy hook survived and makes removing the new fallback safe. An
      // unknown/absent/foreign outcome may mean deletion already committed;
      // retain the canonical fallback so the transaction cannot end at zero.
      if (!readback.definitelyStillOwned) {
        throw new AutostartOperationError(
          'mutation_failed',
          `${original}; partial convergence; Startup fallback rollback skipped: `
            + `legacy task readback=${readback.label}`,
          true,
        );
      }
      try {
        if (existsSync(launcher)) unlinkSync(launcher);
      } catch (rollbackError) {
        const rollback = rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
        throw new AutostartOperationError(
          'mutation_failed',
          `${original}; Startup fallback rollback failure: ${rollback}`,
          true,
        );
      }
      throw new AutostartOperationError(
        'mutation_failed',
        `${original}; 已回滚 Startup fallback 并保留 owned legacy task`,
        true,
      );
    }
  }
  return { manager: 'startup-folder', changed: true };
}

/** Reconcile Task Scheduler and Startup as exactly one current-user hook.
 *
 * A pre-existing Startup launcher is authoritative and never detached. Owned
 * duplicate tasks are removed only after XML ownership proof and authoritative
 * absence readback. Without a launcher, scoped task creation is allowed only
 * after both scoped and legacy names have been inspected fail-closed. */
function reconcileWindowsRegistration(
  opts: AutostartOpts,
  scriptPath: string,
  inspectedTasks?: WindowsMutationTaskSet,
): WindowsRegistrationMutation {
  const launcher = windowsStartupLauncherPath();
  const snapshot = windowsLauncherSnapshot(launcher);
  const tasks = inspectedTasks ?? windowsMutationTaskSet(scriptPath);
  if (snapshot) {
    return refreshAuthoritativeWindowsFallback(scriptPath, snapshot, tasks);
  }

  const scopedOwnership = ensureTaskCanBeIgnoredOrOwned(
    tasks.scoped,
    tasks.scopedName,
    false,
  );
  const legacyOwnership = ensureTaskCanBeIgnoredOrOwned(
    tasks.legacy,
    WINDOWS_LEGACY_TASK_NAME,
    true,
    windowsLegacyTaskOwnership,
  );

  if (scopedOwnership === 'owned' && healthyWindowsTask(tasks.scoped)) {
    let changed = false;
    if (legacyOwnership === 'owned') {
      deleteOwnedWindowsTask(WINDOWS_LEGACY_TASK_NAME, scriptPath, tasks.userSid);
      changed = true;
    }
    return { manager: 'task-scheduler', changed, taskName: tasks.scopedName };
  }

  const replaceExisting = scopedOwnership === 'owned';
  const result = createWindowsTask(
    opts,
    scriptPath,
    tasks.userSid,
    tasks.scopedName,
    replaceExisting,
  );
  const after = mutationWindowsTask(tasks.scopedName, scriptPath, tasks.userSid);
  if (healthyWindowsTask(after)) {
    if (legacyOwnership === 'owned') {
      try {
        deleteOwnedWindowsTask(WINDOWS_LEGACY_TASK_NAME, scriptPath, tasks.userSid);
      } catch (error) {
        const original = error instanceof Error ? error.message : String(error);
        const readback = windowsDeleteFailureReadback(error, windowsLegacyTaskOwnership);
        if (readback.definitelyStillOwned) {
          rollbackScopedTask(tasks.scopedName, scriptPath, tasks.userSid, error);
        }
        // The legacy deletion may already have committed even when its XML
        // readback is unavailable or no longer proves ownership. Keep the
        // healthy scoped replacement rather than risk removing the last hook.
        throw new AutostartOperationError(
          'mutation_failed',
          `${original}; partial convergence; scoped task rollback skipped: `
            + `legacy task readback=${readback.label}`,
          true,
        );
      }
    }
    if (result.status !== 0) {
      const detail = taskMutationMessage(result);
      console.warn(`⚠️  schtasks /Create 返回非零，但 scoped task 已权威收敛${detail ? `: ${detail}` : ''}`);
    }
    return { manager: 'task-scheduler', changed: true, taskName: tasks.scopedName };
  }

  if (after.exists === false) {
    const createDetail = taskMutationMessage(result);
    console.warn(`⚠️  任务计划创建失败，已确认任务不存在，改用当前用户 Startup 文件夹自启。`);
    if (createDetail) console.warn(createDetail);
    try {
      return installWindowsFallbackAfterAbsentTask(scriptPath, tasks, legacyOwnership);
    } catch (fallbackError) {
      const fallbackDetail = fallbackError instanceof Error
        ? fallbackError.message
        : String(fallbackError);
      const fallbackFailure = fallbackError instanceof AutostartOperationError
        ? fallbackDetail
        : `Startup fallback write failure: ${fallbackDetail}`;
      throw new AutostartOperationError(
        'mutation_failed',
        `Windows 任务计划创建失败${createDetail ? `: ${createDetail}` : ''}; `
          + fallbackFailure,
        true,
      );
    }
  }

  // If a newly created scoped task is readable and owned but unhealthy, it is
  // safe to roll it back when an owned legacy task is the preserved hook.
  if (legacyOwnership === 'owned' && windowsTaskOwnership(after) === 'owned') {
    try {
      deleteOwnedWindowsTask(tasks.scopedName, scriptPath, tasks.userSid);
    } catch (rollbackError) {
      const rollbackDetail = rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError);
      throwWindowsCreateFailure(
        result,
        `Windows scoped task 未健康收敛；rollback failure: ${rollbackDetail}`,
      );
    }
    throwWindowsCreateFailure(
      result,
      'Windows scoped task 未健康收敛；已回滚并保留 owned legacy task',
    );
  }

  throwWindowsCreateFailure(
    result,
    `Windows scoped task 未健康收敛（${taskStateLabel(after)}）；未安装 Startup fallback`,
  );
}

function enableWindows(opts: AutostartOpts): void {
  const script = windowsScriptPath();
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(opts.logDir, { recursive: true });
  atomicWriteFileSync(script, windowsScriptContent(opts));
  console.log(`✅ 已写入 Windows 启动脚本: ${script}`);

  const registration = reconcileWindowsRegistration(opts, script);
  if (registration.manager === 'task-scheduler') {
    console.log(`✅ 已创建/更新 Windows 任务计划: ${registration.taskName}`);
  } else {
    console.log(`✅ 已写入/保留 Startup 启动器: ${windowsStartupLauncherPath()}`);
  }

  console.log(`   下次登录 Windows 时自动启动。立即启动: botmux start`);
}

function disableWindows(): void {
  const script = windowsScriptPath();
  const tasks = windowsMutationTaskSet(script);
  const scopedOwnership = ensureTaskCanBeIgnoredOrOwned(
    tasks.scoped,
    tasks.scopedName,
    true,
  );
  const legacyOwnership = ensureTaskCanBeIgnoredOrOwned(
    tasks.legacy,
    WINDOWS_LEGACY_TASK_NAME,
    true,
    windowsLegacyTaskOwnership,
  );

  if (scopedOwnership === 'owned') {
    deleteOwnedWindowsTask(tasks.scopedName, script, tasks.userSid);
    console.log(`✅ 已删除 Windows 任务计划: ${tasks.scopedName}`);
  }
  if (legacyOwnership === 'owned') {
    deleteOwnedWindowsTask(WINDOWS_LEGACY_TASK_NAME, script, tasks.userSid);
    console.log(`✅ 已删除旧版 Windows 任务计划: ${WINDOWS_LEGACY_TASK_NAME}`);
  }

  const launcher = windowsStartupLauncherPath();
  if (existsSync(launcher)) {
    unlinkSync(launcher);
    console.log(`✅ 已删除 ${launcher}`);
  } else {
    console.log(`ℹ️  ${launcher} 不存在`);
  }

  if (existsSync(script)) {
    unlinkSync(script);
    console.log(`✅ 已删除 ${script}`);
  } else {
    console.log(`ℹ️  ${script} 不存在`);
  }
  console.log(`   pm2 daemon 仍在运行；要停止请跑 botmux stop`);
}

function statusWindows(): void {
  const script = windowsScriptPath();
  const launcher = windowsStartupLauncherPath();
  const userSid = currentWindowsUserSid({}, defaultInspectionRun);
  const taskName = userSid === null ? null : windowsTaskNameForSid(userSid);
  console.log(`平台: Windows (Task Scheduler / Startup folder)`);
  console.log(`任务名称: ${taskName ?? '无法确认（当前用户 SID 不可用）'}`);
  console.log(`启动脚本: ${script}`);
  console.log(`启动脚本存在: ${existsSync(script) ? 'yes' : 'no'}`);
  console.log(`Startup 启动器: ${launcher}`);
  console.log(`Startup 启动器存在: ${existsSync(launcher) ? 'yes' : 'no'}`);

  if (taskName === null || userSid === null) return;
  const task = mutationWindowsTask(taskName, script, userSid);
  console.log(`任务计划状态: ${taskStateLabel(task)}`);
}

// ─── Structured inspection (Dashboard / tests) ──────────────────────────────

function probeText(value: string | Uint8Array | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value.replace(/^\uFEFF/, '').trim();

  const bytes = Buffer.from(value);
  // `schtasks /XML` may emit UTF-16LE even when stdout is redirected. Detect
  // the alternating NUL bytes before decoding so non-ASCII Windows paths are
  // not corrupted. Other platform probes remain ordinary UTF-8.
  let oddNuls = 0;
  const pairs = Math.min(Math.floor(bytes.length / 2), 256);
  for (let i = 0; i < pairs; i += 1) {
    if (bytes[(i * 2) + 1] === 0) oddNuls += 1;
  }
  const encoding = pairs > 0 && oddNuls / pairs > 0.6 ? 'utf16le' : 'utf8';
  return bytes.toString(encoding).replace(/^\uFEFF/, '').trim();
}

function defaultInspectionRun(command: string, args: string[]): AutostartProbeResult {
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    timeout: 2_000,
    maxBuffer: 64 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function inspectionReadText(path: string, deps: AutostartInspectionDeps): string | null {
  if (deps.readText) return deps.readText(path);
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function inspectionTargetUsable(
  path: string,
  deps: AutostartInspectionDeps,
  requirements: AutostartTargetRequirements,
): boolean {
  if (deps.targetUsable) return deps.targetUsable(path, requirements);
  // Real inspection requires an ordinary readable file; POSIX Node also needs
  // execute permission. Windows does not use POSIX X_OK semantics. Tests with
  // virtual filesystems use the explicit targetUsable seam above.
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(
      path,
      fsConstants.R_OK | (requirements.executable ? fsConstants.X_OK : 0),
    );
    return true;
  } catch {
    return false;
  }
}

interface RegistrationFileMetadata extends Pick<AutostartState,
  'targetExists' | 'targetMatchesCurrentRuntime' | 'localDevTarget'> {
  structureValid: boolean | null;
}

function runtimeTargetMetadata(
  opts: AutostartOpts,
  deps: AutostartInspectionDeps,
  installedPath: string,
  installed: boolean,
  kind: AutostartPlatform,
): RegistrationFileMetadata {
  const exists = deps.exists ?? existsSync;
  const nodeRequirements: AutostartTargetRequirements = {
    regularFile: true,
    readable: true,
    executable: kind !== 'windows',
  };
  const cliRequirements: AutostartTargetRequirements = {
    regularFile: true,
    readable: true,
    executable: false,
  };
  const targetExists = inspectionTargetUsable(cliJs(opts), deps, cliRequirements)
    && inspectionTargetUsable(deps.nodePath ?? nodeBin(), deps, nodeRequirements);
  const localDevTarget = exists(join(opts.pkgRoot, '.git')) || exists(join(opts.pkgRoot, 'src'));
  if (!installed) {
    return { targetExists, targetMatchesCurrentRuntime: null, localDevTarget, structureValid: null };
  }
  const content = inspectionReadText(installedPath, deps);
  if (content === null) {
    return { targetExists, targetMatchesCurrentRuntime: null, localDevTarget, structureValid: null };
  }
  const inspected = kind === 'macos'
    ? inspectMacPlist(content, opts, deps.nodePath ?? nodeBin())
    : kind === 'linux'
      ? inspectLinuxUnit(content, opts, deps.nodePath ?? nodeBin())
      : inspectWindowsScript(
        content,
        opts,
        deps.nodePath ?? nodeBin(),
        deps.pathValue ?? currentPath(),
      );
  return {
    targetExists,
    targetMatchesCurrentRuntime: inspected.targetMatchesCurrentRuntime,
    localDevTarget,
    structureValid: inspected.structureValid,
  };
}

function publicTargetMetadata(metadata: RegistrationFileMetadata): Pick<AutostartState,
  'targetExists' | 'targetMatchesCurrentRuntime' | 'localDevTarget'> {
  return {
    targetExists: metadata.targetExists,
    targetMatchesCurrentRuntime: metadata.targetMatchesCurrentRuntime,
    localDevTarget: metadata.localDevTarget,
  };
}

function stateWarnings(input: {
  registration: AutostartRegistration;
  enabled: boolean | null;
  managerReachable: boolean;
  loaded: boolean | null;
  lingerEnabled: boolean | null;
  targetExists: boolean;
  targetMatchesCurrentRuntime: boolean | null;
  localDevTarget: boolean;
  platform: AutostartPlatform;
}): AutostartWarning[] {
  const warnings = new Set<AutostartWarning>();
  if (!input.managerReachable && input.platform !== 'unsupported') warnings.add('manager_unavailable');
  if (input.registration === 'partial') warnings.add('registration_partial');
  if (input.platform === 'macos' && input.enabled === true && input.loaded === false) warnings.add('pending_login');
  if (input.platform === 'linux' && input.enabled === true && input.lingerEnabled === false) warnings.add('linger_disabled');
  if (input.enabled === true || input.registration === 'partial') {
    if (!input.targetExists) warnings.add('target_missing');
    if (input.targetMatchesCurrentRuntime === false) warnings.add('target_mismatch');
  }
  if (input.localDevTarget) warnings.add('local_dev_target');
  return [...warnings];
}

function systemdRegistration(raw: string): boolean | null {
  const state = raw.toLowerCase().split(/\s+/u)[0] ?? '';
  if (state === 'enabled'
    || state === 'enabled-runtime'
    || state === 'linked'
    || state === 'linked-runtime'
    || state === 'alias') return true;
  if (state === 'disabled'
    || state === 'static'
    || state === 'indirect'
    || state === 'generated'
    || state === 'transient'
    || state === 'masked'
    || state === 'masked-runtime'
    || state === 'bad'
    || state === 'not-found') return false;
  return null;
}

function systemdActivity(probe: AutostartProbeResult): boolean | null {
  if (probe.status === null) return null;
  const state = probeText(probe.stdout).toLowerCase().split(/\s+/u)[0] ?? '';
  if (state === 'active') return true;
  if (state === 'inactive' || state === 'failed') return false;
  return null;
}

function systemdLinger(probe: AutostartProbeResult): boolean | null {
  if (probe.status !== 0) return null;
  const state = probeText(probe.stdout).toLowerCase();
  if (state === 'linger=yes') return true;
  if (state === 'linger=no') return false;
  return null;
}

function xmlDecode(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (raw, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : raw;
    })
    .replace(/&#([0-9]+);/g, (raw, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : raw;
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function combineTruth(left: boolean | null, right: boolean | null): boolean | null {
  if (left === false || right === false) return false;
  if (left === true && right === true) return true;
  return null;
}

type PlistValue = string | boolean | PlistValue[] | { [key: string]: PlistValue };

interface SimpleXmlToken {
  kind: 'open' | 'close' | 'empty' | 'text';
  name?: string;
  text?: string;
}

function plistTokens(xml: string): SimpleXmlToken[] | null {
  const chunks = xml.match(/<[^>]*>|[^<]+/g) ?? [];
  const tokens: SimpleXmlToken[] = [];
  for (const chunk of chunks) {
    if (!chunk.startsWith('<')) {
      tokens.push({ kind: 'text', text: chunk });
      continue;
    }
    if (chunk.startsWith('<?') || chunk.startsWith('<!')) continue;
    const close = chunk.match(/^<\/\s*([A-Za-z][\w:.-]*)\s*>$/u);
    if (close) {
      tokens.push({ kind: 'close', name: close[1] });
      continue;
    }
    const empty = chunk.match(/^<\s*([A-Za-z][\w:.-]*)(?:\s[^>]*)?\/\s*>$/u);
    if (empty) {
      tokens.push({ kind: 'empty', name: empty[1] });
      continue;
    }
    const open = chunk.match(/^<\s*([A-Za-z][\w:.-]*)(?:\s[^>]*)?>$/u);
    if (open) {
      tokens.push({ kind: 'open', name: open[1] });
      continue;
    }
    return null;
  }
  return tokens;
}

function skipXmlWhitespace(tokens: SimpleXmlToken[], start: number): number {
  let index = start;
  while (tokens[index]?.kind === 'text' && !(tokens[index]?.text ?? '').trim()) index += 1;
  return index;
}

function parsePlistTextElement(
  tokens: SimpleXmlToken[],
  start: number,
  tag: 'key' | 'string',
): { value: string; next: number } | null {
  if (tokens[start]?.kind !== 'open' || tokens[start]?.name !== tag) return null;
  let index = start + 1;
  let value = '';
  while (tokens[index]?.kind === 'text') {
    value += tokens[index]?.text ?? '';
    index += 1;
  }
  if (tokens[index]?.kind !== 'close' || tokens[index]?.name !== tag) return null;
  return { value: xmlDecode(value), next: index + 1 };
}

function parsePlistValue(
  tokens: SimpleXmlToken[],
  start: number,
): { value: PlistValue; next: number } | null {
  let index = skipXmlWhitespace(tokens, start);
  const token = tokens[index];
  if (!token) return null;
  if (token.kind === 'empty' && (token.name === 'true' || token.name === 'false')) {
    return { value: token.name === 'true', next: index + 1 };
  }
  if (token.kind === 'open' && token.name === 'string') {
    return parsePlistTextElement(tokens, index, 'string');
  }
  if (token.kind === 'open' && token.name === 'array') {
    const values: PlistValue[] = [];
    index += 1;
    for (;;) {
      index = skipXmlWhitespace(tokens, index);
      if (tokens[index]?.kind === 'close' && tokens[index]?.name === 'array') {
        return { value: values, next: index + 1 };
      }
      const parsed = parsePlistValue(tokens, index);
      if (!parsed) return null;
      values.push(parsed.value);
      index = parsed.next;
    }
  }
  if (token.kind === 'open' && token.name === 'dict') {
    // plist keys are local file input. A null-prototype dictionary prevents a
    // `__proto__` key from manufacturing inherited values that look like our
    // required launchd fields.
    const value: { [key: string]: PlistValue } = Object.create(null);
    index += 1;
    for (;;) {
      index = skipXmlWhitespace(tokens, index);
      if (tokens[index]?.kind === 'close' && tokens[index]?.name === 'dict') {
        return { value, next: index + 1 };
      }
      const key = parsePlistTextElement(tokens, index, 'key');
      if (!key || Object.hasOwn(value, key.value.trim())) return null;
      const parsed = parsePlistValue(tokens, key.next);
      if (!parsed) return null;
      value[key.value.trim()] = parsed.value;
      index = parsed.next;
    }
  }
  return null;
}

function parsePlistDictionary(xml: string): { [key: string]: PlistValue } | null {
  const tokens = plistTokens(xml);
  if (!tokens) return null;
  let index = skipXmlWhitespace(tokens, 0);
  if (tokens[index]?.kind !== 'open' || tokens[index]?.name !== 'plist') return null;
  const parsed = parsePlistValue(tokens, index + 1);
  if (!parsed || Array.isArray(parsed.value) || typeof parsed.value !== 'object') return null;
  index = skipXmlWhitespace(tokens, parsed.next);
  if (tokens[index]?.kind !== 'close' || tokens[index]?.name !== 'plist') return null;
  return skipXmlWhitespace(tokens, index + 1) === tokens.length ? parsed.value : null;
}

interface FileSemanticInspection {
  structureValid: boolean;
  targetMatchesCurrentRuntime: boolean | null;
}

function hasExactKeys(actual: Iterable<string>, expected: string[]): boolean {
  const actualKeys = [...actual].sort();
  const expectedKeys = [...expected].sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index]);
}

function plistRecord(value: PlistValue | undefined): { [key: string]: PlistValue } | null {
  return value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function inspectMacPlist(
  content: string,
  opts: AutostartOpts,
  expectedNode: string,
): FileSemanticInspection {
  const plist = parsePlistDictionary(content);
  if (!plist) return { structureValid: false, targetMatchesCurrentRuntime: null };
  const args = plist.ProgramArguments;
  const environment = plistRecord(plist.EnvironmentVariables);
  const argsValid = Array.isArray(args)
    && args.length === 3
    && args.every(value => typeof value === 'string')
    && args[2] === 'start';
  const structureValid = hasExactKeys(Object.keys(plist), [
    'Label',
    'ProgramArguments',
    'RunAtLoad',
    'KeepAlive',
    'WorkingDirectory',
    'EnvironmentVariables',
    'StandardOutPath',
    'StandardErrorPath',
  ])
    && plist.Label === LABEL
    && plist.RunAtLoad === true
    && plist.KeepAlive === false
    && argsValid
    && typeof plist.WorkingDirectory === 'string'
    && environment !== null
    && hasExactKeys(Object.keys(environment), ['PATH'])
    && typeof environment.PATH === 'string'
    && environment.PATH.length > 0
    && typeof plist.StandardOutPath === 'string'
    && typeof plist.StandardErrorPath === 'string';
  const targetMatchesCurrentRuntime = argsValid
    && args[0] === expectedNode
    && args[1] === cliJs(opts)
    && plist.WorkingDirectory === opts.configDir
    && plist.StandardOutPath === join(opts.logDir, 'autostart-out.log')
    && plist.StandardErrorPath === join(opts.logDir, 'autostart-err.log');
  return {
    structureValid,
    targetMatchesCurrentRuntime,
  };
}

type SystemdDirectives = Map<string, Map<string, string[]>>;

function parseSystemdUnit(content: string): SystemdDirectives | null {
  const sections: SystemdDirectives = new Map();
  let section: string | null = null;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = line.match(/^\[([^\]]+)\]$/u);
    if (header) {
      section = header[1] ?? null;
      if (!section || sections.has(section)) return null;
      sections.set(section, new Map());
      continue;
    }
    if (!section || /\\$/u.test(line)) return null;
    const equals = line.indexOf('=');
    if (equals <= 0) return null;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    const directives = sections.get(section);
    if (!directives || !key) return null;
    const values = directives.get(key) ?? [];
    values.push(value);
    directives.set(key, values);
  }
  return sections;
}

function onlySystemdDirective(
  unit: SystemdDirectives,
  section: string,
  key: string,
): string | null {
  const values = unit.get(section)?.get(key);
  return values?.length === 1 ? values[0] ?? null : null;
}

function decodeSystemdLiteral(value: string, expandDollar: boolean): string | null {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? '';
    if (char === '%') {
      if (value[index + 1] !== '%') return null;
      decoded += '%';
      index += 1;
    } else if (expandDollar && char === '$') {
      if (value[index + 1] !== '$') return null;
      decoded += '$';
      index += 1;
    } else {
      decoded += char;
    }
  }
  return decoded;
}

function parseSystemdWords(raw: string, expandDollar: boolean): string[] | null {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? '';
    if (!quote && /\s/u.test(char)) {
      if (started) {
        const decoded = decodeSystemdLiteral(word, expandDollar);
        if (decoded === null) return null;
        words.push(decoded);
        word = '';
        started = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      if (!quote) {
        quote = char;
        started = true;
        continue;
      }
      if (quote === char) {
        quote = null;
        continue;
      }
    }
    if (char === '\\') {
      const next = raw[index + 1];
      if (next === undefined) return null;
      const escapes: Record<string, string> = {
        '\\': '\\', '"': '"', "'": "'", n: '\n', r: '\r', t: '\t', s: ' ',
      };
      if (!Object.hasOwn(escapes, next)) return null;
      word += escapes[next];
      started = true;
      index += 1;
      continue;
    }
    word += char;
    started = true;
  }
  if (quote) return null;
  if (started) {
    const decoded = decodeSystemdLiteral(word, expandDollar);
    if (decoded === null) return null;
    words.push(decoded);
  }
  return words;
}

function inspectLinuxUnit(
  content: string,
  opts: AutostartOpts,
  expectedNode: string,
): FileSemanticInspection {
  const unit = parseSystemdUnit(content);
  if (!unit) return { structureValid: false, targetMatchesCurrentRuntime: null };
  const execStart = parseSystemdWords(onlySystemdDirective(unit, 'Service', 'ExecStart') ?? '', true);
  const execStop = parseSystemdWords(onlySystemdDirective(unit, 'Service', 'ExecStop') ?? '', true);
  const workingDir = parseSystemdWords(
    onlySystemdDirective(unit, 'Service', 'WorkingDirectory') ?? '',
    false,
  );
  const environment = parseSystemdWords(
    onlySystemdDirective(unit, 'Service', 'Environment') ?? '',
    false,
  );
  const wantedBy = parseSystemdWords(
    onlySystemdDirective(unit, 'Install', 'WantedBy') ?? '',
    false,
  );
  const structureValid = hasExactKeys(unit.keys(), ['Unit', 'Service', 'Install'])
    && hasExactKeys(unit.get('Unit')?.keys() ?? [], ['Description', 'After', 'Wants'])
    && hasExactKeys(unit.get('Service')?.keys() ?? [], [
      'Type',
      'RemainAfterExit',
      'WorkingDirectory',
      'Environment',
      'ExecStart',
      'ExecStop',
    ])
    && hasExactKeys(unit.get('Install')?.keys() ?? [], ['WantedBy'])
    && onlySystemdDirective(unit, 'Unit', 'Description') === 'botmux daemon (IM <-> AI coding CLI bridge)'
    && onlySystemdDirective(unit, 'Unit', 'After') === 'network-online.target'
    && onlySystemdDirective(unit, 'Unit', 'Wants') === 'network-online.target'
    && onlySystemdDirective(unit, 'Service', 'Type') === 'oneshot'
    && onlySystemdDirective(unit, 'Service', 'RemainAfterExit') === 'yes'
    && execStart?.length === 3
    && execStart[2] === 'start'
    && execStop?.length === 3
    && execStop[2] === 'stop'
    && workingDir?.length === 1
    && environment?.length === 1
    && environment[0]?.startsWith('PATH=') === true
    && wantedBy?.length === 1
    && wantedBy[0] === 'default.target';
  const targetMatchesCurrentRuntime = execStart?.length === 3
    && execStart[2] === 'start'
    && execStop?.length === 3
    && execStop[2] === 'stop'
    && workingDir?.length === 1
    && execStart[0] === expectedNode
    && execStart[1] === cliJs(opts)
    && execStop[0] === expectedNode
    && execStop[1] === cliJs(opts)
    && workingDir[0] === opts.configDir;
  return {
    structureValid,
    targetMatchesCurrentRuntime,
  };
}

function inspectWindowsScript(
  content: string,
  opts: AutostartOpts,
  expectedNode: string,
  expectedPath: string,
): FileSemanticInspection {
  const lines = content
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const pathLine = lines[2]?.match(/^set\s+"PATH=(.+)"$/iu);
  const workingDirectory = lines[3]?.match(/^cd\s+\/d\s+"([^"]+)"$/iu);
  const command = lines[4]?.match(
    /^"([^"]+)"\s+"([^"]+)"\s+start\s+>>\s+"([^"]+)"\s+2>>\s+"([^"]+)"$/iu,
  );
  const structureValid = lines.length === 5
    && lines[0]?.toLowerCase() === '@echo off'
    && lines[1]?.toLowerCase() === 'setlocal disabledelayedexpansion'
    && pathLine !== null
    && pathLine !== undefined
    && workingDirectory !== null
    && workingDirectory !== undefined
    && command !== null
    && command !== undefined;
  if (!workingDirectory || !command || !pathLine) {
    return { structureValid: false, targetMatchesCurrentRuntime: false };
  }
  const decodedWorkingDirectory = decodeEscapedCmdValue(workingDirectory[1] ?? '');
  const decodedNode = decodeEscapedCmdValue(command[1] ?? '');
  const decodedCli = decodeEscapedCmdValue(command[2] ?? '');
  const decodedOutLog = decodeEscapedCmdValue(command[3] ?? '');
  const decodedErrLog = decodeEscapedCmdValue(command[4] ?? '');
  if ([decodedWorkingDirectory, decodedNode, decodedCli, decodedOutLog, decodedErrLog]
    .some(value => value === null)) {
    return { structureValid: false, targetMatchesCurrentRuntime: false };
  }
  return {
    structureValid,
    targetMatchesCurrentRuntime: pathLine?.[1] === escapeCmdValue(expectedPath)
      && normalizedWindowsPath(decodedNode ?? '') === normalizedWindowsPath(expectedNode)
      && normalizedWindowsPath(decodedCli ?? '') === normalizedWindowsPath(cliJs(opts))
      && normalizedWindowsPath(decodedWorkingDirectory ?? '') === normalizedWindowsPath(opts.configDir)
      && normalizedWindowsPath(decodedOutLog ?? '') === normalizedWindowsPath(windowsLogPath(opts, 'autostart-out.log'))
      && normalizedWindowsPath(decodedErrLog ?? '') === normalizedWindowsPath(windowsLogPath(opts, 'autostart-err.log')),
  };
}

function normalizedWindowsPath(value: string): string {
  let normalized = xmlDecode(value).trim();
  while (normalized.length >= 2 && normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized.replace(/\//g, '\\').toLowerCase();
}

interface SimpleXmlElement {
  name: string;
  children: SimpleXmlElement[];
  text: string;
}

function localXmlName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}

/** Minimal, non-validating XML tree parser for Task Scheduler's own output.
 * It rejects malformed structure; schema deviations are handled separately as
 * known-broken registrations rather than being mistaken for healthy tasks. */
function parseSimpleXmlTree(xml: string): SimpleXmlElement | null {
  const roots: SimpleXmlElement[] = [];
  const stack: SimpleXmlElement[] = [];
  const tags = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/[A-Za-z_][\w:.-]*\s*>|<[A-Za-z_][^>]*>/gu;
  let cursor = 0;
  for (const match of xml.matchAll(tags)) {
    const raw = match[0] ?? '';
    const index = match.index ?? 0;
    const between = xml.slice(cursor, index);
    if (between.includes('<')) return null;
    if (stack.length === 0) {
      if (between.trim()) return null;
    } else {
      stack[stack.length - 1]!.text += between;
    }
    cursor = index + raw.length;

    if (raw.startsWith('<!--')) continue;
    if (raw.startsWith('<?')) {
      if (stack.length > 0) return null;
      continue;
    }
    if (raw.startsWith('<!')) return null;

    const closing = raw.match(/^<\/\s*([A-Za-z_][\w:.-]*)\s*>$/u);
    if (closing) {
      const current = stack.pop();
      if (!current || current.name !== closing[1]) return null;
      continue;
    }

    const opening = raw.match(/^<\s*([A-Za-z_][\w:.-]*)/u);
    if (!opening) return null;
    const element: SimpleXmlElement = { name: opening[1] ?? '', children: [], text: '' };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else roots.push(element);
    if (!/\/\s*>$/u.test(raw)) stack.push(element);
  }

  const tail = xml.slice(cursor);
  if (tail.includes('<') || tail.trim() || stack.length > 0 || roots.length !== 1) return null;
  return roots[0] ?? null;
}

function directXmlChildren(element: SimpleXmlElement, name: string): SimpleXmlElement[] {
  return element.children.filter(child => localXmlName(child.name) === name);
}

function simpleXmlText(element: SimpleXmlElement): string | null {
  if (element.children.length > 0) return null;
  return xmlDecode(element.text).trim();
}

function directXmlBoolean(
  element: SimpleXmlElement,
  name: string,
  defaultValue: boolean,
): boolean | null {
  const values = directXmlChildren(element, name);
  if (values.length === 0) return defaultValue;
  if (values.length !== 1) return null;
  const value = simpleXmlText(values[0]!)?.toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

interface WindowsTaskInspection {
  exists: boolean | null;
  enabled: boolean | null;
  targetMatchesScript: boolean | null;
  principalMatchesCurrentUser: boolean | null;
  principalCanonical: boolean | null;
  triggerMatchesCurrentUser: boolean;
  legacyTriggerCompatible: boolean | null;
  detailsReadable: boolean;
  managerReachable: boolean;
}

function parsedWindowsSid(value: string | null | undefined): string | null {
  const sid = value?.trim().toUpperCase() ?? '';
  if (!/^S-\d+(?:-\d+)+$/u.test(sid)) return null;
  return sid;
}

function normalizedWindowsSid(value: string | null | undefined): string | null {
  const sid = parsedWindowsSid(value);
  if (sid === null) return null;
  // Autostart is a per-user login facility, never a machine service account.
  if (sid === 'S-1-5-18' || sid === 'S-1-5-19' || sid === 'S-1-5-20') return null;
  return sid;
}

function currentWindowsUserSid(
  deps: AutostartInspectionDeps,
  run: (command: string, args: string[]) => AutostartProbeResult,
): string | null {
  if (Object.hasOwn(deps, 'windowsUserSid')) {
    return normalizedWindowsSid(deps.windowsUserSid);
  }
  // CSV output keeps the column boundary stable across localized Windows
  // installations; the SID token itself is locale-independent.
  const identity = run('whoami', ['/user', '/fo', 'csv', '/nh']);
  if (identity.status !== 0) return null;
  const matches = probeText(identity.stdout).match(/S-\d+(?:-\d+)+/giu) ?? [];
  const unique = [...new Set(matches.map(value => value.toUpperCase()))];
  return unique.length === 1 ? normalizedWindowsSid(unique[0]) : null;
}

interface WindowsPrincipalInspection {
  matchesCurrentUser: boolean | null;
  canonical: boolean | null;
}

function inspectWindowsPrincipal(
  task: SimpleXmlElement,
  expectedUserSid: string | null,
): WindowsPrincipalInspection {
  const unknown = { matchesCurrentUser: null, canonical: null };
  if (expectedUserSid === null) return unknown;
  const containers = directXmlChildren(task, 'Principals');
  if (containers.length !== 1 || containers[0]!.text.trim()) return unknown;
  const principals = directXmlChildren(containers[0]!, 'Principal');
  if (principals.length !== 1 || principals[0]!.text.trim()) return unknown;
  const principal = principals[0]!;
  const userIds = directXmlChildren(principal, 'UserId');
  if (userIds.length !== 1) return unknown;
  const taskSid = parsedWindowsSid(simpleXmlText(userIds[0]!));
  if (taskSid === null) return unknown;
  const matchesCurrentUser = taskSid === expectedUserSid;
  const logonTypes = directXmlChildren(principal, 'LogonType');
  const runLevels = directXmlChildren(principal, 'RunLevel');
  const logonType = logonTypes.length === 1 ? simpleXmlText(logonTypes[0]!) : null;
  const runLevel = runLevels.length === 1 ? simpleXmlText(runLevels[0]!) : null;
  if (logonType === null || runLevel === null) {
    return { matchesCurrentUser, canonical: null };
  }
  const canonicalChildren = principal.children.every(child => [
    'UserId', 'LogonType', 'RunLevel',
  ].includes(localXmlName(child.name)));
  return {
    matchesCurrentUser,
    canonical: matchesCurrentUser
      && logonType.toLowerCase() === 'interactivetoken'
      && runLevel.toLowerCase() === 'leastprivilege'
      && canonicalChildren,
  };
}

function windowsTaskFromXml(
  xml: string,
  scriptPath: string,
  expectedUserSid: string | null,
): Omit<WindowsTaskInspection, 'exists' | 'managerReachable'> {
  const task = parseSimpleXmlTree(xml);
  if (!task || localXmlName(task.name) !== 'Task') {
    return {
      enabled: null,
      targetMatchesScript: null,
      principalMatchesCurrentUser: null,
      principalCanonical: null,
      triggerMatchesCurrentUser: false,
      legacyTriggerCompatible: null,
      detailsReadable: false,
    };
  }

  const settings = directXmlChildren(task, 'Settings');
  // Both task and trigger Enabled elements are optional in the Task Scheduler
  // schema and default to true. Explicit 1/0 are also valid xs:boolean values.
  const taskEnabled = !task.text.trim() && settings.length === 1 && !settings[0]!.text.trim()
    ? directXmlBoolean(settings[0]!, 'Enabled', true)
    : false;

  const triggerContainers = directXmlChildren(task, 'Triggers');
  let loginEnabled: boolean | null = false;
  let triggerMatchesCurrentUser = false;
  let legacyTriggerCompatible: boolean | null = false;
  if (triggerContainers.length === 1 && !triggerContainers[0]!.text.trim()) {
    const triggerChildren = triggerContainers[0]!.children;
    if (triggerChildren.length === 1
      && localXmlName(triggerChildren[0]!.name) === 'LogonTrigger'
      && !triggerChildren[0]!.text.trim()) {
      const loginTrigger = triggerChildren[0]!;
      loginEnabled = directXmlBoolean(loginTrigger, 'Enabled', true);
      const triggerUserIds = directXmlChildren(loginTrigger, 'UserId');
      const triggerSid = triggerUserIds.length === 1
        ? parsedWindowsSid(simpleXmlText(triggerUserIds[0]!))
        : null;
      const canonicalChildren = loginTrigger.children.every(child => [
        'Enabled', 'UserId',
      ].includes(localXmlName(child.name)));
      // Omitted/empty UserId means "any user" in Task Scheduler, not the
      // current-user boundary promised by this registration.
      triggerMatchesCurrentUser = expectedUserSid !== null
        && triggerSid !== null
        && triggerSid === expectedUserSid
        && canonicalChildren;
      // The pre-scoped implementation used `schtasks /SC ONLOGON` without
      // `/RU`; Task Scheduler exports that legacy trigger without UserId. It
      // is migratable only when this is the sole LogonTrigger and its optional
      // identity is either omitted or the current SID.
      legacyTriggerCompatible = expectedUserSid === null
        ? null
        : triggerUserIds.length === 0
          || (triggerUserIds.length === 1 && triggerSid === expectedUserSid);
    }
  }

  const actionContainers = directXmlChildren(task, 'Actions');
  let targetMatchesScript: boolean | null = null;
  if (actionContainers.length === 1 && !actionContainers[0]!.text.trim()) {
    const actions = actionContainers[0]!.children;
    if (actions.length === 1
      && localXmlName(actions[0]!.name) === 'Exec'
      && !actions[0]!.text.trim()) {
      const exec = actions[0]!;
      const commands = directXmlChildren(exec, 'Command');
      const argumentsElements = directXmlChildren(exec, 'Arguments');
      const workingDirectories = directXmlChildren(exec, 'WorkingDirectory');
      const allowedChildren = exec.children.every(child => [
        'Command', 'Arguments', 'WorkingDirectory',
      ].includes(localXmlName(child.name)));
      const optionalFieldsEmpty = argumentsElements.length <= 1
        && workingDirectories.length <= 1
        && argumentsElements.every(value => simpleXmlText(value) === '')
        && workingDirectories.every(value => simpleXmlText(value) === '');
      const command = commands.length === 1 ? simpleXmlText(commands[0]!) : null;
      if (allowedChildren && optionalFieldsEmpty && command !== null) {
        targetMatchesScript = normalizedWindowsPath(command) === normalizedWindowsPath(scriptPath);
      }
    }
  }
  const enabled = combineTruth(taskEnabled, loginEnabled);
  const principal = inspectWindowsPrincipal(task, expectedUserSid);

  return {
    enabled,
    targetMatchesScript,
    principalMatchesCurrentUser: principal.matchesCurrentUser,
    principalCanonical: principal.canonical,
    triggerMatchesCurrentUser,
    legacyTriggerCompatible,
    detailsReadable: taskEnabled !== null
      && loginEnabled !== null
      && principal.matchesCurrentUser !== null
      && principal.canonical !== null,
  };
}

function unavailableWindowsTask(): WindowsTaskInspection {
  return {
    exists: null,
    enabled: null,
    targetMatchesScript: null,
    principalMatchesCurrentUser: null,
    principalCanonical: null,
    triggerMatchesCurrentUser: false,
    legacyTriggerCompatible: null,
    detailsReadable: false,
    managerReachable: false,
  };
}

function inspectWindowsTaskNamed(
  run: (command: string, args: string[]) => AutostartProbeResult,
  taskName: string,
  scriptPath: string,
  expectedUserSid: string,
): WindowsTaskInspection {
  const exact = run('schtasks', ['/Query', '/TN', taskName, '/XML', '/HRESULT']);
  const presence = windowsTaskPresenceFromProbe(exact);
  if (presence === true) {
    return {
      exists: true,
      managerReachable: true,
      ...windowsTaskFromXml(
        probeText(exact.stdout),
        scriptPath,
        expectedUserSid,
      ),
    };
  }

  // `/HRESULT` makes the process code locale-independent. Only the Windows
  // file-not-found HRESULT is authoritative absence; access errors, timeouts,
  // and every other failure remain unknown.
  if (presence === false) {
    return {
      exists: false,
      enabled: null,
      targetMatchesScript: null,
      principalMatchesCurrentUser: null,
      principalCanonical: null,
      triggerMatchesCurrentUser: false,
      legacyTriggerCompatible: null,
      detailsReadable: true,
      managerReachable: true,
    };
  }

  return unavailableWindowsTask();
}

function inspectWindowsTaskSet(
  run: (command: string, args: string[]) => AutostartProbeResult,
  scriptPath: string,
  deps: AutostartInspectionDeps,
): WindowsMutationTaskSet | null {
  const userSid = currentWindowsUserSid(deps, run);
  if (userSid === null) return null;
  const scopedName = windowsTaskNameForSid(userSid);
  return {
    userSid,
    scopedName,
    scoped: inspectWindowsTaskNamed(run, scopedName, scriptPath, userSid),
    legacy: inspectWindowsTaskNamed(run, WINDOWS_LEGACY_TASK_NAME, scriptPath, userSid),
  };
}

function normalizedWindowsLauncherText(value: string): string {
  return value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
}

function windowsLauncherTargetMatches(
  deps: AutostartInspectionDeps,
  path: string,
  scriptPath: string,
): boolean | null {
  const content = inspectionReadText(path, deps);
  if (content === null) return null;
  return normalizedWindowsLauncherText(content)
    === normalizedWindowsLauncherText(windowsLauncherContent(scriptPath));
}

/** Inspect the host registration without mutating it or printing to stdout. */
export function inspectAutostart(
  opts: AutostartOpts,
  deps: AutostartInspectionDeps = {},
): AutostartState {
  const kind = normalizePlatform(deps.platform ?? process.platform);
  const homeDir = deps.homeDir ?? homedir();
  const exists = deps.exists ?? existsSync;
  const run = deps.run ?? defaultInspectionRun;
  const scope = 'user-login' as const;

  if (kind === 'unsupported') {
    const metadata = publicTargetMetadata(runtimeTargetMetadata(opts, deps, '', false, kind));
    return {
      supported: false,
      platform: kind,
      manager: 'unsupported',
      scope,
      registration: 'unknown',
      enabled: null,
      installed: false,
      loaded: null,
      active: null,
      managerReachable: false,
      manageable: false,
      lingerEnabled: null,
      ...metadata,
      warnings: [],
    };
  }

  if (kind === 'macos') {
    const path = plistPath(homeDir);
    const installed = exists(path);
    const loadedProbe = run('launchctl', ['print', `gui/${deps.uid ?? userInfo().uid}/${LABEL}`]);
    // launchctl exits 113 when the label is authoritatively absent. Permission,
    // domain and I/O failures use other nonzero statuses and stay unknown.
    const loaded = loadedProbe.status === 0 ? true : loadedProbe.status === 113 ? false : null;
    const managerReachable = loaded !== null;
    const fileMetadata = runtimeTargetMetadata(opts, deps, path, installed, kind);
    const metadata = publicTargetMetadata(fileMetadata);
    const registration: AutostartRegistration = installed
      ? fileMetadata.structureValid === true
        ? 'enabled'
        : fileMetadata.structureValid === false ? 'partial' : 'unknown'
      : loaded === true
        ? 'partial'
        : loaded === false ? 'disabled' : 'unknown';
    const enabled = registration === 'enabled' ? true : registration === 'disabled' ? false : null;
    const warningInput = {
      registration, enabled, managerReachable, loaded, lingerEnabled: null,
      ...metadata, platform: kind,
    };
    return {
      supported: true,
      platform: kind,
      manager: 'launchd',
      scope,
      registration,
      enabled,
      installed,
      loaded,
      // A launchd label can remain loaded after its one-shot `botmux start`
      // process exits; without parsing a PID/state from print output, activity
      // is not knowable from the command status alone.
      active: null,
      managerReachable,
      // Registration is file-backed, so repair remains available. Disable still
      // fails closed when launchd cannot prove whether a loaded job remains.
      manageable: true,
      lingerEnabled: null,
      ...metadata,
      warnings: stateWarnings(warningInput),
    };
  }

  if (kind === 'linux') {
    const path = unitPath(homeDir);
    const installed = exists(path);
    const fileMetadata = runtimeTargetMetadata(opts, deps, path, installed, kind);
    const metadata = publicTargetMetadata(fileMetadata);
    const managerProbe = run('systemctl', ['--user', 'show-environment']);
    const managerReachable = managerProbe.status === 0;
    let registration: AutostartRegistration = 'unknown';
    let enabled: boolean | null = null;
    let active: boolean | null = null;
    let lingerEnabled: boolean | null = null;
    if (managerReachable) {
      const enabledProbe = run('systemctl', ['--user', 'is-enabled', SERVICE_NAME]);
      const registered = enabledProbe.status === null
        ? null
        : systemdRegistration(probeText(enabledProbe.stdout));
      if (registered !== null) {
        if (!registered) {
          registration = installed ? 'partial' : 'disabled';
        } else if (!installed) {
          registration = 'partial';
        } else {
          registration = fileMetadata.structureValid === true
            ? 'enabled'
            : fileMetadata.structureValid === false ? 'partial' : 'unknown';
        }
        enabled = registration === 'enabled' ? true : registration === 'disabled' ? false : null;
      }
      const activeProbe = run('systemctl', ['--user', 'is-active', SERVICE_NAME]);
      active = systemdActivity(activeProbe);
      const lingerProbe = run('loginctl', [
        'show-user', deps.username ?? userInfo().username, '--property=Linger',
      ]);
      lingerEnabled = systemdLinger(lingerProbe);
    }
    const warningInput = {
      registration, enabled, managerReachable, loaded: active, lingerEnabled,
      ...metadata, platform: kind,
    };
    return {
      supported: true,
      platform: kind,
      manager: 'systemd-user',
      scope,
      registration,
      enabled,
      installed,
      loaded: active,
      active,
      managerReachable,
      manageable: managerReachable,
      lingerEnabled,
      ...metadata,
      warnings: stateWarnings(warningInput),
    };
  }

  const script = windowsScriptPath(homeDir);
  const launcher = windowsStartupLauncherPath(homeDir, deps.appData);
  const installed = exists(script);
  const launcherInstalled = exists(launcher);
  const tasks = inspectWindowsTaskSet(run, script, deps);
  const launcherTargetMatches = launcherInstalled
    ? windowsLauncherTargetMatches(deps, launcher, script)
    : null;

  const fileMetadata = runtimeTargetMetadata(opts, deps, script, installed, kind);
  const baseMetadata = publicTargetMetadata(fileMetadata);

  let registration: AutostartRegistration;
  const scopedOwnership = tasks === null ? 'unknown' : windowsTaskOwnership(tasks.scoped);
  const legacyOwnership = tasks === null ? 'unknown' : windowsLegacyTaskOwnership(tasks.legacy);
  if (scopedOwnership === 'unknown' || legacyOwnership === 'unknown') {
    registration = 'unknown';
  } else if (scopedOwnership === 'owned' && tasks !== null) {
    if (!tasks.scoped.detailsReadable) {
      registration = 'unknown';
    } else {
      // The scoped task is healthy only with the full current-user boundary;
      // an owned legacy task or Startup launcher is a duplicate to reconcile.
      const taskHealthy = combineTruth(
        installed ? fileMetadata.structureValid : false,
        combineTruth(
          !launcherInstalled && legacyOwnership !== 'owned',
          combineTruth(
            tasks.scoped.principalCanonical,
            combineTruth(
              tasks.scoped.triggerMatchesCurrentUser,
              combineTruth(tasks.scoped.enabled, tasks.scoped.targetMatchesScript),
            ),
          ),
        ),
      );
      registration = taskHealthy === true
        ? 'enabled'
        : taskHealthy === false ? 'partial' : 'unknown';
    }
  } else if (legacyOwnership === 'owned') {
    // The fixed legacy name is recognized only to migrate/delete it. It never
    // counts as the healthy current registration, including old any-user tasks.
    registration = 'partial';
  } else if (launcherInstalled) {
    const launcherHealthy = combineTruth(
      installed ? fileMetadata.structureValid : false,
      launcherTargetMatches,
    );
    registration = launcherHealthy === true
      ? 'enabled'
      : launcherHealthy === false ? 'partial' : 'unknown';
  } else {
    registration = installed ? 'partial' : 'disabled';
  }
  const enabled = registration === 'enabled' ? true : registration === 'disabled' ? false : null;
  const managerReachable = tasks !== null
    && tasks.scoped.managerReachable
    && tasks.legacy.managerReachable;
  const hookTargetMatches = tasks !== null && tasks.scoped.exists === true
    ? tasks.scoped.targetMatchesScript
    : tasks !== null && legacyOwnership === 'owned'
      ? tasks.legacy.targetMatchesScript
      : launcherInstalled ? launcherTargetMatches : null;
  const hasCurrentHook = (tasks?.scoped.exists === true)
    || legacyOwnership === 'owned'
    || launcherInstalled;
  const metadata = {
    ...baseMetadata,
    targetMatchesCurrentRuntime: hasCurrentHook
      ? combineTruth(baseMetadata.targetMatchesCurrentRuntime, hookTargetMatches)
      : baseMetadata.targetMatchesCurrentRuntime,
  };
  const warningInput = {
    registration, enabled, managerReachable, loaded: null, lingerEnabled: null,
    ...metadata, platform: kind,
  };
  return {
    supported: true,
    platform: kind,
    manager: launcherInstalled && scopedOwnership !== 'owned' && legacyOwnership !== 'owned'
      ? 'startup-folder'
      : 'task-scheduler',
    scope,
    registration,
    enabled,
    installed,
    loaded: null,
    active: null,
    managerReachable,
    // A failed/missing Task Scheduler still has the current-user Startup
    // folder fallback used by enableWindows(); status remains unknown until a
    // mutation can produce an authoritatively inspectable registration.
    manageable: true,
    lingerEnabled: null,
    ...metadata,
    warnings: stateWarnings(warningInput),
  };
}

// ─── Public dispatch ─────────────────────────────────────────────────────────

const AUTOSTART_LOCK_TARGET = '.autostart-state';

function withAutostartMutationLock<T>(opts: AutostartOpts, fn: () => T): T {
  mkdirSync(opts.configDir, { recursive: true });
  try {
    return withFileLockSync(join(opts.configDir, AUTOSTART_LOCK_TARGET), fn, { maxWaitMs: 5_000 });
  } catch (error) {
    if (error instanceof AutostartOperationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('file-lock timeout waiting for ')) {
      throw new AutostartOperationError(
        'operation_in_progress',
        '另一个开机自启操作仍在进行，请稍后重试',
      );
    }
    throw error;
  }
}

export function enableAutostart(opts: AutostartOpts): void {
  return withAutostartMutationLock(opts, () => enableAutostartUnlocked(opts));
}

function enableAutostartUnlocked(opts: AutostartOpts): void {
  switch (platform()) {
    case 'macos': return enableMac(opts);
    case 'linux': return enableLinux(opts);
    case 'windows': return enableWindows(opts);
    default:
      console.error(`❌ 当前平台 ${process.platform} 暂不支持 botmux autostart。`);
      throw new AutostartOperationError(
        'unsupported_platform',
        `当前平台 ${process.platform} 暂不支持 botmux autostart`,
        true,
      );
  }
}

export function disableAutostart(opts: AutostartOpts): void {
  return withAutostartMutationLock(opts, () => disableAutostartUnlocked(opts));
}

function disableAutostartUnlocked(opts: AutostartOpts): void {
  switch (platform()) {
    case 'macos': return disableMac();
    case 'linux': return disableLinux();
    case 'windows': return disableWindows();
    default:
      console.error(`❌ 当前平台 ${process.platform} 暂不支持 botmux autostart。`);
      throw new AutostartOperationError(
        'unsupported_platform',
        `当前平台 ${process.platform} 暂不支持 botmux autostart`,
        true,
      );
  }
}

function autostartStateConverged(state: AutostartState, enabled: boolean): boolean {
  const desiredRegistration: AutostartRegistration = enabled ? 'enabled' : 'disabled';
  return state.enabled === enabled
    && state.registration === desiredRegistration
    && (!enabled || (state.targetExists && state.targetMatchesCurrentRuntime === true));
}

/**
 * Reconcile the requested state as one cross-process transaction. The initial
 * inspection, healthy no-op decision, optional platform mutation, and final
 * authoritative readback all happen while `.autostart-state` is held. This is
 * the machine-facing mutation primitive used by Dashboard: another CLI cannot
 * slip a mutation between those phases and make a stale no-op look successful.
 */
export function setAutostartEnabled(
  opts: AutostartOpts,
  enabled: boolean,
): AutostartMutationResult {
  return withAutostartMutationLock(opts, () => {
    const before = inspectAutostart(opts);
    if (!before.supported) {
      throw new AutostartOperationError(
        'unsupported_platform',
        `当前平台 ${process.platform} 暂不支持 botmux autostart`,
      );
    }
    if (!before.manageable) {
      throw new AutostartOperationError(
        'manager_unavailable',
        '当前用户的系统服务管理器不可用',
      );
    }
    if (enabled && !before.targetExists) {
      throw new AutostartOperationError(
        'target_unavailable',
        '当前 Node 或 botmux CLI 目标文件不可用，请先重新构建或安装',
      );
    }

    const alreadyDesired = autostartStateConverged(before, enabled);
    if (!alreadyDesired) {
      if (enabled) enableAutostartUnlocked(opts);
      else disableAutostartUnlocked(opts);
    }

    // Read back even for a healthy no-op. Besides returning a fresh snapshot,
    // this fails closed if a non-cooperating writer changed the registration
    // while the lock was held.
    const after = inspectAutostart(opts);
    if (!autostartStateConverged(after, enabled)) {
      throw new AutostartOperationError(
        'state_mismatch',
        '系统命令已返回，但开机自启状态未收敛',
      );
    }
    return { changed: !alreadyDesired, state: after };
  });
}

export function autostartStatus(_opts: AutostartOpts): void {
  switch (platform()) {
    case 'macos': return statusMac();
    case 'linux': return statusLinux();
    case 'windows': return statusWindows();
    default:
      console.log(`平台: ${process.platform} (不支持)`);
  }
}

/** Re-render the unit/plist file from the current paths without touching enable/disable state. */
export function refreshAutostart(opts: AutostartOpts): boolean {
  try {
    return withAutostartMutationLock(opts, () => refreshAutostartUnlocked(opts));
  } catch (error) {
    if (error instanceof AutostartOperationError && error.code === 'operation_in_progress') {
      console.warn(`⚠️  ${error.message}；本次跳过 autostart 路径同步`);
      return false;
    }
    throw error;
  }
}

function refreshAutostartUnlocked(opts: AutostartOpts): boolean {
  switch (platform()) {
    case 'macos': {
      const path = plistPath();
      if (!existsSync(path)) return false;
      // Only rewrite if content changed, to avoid unnecessary launchctl reload.
      const next = plistContent(opts);
      const prev = readFileSync(path, 'utf-8');
      if (prev === next) return false;
      atomicWriteFileSync(path, next);
      // Refresh is called from `botmux start`/`restart`. Reloading a
      // RunAtLoad job here would invoke a second `botmux start`; the rewritten
      // file is sufficient for the next login and leaves the loaded job alone.
      return true;
    }
    case 'linux': {
      const path = unitPath();
      if (!existsSync(path)) return false;
      const next = unitContent(opts);
      const previous = linuxUnitSnapshot(path)!;
      if (previous.content.toString('utf8') === next) return false;
      atomicWriteFileSync(path, next);
      if (userSystemdAvailable()) {
        reloadSystemdUnitOrRollback(path, previous);
      }
      // When the current user manager is unavailable, retain the historical
      // next-login repair behavior: `true` means the unit file changed on disk,
      // not that the current manager observed or converged to that definition.
      return true;
    }
    case 'windows': {
      const script = windowsScriptPath();
      const launcher = windowsStartupLauncherPath();
      let inspectedTasks: WindowsMutationTaskSet | undefined;
      if (!existsSync(script) && !existsSync(launcher)) {
        inspectedTasks = windowsMutationTaskSet(script);
        const scopedOwnership = ensureTaskCanBeIgnoredOrOwned(
          inspectedTasks.scoped,
          inspectedTasks.scopedName,
          true,
        );
        const legacyOwnership = ensureTaskCanBeIgnoredOrOwned(
          inspectedTasks.legacy,
          WINDOWS_LEGACY_TASK_NAME,
          true,
          windowsLegacyTaskOwnership,
        );
        if (scopedOwnership !== 'owned' && legacyOwnership !== 'owned') return false;
      }

      mkdirSync(dirname(script), { recursive: true });
      mkdirSync(opts.logDir, { recursive: true });
      const next = windowsScriptContent(opts);
      const prev = existsSync(script) ? readFileSync(script, 'utf-8') : '';
      let changed = prev !== next;
      if (changed) atomicWriteFileSync(script, next);

      const registration = reconcileWindowsRegistration(opts, script, inspectedTasks);
      return changed || registration.changed;
    }
    default: return false;
  }
}
