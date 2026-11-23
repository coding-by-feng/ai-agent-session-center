// miniMarkdown.ts — the on-screen part of a Voice central reply on the call screen (Nov 23 2026): the central may
// add a table, a code block or a list after its spoken reply (server/voice/voiceText.ts `SCREEN_MARKER`); the voice
// never says it, the call screen draws it.
//
// A small Markdown subset, built with dom.ts `h()`: every piece of text becomes a text node, so a tag, an entity or
// a script in session-written text stays text. Supported: pipe tables (header, `:---:` alignment) in a scroll box of
// their own, fenced code blocks, `#` headings, `-`/`*`/`+` and `1.` lists, `>` quotes, paragraphs; inline `code`,
// **bold** and *italics*. A link shows its text and goes nowhere: nothing on the call screen leaves the call.

import { h } from './dom.js';

export const TABLE_ROWS_MAX = 30;
export const TABLE_COLS_MAX = 8;

type Align = 'left' | 'center' | 'right' | null;

const FENCE = /^\s*```/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;
// `code`, **bold**, *italic* / _italic_, [text](url): the first match wins, left to right.
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|(?<![\w])_([^_\n]+)_(?![\w])|\[([^\]\n]+)\]\([^)\s]*\)/g;

/** Inline Markdown as nodes. */
function inline(text: string): Array<Node | string> {
  const out: Array<Node | string> = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined) out.push(h('code', {}, m[1]));
    else if (m[2] !== undefined || m[3] !== undefined) out.push(h('strong', {}, m[2] ?? m[3]));
    else if (m[4] !== undefined || m[5] !== undefined) out.push(h('em', {}, m[4] ?? m[5]));
    else out.push(m[6]);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string): string[] => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function alignOf(sep: string): Align {
  const left = sep.startsWith(':');
  const right = sep.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

function cell(tag: 'th' | 'td', text: string, align: Align): HTMLElement {
  const el = h(tag, {}, ...inline(text));
  if (align) el.style.textAlign = align;
  return el;
}

function table(rows: string[]): HTMLElement {
  const head = cells(rows[0]).slice(0, TABLE_COLS_MAX);
  const aligns = cells(rows[1]).slice(0, TABLE_COLS_MAX).map(alignOf);
  const body = rows.slice(2, 2 + TABLE_ROWS_MAX).map((r) => cells(r).slice(0, TABLE_COLS_MAX));
  return h('div', { class: 'call-md-table', attrs: { role: 'region', 'aria-label': 'Table', tabindex: 0 } },
    h('table', {},
      h('thead', {}, h('tr', {}, ...head.map((c, i) => cell('th', c, aligns[i] ?? null)))),
      h('tbody', {}, ...body.map((r) => h('tr', {}, ...head.map((_, i) => cell('td', r[i] ?? '', aligns[i] ?? null)))))));
}

/** The on-screen Markdown as a block of nodes. */
export function renderMiniMarkdown(text: string): HTMLElement {
  const root = h('div', { class: 'call-md' });
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const take = (test: RegExp): string[] => {
    const got: string[] = [];
    while (i < lines.length && test.test(lines[i])) got.push(lines[i++]);
    return got;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (FENCE.test(line)) {
      i += 1;
      const code: string[] = [];
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      i += 1;
      root.append(h('pre', {}, h('code', {}, code.join('\n'))));
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      root.append(table(take(TABLE_ROW)));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      i += 1;
      root.append(h('p', { class: 'call-md-h' }, ...inline(heading[1])));
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const numbered = NUMBERED.test(line);
      const items = take(numbered ? NUMBERED : BULLET).map((l) => (numbered ? NUMBERED : BULLET).exec(l)?.[1] ?? l);
      root.append(h(numbered ? 'ol' : 'ul', {}, ...items.map((t) => h('li', {}, ...inline(t)))));
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted = take(QUOTE).map((l) => QUOTE.exec(l)?.[1] ?? l);
      root.append(h('blockquote', {}, ...inline(quoted.join(' '))));
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length && lines[i].trim() !== '' && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) &&
      !BULLET.test(lines[i]) && !NUMBERED.test(lines[i]) && !QUOTE.test(lines[i]) &&
      !(TABLE_ROW.test(lines[i]) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))
    ) para.push(lines[i++].trim());
    root.append(h('p', {}, ...inline(para.join(' '))));
  }
  return root;
}
