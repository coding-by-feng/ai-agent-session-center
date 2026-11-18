/**
 * readerMode — the desktop terminal's Reader toggle, remembered per session.
 *
 * Reader shows the session's transcript as formatted Markdown (the phone Chat's
 * rows) over the terminal; the terminal itself stays mounted and laid out under it.
 */
const KEY_PREFIX = 'aasc.terminalReader.';

export function readReaderMode(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  try {
    return localStorage.getItem(KEY_PREFIX + sessionId) === '1';
  } catch {
    return false;
  }
}

export function writeReaderMode(sessionId: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY_PREFIX + sessionId, '1');
    else localStorage.removeItem(KEY_PREFIX + sessionId);
  } catch {
    // Storage full or blocked: the toggle still works for this view.
  }
}

/** On <body> while any Reader is open: the kit's portaled sheets and menus get the --ph-* tokens. */
export const READER_BODY_CLASS = 'aasc-reader-tokens';

interface TypeThroughEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  currentTarget: EventTarget | null;
  nativeEvent?: { isComposing?: boolean };
}

/**
 * Reader type-through (Nov 18 2026): a plain character typed on the chat itself (the reader
 * has focus, not the composer or a button) goes back to the terminal, typed there.
 * Shortcuts, Space (scroll), arrows and IME composition stay in Reader.
 */
export function isTypeThrough(e: TypeThroughEvent): boolean {
  if (e.target !== e.currentTarget) return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent?.isComposing) return false;
  return e.key.length === 1 && e.key !== ' ';
}
