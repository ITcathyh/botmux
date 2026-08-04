export interface CodexComposerInputState {
  viewport: string;
  cursor: { x: number; y: number };
}

export type CodexComposerState = 'empty' | 'draft' | 'unknown';

/**
 * Infer whether the cursor is inside a non-empty Codex composer.
 *
 * Codex leaves the cursor immediately after the `› ` marker while its empty
 * placeholder is visible. A real single-line draft moves the cursor to the
 * right; a multi-line draft moves it below the marker row. This lets botmux
 * distinguish the placeholder from user-authored text without depending on
 * the placeholder copy, color, or locale.
 */
export function detectCodexComposerState(
  input: CodexComposerInputState | null | undefined,
): CodexComposerState {
  if (!input) return 'unknown';
  const { cursor } = input;
  if (!Number.isInteger(cursor.x) || !Number.isInteger(cursor.y) || cursor.x < 0 || cursor.y < 0) {
    return 'unknown';
  }

  const lines = input.viewport.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (cursor.y >= lines.length) return 'unknown';

  // Codex keeps the composer compact. Limit the backward scan so an old user
  // prompt higher in the viewport cannot be mistaken for the live composer.
  const firstCandidateRow = Math.max(0, cursor.y - 12);
  for (let row = cursor.y; row >= firstCandidateRow; row -= 1) {
    const line = lines[row] ?? '';
    const marker = /^(\s*)›/.exec(line);
    if (!marker) continue;

    if (row < cursor.y) return 'draft';
    const emptyCursorX = marker[1]!.length + 2; // visible `› ` prefix
    return cursor.x > emptyCursorX ? 'draft' : 'empty';
  }

  return 'unknown';
}
