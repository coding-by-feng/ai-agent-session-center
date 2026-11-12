/**
 * Every string a server sends is printed only after this. A session title is whatever
 * someone typed, and an escape sequence in it could rewrite the screen, set the window
 * title, or write the user's clipboard (OSC 52). Strips C0, DEL, C1 (8-bit CSI/OSC),
 * format characters (bidi overrides, zero-width) and the Unicode line/paragraph separators.
 */
const UNSAFE = /[\x00-\x1F\x7F-\x9F\u2028\u2029\p{Cf}]/gu;

export function cleanText(text: string): string {
  return text.replace(UNSAFE, '');
}

/**
 * JSON for the terminal (`ls --json`): valid JSON, with every character a terminal could act
 * on written as a \u escape. JSON.stringify already escapes C0; this adds DEL, C1 and Cf.
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\x7F-\x9F\u2028\u2029\p{Cf}]/gu,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
