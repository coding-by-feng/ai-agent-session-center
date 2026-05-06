/**
 * Minimal ANSI escape sequence stripper for terminal-captured AI output.
 *
 * Removes:
 *   - CSI sequences:           ESC [ ... <terminator>
 *   - OSC sequences:           ESC ] ... BEL  (or ESC ] ... ESC \)
 *   - Single-char escapes:     ESC <0x40-0x5F>
 *   - Bracketed paste markers: ESC [ 200~ / ESC [ 201~  (already covered by CSI)
 *
 * This is a pragmatic stripper — not a full VT100 emulator. Sufficient for
 * making AI-generated text human-readable when stored to IndexedDB.
 */

// CSI: ESC [ <params> <intermediate?> <final char 0x40-0x7E>
const CSI_RE = /\x1B\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g;
// OSC: ESC ] ... (BEL | ESC \)
const OSC_RE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
// Single-char escapes like ESC ( B, ESC = , ESC > etc.
const SINGLE_RE = /\x1B[\x40-\x5F]/g;
// Carriage returns alone — keep \n, drop standalone \r
const CR_RE = /\r(?!\n)/g;

export function stripAnsi(input: string): string {
  if (!input) return '';
  return input
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(SINGLE_RE, '')
    .replace(CR_RE, '');
}
