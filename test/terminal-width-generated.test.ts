import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { codePointCellWidth, terminalCellWidth } from '../src/cli/terminal-width.js';

const { Terminal } = xtermHeadless;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;

/**
 * src/cli/terminal-width.ts is a generated artifact (scripts/generate-terminal-width.mjs
 * sweeps @xterm/addon-unicode11's wcwidth ∪ Node's \p{Emoji_Presentation}). The table
 * is a CROSS-TERMINAL CONSERVATIVE UPPER BOUND, not a match for one terminal: the
 * picker must never UNDER-count (that wraps a row and hides the pinned title), while
 * over-counting only truncates a cell slightly early. These tests pin that contract.
 */
describe('terminal-width generated table', () => {
  it('is up to date with the installed deps (no drift)', () => {
    // Throws (non-zero exit) if the committed file differs from a fresh generation.
    expect(() =>
      execFileSync('node', ['scripts/generate-terminal-width.mjs', '--check'], { cwd: ROOT }),
    ).not.toThrow();
  });

  it('never under-counts vs the project xterm Unicode-11 terminal', () => {
    const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const core = term as unknown as { _core?: any };
    const svc = core._core?._inputHandler?._unicodeService ?? core._core?.unicodeService;
    expect(typeof svc?.wcwidth).toBe('function');

    // Upper-bound contract: our width >= what xterm-11 paints, for every code point.
    // (Zero-width and wide code points must match; width-1 code points may be lifted
    // to 2 for modern emoji — never dropped below xterm.)
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      expect(codePointCellWidth(cp)).toBeGreaterThanOrEqual(svc.wcwidth(cp));
    }
  });

  it('counts modern (Unicode 14+) emoji as two cells that xterm-11 still scores as one', () => {
    // These wrap the picker on any terminal that renders current emoji two cells
    // wide; xterm-11 under-counts them, so the union with Emoji_Presentation matters.
    for (const e of ['🫠', '🩷', '🫨', '🪿', '🫎', '🪼']) {
      expect(EMOJI_PRESENTATION.test(e)).toBe(true);
      expect(terminalCellWidth(e)).toBe(2);
    }
    // Classic wide emoji + CJK stay 2; text-presentation symbols stay 1.
    for (const two of ['🤖', '🎉', '你', '（']) expect(terminalCellWidth(two)).toBe(2);
    for (const one of ['A', '©', '®', '™', '★', '①', '—']) expect(terminalCellWidth(one)).toBe(1);
  });

  it('keeps combining marks / ZWJ / variation selectors zero width (per-code-point sum)', () => {
    expect(codePointCellWidth(0x200d)).toBe(0); // ZWJ
    expect(codePointCellWidth(0xfe0f)).toBe(0); // VS16
    expect(codePointCellWidth(0x0301)).toBe(0); // combining acute
    // No grapheme clustering: a ZWJ family emoji sums its parts (2+0+2+0+2 = 6),
    // which over-counts vs a single glyph — safe for the no-wrap invariant.
    expect(terminalCellWidth('👨‍👩‍👧')).toBe(6);
  });
});
