#!/usr/bin/env node
// 生成 src/cli/terminal-width.ts:终端 cell 宽度表,供 `botmux list` 交互 TUI 的
// 列宽/行宽计算使用。目标不是「匹配某一个终端」,而是一个**跨终端保守上界**:
// 对任何真实终端,本表给出的宽度都 >= 该终端实际绘制的宽度,从而
// 「layoutWidth <= termWidth」能真正推出「物理行不折」——因为过计只会让单元格
// 被多截一点(安全),欠计才会溢出折行(危险,标题被挤出屏幕)。
//
// 宽度=2 的判据(取并集,只增不减):
//   (a) @xterm/addon-unicode11 wcwidth==2(Unicode 11 East-Asian-Width + 当时的 emoji);
//   (b) 固定的 Unicode 16.0 Emoji_Presentation 集(见 emoji-presentation-u16.mjs)——覆盖
//       Unicode 14/15/16 新增 emoji(🫠🩷🫨…),这些在 xterm-11 表里还是 1,但现代本地/SSH
//       终端按 2 画,只锁旧 oracle 会欠计。用固定集(而非运行时 \p{Emoji_Presentation})
//       保证生成结果不随 Node 的 ICU 版本漂移。
// 宽度=0 沿用 xterm-11 的零宽集(控制符、组合记号、ZWJ、VS 选择符…);这些即使个别
// 终端画成别的宽度,过计方向也安全。逐码点求和、不做 grapheme 聚合(与 xterm 一致:
// ZWJ 家庭 = 2+0+2+0+2 = 6;过计对不折行无害)。
//
// 注意:Tab/ESC/C0/C1 等会移动光标的控制符不在宽度表职责内——它们在渲染前由
// cli.ts 的 sanitize 统一清理(不能靠"宽度"表达一个跳到 tab stop 的动作)。
//
// 用法:
//   node scripts/generate-terminal-width.mjs           # 写回 src/cli/terminal-width.ts
//   node scripts/generate-terminal-width.mjs --check    # 只校验现有文件是否最新(CI/测试用)
//
// 防漂移:test/terminal-width-generated.test.ts 会以 --check 语义断言当前
// 依赖(xterm addon + Node Unicode 表)生成的内容与已提交文件一致;任一升级导致
// 宽度变化时该测试转红,重新跑本脚本(无 --check)提交即可。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import xtermHeadless from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
import { EMOJI_PRESENTATION_RANGES_U16 } from './emoji-presentation-u16.mjs';

const { Terminal } = xtermHeadless;
const { Unicode11Addon } = unicode11;
const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'terminal-width.ts');
const MAX_CODEPOINT = 0x10FFFF; // 全 Unicode 码点空间——高位 tag/VS 等也要正确归类

// 用**固定**的 Unicode 16.0 Emoji_Presentation 区间判定,而不是运行时 \p{Emoji_Presentation}
// 正则——后者取决于当前 Node 捆绑的 ICU/Unicode 版本(同为 Node 22,不同 patch 的 ICU 可能不同),
// 会让生成表在不同机器上不一致(CI build 因此红过)。钉死到 U16 保证生成结果处处逐字节相同。
const isEmojiPresentation = cp => {
  const r = EMOJI_PRESENTATION_RANGES_U16;
  let lo = 0;
  let hi = r.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < r[mid * 2]) hi = mid - 1;
    else if (cp > r[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
};

/**
 * 扫出宽度区间。宽度=2 取 xterm-11-wide ∪ Emoji_Presentation(保守上界);
 * 宽度=0 沿用 xterm-11 零宽集。返回互斥的两组 [start,end] 连续区间。
 */
function extractRanges() {
  const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  const svc = term._core?._inputHandler?._unicodeService ?? term._core?.unicodeService;
  if (!svc || typeof svc.wcwidth !== 'function') {
    throw new Error('无法从 @xterm/headless 取到 unicodeService.wcwidth;xterm 内部结构可能已变，需更新本脚本');
  }
  // 每个码点归一到 0/1/2:先看 xterm-11(权威 EAW+零宽),再对 width-1 的 emoji 提到 2。
  const widthOf = cp => {
    const w = svc.wcwidth(cp);
    if (w === 0 || w === 2) return w;
    // w === 1(含 xterm 对未知/负值的兜底):现代 emoji 提为 2。
    return isEmojiPresentation(cp) ? 2 : 1;
  };
  const ranges = targetWidth => {
    const out = [];
    let start = -1;
    for (let cp = 0; cp <= MAX_CODEPOINT; cp++) {
      if (widthOf(cp) === targetWidth) {
        if (start < 0) start = cp;
      } else if (start >= 0) {
        out.push([start, cp - 1]);
        start = -1;
      }
    }
    if (start >= 0) out.push([start, MAX_CODEPOINT]);
    return out;
  };
  return { wide: ranges(2), zero: ranges(0) };
}

const hex = n => '0x' + n.toString(16).toUpperCase().padStart(4, '0');

function emitArray(name, ranges) {
  const flat = ranges.flatMap(([a, b]) => [a, b]);
  const lines = [];
  for (let i = 0; i < flat.length; i += 24) {
    lines.push('  ' + flat.slice(i, i + 24).map(hex).join(', ') + ',');
  }
  return `const ${name}: readonly number[] = [\n${lines.join('\n')}\n];`;
}

function render({ wide, zero }) {
  return `/**
 * Terminal cell-width table for the interactive \`botmux list\` picker.
 *
 * This is a CROSS-TERMINAL CONSERVATIVE UPPER BOUND, not a match for any one
 * terminal: for any real terminal, the width here is >= what that terminal
 * paints. That direction is what makes the picker safe — the vertical viewport
 * assumes one session per physical row, so a cell must never render WIDER than
 * we budgeted (that wraps and pushes the pinned title off the alt-screen).
 * Over-counting only truncates a cell slightly early; under-counting wraps.
 *
 * Width 2 = union of:
 *   - \`@xterm/addon-unicode11\` wcwidth == 2 (Unicode 11 EAW + then-current emoji;
 *     also what the project's own xterm web terminal paints, see src/worker.ts);
 *   - a pinned Unicode 16.0 Emoji_Presentation set (Unicode 14/15/16 emoji like
 *     🫠🩷🫨 that xterm-11 still scores as 1 but modern local/SSH terminals paint
 *     as 2). Pinned (not the running Node's \\p{…}) so the table is identical on
 *     every Node regardless of the ICU/Unicode version it bundles.
 * Width 0 = xterm-11 zero-width set (controls, combining marks, ZWJ, variation
 * selectors). Per-code-point sum, NO grapheme clustering (a ZWJ family emoji is
 * 2+0+2+0+2 = 6) — over-counting there is harmless for the no-wrap invariant.
 *
 * Cursor-moving controls (Tab, ESC, C0/C1) are NOT handled here — width cannot
 * express "jump to next tab stop"; cli.ts sanitizes them out of dynamic text
 * before measuring/printing.
 *
 * Flat sorted [start,end,start,end,...] inclusive ranges over U+0000..U+10FFFF;
 * everything not listed is width 1. DO NOT hand-edit — regenerate with
 * \`node scripts/generate-terminal-width.mjs\` when the xterm addon or Node's
 * Unicode tables bump (test/terminal-width-generated.test.ts guards against drift).
 */

${emitArray('WIDE_RANGES', wide)}

${emitArray('ZERO_WIDTH_RANGES', zero)}

/** True when \`cp\` lies in a flat sorted inclusive range array (binary search). */
function inFlatRanges(ranges: readonly number[], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = ranges[mid * 2];
    const end = ranges[mid * 2 + 1];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Cell width of a single code point under xterm Unicode 11 (0, 1, or 2). */
export function codePointCellWidth(cp: number): 0 | 1 | 2 {
  if (inFlatRanges(ZERO_WIDTH_RANGES, cp)) return 0;
  if (inFlatRanges(WIDE_RANGES, cp)) return 2;
  return 1;
}

/**
 * Display width of a string in terminal cells, matching xterm's
 * \`getStringCellWidth\` (per-code-point sum, no grapheme clustering).
 */
export function terminalCellWidth(str: string): number {
  let width = 0;
  for (const ch of str) width += codePointCellWidth(ch.codePointAt(0)!);
  return width;
}
`;
}

const generated = render(extractRanges());
const check = process.argv.includes('--check');

if (check) {
  let current = '';
  try {
    current = readFileSync(OUT_PATH, 'utf8');
  } catch {
    console.error(`✗ ${OUT_PATH} 不存在;运行 node scripts/generate-terminal-width.mjs 生成`);
    process.exit(1);
  }
  if (current !== generated) {
    console.error('✗ src/cli/terminal-width.ts 与当前 @xterm/addon-unicode11 不一致');
    console.error('  运行 `node scripts/generate-terminal-width.mjs` 重新生成并提交');
    process.exit(1);
  }
  console.log('✓ src/cli/terminal-width.ts 与 @xterm/addon-unicode11 一致');
} else {
  writeFileSync(OUT_PATH, generated);
  console.log(`✓ 已写入 ${OUT_PATH}`);
}
