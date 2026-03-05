/**
 * ANSI escape code processor for DOM-based terminal output viewer.
 * Strips non-SGR sequences (cursor movement, screen clear, OSC)
 * and splits raw terminal output into lines.
 */

// Matches CSI sequences that are NOT SGR (SGR ends with 'm')
// Covers cursor movement, erase, scroll, mode set/reset, scroll region, etc.
const NON_SGR_CSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[A-HJKSTfhlnqr@GLMPXZ`degi]/g;

// OSC sequences: ESC ] ... BEL or ESC ] ... ST
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

// DEC private mode set/reset: ESC [ ? ... h/l
const DEC_PRIVATE_RE = /\x1b\[\?[\d;]*[hl]/g;

// Title set sequences: ESC k ... ESC \\
const TITLE_RE = /\x1bk[\s\S]*?\x1b\\/g;

// Device status / cursor position reports
const DEVICE_RE = /\x1b\[\d*n/g;

// Two-character escape sequences: ESC =, ESC >, ESC 7, ESC 8, ESC D, ESC M, ESC E, ESC c, etc.
const TWO_CHAR_ESC_RE = /\x1b[=>78DMEcNOHZ]/g;

// Cursor forward: ESC [ <n> C — replace with n spaces to preserve layout
const CURSOR_FORWARD_RE = /\x1b\[(\d*)C/g;

/**
 * Strip non-SGR ANSI escape sequences, keeping only color/style codes.
 * Converts cursor-forward sequences to spaces to preserve text layout.
 */
export function stripNonSgrEscapes(raw: string): string {
  return raw
    .replace(CURSOR_FORWARD_RE, (_match, n) => ' '.repeat(Number(n) || 1))
    .replace(NON_SGR_CSI_RE, '')
    .replace(OSC_RE, '')
    .replace(DEC_PRIVATE_RE, '')
    .replace(TITLE_RE, '')
    .replace(DEVICE_RE, '')
    .replace(TWO_CHAR_ESC_RE, '');
}

/**
 * Resolve backspace characters (\b / 0x08).
 * Each \b deletes the previous visible character. `c\bclaude` → `claude`.
 */
function resolveBackspaces(text: string): string {
  if (!text.includes('\x08')) return text;
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\x08') {
      // Delete previous character if any (skip over SGR escape sequences)
      if (out.length > 0) out.pop();
    } else {
      out.push(text[i]);
    }
  }
  return out.join('');
}

/**
 * Resolve bare \r (carriage return) within a line segment.
 * In a real terminal, \r moves cursor to column 0. If new text follows,
 * it overwrites from the start. If nothing follows (e.g. stripped escape
 * sequences left a trailing \r), the original content stays.
 *
 * Takes the last NON-EMPTY segment after splitting on \r so that
 * `text\r` preserves "text" while `old\rnew` correctly yields "new".
 */
function resolveCarriageReturns(segment: string): string {
  const parts = segment.split('\r');
  // Walk backwards to find the last non-empty part
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]) return parts[i];
  }
  return '';
}

/**
 * Process a chunk of terminal output into lines.
 * Handles \r\n, \n, and bare \r (carriage return overwrites current line).
 *
 * @param raw - Raw terminal output string (after stripNonSgrEscapes)
 * @param partial - Partial line leftover from the previous chunk
 * @returns Object with completed lines and the new partial line
 */
export function processTerminalChunk(
  raw: string,
  partial: string,
): { lines: string[]; partial: string } {
  const combined = partial + raw;
  const completedLines: string[] = [];

  // Split on \r\n or \n
  const segments = combined.split(/\r?\n/);
  // Last segment is the new partial (may be empty if chunk ended with \n)
  const newPartial = segments.pop() ?? '';

  for (const segment of segments) {
    completedLines.push(resolveBackspaces(resolveCarriageReturns(segment)));
  }

  return { lines: completedLines, partial: resolveBackspaces(resolveCarriageReturns(newPartial)) };
}

/**
 * Decode base64-encoded terminal output to UTF-8 string.
 */
export function base64ToUtf8(b64: string): string {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}
