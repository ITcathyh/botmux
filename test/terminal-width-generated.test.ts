import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { codePointCellWidth, terminalCellWidth } from '../src/cli/terminal-width.js';

const { Terminal } = xtermHeadless;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * src/cli/terminal-width.ts is a generated artifact (scripts/generate-terminal-width.mjs
 * sweeps @xterm/addon-unicode11's wcwidth). These tests prove two things:
 *   1. the committed file is exactly what the generator produces from the CURRENTLY
 *      installed addon — so a future xterm upgrade that shifts widths turns this red
 *      (regenerate + commit to fix), preventing silent drift;
 *   2. terminalCellWidth matches xterm's own getStringCellWidth per-code-point, which
 *      is the property the picker relies on to keep one session per physical row.
 */
describe('terminal-width generated table', () => {
  it('is up to date with the installed @xterm/addon-unicode11 (no drift)', () => {
    // Throws (non-zero exit) if the committed file differs from a fresh generation.
    expect(() =>
      execFileSync('node', ['scripts/generate-terminal-width.mjs', '--check'], { cwd: ROOT }),
    ).not.toThrow();
  });

  it('matches xterm getStringCellWidth for every code point and mixed strings', () => {
    const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const core = term as unknown as { _core?: any };
    const svc = core._core?._inputHandler?._unicodeService ?? core._core?.unicodeService;
    expect(typeof svc?.wcwidth).toBe('function');

    // Per-code-point parity across BMP + emoji planes.
    for (let cp = 0; cp <= 0x40000; cp++) {
      expect(codePointCellWidth(cp)).toBe(svc.wcwidth(cp));
    }

    // String parity, including the multi-code-point cases the picker must not wrap on.
    for (const s of [
      'A', '你好世界', '🤖', '🎉🚀✅', '👨‍👩‍👧', '🇺🇸',
      'é', 'á', '👍🏽', '⚡️', '☃️', 'session-42 🤖 部署', '│ ─ ❯ ↑ ↓',
    ]) {
      expect(terminalCellWidth(s)).toBe(svc.getStringCellWidth(s));
    }
  });
});
