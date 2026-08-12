import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));
const osMocks = vi.hoisted(() => ({ homeDir: '' }));

vi.mock('node:child_process', () => childProcessMocks);
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => osMocks.homeDir || actual.homedir() };
});
import {
  AutostartOperationError,
  disableAutostart,
  enableAutostart,
  inspectAutostart,
  refreshAutostart,
  setAutostartEnabled,
  type AutostartInspectionDeps,
  type AutostartOpts,
  type AutostartProbeResult,
} from '../src/autostart.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  childProcessMocks.spawnSync.mockReset();
  osMocks.homeDir = '';
});

const opts: AutostartOpts = {
  pkgRoot: '/opt/botmux',
  configDir: '/home/test/.botmux',
  logDir: '/home/test/.botmux/logs',
};
const cli = '/opt/botmux/dist/cli.js';
const node = '/opt/node/bin/node';
const windowsUserSid = 'S-1-5-21-1000';
const windowsScopedTaskName = `botmux-daemon-${windowsUserSid}`;

function windowsTaskQueryKey(taskName = windowsScopedTaskName): string {
  return `schtasks\0/Query\0/TN\0${taskName}\0/XML\0/HRESULT`;
}

function windowsTaskXml(input: {
  script: string;
  taskEnabled?: boolean | 'omit';
  triggerEnabled?: boolean | 'omit';
  triggerUserId?: string | 'omit';
  additionalTrigger?: string;
  principalUserId?: string | 'omit';
}): string {
  const taskEnabled = input.taskEnabled === 'omit'
    ? ''
    : `<Enabled>${input.taskEnabled ?? true}</Enabled>`;
  const triggerEnabled = input.triggerEnabled === 'omit'
    ? ''
    : `<Enabled>${input.triggerEnabled ?? true}</Enabled>`;
  const triggerUserId = input.triggerUserId === 'omit'
    ? ''
    : `<UserId>${input.triggerUserId ?? windowsUserSid}</UserId>`;
  const principals = input.principalUserId === 'omit'
    ? ''
    : `<Principals><Principal id="Author"><UserId>${input.principalUserId ?? windowsUserSid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task>
  <Triggers><LogonTrigger>${triggerEnabled}${triggerUserId}</LogonTrigger>${input.additionalTrigger ?? ''}</Triggers>
  ${principals}
  <Settings>${taskEnabled}</Settings>
  <Actions><Exec><Command>${input.script}</Command></Exec></Actions>
</Task>`;
}

function macPlist(input: {
  nodePath?: string;
  cliPath?: string;
  label?: string;
  runAtLoad?: boolean;
  keepAlive?: boolean;
  workingDirectory?: string;
  logDir?: string;
  command?: string;
  extra?: string;
} = {}): string {
  const booleanElement = (value: boolean): string => value ? '<true/>' : '<false/>';
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>${input.label ?? 'com.botmux.daemon'}</string>
  <key>ProgramArguments</key><array>
    <string>${input.nodePath ?? node}</string>
    <string>${input.cliPath ?? cli}</string>
    <string>${input.command ?? 'start'}</string>
  </array>
  <key>RunAtLoad</key>${booleanElement(input.runAtLoad ?? true)}
  <key>KeepAlive</key>${booleanElement(input.keepAlive ?? false)}
  <key>WorkingDirectory</key><string>${input.workingDirectory ?? opts.configDir}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin</string></dict>
  <key>StandardOutPath</key><string>${join(input.logDir ?? opts.logDir, 'autostart-out.log')}</string>
  <key>StandardErrorPath</key><string>${join(input.logDir ?? opts.logDir, 'autostart-err.log')}</string>
  ${input.extra ?? ''}
</dict></plist>`;
}

function linuxUnit(input: {
  nodePath?: string;
  cliPath?: string;
  workingDirectory?: string;
  command?: string;
  extraService?: string;
} = {}): string {
  return `[Unit]
Description=botmux daemon (IM <-> AI coding CLI bridge)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory="${input.workingDirectory ?? opts.configDir}"
Environment="PATH=/usr/bin"
ExecStart="${input.nodePath ?? node}" "${input.cliPath ?? cli}" "${input.command ?? 'start'}"
ExecStop="${input.nodePath ?? node}" "${input.cliPath ?? cli}" "stop"
${input.extraService ?? ''}

[Install]
WantedBy=default.target
`;
}

function windowsScript(input: {
  nodePath?: string;
  cliPath?: string;
  workingDirectory?: string;
  logDir?: string;
} = {}): string {
  const escapeCmd = (value: string): string => value.replace(/\^/g, '^^').replace(/%/g, '%%');
  const logDir = input.logDir ?? opts.logDir;
  return `@echo off
setlocal DisableDelayedExpansion
set "PATH=C:\\Windows\\System32"
cd /d "${escapeCmd(input.workingDirectory ?? opts.configDir)}"
"${escapeCmd(input.nodePath ?? node)}" "${escapeCmd(input.cliPath ?? cli)}" start >> "${escapeCmd(join(logDir, 'autostart-out.log'))}" 2>> "${escapeCmd(join(logDir, 'autostart-err.log'))}"
`;
}

function windowsLauncher(script: string): string {
  return `Set shell = CreateObject("WScript.Shell")
shell.Run Chr(34) & "${script}" & Chr(34), 0, False
`;
}

function deps(input: {
  platform: NodeJS.Platform;
  homeDir?: string;
  nodePath?: string;
  pathValue?: string;
  existing?: string[];
  files?: Record<string, string>;
  responses?: Record<string, AutostartProbeResult>;
  windowsUserSid?: string | null;
}): AutostartInspectionDeps {
  const existing = new Set([cli, node, ...(input.existing ?? [])]);
  const responses = input.responses ?? {};
  return {
    platform: input.platform,
    homeDir: input.homeDir ?? '/home/test',
    appData: join(input.homeDir ?? '/home/test', 'AppData', 'Roaming'),
    nodePath: input.nodePath ?? node,
    pathValue: input.pathValue ?? 'C:\\Windows\\System32',
    uid: 501,
    username: 'tester',
    windowsUserSid: Object.hasOwn(input, 'windowsUserSid')
      ? input.windowsUserSid
      : windowsUserSid,
    exists: path => existing.has(path),
    targetUsable: path => existing.has(path),
    readText: path => input.files?.[path] ?? null,
    run: vi.fn((command: string, args: string[]) => {
      const key = `${command}\0${args.join('\0')}`;
      if (Object.hasOwn(responses, key)) return responses[key]!;
      // Tests declare only the task relevant to the scenario. Every omitted
      // Task Scheduler name is authoritatively absent, including legacy.
      if (command === 'schtasks' && args[0] === '/Query') {
        return { status: 0x80070002, stdout: '', stderr: 'not found' };
      }
      return { status: 1, stdout: '', stderr: '' };
    }),
  };
}

function commandResult(
  status: number | null,
  stdout = '',
  stderr = '',
): { status: number | null; stdout: Buffer; stderr: Buffer } {
  return { status, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

function taskNameFromArgs(args: string[]): string | undefined {
  const index = args.indexOf('/TN');
  return index < 0 ? undefined : args[index + 1];
}

function whoamiResult(sid = windowsUserSid): ReturnType<typeof commandResult> {
  return commandResult(0, `"TEST\\tester","${sid}"\r\n`);
}

function absentTaskResult(): ReturnType<typeof commandResult> {
  return commandResult(0x80070002, '', 'not found');
}

function windowsRuntimeFixture(prefix: string): {
  dir: string;
  home: string;
  appData: string;
  runtimeOpts: AutostartOpts;
  runtimeCli: string;
  script: string;
  launcher: string;
  taskXmlPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const home = join(dir, 'home');
  const appData = join(home, 'AppData', 'Roaming');
  const runtimeOpts: AutostartOpts = {
    pkgRoot: join(dir, 'checkout'),
    configDir: join(home, '.botmux'),
    logDir: join(home, '.botmux', 'logs'),
  };
  const runtimeCli = join(runtimeOpts.pkgRoot, 'dist', 'cli.js');
  const script = join(home, '.botmux', 'autostart.cmd');
  const launcher = join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'botmux-autostart.vbs',
  );
  const taskXmlPath = join(runtimeOpts.configDir, '.autostart-task.xml');
  osMocks.homeDir = home;
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.stubEnv('APPDATA', appData);
  vi.stubEnv('PATH', 'C:\\Windows\\System32');
  silenceAutostartOutput();
  mkdirSync(dirname(runtimeCli), { recursive: true });
  writeFileSync(runtimeCli, 'console.log("botmux");\n');
  return { dir, home, appData, runtimeOpts, runtimeCli, script, launcher, taskXmlPath };
}

function silenceAutostartOutput(): void {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

function expectNoDaemonLifecycleCalls(): void {
  const args = childProcessMocks.spawnSync.mock.calls
    .flatMap(([, commandArgs]) => commandArgs as string[]);
  expect(args).not.toContain('--now');
  expect(args).not.toContain('/Run');
  expect(args).not.toContain('start');
  expect(args).not.toContain('stop');
  expect(args).not.toContain('restart');
}

describe('structured autostart inspection', () => {
  it('treats an installed macOS LaunchAgent as enabled even before launchd loads it', () => {
    const plist = '/home/test/Library/LaunchAgents/com.botmux.daemon.plist';
    const state = inspectAutostart(opts, deps({
      platform: 'darwin',
      existing: [plist],
      files: { [plist]: macPlist() },
      responses: {
        [`launchctl\0print\0gui/501/com.botmux.daemon`]: { status: 113, stdout: '', stderr: 'not found' },
      },
    }));

    expect(state).toMatchObject({
      platform: 'macos',
      manager: 'launchd',
      registration: 'enabled',
      enabled: true,
      installed: true,
      loaded: false,
      active: null,
      manageable: true,
      targetMatchesCurrentRuntime: true,
    });
    expect(state.warnings).toContain('pending_login');
  });

  it('keeps an absent macOS registration unknown when launchctl times out', () => {
    const state = inspectAutostart(opts, deps({
      platform: 'darwin',
      responses: {
        [`launchctl\0print\0gui/501/com.botmux.daemon`]: { status: null, stderr: 'timed out' },
      },
    }));

    expect(state).toMatchObject({
      registration: 'unknown',
      enabled: null,
      installed: false,
      loaded: null,
      active: null,
      managerReachable: false,
    });
    expect(state.warnings).toContain('manager_unavailable');
  });

  it('keeps an absent macOS registration unknown on non-absence launchctl errors', () => {
    const state = inspectAutostart(opts, deps({
      platform: 'darwin',
      responses: {
        [`launchctl\0print\0gui/501/com.botmux.daemon`]: {
          status: 1,
          stderr: 'Could not access domain',
        },
      },
    }));

    expect(state).toMatchObject({
      registration: 'unknown',
      enabled: null,
      loaded: null,
      active: null,
      managerReachable: false,
    });
  });

  it('marks a parseable but non-starting macOS plist as partial', () => {
    const plist = '/home/test/Library/LaunchAgents/com.botmux.daemon.plist';
    const state = inspectAutostart(opts, deps({
      platform: 'darwin',
      existing: [plist],
      files: { [plist]: macPlist({ runAtLoad: false }) },
      responses: {
        [`launchctl\0print\0gui/501/com.botmux.daemon`]: { status: 113 },
      },
    }));

    expect(state).toMatchObject({
      registration: 'partial',
      enabled: null,
      targetMatchesCurrentRuntime: true,
    });
    expect(state.warnings).toContain('registration_partial');
    expect(state.warnings).not.toContain('target_mismatch');
  });

  it('does not infer a healthy macOS target from strings in malformed plist content', () => {
    const plist = '/home/test/Library/LaunchAgents/com.botmux.daemon.plist';
    const state = inspectAutostart(opts, deps({
      platform: 'darwin',
      existing: [plist],
      files: { [plist]: `<plist>${node} ${cli}` },
      responses: {
        [`launchctl\0print\0gui/501/com.botmux.daemon`]: { status: 113 },
      },
    }));

    expect(state).toMatchObject({
      registration: 'partial',
      enabled: null,
      targetMatchesCurrentRuntime: null,
    });
  });

  it('keeps a valid but stale macOS target enabled and offers repair metadata', () => {
    const plist = '/home/test/Library/LaunchAgents/com.botmux.daemon.plist';
    const state = inspectAutostart(opts, deps({
      platform: 'darwin',
      existing: [plist],
      files: { [plist]: macPlist({ nodePath: '/old/node' }) },
      responses: {
        [`launchctl\0print\0gui/501/com.botmux.daemon`]: { status: 0 },
      },
    }));

    expect(state).toMatchObject({
      registration: 'enabled',
      enabled: true,
      targetMatchesCurrentRuntime: false,
    });
    expect(state.warnings).toContain('target_mismatch');
  });

  it('reports Linux registration, runtime activity, and linger independently', () => {
    const unit = '/home/test/.config/systemd/user/botmux.service';
    const state = inspectAutostart(opts, deps({
      platform: 'linux',
      existing: [unit],
      files: { [unit]: linuxUnit() },
      responses: {
        [`systemctl\0--user\0show-environment`]: { status: 0, stdout: 'PATH=/usr/bin' },
        [`systemctl\0--user\0is-enabled\0botmux.service`]: { status: 0, stdout: 'enabled\n' },
        [`systemctl\0--user\0is-active\0botmux.service`]: { status: 3, stdout: 'inactive\n' },
        [`loginctl\0show-user\0tester\0--property=Linger`]: { status: 0, stdout: 'Linger=no\n' },
      },
    }));

    expect(state).toMatchObject({
      platform: 'linux',
      manager: 'systemd-user',
      registration: 'enabled',
      enabled: true,
      active: false,
      lingerEnabled: false,
      managerReachable: true,
      manageable: true,
    });
    expect(state.warnings).toContain('linger_disabled');
  });

  it('keeps Linux state unknown when the user systemd manager is unreachable', () => {
    const unit = '/home/test/.config/systemd/user/botmux.service';
    const state = inspectAutostart(opts, deps({
      platform: 'linux',
      existing: [unit],
      files: { [unit]: linuxUnit() },
      responses: {
        [`systemctl\0--user\0show-environment`]: { status: 1, stderr: 'Failed to connect to bus' },
      },
    }));

    expect(state).toMatchObject({
      registration: 'unknown',
      enabled: null,
      installed: true,
      managerReachable: false,
      manageable: false,
    });
    expect(state.warnings).toContain('manager_unavailable');
  });

  it('does not flatten a mismatched Linux file/enable registration into false', () => {
    const unit = '/home/test/.config/systemd/user/botmux.service';
    const state = inspectAutostart(opts, deps({
      platform: 'linux',
      existing: [unit],
      files: { [unit]: linuxUnit() },
      responses: {
        [`systemctl\0--user\0show-environment`]: { status: 0 },
        [`systemctl\0--user\0is-enabled\0botmux.service`]: { status: 1, stdout: 'disabled\n' },
        [`systemctl\0--user\0is-active\0botmux.service`]: { status: 3, stdout: 'inactive\n' },
        [`loginctl\0show-user\0tester\0--property=Linger`]: { status: 0, stdout: 'Linger=yes\n' },
      },
    }));

    expect(state.registration).toBe('partial');
    expect(state.enabled).toBeNull();
    expect(state.warnings).toContain('registration_partial');
  });

  it('keeps Linux registration and activity unknown when subordinate probes fail', () => {
    const state = inspectAutostart(opts, deps({
      platform: 'linux',
      responses: {
        [`systemctl\0--user\0show-environment`]: { status: 0 },
        [`systemctl\0--user\0is-enabled\0botmux.service`]: { status: null, stderr: 'timed out' },
        [`systemctl\0--user\0is-active\0botmux.service`]: { status: null, stderr: 'timed out' },
        [`loginctl\0show-user\0tester\0--property=Linger`]: { status: 1, stderr: 'unavailable' },
      },
    }));

    expect(state).toMatchObject({
      registration: 'unknown',
      enabled: null,
      active: null,
      loaded: null,
      lingerEnabled: null,
      managerReachable: true,
    });
  });

  it('does not treat an unrecognized systemd error as a disabled registration', () => {
    const state = inspectAutostart(opts, deps({
      platform: 'linux',
      responses: {
        [`systemctl\0--user\0show-environment`]: { status: 0 },
        [`systemctl\0--user\0is-enabled\0botmux.service`]: { status: 1, stderr: 'I/O error' },
        [`systemctl\0--user\0is-active\0botmux.service`]: { status: 3, stdout: 'inactive\n' },
        [`loginctl\0show-user\0tester\0--property=Linger`]: { status: 0, stdout: 'Linger=yes\n' },
      },
    }));

    expect(state).toMatchObject({ registration: 'unknown', enabled: null, active: false });
  });

  it('marks a systemd unit with an extra execution directive as partial', () => {
    const unit = '/home/test/.config/systemd/user/botmux.service';
    const state = inspectAutostart(opts, deps({
      platform: 'linux',
      existing: [unit],
      files: { [unit]: linuxUnit({ extraService: 'ExecStartPre="/tmp/unexpected"' }) },
      responses: {
        [`systemctl\0--user\0show-environment`]: { status: 0 },
        [`systemctl\0--user\0is-enabled\0botmux.service`]: { status: 0, stdout: 'enabled\n' },
        [`systemctl\0--user\0is-active\0botmux.service`]: { status: 3, stdout: 'inactive\n' },
        [`loginctl\0show-user\0tester\0--property=Linger`]: { status: 0, stdout: 'Linger=yes\n' },
      },
    }));

    expect(state).toMatchObject({
      registration: 'partial',
      enabled: null,
      targetMatchesCurrentRuntime: true,
    });
    expect(state.warnings).toContain('registration_partial');
    expect(state.warnings).not.toContain('target_mismatch');
  });

  it('keeps a valid but stale systemd target enabled and marks it for repair', () => {
    const unit = '/home/test/.config/systemd/user/botmux.service';
    const state = inspectAutostart(opts, deps({
      platform: 'linux',
      existing: [unit],
      files: { [unit]: linuxUnit({ cliPath: '/old/botmux/dist/cli.js' }) },
      responses: {
        [`systemctl\0--user\0show-environment`]: { status: 0 },
        [`systemctl\0--user\0is-enabled\0botmux.service`]: { status: 0, stdout: 'enabled\n' },
        [`systemctl\0--user\0is-active\0botmux.service`]: { status: 0, stdout: 'active\n' },
        [`loginctl\0show-user\0tester\0--property=Linger`]: { status: 0, stdout: 'Linger=yes\n' },
      },
    }));

    expect(state).toMatchObject({
      registration: 'enabled',
      enabled: true,
      targetMatchesCurrentRuntime: false,
    });
    expect(state.warnings).toContain('target_mismatch');
  });

  it('recognizes the Windows Startup-folder fallback as enabled', () => {
    const script = '/home/test/.botmux/autostart.cmd';
    const launcher = '/home/test/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/botmux-autostart.vbs';
    const state = inspectAutostart(opts, deps({
      platform: 'win32',
      existing: [script, launcher],
      files: {
        [script]: windowsScript(),
        [launcher]: windowsLauncher(script),
      },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0x80070002,
          stderr: 'not found',
        },
      },
    }));

    expect(state).toMatchObject({
      platform: 'windows',
      manager: 'startup-folder',
      registration: 'enabled',
      enabled: true,
      installed: true,
      manageable: true,
      targetMatchesCurrentRuntime: true,
    });
  });

  it('rejects a Startup launcher that merely contains the expected target', () => {
    const script = '/home/test/.botmux/autostart.cmd';
    const launcher = '/home/test/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/botmux-autostart.vbs';
    const state = inspectAutostart(opts, deps({
      platform: 'win32',
      existing: [script, launcher],
      files: {
        [script]: windowsScript(),
        [launcher]: `${windowsLauncher(script)}MsgBox "unexpected"\n`,
      },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0x80070002,
        },
      },
    }));

    expect(state).toMatchObject({
      registration: 'partial',
      enabled: null,
      targetMatchesCurrentRuntime: false,
    });
  });

  it('flags duplicate Windows task and Startup registrations for repair', () => {
    const script = '/home/test/.botmux/autostart.cmd';
    const launcher = '/home/test/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/botmux-autostart.vbs';
    const state = inspectAutostart(opts, deps({
      platform: 'win32',
      existing: [script, launcher],
      files: {
        [script]: windowsScript(),
        [launcher]: windowsLauncher(script),
      },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0,
          stdout: windowsTaskXml({ script }),
        },
      },
    }));

    expect(state).toMatchObject({
      manager: 'task-scheduler',
      registration: 'partial',
      enabled: null,
    });
    expect(state.warnings).toContain('registration_partial');
  });

  it('recognizes a healthy enabled Windows login task and its action target', () => {
    const script = '/home/test/.botmux/autostart.cmd';
    const state = inspectAutostart(opts, deps({
      platform: 'win32',
      existing: [script],
      files: { [script]: windowsScript() },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0,
          stdout: windowsTaskXml({ script, triggerUserId: windowsUserSid }),
        },
      },
    }));

    expect(state).toMatchObject({
      manager: 'task-scheduler',
      registration: 'enabled',
      enabled: true,
      targetMatchesCurrentRuntime: true,
      managerReachable: true,
    });
  });

  it.each([
    { label: 'foreign', triggerUserId: 'S-1-5-21-9999' },
    { label: 'malformed', triggerUserId: 'not-a-sid' },
    { label: 'empty', triggerUserId: '' },
    { label: 'omitted', triggerUserId: 'omit' as const },
  ])('rejects a $label Windows LogonTrigger UserId as non-canonical', ({ triggerUserId }) => {
    const script = '/home/test/.botmux/autostart.cmd';
    const state = inspectAutostart(opts, deps({
      platform: 'win32',
      existing: [script],
      files: { [script]: windowsScript() },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0,
          stdout: windowsTaskXml({ script, triggerUserId }),
        },
      },
    }));

    expect(state).toMatchObject({ registration: 'partial', enabled: null });
    expect(state.warnings).toContain('registration_partial');
  });

  it('round-trips percent signs in Windows batch target paths without expansion', () => {
    const percentOpts: AutostartOpts = {
      pkgRoot: '/opt/100% botmux',
      configDir: '/home/test/100% config',
      logDir: '/home/test/100% logs',
    };
    const percentCli = join(percentOpts.pkgRoot, 'dist', 'cli.js');
    const script = '/home/test/.botmux/autostart.cmd';
    const state = inspectAutostart(percentOpts, deps({
      platform: 'win32',
      existing: [script, percentCli],
      files: {
        [script]: windowsScript({
          cliPath: percentCli,
          workingDirectory: percentOpts.configDir,
          logDir: percentOpts.logDir,
        }),
      },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0,
          stdout: windowsTaskXml({ script }),
        },
      },
    }));

    expect(state).toMatchObject({
      registration: 'enabled',
      enabled: true,
      targetMatchesCurrentRuntime: true,
    });
  });

  it('accepts omitted default-enabled XML fields and UTF-16LE task output', () => {
    const script = '/home/test/.botmux/autostart.cmd';
    const xml = windowsTaskXml({ script, taskEnabled: 'omit', triggerEnabled: 'omit' });
    const state = inspectAutostart(opts, deps({
      platform: 'win32',
      existing: [script],
      files: { [script]: windowsScript() },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0,
          stdout: Buffer.from(`\uFEFF${xml}`, 'utf16le'),
        },
      },
    }));

    expect(state).toMatchObject({
      registration: 'enabled',
      enabled: true,
      targetMatchesCurrentRuntime: true,
    });
  });

  it('parses a representative namespaced Task Scheduler XML document', () => {
    const script = '/home/test/.botmux/autostart.cmd';
    const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>TEST\\tester</Author></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>1</Enabled><UserId>${windowsUserSid}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>S-1-5-21-1000</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><Enabled>1</Enabled><Hidden>false</Hidden></Settings>
  <Actions Context="Author"><Exec><Command>&quot;${script}&quot;</Command></Exec></Actions>
</Task>`;
    const state = inspectAutostart(opts, deps({
      platform: 'win32',
      existing: [script],
      files: { [script]: windowsScript() },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0,
          stdout: Buffer.from(`\uFEFF${xml}`, 'utf16le'),
        },
      },
    }));

    expect(state).toMatchObject({
      registration: 'enabled',
      enabled: true,
      targetMatchesCurrentRuntime: true,
    });
  });

  it('flags a disabled Windows task as partial instead of enabled', () => {
    const script = '/home/test/.botmux/autostart.cmd';
    const state = inspectAutostart(opts, deps({
      platform: 'win32',
      existing: [script],
      files: { [script]: windowsScript() },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0,
          stdout: windowsTaskXml({ script, taskEnabled: false }),
        },
      },
    }));

    expect(state).toMatchObject({
      registration: 'partial',
      enabled: null,
      targetMatchesCurrentRuntime: true,
    });
    expect(state.warnings).toContain('registration_partial');
  });

  it('flags a Windows task with a disabled login trigger as partial', () => {
    const script = '/home/test/.botmux/autostart.cmd';
    const state = inspectAutostart(opts, deps({
      platform: 'win32',
      existing: [script],
      files: { [script]: windowsScript() },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0,
          stdout: windowsTaskXml({ script, triggerEnabled: false }),
        },
      },
    }));

    expect(state).toMatchObject({ registration: 'partial', enabled: null });
  });

  it('flags a Windows task with an additional non-login trigger as partial', () => {
    const script = '/home/test/.botmux/autostart.cmd';
    const state = inspectAutostart(opts, deps({
      platform: 'win32',
      existing: [script],
      files: { [script]: windowsScript() },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0,
          stdout: windowsTaskXml({
            script,
            additionalTrigger: '<CalendarTrigger><StartBoundary>2026-08-12T09:00:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>',
          }),
        },
      },
    }));

    expect(state).toMatchObject({
      registration: 'partial',
      enabled: null,
      targetMatchesCurrentRuntime: true,
    });
  });

  it('keeps a Windows task unknown when an Enabled value is invalid', () => {
    const script = '/home/test/.botmux/autostart.cmd';
    const invalidXml = windowsTaskXml({ script })
      .replace('<Enabled>true</Enabled>', '<Enabled>sometimes</Enabled>');
    const state = inspectAutostart(opts, deps({
      platform: 'win32',
      existing: [script],
      files: { [script]: windowsScript() },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0,
          stdout: invalidXml,
        },
      },
    }));

    expect(state).toMatchObject({ registration: 'unknown', enabled: null });
  });

  it('marks a canonical task with a non-canonical startup script as partial', () => {
    const script = '/home/test/.botmux/autostart.cmd';
    const state = inspectAutostart(opts, deps({
      platform: 'win32',
      existing: [script],
      files: { [script]: `${windowsScript()}echo unexpected\n` },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0,
          stdout: windowsTaskXml({ script }),
        },
      },
    }));

    expect(state).toMatchObject({
      registration: 'partial',
      enabled: null,
      targetMatchesCurrentRuntime: true,
    });
  });

  it('flags a retargeted Windows task for repair', () => {
    const script = '/home/test/.botmux/autostart.cmd';
    const state = inspectAutostart(opts, deps({
      platform: 'win32',
      existing: [script],
      files: { [script]: windowsScript() },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0,
          stdout: windowsTaskXml({ script: 'C:\\other\\start.cmd' }),
        },
      },
    }));

    expect(state).toMatchObject({
      registration: 'partial',
      enabled: null,
      targetMatchesCurrentRuntime: false,
    });
    expect(state.warnings).toEqual(expect.arrayContaining(['registration_partial', 'target_mismatch']));
  });

  it('keeps Windows state unknown when Task Scheduler cannot be inspected', () => {
    const state = inspectAutostart(opts, deps({
      platform: 'win32',
      responses: {
        [windowsTaskQueryKey()]: {
          status: null,
          stderr: 'timed out',
        },
      },
    }));

    expect(state).toMatchObject({
      registration: 'unknown',
      enabled: null,
      managerReachable: false,
      manageable: true,
    });
    expect(state.warnings).toContain('manager_unavailable');
  });

  it('keeps malformed or access-denied Windows task inspection unknown', () => {
    const script = '/home/test/.botmux/autostart.cmd';
    const malformed = inspectAutostart(opts, deps({
      platform: 'win32',
      existing: [script],
      files: { [script]: windowsScript() },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0,
          stdout: '<Task><Settings>',
        },
      },
    }));
    const denied = inspectAutostart(opts, deps({
      platform: 'win32',
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0x80070005,
          stderr: 'access denied',
        },
      },
    }));

    expect(malformed).toMatchObject({ registration: 'unknown', enabled: null, managerReachable: true });
    expect(denied).toMatchObject({ registration: 'unknown', enabled: null, managerReachable: false });
  });

  it('reports unsupported platforms without probing or inventing a disabled state', () => {
    const injected = deps({ platform: 'freebsd' });
    const state = inspectAutostart(opts, injected);

    expect(state).toMatchObject({
      supported: false,
      platform: 'unsupported',
      manager: 'unsupported',
      registration: 'unknown',
      enabled: null,
      manageable: false,
    });
    expect(injected.run).not.toHaveBeenCalled();
  });

  it('throws a typed unsupported error without terminating the hosting process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('unexpected process.exit');
    });
    vi.spyOn(process, 'platform', 'get').mockReturnValue('freebsd');
    try {
      expect(() => enableAutostart({ pkgRoot: dir, configDir: dir, logDir: join(dir, 'logs') }))
        .toThrow(AutostartOperationError);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('quotes and semantically round-trips systemd paths containing spaces, percent, and dollar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-linux-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout $100% space'),
      configDir: join(home, 'config $25% space'),
      logDir: join(home, 'logs'),
    };
    const runtimeCli = join(runtimeOpts.pkgRoot, 'dist', 'cli.js');
    const unit = join(home, '.config', 'systemd', 'user', 'botmux.service');
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('PATH', '/bin path/100%/$tool');
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(unit, 'stale');
    childProcessMocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    });

    try {
      expect(refreshAutostart(runtimeOpts)).toBe(true);
      const rendered = readFileSync(unit, 'utf8');
      expect(rendered).toContain('Environment="PATH=/bin path/100%%/$tool"');
      expect(rendered).toContain('checkout $$100%% space');
      expect(rendered).toContain('config $25%% space');

      const state = inspectAutostart(runtimeOpts, deps({
        platform: 'linux',
        homeDir: home,
        nodePath: process.execPath,
        existing: [unit, runtimeCli, process.execPath],
        files: { [unit]: rendered },
        responses: {
          [`systemctl\0--user\0show-environment`]: { status: 0 },
          [`systemctl\0--user\0is-enabled\0botmux.service`]: { status: 0, stdout: 'enabled\n' },
          [`systemctl\0--user\0is-active\0botmux.service`]: { status: 3, stdout: 'inactive\n' },
          [`loginctl\0show-user\0tester\0--property=Linger`]: { status: 0, stdout: 'Linger=yes\n' },
        },
      }));
      expect(state).toMatchObject({
        registration: 'enabled',
        enabled: true,
        targetMatchesCurrentRuntime: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enables a Linux user unit without starting or stopping the current daemon', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-linux-enable-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const unit = join(home, '.config', 'systemd', 'user', 'botmux.service');
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => ({
      status: 0,
      stdout: Buffer.from(command === 'loginctl' ? 'Linger=yes\n' : ''),
      stderr: Buffer.from(''),
      args,
    }));

    try {
      enableAutostart(runtimeOpts);
      expect(existsSync(unit)).toBe(true);
      const calls = childProcessMocks.spawnSync.mock.calls.map(([, args]) => args as string[]);
      expect(calls).toContainEqual(['--user', 'enable', 'botmux.service']);
      expect(calls.flat()).not.toContain('--now');
      expect(calls.flat()).not.toContain('start');
      expect(calls.flat()).not.toContain('stop');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restores stale Linux unit bytes and mode when enable daemon-reload fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-linux-enable-stale-rollback-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const unit = join(home, '.config', 'systemd', 'user', 'botmux.service');
    const original = Buffer.from('[Service]\nExecStart=/old/runtime\n');
    let reloadCount = 0;
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    silenceAutostartOutput();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, original);
    chmodSync(unit, 0o640);
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args.join('\0') === '--user\0show-environment') return commandResult(0);
      if (args.join('\0') === '--user\0daemon-reload') {
        reloadCount += 1;
        return reloadCount === 1
          ? commandResult(1, '', 'stale reload rejected')
          : commandResult(0);
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      let error: unknown;
      try {
        enableAutostart(runtimeOpts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: 'mutation_failed',
        message: expect.stringContaining('stale reload rejected'),
      });
      expect((error as Error).message).toContain('已原子恢复原 unit');
      expect(readFileSync(unit)).toEqual(original);
      expect(statSync(unit).mode & 0o7777).toBe(0o640);
      expect(reloadCount).toBe(2);
      expect(childProcessMocks.spawnSync.mock.calls
        .some(([, args]) => (args as string[]).includes('enable'))).toBe(false);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes a fresh Linux unit and reloads the old manager view after reload timeout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-linux-enable-fresh-rollback-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const unit = join(home, '.config', 'systemd', 'user', 'botmux.service');
    let reloadCount = 0;
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    silenceAutostartOutput();
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args.join('\0') === '--user\0show-environment') return commandResult(0);
      if (args.join('\0') === '--user\0daemon-reload') {
        reloadCount += 1;
        return reloadCount === 1
          ? commandResult(null, '', 'reload timed out')
          : commandResult(0);
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      expect(() => enableAutostart(runtimeOpts)).toThrow(AutostartOperationError);
      expect(existsSync(unit)).toBe(false);
      expect(reloadCount).toBe(2);
      expect(childProcessMocks.spawnSync.mock.calls
        .some(([, args]) => (args as string[]).includes('enable'))).toBe(false);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws instead of reporting refresh changed when Linux daemon-reload fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-linux-refresh-rollback-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'new checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const unit = join(home, '.config', 'systemd', 'user', 'botmux.service');
    const original = Buffer.from('[Service]\nExecStart=/old/runtime\n');
    let reloadCount = 0;
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    silenceAutostartOutput();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, original);
    chmodSync(unit, 0o604);
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args.join('\0') === '--user\0show-environment') return commandResult(0);
      if (args.join('\0') === '--user\0daemon-reload') {
        reloadCount += 1;
        return reloadCount === 1
          ? commandResult(1, '', 'refresh reload failed')
          : commandResult(0);
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      let returned: boolean | undefined;
      expect(() => {
        returned = refreshAutostart(runtimeOpts);
      }).toThrow(AutostartOperationError);
      expect(returned).toBeUndefined();
      expect(readFileSync(unit)).toEqual(original);
      expect(statSync(unit).mode & 0o7777).toBe(0o604);
      expect(reloadCount).toBe(2);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a Linux refresh file change without claiming manager convergence when unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-linux-refresh-next-login-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'next checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const unit = join(home, '.config', 'systemd', 'user', 'botmux.service');
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    silenceAutostartOutput();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, '[Service]\nExecStart=/old/runtime\n');
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args.join('\0') === '--user\0show-environment') {
        return commandResult(1, '', 'manager unavailable');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      expect(refreshAutostart(runtimeOpts)).toBe(true);
      expect(readFileSync(unit, 'utf8')).toContain(join(runtimeOpts.pkgRoot, 'dist', 'cli.js'));
      expect(childProcessMocks.spawnSync).toHaveBeenCalledTimes(1);
      expect(childProcessMocks.spawnSync.mock.calls[0]?.[1]).toEqual([
        '--user',
        'show-environment',
      ]);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves primary reload detail when Linux write rollback reload also fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-linux-enable-rollback-failure-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const unit = join(home, '.config', 'systemd', 'user', 'botmux.service');
    const original = Buffer.from('old unit');
    let reloadCount = 0;
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    silenceAutostartOutput();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, original);
    chmodSync(unit, 0o640);
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args.join('\0') === '--user\0show-environment') return commandResult(0);
      if (args.join('\0') === '--user\0daemon-reload') {
        reloadCount += 1;
        return reloadCount === 1
          ? commandResult(1, '', 'primary reload exploded')
          : commandResult(null, '', 'rollback reload timed out');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      let error: unknown;
      try {
        enableAutostart(runtimeOpts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'mutation_failed' });
      expect((error as Error).message).toContain('primary reload exploded');
      expect((error as Error).message).toContain('unit rollback failure:');
      expect((error as Error).message).toContain('rollback reload timed out');
      expect(readFileSync(unit)).toEqual(original);
      expect(statSync(unit).mode & 0o7777).toBe(0o640);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not reload systemd again when restoring the previous Linux unit file fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-linux-file-rollback-failure-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const unit = join(home, '.config', 'systemd', 'user', 'botmux.service');
    let reloadCount = 0;
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    silenceAutostartOutput();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, 'old unit');
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args.join('\0') === '--user\0show-environment') return commandResult(0);
      if (args.join('\0') === '--user\0daemon-reload') {
        reloadCount += 1;
        rmSync(dirname(unit), { recursive: true, force: true });
        return commandResult(1, '', 'primary reload failed');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      let error: unknown;
      try {
        enableAutostart(runtimeOpts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'mutation_failed' });
      expect((error as Error).message).toContain('primary reload failed');
      expect((error as Error).message).toContain('unit rollback failure: file restore:');
      expect(reloadCount).toBe(1);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the reloaded unit when systemctl enable fails with unknown partial-commit state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-linux-enable-command-failure-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'new checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const unit = join(home, '.config', 'systemd', 'user', 'botmux.service');
    let reloadCount = 0;
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    silenceAutostartOutput();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, '[Service]\nExecStart=/old/runtime\n');
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args.join('\0') === '--user\0show-environment') return commandResult(0);
      if (args.join('\0') === '--user\0daemon-reload') {
        reloadCount += 1;
        return commandResult(0);
      }
      if (args.join('\0') === '--user\0enable\0botmux.service') {
        return commandResult(1, '', 'enable state unknown');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      expect(() => enableAutostart(runtimeOpts)).toThrow(AutostartOperationError);
      expect(readFileSync(unit, 'utf8')).toContain(join(runtimeOpts.pkgRoot, 'dist', 'cli.js'));
      expect(reloadCount).toBe(1);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes and refreshes a macOS hook without invoking launchctl lifecycle commands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-mac-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const plist = join(home, 'Library', 'LaunchAgents', 'com.botmux.daemon.plist');
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    childProcessMocks.spawnSync.mockImplementation(() => {
      throw new Error('enable/refresh must not invoke launchctl');
    });

    try {
      enableAutostart(runtimeOpts);
      expect(existsSync(plist)).toBe(true);
      expect(readFileSync(plist, 'utf8')).toContain(join(runtimeOpts.pkgRoot, 'dist', 'cli.js'));
      expect(childProcessMocks.spawnSync).not.toHaveBeenCalled();
      const rendered = readFileSync(plist, 'utf8');
      const inspected = inspectAutostart(runtimeOpts, deps({
        platform: 'darwin',
        homeDir: home,
        nodePath: process.execPath,
        existing: [plist, join(runtimeOpts.pkgRoot, 'dist', 'cli.js'), process.execPath],
        files: { [plist]: rendered },
        responses: {
          [`launchctl\0print\0gui/501/com.botmux.daemon`]: { status: 113 },
        },
      }));
      expect(inspected).toMatchObject({
        registration: 'enabled',
        enabled: true,
        targetMatchesCurrentRuntime: true,
      });

      writeFileSync(plist, '<plist>stale path</plist>');
      expect(refreshAutostart(runtimeOpts)).toBe(true);
      expect(readFileSync(plist, 'utf8')).toContain(join(runtimeOpts.pkgRoot, 'dist', 'cli.js'));
      expect(childProcessMocks.spawnSync).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when Linux disable fails and the unit is still enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-linux-disable-failure-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const unit = join(home, '.config', 'systemd', 'user', 'botmux.service');
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    silenceAutostartOutput();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, 'keep me');
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args.join('\0') === '--user\0show-environment') return commandResult(0);
      if (args.join('\0') === '--user\0disable\0botmux.service') {
        return commandResult(1, '', 'Access denied');
      }
      if (args.join('\0') === '--user\0is-enabled\0botmux.service') {
        return commandResult(0, 'enabled\n');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      let error: unknown;
      try {
        disableAutostart(runtimeOpts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'mutation_failed' });
      expect(readFileSync(unit, 'utf8')).toBe('keep me');
      expect(childProcessMocks.spawnSync.mock.calls).not.toContainEqual([
        'systemctl',
        ['--user', 'daemon-reload'],
        expect.anything(),
      ]);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'verification times out', verification: commandResult(null) },
    { label: 'verification returns an unknown state', verification: commandResult(1, 'unexpected\n') },
  ])('keeps the Linux unit when disable fails and $label', ({ verification }) => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-linux-disable-unknown-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const unit = join(home, '.config', 'systemd', 'user', 'botmux.service');
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    silenceAutostartOutput();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, 'keep me');
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args.join('\0') === '--user\0show-environment') return commandResult(0);
      if (args.join('\0') === '--user\0disable\0botmux.service') return commandResult(1);
      if (args.join('\0') === '--user\0is-enabled\0botmux.service') return verification;
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      expect(() => disableAutostart(runtimeOpts)).toThrow(AutostartOperationError);
      expect(readFileSync(unit, 'utf8')).toBe('keep me');
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a failed Linux disable only after is-enabled proves it is already disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-linux-disable-idempotent-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const unit = join(home, '.config', 'systemd', 'user', 'botmux.service');
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    silenceAutostartOutput();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, 'remove me');
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args.join('\0') === '--user\0show-environment') return commandResult(0);
      if (args.join('\0') === '--user\0disable\0botmux.service') return commandResult(1);
      if (args.join('\0') === '--user\0is-enabled\0botmux.service') {
        return commandResult(1, 'disabled\n');
      }
      if (args.join('\0') === '--user\0daemon-reload') return commandResult(0);
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      disableAutostart(runtimeOpts);
      expect(existsSync(unit)).toBe(false);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomically restores Linux unit content and permissions when daemon-reload fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-linux-disable-rollback-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const unit = join(home, '.config', 'systemd', 'user', 'botmux.service');
    const original = Buffer.from('[Service]\nExecStart=/original\n');
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    silenceAutostartOutput();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, original);
    chmodSync(unit, 0o640);
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args.join('\0') === '--user\0show-environment') return commandResult(0);
      if (args.join('\0') === '--user\0disable\0botmux.service') return commandResult(0);
      if (args.join('\0') === '--user\0daemon-reload') {
        return commandResult(1, '', 'Failed to connect to bus');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      let error: unknown;
      try {
        disableAutostart(runtimeOpts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: 'mutation_failed',
        message: expect.stringContaining('已原子恢复原 unit'),
      });
      expect(readFileSync(unit)).toEqual(original);
      expect(statSync(unit).mode & 0o7777).toBe(0o640);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the reload failure when Linux unit rollback also fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-linux-disable-rollback-failure-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const unit = join(home, '.config', 'systemd', 'user', 'botmux.service');
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    silenceAutostartOutput();
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, 'original unit');
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args.join('\0') === '--user\0show-environment') return commandResult(0);
      if (args.join('\0') === '--user\0disable\0botmux.service') return commandResult(0);
      if (args.join('\0') === '--user\0daemon-reload') {
        rmSync(dirname(unit), { recursive: true, force: true });
        return commandResult(1, '', 'reload exploded');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      let error: unknown;
      try {
        disableAutostart(runtimeOpts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'mutation_failed' });
      expect((error as Error).message).toContain('daemon-reload 失败: reload exploded');
      expect((error as Error).message).toContain('unit rollback failure:');
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the macOS plist when launchctl cannot unload a loaded registration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-mac-disable-failure-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const plist = join(home, 'Library', 'LaunchAgents', 'com.botmux.daemon.plist');
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    silenceAutostartOutput();
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, 'keep me');
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'print') return commandResult(0);
      if (args[0] === 'bootout' || args[0] === 'unload') {
        return commandResult(1, '', 'operation denied');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      let error: unknown;
      try {
        disableAutostart(runtimeOpts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'mutation_failed' });
      expect(readFileSync(plist, 'utf8')).toBe('keep me');
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates a canonical Windows task hook that its inspector accepts', () => {
    const fixture = windowsRuntimeFixture('botmux-autostart-windows-enable-');
    const { dir, home, appData, runtimeOpts, runtimeCli, script, launcher, taskXmlPath } = fixture;
    const sentinel = join(dir, 'xml-symlink-sentinel');
    mkdirSync(dirname(taskXmlPath), { recursive: true });
    writeFileSync(sentinel, 'must not be overwritten');
    symlinkSync(sentinel, taskXmlPath);
    let generatedTaskXml = '';
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Query') {
        const name = taskNameFromArgs(args);
        if (name === 'botmux-daemon') return absentTaskResult();
        if (name === windowsScopedTaskName && generatedTaskXml) {
          return commandResult(0, generatedTaskXml);
        }
        return absentTaskResult();
      }
      if (args[0] === '/Create') {
        expect(taskNameFromArgs(args)).toBe(windowsScopedTaskName);
        expect(args).toContainEqual('/XML');
        expect(args).not.toContain('/F');
        expect(args).not.toContain('/SC');
        expect(args).not.toContain('/TR');
        expect(args).not.toContain('/Run');
        expect(existsSync(join(runtimeOpts.configDir, '.autostart-state.lock'))).toBe(true);
        const xmlIndex = args.indexOf('/XML');
        expect(args[xmlIndex + 1]).toBe(taskXmlPath);
        expect(statSync(taskXmlPath).mode & 0o7777).toBe(0o600);
        generatedTaskXml = readFileSync(taskXmlPath, 'utf8');
        return commandResult(0);
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      enableAutostart(runtimeOpts);
      expect(existsSync(script)).toBe(true);
      expect(existsSync(launcher)).toBe(false);
      expect(existsSync(taskXmlPath)).toBe(false);
      expect(readFileSync(sentinel, 'utf8')).toBe('must not be overwritten');
      expectNoDaemonLifecycleCalls();

      const rendered = readFileSync(script, 'utf8');
      const state = inspectAutostart(runtimeOpts, {
        platform: 'win32',
        homeDir: home,
        appData,
        nodePath: process.execPath,
        pathValue: 'C:\\Windows\\System32',
        windowsUserSid,
        run: (command, args) => command === 'schtasks'
          && taskNameFromArgs(args) === windowsScopedTaskName
          ? { status: 0, stdout: generatedTaskXml }
          : command === 'schtasks' ? { status: 0x80070002 } : { status: null },
      });
      expect(rendered).toContain(runtimeCli);
      expect(generatedTaskXml.match(new RegExp(`<UserId>${windowsUserSid}</UserId>`, 'g')))
        .toHaveLength(2);
      expect(state).toMatchObject({
        manager: 'task-scheduler',
        registration: 'enabled',
        enabled: true,
        targetExists: true,
        targetMatchesCurrentRuntime: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives distinct scoped task names for distinct normalized Windows SIDs', () => {
    const fixture = windowsRuntimeFixture('botmux-autostart-windows-scoped-names-');
    const secondSid = 'S-1-5-21-2000';
    let currentSid = windowsUserSid;
    const taskXmlByName = new Map<string, string>();
    const createdNames: string[] = [];
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult(currentSid);
      if (args[0] === '/Query') {
        const xml = taskXmlByName.get(taskNameFromArgs(args) ?? '');
        return xml ? commandResult(0, xml) : absentTaskResult();
      }
      if (args[0] === '/Create') {
        const name = taskNameFromArgs(args)!;
        const xmlPath = args[args.indexOf('/XML') + 1]!;
        createdNames.push(name);
        taskXmlByName.set(name, readFileSync(xmlPath, 'utf8'));
        return commandResult(0);
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      enableAutostart(fixture.runtimeOpts);
      currentSid = secondSid.toLowerCase();
      enableAutostart(fixture.runtimeOpts);

      expect(createdNames).toEqual([
        `botmux-daemon-${windowsUserSid}`,
        `botmux-daemon-${secondSid}`,
      ]);
      expect(new Set(createdNames).size).toBe(2);
      expect(childProcessMocks.spawnSync.mock.calls
        .filter(([, args]) => (args as string[])[0] === '/Create')
        .every(([, args]) => !(args as string[]).includes('/F'))).toBe(true);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('refreshes an existing Windows Startup fallback without migrating when task is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-windows-fallback-'));
    const home = join(dir, 'home');
    const appData = join(home, 'AppData', 'Roaming');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const launcher = join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'botmux-autostart.vbs',
    );
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('APPDATA', appData);
    silenceAutostartOutput();
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, 'existing fallback');
    chmodSync(launcher, 0o640);
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Create') return commandResult(1, '', 'Access denied');
      if (args[0] === '/Query') return commandResult(0x80070002);
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      enableAutostart(runtimeOpts);
      expect(existsSync(launcher)).toBe(true);
      expect(readFileSync(launcher, 'utf8')).toContain('autostart.cmd');
      expect(statSync(launcher).mode & 0o7777).toBe(0o640);
      expect(childProcessMocks.spawnSync.mock.calls
        .some(([, args]) => (args as string[])[0] === '/Create')).toBe(false);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports refresh changed after removing an owned scoped duplicate while preserving fallback', () => {
    const fixture = windowsRuntimeFixture('botmux-autostart-windows-refresh-duplicate-');
    const { script, launcher } = fixture;
    const original = Buffer.from(windowsLauncher(script));
    let scopedExists = true;
    mkdirSync(dirname(script), { recursive: true });
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(script, windowsScript({
      nodePath: process.execPath,
      cliPath: fixture.runtimeCli,
      workingDirectory: fixture.runtimeOpts.configDir,
      logDir: fixture.runtimeOpts.logDir,
    }));
    writeFileSync(launcher, original);
    chmodSync(launcher, 0o640);
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Query') {
        if (taskNameFromArgs(args) === 'botmux-daemon') return absentTaskResult();
        return scopedExists
          ? commandResult(0, windowsTaskXml({ script }))
          : absentTaskResult();
      }
      if (args[0] === '/Delete' && taskNameFromArgs(args) === windowsScopedTaskName) {
        scopedExists = false;
        return commandResult(0);
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      expect(refreshAutostart(fixture.runtimeOpts)).toBe(true);
      expect(scopedExists).toBe(false);
      expect(readFileSync(launcher)).toEqual(original);
      expect(statSync(launcher).mode & 0o7777).toBe(0o640);
      expect(childProcessMocks.spawnSync.mock.calls
        .some(([, args]) => (args as string[])[0] === '/Create')).toBe(false);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it.each([
    { action: 'enable', duplicate: 'scoped' },
    { action: 'refresh', duplicate: 'legacy' },
  ] as const)(
    'restores a stale fallback after $action first-$duplicate deletion definitely remains owned',
    ({ action, duplicate }) => {
      const fixture = windowsRuntimeFixture(`botmux-autostart-windows-${action}-${duplicate}-restore-`);
      const original = Buffer.from(`stale ${duplicate} launcher\r\n`);
      const ownedXml = windowsTaskXml({
        script: fixture.script,
        triggerUserId: duplicate === 'legacy' ? 'omit' : windowsUserSid,
      });
      mkdirSync(dirname(fixture.script), { recursive: true });
      mkdirSync(dirname(fixture.launcher), { recursive: true });
      writeFileSync(fixture.script, 'old script');
      writeFileSync(fixture.launcher, original);
      chmodSync(fixture.launcher, 0o640);
      childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
        if (command === 'whoami') return whoamiResult();
        if (args[0] === '/Query') {
          const name = taskNameFromArgs(args);
          const expected = duplicate === 'legacy' ? 'botmux-daemon' : windowsScopedTaskName;
          return name === expected ? commandResult(0, ownedXml) : absentTaskResult();
        }
        if (args[0] === '/Delete') return commandResult(5, '', `${duplicate} delete denied`);
        throw new Error(`unexpected command: ${args.join(' ')}`);
      });

      try {
        const mutate = () => action === 'enable'
          ? enableAutostart(fixture.runtimeOpts)
          : refreshAutostart(fixture.runtimeOpts);
        let error: unknown;
        try {
          mutate();
        } catch (caught) {
          error = caught;
        }
        expect(error).toMatchObject({ code: 'mutation_failed' });
        expect((error as Error).message).toContain(`${duplicate} delete denied`);
        expect((error as Error).message).toContain('已原子恢复原 Startup fallback');
        expect(readFileSync(fixture.launcher)).toEqual(original);
        expect(statSync(fixture.launcher).mode & 0o7777).toBe(0o640);
        expect(childProcessMocks.spawnSync.mock.calls
          .filter(([, args]) => (args as string[])[0] === '/Delete')).toHaveLength(1);
        expect(childProcessMocks.spawnSync.mock.calls
          .some(([, args]) => (args as string[])[0] === '/Create')).toBe(false);
        expectNoDaemonLifecycleCalls();
      } finally {
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    },
  );

  it('preserves the duplicate deletion error when stale fallback restoration fails', () => {
    const fixture = windowsRuntimeFixture('botmux-autostart-windows-fallback-rollback-failure-');
    const original = Buffer.from('stale launcher');
    const ownedXml = windowsTaskXml({ script: fixture.script });
    mkdirSync(dirname(fixture.launcher), { recursive: true });
    writeFileSync(fixture.launcher, original);
    chmodSync(fixture.launcher, 0o640);
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Query') {
        return taskNameFromArgs(args) === windowsScopedTaskName
          ? commandResult(0, ownedXml)
          : absentTaskResult();
      }
      if (args[0] === '/Delete') {
        rmSync(dirname(fixture.launcher), { recursive: true, force: true });
        return commandResult(5, '', 'owned delete failed');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      let error: unknown;
      try {
        enableAutostart(fixture.runtimeOpts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'mutation_failed' });
      expect((error as Error).message).toContain('owned delete failed');
      expect((error as Error).message).toContain('Startup fallback rollback failure:');
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('keeps the canonical fallback when duplicate deletion readback becomes unknown', () => {
    const fixture = windowsRuntimeFixture('botmux-autostart-windows-fallback-unknown-delete-');
    const original = Buffer.from('stale launcher');
    const ownedXml = windowsTaskXml({ script: fixture.script });
    let deleteAttempted = false;
    mkdirSync(dirname(fixture.launcher), { recursive: true });
    writeFileSync(fixture.launcher, original);
    chmodSync(fixture.launcher, 0o640);
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Query') {
        if (taskNameFromArgs(args) === 'botmux-daemon') return absentTaskResult();
        return deleteAttempted
          ? commandResult(null, '', 'delete readback timed out')
          : commandResult(0, ownedXml);
      }
      if (args[0] === '/Delete') {
        deleteAttempted = true;
        return commandResult(5, '', 'delete outcome unknown');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      let error: unknown;
      try {
        enableAutostart(fixture.runtimeOpts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'mutation_failed' });
      expect((error as Error).message).toContain('partial convergence');
      expect((error as Error).message).toContain('Startup fallback rollback skipped');
      expect(readFileSync(fixture.launcher, 'utf8')).toBe(windowsLauncher(fixture.script));
      expect(statSync(fixture.launcher).mode & 0o7777).toBe(0o640);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('keeps the canonical fallback after one duplicate was removed before another fails', () => {
    const fixture = windowsRuntimeFixture('botmux-autostart-windows-fallback-partial-delete-');
    const original = Buffer.from('stale launcher');
    const scopedXml = windowsTaskXml({ script: fixture.script });
    const legacyXml = windowsTaskXml({ script: fixture.script, triggerUserId: 'omit' });
    let scopedExists = true;
    mkdirSync(dirname(fixture.launcher), { recursive: true });
    writeFileSync(fixture.launcher, original);
    chmodSync(fixture.launcher, 0o640);
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Query') {
        if (taskNameFromArgs(args) === windowsScopedTaskName) {
          return scopedExists ? commandResult(0, scopedXml) : absentTaskResult();
        }
        return commandResult(0, legacyXml);
      }
      if (args[0] === '/Delete' && taskNameFromArgs(args) === windowsScopedTaskName) {
        scopedExists = false;
        return commandResult(0);
      }
      if (args[0] === '/Delete' && taskNameFromArgs(args) === 'botmux-daemon') {
        return commandResult(5, '', 'legacy delete failed');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      let error: unknown;
      try {
        enableAutostart(fixture.runtimeOpts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'mutation_failed' });
      expect((error as Error).message).toContain('legacy delete failed');
      expect((error as Error).message).toContain('another duplicate was already removed');
      expect(scopedExists).toBe(false);
      expect(readFileSync(fixture.launcher, 'utf8')).toBe(windowsLauncher(fixture.script));
      expect(statSync(fixture.launcher).mode & 0o7777).toBe(0o640);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('installs a new Windows fallback only after failed Create is authoritatively absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-windows-new-fallback-'));
    const home = join(dir, 'home');
    const appData = join(home, 'AppData', 'Roaming');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const launcher = join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'botmux-autostart.vbs',
    );
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('APPDATA', appData);
    silenceAutostartOutput();
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') {
        return commandResult(0, `"TEST\\tester","${windowsUserSid}"\r\n`);
      }
      if (args[0] === '/Create') return commandResult(1, '', 'Access denied');
      if (args[0] === '/Query') return commandResult(0x80070002);
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      enableAutostart(runtimeOpts);
      expect(readFileSync(launcher, 'utf8')).toContain('autostart.cmd');
      expect(childProcessMocks.spawnSync.mock.calls
        .filter(([, args]) => (args as string[])[0] === '/Create')).toHaveLength(1);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['unknown', 'foreign', 'ownership-unknown'] as const)(
    'keeps a fresh Windows fallback when owned-legacy deletion readback becomes %s',
    readbackState => {
      const fixture = windowsRuntimeFixture(
        `botmux-autostart-windows-fresh-fallback-legacy-${readbackState}-`,
      );
      const legacyXml = windowsTaskXml({
        script: fixture.script,
        triggerUserId: 'omit',
      });
      const foreignLegacyXml = windowsTaskXml({
        script: fixture.script,
        principalUserId: 'S-1-5-21-9999',
        triggerUserId: 'omit',
      });
      const incompatibleLegacyXml = windowsTaskXml({
        script: fixture.script,
        triggerUserId: 'omit',
        additionalTrigger: '<TimeTrigger><StartBoundary>2030-01-01T00:00:00</StartBoundary></TimeTrigger>',
      });
      let legacyDeleteAttempted = false;
      let legacyActuallyExists = true;
      childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
        if (command === 'whoami') return whoamiResult();
        if (args[0] === '/Query') {
          if (taskNameFromArgs(args) !== 'botmux-daemon') return absentTaskResult();
          if (!legacyDeleteAttempted) return commandResult(0, legacyXml);
          return readbackState === 'unknown'
            ? commandResult(null, '', 'legacy readback timed out')
            : commandResult(
                0,
                readbackState === 'foreign' ? foreignLegacyXml : incompatibleLegacyXml,
              );
        }
        if (args[0] === '/Create') return commandResult(5, '', 'scoped create denied');
        if (args[0] === '/Delete' && taskNameFromArgs(args) === 'botmux-daemon') {
          expect(readFileSync(fixture.launcher, 'utf8')).toBe(windowsLauncher(fixture.script));
          legacyDeleteAttempted = true;
          legacyActuallyExists = false;
          return commandResult(0);
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      });

      try {
        let error: unknown;
        try {
          enableAutostart(fixture.runtimeOpts);
        } catch (caught) {
          error = caught;
        }
        expect(error).toMatchObject({ code: 'mutation_failed' });
        expect((error as Error).message).toContain('partial convergence');
        expect((error as Error).message).toContain('Startup fallback rollback skipped');
        expect((error as Error).message).toContain(
          `legacy task readback=${readbackState === 'unknown'
            ? 'unknown/unknown'
            : readbackState === 'foreign' ? 'present/foreign' : 'present/unknown'}`,
        );
        expect(legacyActuallyExists).toBe(false);
        expect(readFileSync(fixture.launcher, 'utf8')).toBe(windowsLauncher(fixture.script));
        expect(childProcessMocks.spawnSync.mock.calls
          .filter(([, args]) => (args as string[])[0] === '/Delete')).toHaveLength(1);
        expect(childProcessMocks.spawnSync.mock.calls
          .filter(([, args]) => (args as string[])[0] === '/Delete')
          .map(([, args]) => taskNameFromArgs(args as string[]))).toEqual(['botmux-daemon']);
        expectNoDaemonLifecycleCalls();
      } finally {
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    },
  );

  it('keeps a fresh fallback when owned-legacy deletion is authoritatively absent', () => {
    const fixture = windowsRuntimeFixture('botmux-autostart-windows-fresh-fallback-absent-');
    const legacyXml = windowsTaskXml({ script: fixture.script, triggerUserId: 'omit' });
    let legacyExists = true;
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Query') {
        if (taskNameFromArgs(args) !== 'botmux-daemon') return absentTaskResult();
        return legacyExists ? commandResult(0, legacyXml) : absentTaskResult();
      }
      if (args[0] === '/Create') return commandResult(5, '', 'scoped create denied');
      if (args[0] === '/Delete' && taskNameFromArgs(args) === 'botmux-daemon') {
        legacyExists = false;
        return commandResult(5, '', 'delete command reported a race');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      expect(() => enableAutostart(fixture.runtimeOpts)).not.toThrow();
      expect(legacyExists).toBe(false);
      expect(readFileSync(fixture.launcher, 'utf8')).toBe(windowsLauncher(fixture.script));
      expect(childProcessMocks.spawnSync.mock.calls
        .filter(([, args]) => (args as string[])[0] === '/Delete')
        .map(([, args]) => taskNameFromArgs(args as string[]))).toEqual(['botmux-daemon']);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('removes a fresh fallback only when legacy cleanup readback is still present-owned', () => {
    const fixture = windowsRuntimeFixture('botmux-autostart-windows-fresh-fallback-rollback-');
    const legacyXml = windowsTaskXml({ script: fixture.script, triggerUserId: 'omit' });
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Query') {
        return taskNameFromArgs(args) === 'botmux-daemon'
          ? commandResult(0, legacyXml)
          : absentTaskResult();
      }
      if (args[0] === '/Create') return commandResult(5, '', 'scoped create denied');
      if (args[0] === '/Delete' && taskNameFromArgs(args) === 'botmux-daemon') {
        return commandResult(5, '', 'legacy delete denied');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      let error: unknown;
      try {
        enableAutostart(fixture.runtimeOpts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'mutation_failed' });
      expect((error as Error).message).toContain('legacy delete denied');
      expect((error as Error).message).toContain('已回滚 Startup fallback 并保留 owned legacy task');
      expect(existsSync(fixture.launcher)).toBe(false);
      expect(childProcessMocks.spawnSync.mock.calls
        .filter(([, args]) => (args as string[])[0] === '/Delete')).toHaveLength(1);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('preserves an existing Windows fallback when task state is unknown before migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-windows-preserve-preflight-'));
    const home = join(dir, 'home');
    const appData = join(home, 'AppData', 'Roaming');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const launcher = join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'botmux-autostart.vbs',
    );
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('APPDATA', appData);
    silenceAutostartOutput();
    const original = Buffer.from('existing fallback bytes\r\n');
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, original);
    chmodSync(launcher, 0o640);
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Query') return commandResult(null, '', 'manager unavailable');
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      let error: unknown;
      try {
        enableAutostart(runtimeOpts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'mutation_failed' });
      expect(readFileSync(launcher)).toEqual(original);
      expect(statSync(launcher).mode & 0o7777).toBe(0o640);
      expect(childProcessMocks.spawnSync.mock.calls
        .some(([, args]) => (args as string[])[0] === '/Create')).toBe(false);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves a healthy fallback byte-for-byte when current Windows SID is unavailable', () => {
    const fixture = windowsRuntimeFixture('botmux-autostart-windows-fallback-no-sid-');
    const original = Buffer.from(windowsLauncher(fixture.script).replace(/\n/gu, '\r\n'));
    mkdirSync(dirname(fixture.launcher), { recursive: true });
    writeFileSync(fixture.launcher, original);
    chmodSync(fixture.launcher, 0o640);
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return commandResult(1, '', 'identity unavailable');
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      expect(() => enableAutostart(fixture.runtimeOpts)).toThrow(AutostartOperationError);
      expect(readFileSync(fixture.launcher)).toEqual(original);
      expect(statSync(fixture.launcher).mode & 0o7777).toBe(0o640);
      expect(childProcessMocks.spawnSync.mock.calls
        .some(([, args]) => ['/Create', '/Delete'].includes((args as string[])[0]!))).toBe(false);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it.each(['foreign-scoped', 'malformed-legacy'] as const)(
    'keeps a healthy fallback unchanged for a %s task collision',
    collision => {
      const fixture = windowsRuntimeFixture(`botmux-autostart-windows-${collision}-fallback-`);
      const original = Buffer.from(windowsLauncher(fixture.script).replace(/\n/gu, '\r\n'));
      mkdirSync(dirname(fixture.launcher), { recursive: true });
      writeFileSync(fixture.launcher, original);
      chmodSync(fixture.launcher, 0o640);
      childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
        if (command === 'whoami') return whoamiResult();
        if (args[0] === '/Query') {
          const name = taskNameFromArgs(args);
          if (collision === 'foreign-scoped' && name === windowsScopedTaskName) {
            return commandResult(0, windowsTaskXml({
              script: fixture.script,
              principalUserId: 'S-1-5-21-9999',
              triggerUserId: 'S-1-5-21-9999',
            }));
          }
          if (collision === 'malformed-legacy' && name === 'botmux-daemon') {
            return commandResult(0, '<Task><Principals>');
          }
          return absentTaskResult();
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      });

      try {
        expect(() => enableAutostart(fixture.runtimeOpts)).toThrow(AutostartOperationError);
        expect(readFileSync(fixture.launcher)).toEqual(original);
        expect(statSync(fixture.launcher).mode & 0o7777).toBe(0o640);
        expect(childProcessMocks.spawnSync.mock.calls
          .some(([, args]) => ['/Create', '/Delete'].includes((args as string[])[0]!))).toBe(false);
        expectNoDaemonLifecycleCalls();
      } finally {
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    },
  );

  it('preserves the authoritative fallback when a scoped task is unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-windows-task-only-'));
    const home = join(dir, 'home');
    const appData = join(home, 'AppData', 'Roaming');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const launcher = join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'botmux-autostart.vbs',
    );
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('APPDATA', appData);
    silenceAutostartOutput();
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, 'existing fallback');
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') {
        return commandResult(0, `"TEST\\tester","${windowsUserSid}"\r\n`);
      }
      if (args[0] === '/Query') return commandResult(0, '<Task/>');
      if (args[0] === '/Create') return commandResult(1, '', 'registration failed');
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      expect(() => enableAutostart(runtimeOpts)).toThrow(AutostartOperationError);
      expect(readFileSync(launcher, 'utf8')).toBe('existing fallback');
      expect(childProcessMocks.spawnSync.mock.calls
        .some(([, args]) => (args as string[])[0] === '/Delete')).toBe(false);
      expect(childProcessMocks.spawnSync.mock.calls
        .some(([, args]) => (args as string[])[0] === '/Create')).toBe(false);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['enable', 'refresh'] as const)(
    'keeps the exact fallback when %s cannot confirm duplicate task deletion',
    action => {
      const dir = mkdtempSync(join(tmpdir(), `botmux-autostart-windows-${action}-rollback-`));
      const home = join(dir, 'home');
      const appData = join(home, 'AppData', 'Roaming');
      const runtimeOpts: AutostartOpts = {
        pkgRoot: join(dir, 'checkout'),
        configDir: join(home, '.botmux'),
        logDir: join(home, '.botmux', 'logs'),
      };
      const script = join(home, '.botmux', 'autostart.cmd');
      const launcher = join(
        appData,
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Startup',
        'botmux-autostart.vbs',
      );
      const original = Buffer.from(windowsLauncher(script).replace(/\n/gu, '\r\n'));
      let taskExists = true;
      let deleteAttempted = false;
      osMocks.homeDir = home;
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      vi.stubEnv('APPDATA', appData);
      silenceAutostartOutput();
      mkdirSync(dirname(script), { recursive: true });
      mkdirSync(dirname(launcher), { recursive: true });
      writeFileSync(script, 'old script');
      writeFileSync(launcher, original);
      chmodSync(launcher, 0o640);
      childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
        if (command === 'whoami') return whoamiResult();
        if (args[0] === '/Query') {
          if (taskNameFromArgs(args) === 'botmux-daemon') return absentTaskResult();
          return deleteAttempted
            ? commandResult(null, '', 'query timed out')
            : commandResult(0, windowsTaskXml({ script }));
        }
        if (args[0] === '/Delete') {
          deleteAttempted = true;
          return commandResult(5, '', 'access denied');
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      });

      try {
        const mutate = () => action === 'enable'
          ? enableAutostart(runtimeOpts)
          : refreshAutostart(runtimeOpts);
        expect(mutate).toThrow(AutostartOperationError);
        expect(taskExists).toBe(true);
        expect(readFileSync(launcher)).toEqual(original);
        expect(statSync(launcher).mode & 0o7777).toBe(0o640);
        expect(childProcessMocks.spawnSync.mock.calls
          .filter(([, args]) => (args as string[])[0] === '/Create')).toHaveLength(0);
        expect(childProcessMocks.spawnSync.mock.calls
          .filter(([, args]) => (args as string[])[0] === '/Delete')).toHaveLength(1);
        expectNoDaemonLifecycleCalls();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('never overwrites or deletes a foreign scoped task', () => {
    const fixture = windowsRuntimeFixture('botmux-autostart-windows-foreign-scoped-');
    const foreignXml = windowsTaskXml({
      script: fixture.script,
      principalUserId: 'S-1-5-21-9999',
      triggerUserId: 'S-1-5-21-9999',
    });
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Query') {
        return taskNameFromArgs(args) === windowsScopedTaskName
          ? commandResult(0, foreignXml)
          : absentTaskResult();
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      expect(() => enableAutostart(fixture.runtimeOpts)).toThrow(AutostartOperationError);
      expect(() => disableAutostart(fixture.runtimeOpts)).not.toThrow();
      expect(childProcessMocks.spawnSync.mock.calls
        .some(([, args]) => ['/Create', '/Delete'].includes((args as string[])[0]!))).toBe(false);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('ignores a foreign fixed-name task while creating only the scoped task', () => {
    const fixture = windowsRuntimeFixture('botmux-autostart-windows-foreign-legacy-');
    const foreignLegacy = windowsTaskXml({
      script: fixture.script,
      principalUserId: 'S-1-5-21-9999',
      triggerUserId: 'omit',
    });
    let scopedXml = '';
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Query') {
        if (taskNameFromArgs(args) === 'botmux-daemon') return commandResult(0, foreignLegacy);
        return scopedXml ? commandResult(0, scopedXml) : absentTaskResult();
      }
      if (args[0] === '/Create') {
        expect(taskNameFromArgs(args)).toBe(windowsScopedTaskName);
        expect(args).not.toContain('/F');
        scopedXml = readFileSync(args[args.indexOf('/XML') + 1]!, 'utf8');
        return commandResult(0);
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      enableAutostart(fixture.runtimeOpts);
      expect(scopedXml).toContain(`<UserId>${windowsUserSid}</UserId>`);
      expect(childProcessMocks.spawnSync.mock.calls
        .some(([, args]) => (args as string[])[0] === '/Delete')).toBe(false);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('safely migrates an owned any-user legacy task to one healthy scoped task', () => {
    const fixture = windowsRuntimeFixture('botmux-autostart-windows-owned-legacy-migrate-');
    const legacyXml = windowsTaskXml({ script: fixture.script, triggerUserId: 'omit' });
    let scopedXml = '';
    let legacyExists = true;
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Query') {
        if (taskNameFromArgs(args) === 'botmux-daemon') {
          return legacyExists ? commandResult(0, legacyXml) : absentTaskResult();
        }
        return scopedXml ? commandResult(0, scopedXml) : absentTaskResult();
      }
      if (args[0] === '/Create') {
        expect(taskNameFromArgs(args)).toBe(windowsScopedTaskName);
        expect(args).not.toContain('/F');
        scopedXml = readFileSync(args[args.indexOf('/XML') + 1]!, 'utf8');
        return commandResult(0);
      }
      if (args[0] === '/Delete' && taskNameFromArgs(args) === 'botmux-daemon') {
        legacyExists = false;
        return commandResult(0);
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      enableAutostart(fixture.runtimeOpts);
      expect(legacyExists).toBe(false);
      expect(scopedXml).not.toBe('');
      expect(existsSync(fixture.launcher)).toBe(false);
      expect(childProcessMocks.spawnSync.mock.calls
        .filter(([, args]) => (args as string[])[0] === '/Delete'
          && taskNameFromArgs(args as string[]) === 'botmux-daemon')).toHaveLength(1);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it.each(['unknown', 'foreign'] as const)(
    'keeps a healthy scoped replacement when owned-legacy deletion readback becomes %s',
    readbackState => {
      const fixture = windowsRuntimeFixture(
        `botmux-autostart-windows-scoped-legacy-${readbackState}-`,
      );
      const legacyXml = windowsTaskXml({ script: fixture.script, triggerUserId: 'omit' });
      const foreignLegacyXml = windowsTaskXml({
        script: fixture.script,
        principalUserId: 'S-1-5-21-9999',
        triggerUserId: 'omit',
      });
      let scopedXml = '';
      let legacyDeleteAttempted = false;
      let legacyActuallyExists = true;
      childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
        if (command === 'whoami') return whoamiResult();
        if (args[0] === '/Query') {
          if (taskNameFromArgs(args) === 'botmux-daemon') {
            if (!legacyDeleteAttempted) return commandResult(0, legacyXml);
            return readbackState === 'unknown'
              ? commandResult(null, '', 'legacy readback timed out')
              : commandResult(0, foreignLegacyXml);
          }
          return scopedXml ? commandResult(0, scopedXml) : absentTaskResult();
        }
        if (args[0] === '/Create') {
          scopedXml = readFileSync(args[args.indexOf('/XML') + 1]!, 'utf8');
          return commandResult(0);
        }
        if (args[0] === '/Delete' && taskNameFromArgs(args) === 'botmux-daemon') {
          legacyDeleteAttempted = true;
          legacyActuallyExists = false;
          return commandResult(0);
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      });

      try {
        let error: unknown;
        try {
          enableAutostart(fixture.runtimeOpts);
        } catch (caught) {
          error = caught;
        }
        expect(error).toMatchObject({ code: 'mutation_failed' });
        expect((error as Error).message).toContain('partial convergence');
        expect((error as Error).message).toContain('scoped task rollback skipped');
        expect((error as Error).message).toContain(
          `legacy task readback=${readbackState === 'unknown' ? 'unknown/unknown' : 'present/foreign'}`,
        );
        expect(legacyActuallyExists).toBe(false);
        expect(scopedXml).toContain(`<UserId>${windowsUserSid}</UserId>`);
        expect(existsSync(fixture.launcher)).toBe(false);
        expect(childProcessMocks.spawnSync.mock.calls
          .filter(([, args]) => (args as string[])[0] === '/Delete')
          .map(([, args]) => taskNameFromArgs(args as string[]))).toEqual(['botmux-daemon']);
        expectNoDaemonLifecycleCalls();
      } finally {
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    },
  );

  it('rolls back a healthy scoped replacement when legacy cleanup is definitely still owned', () => {
    const fixture = windowsRuntimeFixture('botmux-autostart-windows-scoped-legacy-rollback-');
    const legacyXml = windowsTaskXml({ script: fixture.script, triggerUserId: 'omit' });
    let scopedXml = '';
    let scopedExists = false;
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Query') {
        if (taskNameFromArgs(args) === 'botmux-daemon') return commandResult(0, legacyXml);
        return scopedExists ? commandResult(0, scopedXml) : absentTaskResult();
      }
      if (args[0] === '/Create') {
        scopedXml = readFileSync(args[args.indexOf('/XML') + 1]!, 'utf8');
        scopedExists = true;
        return commandResult(0);
      }
      if (args[0] === '/Delete' && taskNameFromArgs(args) === 'botmux-daemon') {
        return commandResult(5, '', 'legacy delete denied');
      }
      if (args[0] === '/Delete' && taskNameFromArgs(args) === windowsScopedTaskName) {
        scopedExists = false;
        return commandResult(0);
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      let error: unknown;
      try {
        enableAutostart(fixture.runtimeOpts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'mutation_failed' });
      expect((error as Error).message).toContain('legacy delete denied');
      expect((error as Error).message).toContain('已回滚 scoped task 并保留 owned legacy task');
      expect(scopedExists).toBe(false);
      expect(existsSync(fixture.launcher)).toBe(false);
      expect(childProcessMocks.spawnSync.mock.calls
        .filter(([, args]) => (args as string[])[0] === '/Delete')
        .map(([, args]) => taskNameFromArgs(args as string[])))
        .toEqual(['botmux-daemon', windowsScopedTaskName]);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('deletes an owned legacy task on disable but leaves foreign names untouched', () => {
    const fixture = windowsRuntimeFixture('botmux-autostart-windows-owned-legacy-disable-');
    const legacyXml = windowsTaskXml({ script: fixture.script, triggerUserId: 'omit' });
    let legacyExists = true;
    mkdirSync(dirname(fixture.script), { recursive: true });
    mkdirSync(dirname(fixture.launcher), { recursive: true });
    writeFileSync(fixture.script, 'remove script');
    writeFileSync(fixture.launcher, 'remove launcher');
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Query') {
        if (taskNameFromArgs(args) === 'botmux-daemon') {
          return legacyExists ? commandResult(0, legacyXml) : absentTaskResult();
        }
        return absentTaskResult();
      }
      if (args[0] === '/Delete' && taskNameFromArgs(args) === 'botmux-daemon') {
        legacyExists = false;
        return commandResult(0);
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      disableAutostart(fixture.runtimeOpts);
      expect(legacyExists).toBe(false);
      expect(existsSync(fixture.script)).toBe(false);
      expect(existsSync(fixture.launcher)).toBe(false);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('returns refresh changed=true when it creates a previously absent scoped task', () => {
    const fixture = windowsRuntimeFixture('botmux-autostart-windows-refresh-create-');
    let scopedXml = '';
    mkdirSync(dirname(fixture.script), { recursive: true });
    writeFileSync(fixture.script, windowsScript({
      nodePath: process.execPath,
      cliPath: fixture.runtimeCli,
      workingDirectory: fixture.runtimeOpts.configDir,
      logDir: fixture.runtimeOpts.logDir,
    }));
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Query') {
        if (taskNameFromArgs(args) === 'botmux-daemon') return absentTaskResult();
        return scopedXml ? commandResult(0, scopedXml) : absentTaskResult();
      }
      if (args[0] === '/Create') {
        scopedXml = readFileSync(args[args.indexOf('/XML') + 1]!, 'utf8');
        return commandResult(0);
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      expect(refreshAutostart(fixture.runtimeOpts)).toBe(true);
      expect(scopedXml).not.toBe('');
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it.each(['present', 'unknown'] as const)(
    'fails closed when owned-legacy cleanup and scoped rollback remain %s',
    rollbackState => {
      const fixture = windowsRuntimeFixture(`botmux-autostart-windows-rollback-${rollbackState}-`);
      const legacyXml = windowsTaskXml({ script: fixture.script, triggerUserId: 'omit' });
      let scopedXml = '';
      childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
        if (command === 'whoami') return whoamiResult();
        if (args[0] === '/Query') {
          const name = taskNameFromArgs(args);
          if (name === 'botmux-daemon') return commandResult(0, legacyXml);
          if (!scopedXml) return absentTaskResult();
          return rollbackState === 'unknown'
            && childProcessMocks.spawnSync.mock.calls.some(([, callArgs]) => (
              (callArgs as string[])[0] === '/Delete'
              && taskNameFromArgs(callArgs as string[]) === windowsScopedTaskName
            ))
            ? commandResult(null, '', 'rollback query timed out')
            : commandResult(0, scopedXml);
        }
        if (args[0] === '/Create') {
          scopedXml = readFileSync(args[args.indexOf('/XML') + 1]!, 'utf8');
          return commandResult(0);
        }
        if (args[0] === '/Delete') return commandResult(5, '', 'delete denied');
        throw new Error(`unexpected command: ${args.join(' ')}`);
      });

      try {
        let error: unknown;
        try {
          enableAutostart(fixture.runtimeOpts);
        } catch (caught) {
          error = caught;
        }
        expect(error).toMatchObject({ code: 'mutation_failed' });
        expect((error as Error).message).toContain('scoped task rollback failure');
        expect(existsSync(fixture.launcher)).toBe(false);
        expect(childProcessMocks.spawnSync.mock.calls
          .filter(([, args]) => (args as string[])[0] === '/Delete')).toHaveLength(2);
        expectNoDaemonLifecycleCalls();
      } finally {
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    },
  );

  it('keeps Windows artifacts when task deletion fails and the task still exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-windows-disable-failure-'));
    const home = join(dir, 'home');
    const appData = join(home, 'AppData', 'Roaming');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const script = join(home, '.botmux', 'autostart.cmd');
    const launcher = join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'botmux-autostart.vbs',
    );
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('APPDATA', appData);
    silenceAutostartOutput();
    mkdirSync(dirname(script), { recursive: true });
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(script, 'keep script');
    writeFileSync(launcher, 'keep launcher');
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Delete') return commandResult(5, '', 'Access denied');
      if (args[0] === '/Query') {
        return taskNameFromArgs(args) === windowsScopedTaskName
          ? commandResult(0, windowsTaskXml({ script }))
          : absentTaskResult();
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      let error: unknown;
      try {
        disableAutostart(runtimeOpts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'mutation_failed' });
      expect(readFileSync(script, 'utf8')).toBe('keep script');
      expect(readFileSync(launcher, 'utf8')).toBe('keep launcher');
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the Windows script when delete fails and the task query is inconclusive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-windows-disable-unknown-'));
    const home = join(dir, 'home');
    const appData = join(home, 'AppData', 'Roaming');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const script = join(home, '.botmux', 'autostart.cmd');
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('APPDATA', appData);
    silenceAutostartOutput();
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, 'keep script');
    let deleteAttempted = false;
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Delete') {
        deleteAttempted = true;
        return commandResult(1);
      }
      if (args[0] === '/Query') {
        if (taskNameFromArgs(args) === 'botmux-daemon') return absentTaskResult();
        return deleteAttempted
          ? commandResult(null, '', 'timed out')
          : commandResult(0, windowsTaskXml({ script }));
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      expect(() => disableAutostart(runtimeOpts)).toThrow(AutostartOperationError);
      expect(readFileSync(script, 'utf8')).toBe('keep script');
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleans Windows artifacts after both task names are authoritatively absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-windows-disable-idempotent-'));
    const home = join(dir, 'home');
    const appData = join(home, 'AppData', 'Roaming');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const script = join(home, '.botmux', 'autostart.cmd');
    const launcher = join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'botmux-autostart.vbs',
    );
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('APPDATA', appData);
    silenceAutostartOutput();
    mkdirSync(dirname(script), { recursive: true });
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(script, 'remove script');
    writeFileSync(launcher, 'remove launcher');
    childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'whoami') return whoamiResult();
      if (args[0] === '/Query') return commandResult(0x80070002);
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      disableAutostart(runtimeOpts);
      expect(existsSync(script)).toBe(false);
      expect(existsSync(launcher)).toBe(false);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed for another-user, SYSTEM, or inconclusive Windows principals', () => {
    const script = '/home/test/.botmux/autostart.cmd';
    const inspectPrincipal = (
      principalUserId: string | 'omit',
      currentSid: string | null = windowsUserSid,
    ) => inspectAutostart(opts, deps({
      platform: 'win32',
      windowsUserSid: currentSid,
      existing: [script],
      files: { [script]: windowsScript() },
      responses: {
        [windowsTaskQueryKey()]: {
          status: 0,
          stdout: windowsTaskXml({ script, principalUserId }),
        },
      },
    }));

    expect(inspectPrincipal('S-1-5-21-9999')).toMatchObject({
      registration: 'partial',
      enabled: null,
    });
    expect(inspectPrincipal('S-1-5-18')).toMatchObject({
      registration: 'partial',
      enabled: null,
    });
    expect(inspectPrincipal('not-a-sid')).toMatchObject({
      registration: 'unknown',
      enabled: null,
    });
    expect(inspectPrincipal('')).toMatchObject({
      registration: 'unknown',
      enabled: null,
    });
    expect(inspectPrincipal('omit')).toMatchObject({
      registration: 'unknown',
      enabled: null,
    });
    expect(inspectPrincipal(windowsUserSid, null)).toMatchObject({
      registration: 'unknown',
      enabled: null,
    });
  });

  it('resolves the runtime Windows SID through a locale-independent injected whoami probe', () => {
    const script = '/home/test/.botmux/autostart.cmd';
    const run = vi.fn((command: string, args: string[]): AutostartProbeResult => {
      if (command === 'schtasks') {
        return taskNameFromArgs(args) === windowsScopedTaskName
          ? { status: 0, stdout: windowsTaskXml({ script }) }
          : { status: 0x80070002 };
      }
      if (command === 'whoami' && args.join('\0') === '/user\0/fo\0csv\0/nh') {
        return { status: 0, stdout: `"TEST\\tester","${windowsUserSid}"\r\n` };
      }
      return { status: null };
    });
    const state = inspectAutostart(opts, {
      platform: 'win32',
      homeDir: '/home/test',
      appData: '/home/test/AppData/Roaming',
      nodePath: node,
      pathValue: 'C:\\Windows\\System32',
      exists: path => [script, cli, node].includes(path),
      targetUsable: path => [cli, node].includes(path),
      readText: path => path === script ? windowsScript() : null,
      run,
    });

    expect(state).toMatchObject({ registration: 'enabled', enabled: true });
    expect(run).toHaveBeenCalledWith('whoami', ['/user', '/fo', 'csv', '/nh']);
  });

  it('requires executable Node on POSIX but not Windows while keeping CLI read-only executable-neutral', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-target-permissions-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const runtimeNode = join(dir, 'runtime', 'node');
    const runtimeCli = join(runtimeOpts.pkgRoot, 'dist', 'cli.js');
    const unit = join(home, '.config', 'systemd', 'user', 'botmux.service');
    const script = join(home, '.botmux', 'autostart.cmd');
    mkdirSync(dirname(runtimeNode), { recursive: true });
    mkdirSync(dirname(runtimeCli), { recursive: true });
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(runtimeNode, 'node');
    writeFileSync(runtimeCli, 'cli');
    writeFileSync(unit, linuxUnit({
      nodePath: runtimeNode,
      cliPath: runtimeCli,
      workingDirectory: runtimeOpts.configDir,
    }));
    chmodSync(runtimeNode, 0o644);
    chmodSync(runtimeCli, 0o644);

    try {
      const linuxState = inspectAutostart(runtimeOpts, {
        platform: 'linux',
        homeDir: home,
        nodePath: runtimeNode,
        username: 'tester',
        run: (command, args) => {
          const key = `${command}\0${args.join('\0')}`;
          const responses: Record<string, AutostartProbeResult> = {
            [`systemctl\0--user\0show-environment`]: { status: 0 },
            [`systemctl\0--user\0is-enabled\0botmux.service`]: { status: 0, stdout: 'enabled\n' },
            [`systemctl\0--user\0is-active\0botmux.service`]: { status: 3, stdout: 'inactive\n' },
            [`loginctl\0show-user\0tester\0--property=Linger`]: { status: 0, stdout: 'Linger=yes\n' },
          };
          return responses[key] ?? { status: null };
        },
      });
      expect(linuxState.targetExists).toBe(false);
      expect(linuxState.warnings).toContain('target_missing');

      chmodSync(runtimeNode, 0o755);
      const executableLinuxState = inspectAutostart(runtimeOpts, {
        platform: 'linux',
        homeDir: home,
        nodePath: runtimeNode,
        username: 'tester',
        run: (command, args) => {
          const key = `${command}\0${args.join('\0')}`;
          if (key === 'systemctl\0--user\0show-environment') return { status: 0 };
          if (key === 'systemctl\0--user\0is-enabled\0botmux.service') {
            return { status: 0, stdout: 'enabled\n' };
          }
          if (key === 'systemctl\0--user\0is-active\0botmux.service') {
            return { status: 3, stdout: 'inactive\n' };
          }
          if (key === 'loginctl\0show-user\0tester\0--property=Linger') {
            return { status: 0, stdout: 'Linger=yes\n' };
          }
          return { status: null };
        },
      });
      expect(executableLinuxState.targetExists).toBe(true);

      chmodSync(runtimeNode, 0o644);
      mkdirSync(dirname(script), { recursive: true });
      writeFileSync(script, windowsScript({
        nodePath: runtimeNode,
        cliPath: runtimeCli,
        workingDirectory: runtimeOpts.configDir,
        logDir: runtimeOpts.logDir,
      }));
      const windowsState = inspectAutostart(runtimeOpts, {
        platform: 'win32',
        homeDir: home,
        nodePath: runtimeNode,
        pathValue: 'C:\\Windows\\System32',
        windowsUserSid,
        run: (_command, args) => taskNameFromArgs(args) === windowsScopedTaskName
          ? { status: 0, stdout: windowsTaskXml({ script }) }
          : { status: 0x80070002 },
      });
      expect(windowsState.targetExists).toBe(true);
      expect(windowsState.registration).toBe('enabled');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps inspect, mutation/no-op, and readback inside one autostart lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-atomic-set-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const runtimeCli = join(runtimeOpts.pkgRoot, 'dist', 'cli.js');
    const plist = join(home, 'Library', 'LaunchAgents', 'com.botmux.daemon.plist');
    const lock = join(runtimeOpts.configDir, '.autostart-state.lock');
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    silenceAutostartOutput();
    mkdirSync(dirname(runtimeCli), { recursive: true });
    writeFileSync(runtimeCli, 'console.log("botmux");\n');
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      expect(existsSync(lock)).toBe(true);
      if (args[0] === 'print') return commandResult(113, '', 'not found');
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      const changed = setAutostartEnabled(runtimeOpts, true);
      expect(changed.changed).toBe(true);
      expect(changed.state).toMatchObject({
        registration: 'enabled',
        enabled: true,
        targetMatchesCurrentRuntime: true,
      });
      expect(existsSync(plist)).toBe(true);
      expect(existsSync(lock)).toBe(false);
      expect(childProcessMocks.spawnSync).toHaveBeenCalledTimes(2);
      expectNoDaemonLifecycleCalls();

      childProcessMocks.spawnSync.mockClear();
      const noOp = setAutostartEnabled(runtimeOpts, true);
      expect(noOp.changed).toBe(false);
      expect(noOp.state.registration).toBe('enabled');
      expect(childProcessMocks.spawnSync).toHaveBeenCalledTimes(2);
      expect(existsSync(lock)).toBe(false);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repairs an enabled stale target and reads back healthy state inside the same lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-atomic-repair-stale-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const runtimeCli = join(runtimeOpts.pkgRoot, 'dist', 'cli.js');
    const plist = join(home, 'Library', 'LaunchAgents', 'com.botmux.daemon.plist');
    const lock = join(runtimeOpts.configDir, '.autostart-state.lock');
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    silenceAutostartOutput();
    mkdirSync(dirname(runtimeCli), { recursive: true });
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(runtimeCli, 'console.log("botmux");\n');
    writeFileSync(plist, macPlist({
      nodePath: '/old/node',
      cliPath: runtimeCli,
      workingDirectory: runtimeOpts.configDir,
      logDir: runtimeOpts.logDir,
    }));

    const stale = inspectAutostart(runtimeOpts, {
      platform: 'darwin',
      homeDir: home,
      nodePath: process.execPath,
      uid: 501,
      run: () => ({ status: 113 }),
    });
    expect(stale).toMatchObject({
      registration: 'enabled',
      enabled: true,
      targetMatchesCurrentRuntime: false,
    });

    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      expect(existsSync(lock)).toBe(true);
      if (args[0] === 'print') return commandResult(113, '', 'not found');
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      const result = setAutostartEnabled(runtimeOpts, true);
      expect(result).toMatchObject({
        changed: true,
        state: {
          registration: 'enabled',
          enabled: true,
          targetMatchesCurrentRuntime: true,
        },
      });
      expect(readFileSync(plist, 'utf8')).toContain(process.execPath);
      expect(readFileSync(plist, 'utf8')).not.toContain('/old/node');
      expect(childProcessMocks.spawnSync).toHaveBeenCalledTimes(2);
      expect(existsSync(lock)).toBe(false);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unavailable runtime target before the atomic mutation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-atomic-target-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout-without-dist'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const plist = join(home, 'Library', 'LaunchAgents', 'com.botmux.daemon.plist');
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    silenceAutostartOutput();
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'print') return commandResult(113, '', 'not found');
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    try {
      expect(() => setAutostartEnabled(runtimeOpts, true)).toThrowError(
        expect.objectContaining({ code: 'target_unavailable' }),
      );
      expect(existsSync(plist)).toBe(false);
      expect(childProcessMocks.spawnSync).toHaveBeenCalledOnce();
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when atomic mutation readback does not converge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-autostart-atomic-mismatch-'));
    const home = join(dir, 'home');
    const runtimeOpts: AutostartOpts = {
      pkgRoot: join(dir, 'checkout'),
      configDir: join(home, '.botmux'),
      logDir: join(home, '.botmux', 'logs'),
    };
    const runtimeCli = join(runtimeOpts.pkgRoot, 'dist', 'cli.js');
    const plist = join(home, 'Library', 'LaunchAgents', 'com.botmux.daemon.plist');
    osMocks.homeDir = home;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    silenceAutostartOutput();
    mkdirSync(dirname(runtimeCli), { recursive: true });
    writeFileSync(runtimeCli, 'console.log("botmux");\n');
    let inspections = 0;
    childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] !== 'print') throw new Error(`unexpected command: ${args.join(' ')}`);
      inspections += 1;
      if (inspections === 2 && existsSync(plist)) rmSync(plist);
      return commandResult(113, '', 'not found');
    });

    try {
      expect(() => setAutostartEnabled(runtimeOpts, true)).toThrowError(
        expect.objectContaining({ code: 'state_mismatch' }),
      );
      expect(inspections).toBe(2);
      expectNoDaemonLifecycleCalls();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
