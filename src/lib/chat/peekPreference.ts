/**
 * peekPreference.ts — does this phone show the terminal's last lines while the agent
 * works? Hidden unless asked for (Oct 19 2026: the strip, the lines and the composer's
 * chips took ~180pt of a phone screen), and the phone remembers. Per device, so storage
 * that throws or is empty reads as hidden.
 *
 * Nov 13 2026: the chip under the composer flips it and ChatView draws the lines above the
 * box, two siblings, so a change goes through `setPeekOpen` and reaches every subscriber
 * (`usePeekOpen`). Full-screen Chat's strip (its ⌄) uses the same switch.
 */
export const PEEK_OPEN_KEY = 'aasc.peekOpen';

const listeners = new Set<() => void>();
/** This visit's choice, kept only while storage refuses to save it (private mode, blocked data). */
let unsaved: boolean | null = null;

export function readPeekOpen(): boolean {
  try {
    return localStorage.getItem(PEEK_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Saves the choice; false when storage refused it. */
export function writePeekOpen(open: boolean): boolean {
  try {
    localStorage.setItem(PEEK_OPEN_KEY, open ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

/** The current choice: the saved one, or this visit's when storage would not save it. */
export function getPeekOpen(): boolean {
  return unsaved ?? readPeekOpen();
}

/** Opens or closes the peek on this phone, saves it, and tells every subscriber. */
export function setPeekOpen(open: boolean): void {
  unsaved = writePeekOpen(open) ? null : open;
  for (const listener of listeners) listener();
}

export function subscribePeekOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
