/**
 * codeLines — the phone's code view, as data (AASC-56): highlight.js output cut
 * into numbered lines of coloured pieces, the language a file gets, and find in
 * the file. Pure (no DOM, no highlight.js import: the caller loads it lazily and
 * passes its HTML in), so the eager chunk never sees any of it.
 *
 * The pieces are rendered as React text, never as HTML: highlight.js's escaped
 * output is parsed here (only its own `<span class="…">` / `</span>` tags and
 * entities), so nothing in a file can become markup.
 *
 * Find uses the shared search rule (`textHighlight.splitHighlight`: trimmed,
 * case-insensitive substring), the same one that marks the project search's hits.
 */
import { normalizeQuery, splitHighlight } from './textHighlight';

export interface CodePiece {
  text: string;
  /** highlight.js classes in effect (outermost first), '' for plain text. */
  cls: string;
  /** A find hit: every one is marked, the current one more strongly. */
  mark?: 'match' | 'current';
}

export type CodeLine = readonly CodePiece[];

export interface LineMatch {
  /** 1-based line number. */
  line: number;
  start: number;
  end: number;
}

/** Hits counted at most: a one-letter query in a long file would find tens of thousands. */
export const MAX_FIND_MATCHES = 2000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'", apos: "'" };

function unescape(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#x27|#39|apos);/g, (_, name: string) => ENTITIES[name]);
}

const TAG = /<span class="([^"]*)">|<\/span>/g;

/** highlight.js HTML → lines of pieces. A span crossing a newline is closed and reopened. */
export function highlightedLines(html: string): CodeLine[] {
  const lines: CodePiece[][] = [[]];
  const classes: string[] = [];
  const addText = (raw: string) => {
    const parts = unescape(raw).split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, cls: classes.join(' ') });
    });
  };
  let at = 0;
  for (const match of html.matchAll(TAG)) {
    addText(html.slice(at, match.index));
    if (match[1] !== undefined) classes.push(match[1]);
    else classes.pop();
    at = (match.index ?? 0) + match[0].length;
  }
  addText(html.slice(at));
  return lines;
}

export function plainLines(content: string): CodeLine[] {
  return content.split('\n').map((text) => (text ? [{ text, cls: '' }] : []));
}

/** Files named by their whole name rather than an extension. */
const NAMED: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'makefile', gemfile: 'ruby', rakefile: 'ruby' };
/** Extensions highlight.js knows under another name. */
const ALIASES: Record<string, string> = { yml: 'yaml', mjs: 'js', cjs: 'js', mts: 'ts', cts: 'ts', zsh: 'sh', htm: 'html' };
/** Plain text: no colours to find. */
const PLAIN = new Set(['txt', 'text', 'log', 'csv', 'tsv']);

/**
 * The highlight.js language for a file, or null to show it plain. `has` asks the
 * loaded highlight.js whether it knows a name. Never guesses (highlightAuto is
 * slow on a phone and often wrong on short files).
 */
export function languageForFile(name: string, has: (lang: string) => boolean): string | null {
  const lower = name.toLowerCase();
  if (NAMED[lower] && has(NAMED[lower])) return NAMED[lower];
  const dot = lower.lastIndexOf('.');
  if (dot <= 0 || dot === lower.length - 1) return null;
  const ext = lower.slice(dot + 1);
  if (PLAIN.has(ext)) return null;
  const lang = ALIASES[ext] ?? ext;
  return has(lang) ? lang : null;
}

/** Every hit of `query` in the lines, in reading order (at most MAX_FIND_MATCHES). */
export function findLineMatches(lines: readonly string[], query: string): LineMatch[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  const out: LineMatch[] = [];
  for (let i = 0; i < lines.length && out.length < MAX_FIND_MATCHES; i++) {
    let col = 0;
    for (const seg of splitHighlight(lines[i], q)) {
      if (seg.match) {
        out.push({ line: i + 1, start: col, end: col + seg.text.length });
        if (out.length >= MAX_FIND_MATCHES) break;
      }
      col += seg.text.length;
    }
  }
  return out;
}

export interface MarkRange {
  start: number;
  end: number;
  current: boolean;
}

/** The pieces with the ranges marked, split at each range's edges; the text is unchanged. */
export function markPieces(pieces: CodeLine, ranges: readonly MarkRange[]): CodeLine {
  if (ranges.length === 0) return pieces;
  const out: CodePiece[] = [];
  let col = 0;
  for (const piece of pieces) {
    const from = col;
    const to = col + piece.text.length;
    const cuts = new Set([from, to]);
    for (const r of ranges) {
      if (r.start > from && r.start < to) cuts.add(r.start);
      if (r.end > from && r.end < to) cuts.add(r.end);
    }
    const edges = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < edges.length - 1; i++) {
      const [a, b] = [edges[i], edges[i + 1]];
      const hit = ranges.find((r) => r.start <= a && r.end >= b);
      const text = piece.text.slice(a - from, b - from);
      out.push(hit ? { text, cls: piece.cls, mark: hit.current ? 'current' : 'match' } : { text, cls: piece.cls });
    }
    col = to;
  }
  return out;
}
