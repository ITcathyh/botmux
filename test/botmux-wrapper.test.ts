import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { prependBotmuxBin, botmuxWrapperFiles, resolveBotmuxWrapperBinDir, botmuxWrapperPathExportSh } from '../src/core/botmux-wrapper.js';

describe('resolveBotmuxWrapperBinDir — single source of truth (core-only isolation)', () => {
  it('core-only → dedicated <SESSION_DATA_DIR>/bin (never shared ~/.botmux/bin)', () => {
    expect(resolveBotmuxWrapperBinDir({ BOTMUX_CORE_ONLY: '1', SESSION_DATA_DIR: '/srv/co/data', HOME: '/home/u' }))
      .toBe('/srv/co/data/bin');
  });
  it('normal fleet → shared ~/.botmux/bin', () => {
    expect(resolveBotmuxWrapperBinDir({ HOME: '/home/u' })).toBe('/home/u/.botmux/bin');
  });
  it('core-only WITHOUT SESSION_DATA_DIR falls back to shared (defensive; entrypoint always sets it)', () => {
    expect(resolveBotmuxWrapperBinDir({ BOTMUX_CORE_ONLY: '1', HOME: '/home/u' })).toBe('/home/u/.botmux/bin');
  });

  it('shell snippet resolves the SAME dir at pane-script runtime (real /bin/sh)', () => {
    const snippet = botmuxWrapperPathExportSh();
    const run = (env: Record<string, string>) =>
      execFileSync('/bin/sh', ['-c', `${snippet}; printf %s "$PATH"`], { env, encoding: 'utf8' });
    // core-only: dedicated dir wins the prepend
    expect(run({ BOTMUX_CORE_ONLY: '1', SESSION_DATA_DIR: '/srv/co/data', HOME: '/home/u', PATH: '/usr/bin' }))
      .toBe('/srv/co/data/bin:/usr/bin');
    // normal: shared dir
    expect(run({ HOME: '/home/u', PATH: '/usr/bin' })).toBe('/home/u/.botmux/bin:/usr/bin');
    // a HOSTILE shared wrapper dir is NOT prepended in core-only (its PATH position
    // is behind the dedicated dir → `command -v` would resolve dedicated first).
    const coreOnlyPath = run({ BOTMUX_CORE_ONLY: '1', SESSION_DATA_DIR: '/srv/co/data', HOME: '/home/u', PATH: '/home/u/.botmux/bin:/usr/bin' });
    expect(coreOnlyPath.startsWith('/srv/co/data/bin:')).toBe(true);
  });
});

describe('prependBotmuxBin', () => {
  it('uses : on POSIX', () => {
    expect(prependBotmuxBin('/home/u/.botmux/bin', '/usr/bin:/bin', ':'))
      .toBe('/home/u/.botmux/bin:/usr/bin:/bin');
  });

  it('uses ; on Windows', () => {
    expect(prependBotmuxBin(
      String.raw`C:\Users\First Last\.botmux\bin`,
      String.raw`C:\Windows\System32;C:\Windows`,
      ';',
    )).toBe(String.raw`C:\Users\First Last\.botmux\bin;C:\Windows\System32;C:\Windows`);
  });

  it('tolerates an empty/undefined current PATH', () => {
    expect(prependBotmuxBin('/bin/dir', undefined, ':')).toBe('/bin/dir:');
    expect(prependBotmuxBin('/bin/dir', '', ':')).toBe('/bin/dir:');
  });
});

describe('botmuxWrapperFiles', () => {
  const cli = String.raw`C:\Users\First Last\AppData\Roaming\npm\node_modules\botmux\dist\cli.js`;
  const node = String.raw`C:\Program Files\nodejs\node.exe`;

  it('writes only the sh wrapper on POSIX', () => {
    const files = botmuxWrapperFiles('/opt/botmux/dist/cli.js', '/usr/bin/node', 'linux');
    expect(files.map(f => f.name)).toEqual(['botmux']);
    expect(files[0].content).toBe('#!/bin/sh\nexec node "/opt/botmux/dist/cli.js" "$@"\n');
    expect(files[0].mode).toBe(0o755);
  });

  it('adds a quoted botmux.cmd pinning the current node on Windows', () => {
    const files = botmuxWrapperFiles(cli, node, 'win32');
    expect(files.map(f => f.name)).toEqual(['botmux', 'botmux.cmd']);
    const cmd = files.find(f => f.name === 'botmux.cmd')!;
    // Quoted node + cli so spaced paths survive; CRLF + %* forward all args.
    expect(cmd.content).toBe(`@echo off\r\n"${node}" "${cli}" %*\r\n`);
  });
});
