/**
 * @module fileRefs
 * Which bits of an agent's text may name a file or a folder (Nov 18 2026). One detector for the
 * phone Chat, the desktop CONVERSATION and Reader, and the terminal, so they link the same things:
 *
 *   file  docs/plan.md, ./a/b.ts, /abs/x.md   a folder part and an extension: placed for certain
 *   dir   /Users/me/proj/docs, ~/notes         an absolute or ~ folder: a link once it is found
 *   bare  plan.md, package.json                a name alone: a link once it is found (fileRefResolve)
 *
 * `file` is `filePathLink.ts`'s own pattern (plus `~/`), so nothing that linked before stops.
 * `dir` and `bare` are only candidates: prose is full of look-alikes ("Node.js", a regex), so
 * the caller links them only after the Mac says the path exists. Pure.
 */

export type FileRefKind = 'file' | 'dir' | 'bare';

export interface FileRefToken {
  start: number;
  /** Exclusive. */
  end: number;
  text: string;
  kind: FileRefKind;
}

const SEG = '[\\p{L}\\p{N}\\p{M}@.+_-]+';
const FILE = `(?:~/|\\.{0,2}/)?(?:${SEG}/)+${SEG}\\.[\\w]+`;
// Not after a word, a path or a URL scheme: "a/b" inside a longer token is not a folder.
const NOT_INSIDE = '(?<![\\p{L}\\p{N}\\p{M}@.+_\\-/:~\\\\])';
const DIR = `${NOT_INSIDE}(?:/(?:${SEG}/)+${SEG}/?|~/(?:${SEG}/)*${SEG}/?)`;
/** Extensions a bare name may end in: without one of these it is prose ("aasc.work", "e.g."). */
const BARE_EXTS = [
  'md', 'mdx', 'txt', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'zsh', 'sql', 'html', 'css', 'scss', 'xml', 'csv', 'tsv', 'pdf',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'mov', 'mp3', 'wav', 'docx', 'xlsx', 'pptx', 'zip', 'log', 'plist', 'ipynb',
].join('|');
const BARE = `${NOT_INSIDE}[\\p{L}\\p{N}_][\\p{L}\\p{N}\\p{M}@+_.-]*\\.(?:${BARE_EXTS})(?![\\p{L}\\p{N}_/-])`;
/** Names that are libraries far more often than files; a lookup for each would be wasted. */
const NOT_FILES = new Set(['node.js', 'next.js', 'vue.js', 'react.js', 'three.js', 'd3.js', 'express.js', 'nuxt.js', 'bun.sh']);

const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>)\]]+/gi;
const LINE_SUFFIX = /(?::\d+){1,2}$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function scanner(): RegExp {
  return new RegExp(`(?<file>${FILE})|(?<dir>${DIR})|(?<bare>${BARE})`, 'gu');
}

function urlRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(URL)) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
}

/** Every file, folder or bare-name candidate in `text`, left to right; none inside a URL. */
export function findFileRefs(text: string): FileRefToken[] {
  if (!text) return [];
  const urls = urlRanges(text);
  const out: FileRefToken[] = [];
  for (const match of text.matchAll(scanner())) {
    const groups = match.groups ?? {};
    const kind: FileRefKind = groups.file !== undefined ? 'file' : groups.dir !== undefined ? 'dir' : 'bare';
    // A sentence's full stop is not part of a folder's name.
    const value = kind === 'dir' ? match[0].replace(/\.+$/, '') : match[0];
    const start = match.index;
    const end = start + value.length;
    if (!value || urls.some(([from, to]) => start < to && end > from)) continue;
    if (kind === 'bare' && NOT_FILES.has(value.toLowerCase())) continue;
    out.push({ start, end, text: value, kind });
  }
  return out;
}

/** What a whole string (an inline code span, a link target) may name, or null. */
export function classifyRef(raw: string): FileRefKind | null {
  const text = raw.trim().replace(LINE_SUFFIX, '');
  if (!text || /\s/.test(text) || SCHEME.test(text)) return null;
  if (!text.includes('/')) {
    const [only] = findFileRefs(text);
    return only && only.kind === 'bare' && only.start === 0 && only.end === text.length ? 'bare' : null;
  }
  const full = new RegExp(`^(?:${FILE})$`, 'u');
  if (full.test(text)) return 'file';
  // A folder: absolute, ~, or relative with a slash; path characters only.
  return new RegExp(`^(?:~/|\\.{0,2}/)?(?:${SEG}/)*${SEG}/?$`, 'u').test(text) ? 'dir' : null;
}

/** The folders a message names, in order: where its bare file names are looked for first. */
export function messageFolders(text: string): string[] {
  const out: string[] = [];
  const add = (folder: string) => {
    const clean = folder.replace(/\/+$/, '');
    if (clean && !out.includes(clean)) out.push(clean);
  };
  for (const token of findFileRefs(text)) {
    if (token.kind === 'dir') add(token.text);
    else if (token.kind === 'file' && /^(?:~?\/)/.test(token.text)) add(token.text.slice(0, token.text.lastIndexOf('/')));
  }
  return out;
}
