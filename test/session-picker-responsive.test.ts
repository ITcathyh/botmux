import * as pty from 'node-pty';
import xtermHeadless from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const { Terminal } = xtermHeadless;
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(TEST_DIR, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];
const children: pty.IPty[] = [];

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch { /* already exited */ }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Build the xterm buffer the same way the project's own web terminal does
// (src/worker.ts loads Unicode11Addon + activeVersion='11'). A bare xterm scores
// emoji as one cell and would NOT reproduce emoji wrapping — this addon makes the
// headless terminal count 🤖/🎉 as two cells, exactly as a real terminal paints.
function makeTerminal(cols: number): InstanceType<typeof Terminal> {
  const terminal = new Terminal({ cols, rows: 24, allowProposedApi: true });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  return terminal;
}

function makeFixture(multiBot: boolean, titleFor?: (index: number) => string): { root: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'botmux-picker-responsive-'));
  tempDirs.push(root);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });

  if (multiBot) {
    const configDir = join(root, '.botmux');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'bots.json'), JSON.stringify([
      { larkAppId: 'cli_test_a', cliId: 'codex' },
      { larkAppId: 'cli_test_b', cliId: 'claude-code' },
    ]));
  }

  const sessions: Record<string, object> = {};
  for (let i = 0; i < 48; i++) {
    const n = String(i + 1).padStart(2, '0');
    const sessionId = `${n}000000-1111-2222-3333-444444444444`;
    sessions[sessionId] = {
      sessionId,
      chatId: 'oc_picker_test',
      rootMessageId: `om_${n}`,
      title: titleFor ? titleFor(i) : `session-${n}`,
      workingDir: '/workspace/botmux',
      status: 'active',
      createdAt: new Date(Date.UTC(2026, 7, 6, 0, 0, i)).toISOString(),
      cliId: 'codex',
      backendType: 'pty',
      pid: process.pid,
    };
  }
  writeFileSync(join(dataDir, 'sessions.json'), JSON.stringify(sessions));
  return { root, dataDir };
}

async function spawnPicker(cols: number, multiBot: boolean, titleFor?: (index: number) => string): Promise<{
  child: pty.IPty;
  terminal: InstanceType<typeof Terminal>;
  renderCount: () => number;
  waitForRender: (minimum: number) => Promise<void>;
}> {
  const fixture = makeFixture(multiBot, titleFor);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: fixture.root,
    SESSION_DATA_DIR: fixture.dataDir,
    TERM: 'xterm-256color',
  };
  for (const key of [
    'BOTMUX_SESSION_ID',
    'BOTMUX_LARK_APP_ID',
    'BOTMUX_SEND_RELAY',
    'BOTMUX_DAEMON_IPC_PORT',
  ]) delete env[key];

  const child = pty.spawn(process.execPath, ['--import', 'tsx', CLI_PATH, 'list'], {
    cwd: join(TEST_DIR, '..'),
    env,
    cols,
    rows: 24,
    name: 'xterm-256color',
  });
  children.push(child);
  const terminal = makeTerminal(cols);
  let raw = '';
  let writes = Promise.resolve();
  child.onData(data => {
    raw += data;
    writes = writes.then(() => new Promise<void>(resolve => terminal.write(data, resolve)));
  });

  const renderCount = () => raw.split('botmux sessions').length - 1;
  const waitForRender = async (minimum: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (renderCount() < minimum && Date.now() < deadline) await delay(20);
    expect(renderCount()).toBeGreaterThanOrEqual(minimum);
    await delay(60);
    await writes;
  };
  await waitForRender(1);
  return { child, terminal, renderCount, waitForRender };
}

function inspectScreen(terminal: InstanceType<typeof Terminal>): {
  lines: string[];
  wrappedRows: number[];
} {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  const wrappedRows: number[] = [];
  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(y);
    lines.push((line?.translateToString(true) ?? '').trimEnd());
    if (line?.isWrapped) wrappedRows.push(y);
  }
  return { lines, wrappedRows };
}

async function closePicker(child: pty.IPty, terminal: InstanceType<typeof Terminal>): Promise<void> {
  child.write('q');
  await delay(50);
  terminal.dispose();
  const idx = children.indexOf(child);
  if (idx >= 0) children.splice(idx, 1);
}

describe('session picker real terminal responsiveness', () => {
  it('rebuilds horizontal layout when a wide terminal shrinks', async () => {
    const picker = await spawnPicker(180, false);
    const beforeResize = picker.renderCount();
    picker.terminal.resize(100, 24);
    picker.child.resize(100, 24);
    await picker.waitForRender(beforeResize + 1);

    const screen = inspectScreen(picker.terminal);
    expect(screen.lines[0]).toContain('botmux sessions  (1/48)');
    expect(screen.lines.some(line => line.includes('❯') && line.includes('48000000'))).toBe(true);
    expect(screen.lines).toContainEqual(expect.stringContaining('↓ 37 更多'));
    expect(screen.wrappedRows).toEqual([]);
    await closePicker(picker.child, picker.terminal);
  });

  it('keeps the title pinned when a single-bot picker starts at 99 columns', async () => {
    const picker = await spawnPicker(99, false);
    const screen = inspectScreen(picker.terminal);
    expect(screen.lines[0]).toContain('botmux sessions  (1/48)');
    expect(screen.lines.some(line => line.includes('❯') && line.includes('48000000'))).toBe(true);
    expect(screen.wrappedRows).toEqual([]);
    await closePicker(picker.child, picker.terminal);
  });

  it('keeps the title pinned when a multi-bot picker starts at 120 columns', async () => {
    const picker = await spawnPicker(120, true);
    const screen = inspectScreen(picker.terminal);
    expect(screen.lines[0]).toContain('botmux sessions  (1/48)');
    expect(screen.lines.some(line => line.includes('❯') && line.includes('48000000'))).toBe(true);
    expect(screen.wrappedRows).toEqual([]);
    await closePicker(picker.child, picker.terminal);
  });

  it('does not wrap when every session title is emoji-heavy', async () => {
    // Regression for the Unicode-width gap: session titles routinely carry emoji
    // (Lark topic names), and a real terminal paints each emoji two cells wide.
    // If column math scores them as one cell, the row overflows, wraps onto a
    // second physical line and the vertical viewport's one-row-per-session
    // accounting breaks — pushing the pinned title back off the alt-screen.
    const picker = await spawnPicker(99, false, i => `🤖🎉🚀 session ${i + 1} 部署✅ 🔥🔥🔥`);
    const screen = inspectScreen(picker.terminal);
    expect(screen.lines[0]).toContain('botmux sessions  (1/48)');
    expect(screen.lines.some(line => line.includes('❯'))).toBe(true);
    expect(screen.wrappedRows).toEqual([]);
    await closePicker(picker.child, picker.terminal);
  });
});
