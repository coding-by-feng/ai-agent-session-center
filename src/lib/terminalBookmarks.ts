/**
 * terminalBookmarks — a phone's bookmarks in a terminal's output (AASC-20).
 *
 * Long-press a line to keep it; the terminal's actions sheet lists them and
 * scrolls back to one. Kept per terminal on this device only (localStorage), the
 * way the desktop's removed bookmark panel was: a bookmark points into one PTY's
 * scrollback and means nothing on another terminal or another device.
 *
 * A buffer line number is not a stable address. The scrollback trims its oldest
 * lines, and a refresh or reattach replays the output, so the same text can sit a
 * few lines from where it was. A bookmark therefore keeps its text as well, and
 * finding it looks for that text, nearest to the old line first.
 *
 * Pure and import-free: the buffer helpers take anything shaped like xterm's
 * `IBuffer`, so they are tested without a terminal.
 */

export interface TerminalBookmark {
  id: string;
  /** Absolute buffer line (xterm `buffer.active` coordinates) when it was taken. */
  line: number;
  /** The whole logical line (wrapped rows joined), trimmed. */
  text: string;
  createdAt: number;
}

/** Enough to come back to a long session's landmarks; the oldest goes first. */
export const MAX_BOOKMARKS = 30;

const STORAGE_PREFIX = 'aasc:term-bookmarks:';

function isBookmark(value: unknown): value is TerminalBookmark {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  return typeof b.id === 'string'
    && typeof b.line === 'number' && Number.isInteger(b.line) && b.line >= 0
    && typeof b.text === 'string' && b.text !== ''
    && typeof b.createdAt === 'number';
}

/** This device's bookmarks for a terminal, newest first. Never throws. */
export function loadBookmarks(terminalId: string): TerminalBookmark[] {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + terminalId);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isBookmark).slice(0, MAX_BOOKMARKS) : [];
  } catch {
    return [];
  }
}

/** Persist a terminal's bookmarks; an empty list removes the key. Never throws. */
export function saveBookmarks(terminalId: string, bookmarks: readonly TerminalBookmark[]): void {
  try {
    if (bookmarks.length === 0) localStorage.removeItem(STORAGE_PREFIX + terminalId);
    else localStorage.setItem(STORAGE_PREFIX + terminalId, JSON.stringify(bookmarks));
  } catch {
    /* private mode or full storage: the bookmark lives until the page reloads */
  }
}

/**
 * A new list with `text` at `line` added first. Bookmarking the same line again
 * moves it to the top instead of adding a twin; past the cap the oldest drops.
 */
export function addBookmark(
  bookmarks: readonly TerminalBookmark[],
  line: number,
  text: string,
  now: number = Date.now(),
): TerminalBookmark[] {
  const trimmed = text.trim();
  if (!trimmed) return [...bookmarks];
  const rest = bookmarks.filter((b) => !(b.line === line && b.text === trimmed));
  const added: TerminalBookmark = { id: `${now.toString(36)}-${line}`, line, text: trimmed, createdAt: now };
  return [added, ...rest].slice(0, MAX_BOOKMARKS);
}

export function removeBookmark(bookmarks: readonly TerminalBookmark[], id: string): TerminalBookmark[] {
  return bookmarks.filter((b) => b.id !== id);
}

/** One line for a list row or a toast: whitespace collapsed, cut with an ellipsis. */
export function bookmarkLabel(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---------------------------------------------------------------------------
// Reading xterm's buffer
// ---------------------------------------------------------------------------

/** The parts of xterm's `IBufferLine` used here. */
export interface BufferLineLike {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

/** The parts of xterm's `IBuffer` used here. */
export interface BufferLike {
  readonly length: number;
  getLine(y: number): BufferLineLike | undefined;
}

/**
 * The viewport row (0-based) at `offsetY` px below the top of the rendered
 * screen, or null when the point is outside the rows.
 */
export function rowAtOffset(offsetY: number, screenHeight: number, rows: number): number | null {
  if (rows <= 0 || screenHeight <= 0 || offsetY < 0 || offsetY >= screenHeight) return null;
  return Math.min(rows - 1, Math.floor(offsetY / (screenHeight / rows)));
}

/**
 * The logical line through buffer row `y`: a long line soft-wrapped over several
 * rows is one line, addressed by its first row. Null for a blank line or a row
 * outside the buffer.
 */
export function logicalLineAt(buffer: BufferLike, y: number): { line: number; text: string } | null {
  if (y < 0 || y >= buffer.length || !buffer.getLine(y)) return null;
  let start = y;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  let text = buffer.getLine(start)?.translateToString(true) ?? '';
  for (let next = start + 1; next < buffer.length; next++) {
    const row = buffer.getLine(next);
    if (!row?.isWrapped) break;
    text += row.translateToString(true);
  }
  const trimmed = text.trim();
  return trimmed ? { line: start, text: trimmed } : null;
}

/**
 * Where a bookmark's text is now: its old line when the text is still there,
 * else the nearest line carrying the same text, else null (trimmed away, or the
 * output was cleared).
 */
export function locateBookmark(buffer: BufferLike, bookmark: Pick<TerminalBookmark, 'line' | 'text'>): number | null {
  const found = (y: number): number | null => {
    const hit = logicalLineAt(buffer, y);
    return hit && hit.text === bookmark.text ? hit.line : null;
  };
  const here = found(bookmark.line);
  if (here !== null) return here;
  const reach = Math.max(bookmark.line, buffer.length - bookmark.line);
  for (let d = 1; d <= reach; d++) {
    // Output trims from the top, so the line usually moved UP: look there first.
    const hit = found(bookmark.line - d) ?? found(bookmark.line + d);
    if (hit !== null) return hit;
  }
  return null;
}
