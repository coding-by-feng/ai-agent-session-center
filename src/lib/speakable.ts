/**
 * speakable — an agent's Markdown answer as text worth hearing (AASC-20).
 *
 * The phone's read-aloud button speaks the last answer through the cloud TTS
 * (ttsEngine → /api/tts/synthesize). Read raw, an answer is asterisks, hashes,
 * pipes and whole code blocks; this keeps the words and names what it leaves
 * out. Pure and import-free.
 */

/** Under the server's per-request cap (12,000 characters), at a sentence or line end. */
export const SPEECH_CHUNK_CHARS = 4000;

export function toSpeakableText(markdown: string): string {
  return markdown
    // Fenced code is not speech: say that it is there.
    .replace(/```[\s\S]*?(```|$)/g, '\n(code block)\n')
    // Images and links keep their words, never the address.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? `(image: ${alt})` : '(image)'))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '(link)')
    // Inline code, emphasis, headings, quotes, list markers and table rules.
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, '$1')
    .replace(/[ \t]*\|[ \t]*/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .replace(/^ +| +$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Split for the TTS route: whole paragraphs or sentences, each under `max` characters. */
export function chunkSpeech(text: string, max: number = SPEECH_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const head = rest.slice(0, max);
    const at = [head.lastIndexOf('\n'), head.lastIndexOf('. '), head.lastIndexOf('。'), head.lastIndexOf(' ')]
      .find((i) => i > max / 2);
    // Keep the boundary character with the first piece; no boundary: a hard cut.
    const cut = at === undefined ? max : at + 1;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
