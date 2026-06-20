/**
 * filePathLink — shared file-path detection for clickable links.
 *
 * Used by the conversation/notes renderer (LinkifiedText) and the xterm
 * terminal link provider (useTerminal) so both stay in sync. The pattern is
 * Unicode-aware: non-ASCII path segments (CJK, Cyrillic, accented Latin, …) are
 * matched, e.g. `coupon-redeem/docs/客户版-业务流程确认.md`.
 *
 * A path segment may contain any Unicode letter / number / combining mark plus
 * the ASCII path-safe punctuation `@ . + _ -`. The file extension stays ASCII
 * (`\w`) on purpose: real extensions are ASCII, and keeping it ASCII stops the
 * match from greedily swallowing CJK text that immediately follows a filename
 * with no separating space (e.g. `客户版.md文件` → `客户版.md`).
 */

// One Unicode letter/number/mark or path-safe punctuation. The `-` is last so it
// is a literal, not a range; `\p{…}` requires the `u` flag (see below).
const SEGMENT = '[\\p{L}\\p{N}\\p{M}@.+_-]+';

// Optional ./ or ../ prefix, one or more `segment/` directories, a final
// `segment.ext`. At least one slash is required (matches the original behaviour
// — bare `word.doc` in prose is not treated as a path).
const FILE_PATH_SOURCE = `(?:\\.{0,2}/)?(?:${SEGMENT}/)+${SEGMENT}\\.[\\w]+`;

/**
 * A fresh global, Unicode-aware file-path regex. Returns a new instance every
 * call because the `g` flag carries mutable `lastIndex` state — never share one
 * across concurrent scans.
 */
export function createFilePathRegex(): RegExp {
  return new RegExp(FILE_PATH_SOURCE, 'gu');
}

/** Minimal structural shape of an xterm buffer cell (`IBufferCell`). */
export interface FilePathCell {
  getChars(): string;
  getWidth(): number;
}

/** Minimal structural shape of an xterm buffer line (`IBufferLine`). */
export interface FilePathBufferLine {
  readonly length: number;
  getCell(x: number): FilePathCell | undefined;
}

/**
 * Rebuild a terminal line's string together with a per-code-unit map back to
 * terminal columns.
 *
 * xterm renders wide (double-width / CJK) characters across two cells: the
 * character cell (width 2) followed by a zero-width placeholder. The string from
 * `translateToString` collapses that to a single code unit, so `match.index`
 * and `string.length` no longer equal column positions on any line containing
 * CJK — making `match.index + 1` arithmetic mis-locate links. Walking the cells
 * directly yields the true start/end column for every code unit.
 *
 * - `text` mirrors `line.translateToString(false)`: each cell contributes its
 *   `getChars()` content (usually one code point, but combining / ZWJ sequences
 *   may be several), wide-char placeholder cells are skipped, and empty cells
 *   render as a space.
 * - `startCol[i]` / `endCol[i]` are the 0-indexed first / last terminal columns
 *   occupied by the cell holding the character at string code-unit offset `i`.
 */
export function mapLineColumns(line: FilePathBufferLine): {
  text: string;
  startCol: number[];
  endCol: number[];
} {
  let text = '';
  const startCol: number[] = [];
  const endCol: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) continue;
    const width = cell.getWidth();
    if (width === 0) continue; // trailing placeholder half of a wide char
    const chars = cell.getChars() || ' '; // empty cell → space (matches xterm)
    const last = x + Math.max(width, 1) - 1;
    for (let k = 0; k < chars.length; k++) {
      startCol.push(x);
      endCol.push(last);
    }
    text += chars;
  }
  return { text, startCol, endCol };
}
