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
