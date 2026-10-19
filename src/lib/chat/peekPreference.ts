/**
 * peekPreference.ts — does this phone show the terminal's last lines under the
 * working strip? Hidden unless asked for (Oct 19 2026: the strip, the lines and the
 * composer's chips took ~180pt of a phone screen); ⌄ on the strip flips it, and the
 * phone remembers. Per device, so storage that throws or is empty reads as hidden.
 */
export const PEEK_OPEN_KEY = 'aasc.peekOpen';

export function readPeekOpen(): boolean {
  try {
    return localStorage.getItem(PEEK_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function writePeekOpen(open: boolean): void {
  try {
    localStorage.setItem(PEEK_OPEN_KEY, open ? '1' : '0');
  } catch {
    // Private mode or blocked site data: the choice lasts for this visit only.
  }
}
