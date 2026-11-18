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

/** Where a clicked file-path link points, in the terms the `/api/files/*` routes take: a root and a path under it. */
export interface LinkTarget {
  projectPath: string;
  filePath: string;
  /**
   * Set when the path is absolute and outside the session's folder: the session (by its folder) that clicked it.
   * `projectPath` is then the file's own folder, so the routes, which read every path as relative to the root,
   * find it; "Open in app" opens a PROJECT sub-tab there (ProjectTabContainer).
   */
  hostProjectPath?: string;
  /** A folder (Nov 18 2026): rooted at itself (`filePath` "/"), opened as a PROJECT sub-tab of the host. */
  kind?: 'dir';
}

/**
 * Turn a printed path into a LinkTarget (Nov 17 2026). The routes strip a leading `/` and resolve under the
 * root, so an absolute path sent as-is (`/Users/…/x.md` → `<root>/Users/…/x.md`) found nothing, and all three
 * chooser actions failed without a word.
 *   relative               → unchanged (minus a leading `./`), under the session folder
 *   absolute, inside root  → made relative to it
 *   absolute, outside root → rooted at the file's own folder, with `hostProjectPath` = the session folder
 */
export function linkTarget(path: string, sessionRoot: string): LinkTarget {
  const clean = path.replace(/^\.\//, '');
  if (!clean.startsWith('/')) return { projectPath: sessionRoot, filePath: clean };
  const root = sessionRoot.replace(/\/+$/, '');
  if (root && clean.startsWith(`${root}/`)) return { projectPath: sessionRoot, filePath: clean.slice(root.length + 1) };
  const cut = clean.lastIndexOf('/');
  return { projectPath: clean.slice(0, cut) || '/', filePath: clean.slice(cut + 1), hostProjectPath: sessionRoot };
}

/**
 * Where a folder link points (Nov 18 2026): the folder is its own root, wherever it lies, so the
 * PROJECT tab opens a sub-tab at it and "Reveal" / "Open with default app" act on the folder.
 */
export function dirLinkTarget(absoluteDir: string, sessionRoot: string): LinkTarget {
  return { projectPath: absoluteDir.length > 1 ? absoluteDir.replace(/\/+$/, '') : absoluteDir, filePath: '/', hostProjectPath: sessionRoot, kind: 'dir' };
}

/** The target for a path the Mac confirmed (fileRefResolve): a file through `linkTarget`, a folder through `dirLinkTarget`. */
export function resolvedLinkTarget(ref: { kind: 'file' | 'dir'; absolute: string }, sessionRoot: string): LinkTarget {
  return ref.kind === 'dir' ? dirLinkTarget(ref.absolute, sessionRoot) : linkTarget(ref.absolute, sessionRoot);
}
