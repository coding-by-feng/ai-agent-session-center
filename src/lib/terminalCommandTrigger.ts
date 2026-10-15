/**
 * The `/` command list in a session's terminal: which keystrokes open it, what
 * the user has typed since, what to write when they pick an entry, and where it
 * goes on screen.
 *
 * xterm only ever sees keystrokes, never the CLI's input line, so the token is
 * rebuilt from what is typed. The one thing read from the screen is the caret's
 * surroundings: both Claude Code and Codex park the hardware cursor on their
 * caret (checked in tmux, Oct 2026), so the cell left of it is the character
 * the `/` follows — once the echo has landed. A quick `space /` beats the echo
 * (output is painted once per frame), so the character typed just before wins
 * over the screen for ECHO_GRACE_MS.
 *
 * Both CLIs already list commands when `/` is the FIRST character of the input
 * (the line left of the caret is just their prompt glyph). Mid-prompt, Claude
 * shows a single ghost completion (`/tel` → `eport +4`) and Codex nothing; that
 * gap is what this list fills, so it stays shut where the CLI's own list opens.
 */

/** What the user has typed after the `/` (the slash itself is implied). */
export interface TerminalToken {
  query: string;
}

/** The caret's surroundings at the moment a key is typed (before the echo). */
export interface CaretContext {
  /** The character in the cell left of the caret; '' at column 0 or an empty cell. */
  charBefore: string;
  /** The caret row's text left of the caret. */
  lineBefore: string;
}

/**
 * The row is the input's first line with nothing typed before the caret:
 * Claude draws `❯ `, Codex `› ` (older Claude builds `> `). The CLI opens its
 * own list here.
 */
const CLI_OWN_MENU_RE = /^\s*[❯›>]\s*$/;

/** Printable text with no whitespace or control characters (escape sequences start with ESC). */
function isPrintableWord(data: string): boolean {
  if (!data || /\s/.test(data)) return false;
  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** How long the last typed character outranks the screen (its echo may not be painted yet). */
export const ECHO_GRACE_MS = 1000;

/**
 * Does this keystroke start a token? `lastTyped` is the character typed just
 * before it, while within ECHO_GRACE_MS; null when unknown (none, too old, or
 * the caret moved: an arrow, a paste, a Backspace).
 */
export function startsToken(data: string, caret: CaretContext, lastTyped: string | null = null): boolean {
  if (data !== '/') return false;
  // Just submitted (or a new line): a fresh input, where the CLI lists itself.
  if (lastTyped === '\r') return false;
  if (lastTyped !== null) {
    if (!/\s/.test(lastTyped)) return false;
  } else if (caret.charBefore !== '' && !/\s/.test(caret.charBefore)) {
    return false;
  }
  return !CLI_OWN_MENU_RE.test(caret.lineBefore);
}

/**
 * What `lastTyped` becomes after a chunk of input: its last character for typed
 * text or Enter, null when the caret may have moved (escape sequences such as
 * arrows, Backspace) — then the screen decides again.
 */
export function lastTypedAfter(data: string): string | null {
  if (!data || data.startsWith('\x1b') || data === '\x7f' || data === '\b') return null;
  return data[data.length - 1];
}

/**
 * The token after one more chunk of input, or null when that chunk ends it:
 * whitespace, Enter, an arrow or other escape sequence, a paste holding a
 * space, or a Backspace that deletes the `/` itself.
 */
export function advanceToken(token: TerminalToken, data: string): TerminalToken | null {
  if (data === '\x7f' || data === '\b') {
    return token.query ? { query: token.query.slice(0, -1) } : null;
  }
  if (isPrintableWord(data)) return { query: token.query + data };
  return null;
}

/** The token as it stands in the CLI's input. */
export function typedText(token: TerminalToken): string {
  return '/' + token.query;
}

/**
 * The keystrokes that turn the typed token into `insert` plus a trailing
 * space. Matching is not prefix-only (`filterAndGroup` also matches inside a
 * name and on abbreviations), so when the pick does not start with what was
 * typed, the typed text is erased first.
 */
export function completionKeys(token: TerminalToken, insert: string): string {
  const typed = typedText(token);
  if (insert.startsWith(typed)) return insert.slice(typed.length) + ' ';
  return '\x7f'.repeat(typed.length) + insert + ' ';
}

/** The caret cell in viewport coordinates. */
export interface CaretRect {
  left: number;
  top: number;
  bottom: number;
}

export interface MenuPlacement {
  left: number;
  width: number;
  maxHeight: number;
  /** Exactly one of top / bottom is set. */
  top?: number;
  bottom?: number;
}

export const MENU_VIEWPORT_MARGIN = 8;
export const MENU_MAX_WIDTH = 560;
export const MENU_MIN_WIDTH = 240;
/** Above the caret needs this much room (about eight rows); the CLI draws its own hints below the input. */
const MENU_MIN_ABOVE = 280;
const MENU_GAP = 4;

/**
 * Where the list goes: above the `/` when there is room (both CLIs draw under
 * their input), else below; left edge at the `/`, clamped inside the viewport
 * with an 8px margin. `slash` is the cell the `/` was typed into — the caret
 * at that keystroke, before its echo moved it on.
 */
export function placeMenuAtCaret(
  slash: CaretRect,
  viewport: { width: number; height: number },
): MenuPlacement {
  const m = MENU_VIEWPORT_MARGIN;
  const width = Math.max(
    Math.min(MENU_MIN_WIDTH, viewport.width - 2 * m),
    Math.min(MENU_MAX_WIDTH, viewport.width - 2 * m),
  );
  const left = Math.min(Math.max(slash.left, m), Math.max(m, viewport.width - width - m));
  const spaceAbove = slash.top - MENU_GAP - m;
  const spaceBelow = viewport.height - slash.bottom - MENU_GAP - m;
  const above = spaceAbove >= MENU_MIN_ABOVE || spaceAbove >= spaceBelow;
  const room = Math.max(0, above ? spaceAbove : spaceBelow);
  const maxHeight = Math.min(viewport.height * 0.5, room);
  return above
    ? { left, width, maxHeight, bottom: viewport.height - slash.top + MENU_GAP }
    : { left, width, maxHeight, top: slash.bottom + MENU_GAP };
}
