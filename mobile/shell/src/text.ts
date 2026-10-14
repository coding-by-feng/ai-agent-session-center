// text.ts — make untrusted text safe to show (AASC-19).
//
// Session titles, notification text and shared text come from the Mac, the
// backend or another app. Control characters, line separators and bidi
// overrides can forge or hide what the user reads, so a label loses them.

/** C0 and C1 controls, DEL (tabs and newlines included: a label is one line). */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
/** Bidi marks, embeddings, overrides and isolates, and the BOM. ZWJ stays: emoji need it. */
const BIDI_AND_BOM = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
/**
 * Invisible characters that can carry text a reader never sees ("ASCII smuggling"):
 * zero-width space, word joiner and invisible operators, the Mongolian vowel separator,
 * interlinear annotations, Unicode tag characters and the variation-selector supplement.
 * Emoji variation selectors (FE00-FE0F) and ZWJ stay.
 */
const SMUGGLING = /[\u200B\u2060-\u2064\u180E\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const LINE_SEPARATORS = /[\u2028\u2029]/g;

/** User-perceived characters, so a cut never splits an emoji or an accent. */
function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/** Cut to at most `max` user-perceived characters, ending with … when cut. */
export function clip(text: string, max: number): string {
  if (max <= 0) return '';
  const parts = graphemes(text);
  if (parts.length <= max) return text;
  return `${parts.slice(0, max - 1).join('').trimEnd()}…`;
}

/** Strip characters that can hide, reorder or smuggle text; keeps newlines and tabs. */
export function stripInvisible(text: string): string {
  return text.replace(BIDI_AND_BOM, '').replace(SMUGGLING, '');
}

/** One line of display text: no controls or bidi characters, single spaces, at most `max` characters. */
export function cleanLabel(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  // A title can be huge; nothing past this point could survive the cut anyway.
  const head = raw.slice(0, Math.max(0, max) * 16);
  const flat = stripInvisible(head)
    .replace(CONTROL, ' ')
    .replace(LINE_SEPARATORS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(flat, max);
}

/** Terminal escape sequences: CSI (colours, cursor), OSC (titles, links) and two-character escapes. */
const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-Z\\-_]/g;
/** Controls except tab (\x09) and newline (\x0A). */
const CONTROL_EXCEPT_TAB_NL = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

/**
 * Multi-line text (a shared prompt): line endings become \n, terminal escape
 * sequences, other controls and bidi characters go, tabs and newlines stay.
 * Not trimmed and not cut: the caller decides what an empty or long text means.
 */
export function cleanMultiline(raw: string): string {
  return stripInvisible(raw)
    .replace(/\r\n?/g, '\n')
    .replace(LINE_SEPARATORS, '\n')
    .replace(ANSI, '')
    .replace(CONTROL_EXCEPT_TAB_NL, '');
}
