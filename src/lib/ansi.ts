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

// TUI chrome that is never answer content: box-drawing + block elements +
// geometric shapes (U+2500–25FF) and Braille glyphs (U+2800–28FF, used for
// Claude Code's "thinking" spinner).
const TUI_GLYPH_RE = /[─-◿⠀-⣿]/gu;
// Trailing whitespace left behind after stripping the chrome, per line.
const TRAILING_WS_RE = /[ \t]+$/gm;
// Collapse the big runs of blank lines that screen redraws leave behind.
const EXTRA_BLANKS_RE = /\n{3,}/g;

/**
 * Clean raw terminal scrollback captured from an interactive CLI (TUI) into
 * readable text: strip ANSI, then remove box-drawing / block / Braille-spinner
 * chrome and collapse the whitespace those redraws leave behind.
 *
 * Used when storing an AI-popup response to the REVIEW / AI POPUPS history,
 * where the raw capture is a Claude Code TUI screen, not clean prose.
 */
export function cleanCapturedOutput(input: string): string {
  if (!input) return '';
  return stripAnsi(input)
    .replace(TUI_GLYPH_RE, '')
    .replace(TRAILING_WS_RE, '')
    .replace(EXTRA_BLANKS_RE, '\n\n');
}
