// @vitest-environment jsdom
// miniMarkdown.test.ts — the call screen's on-screen part of a Voice central reply (Nov 23 2026): a small Markdown
// subset built as DOM nodes, so session-written text never becomes HTML.
import { describe, it, expect } from 'vitest';
import { renderMiniMarkdown, TABLE_COLS_MAX, TABLE_ROWS_MAX } from './miniMarkdown.js';

const md = (text: string): HTMLElement => renderMiniMarkdown(text);

describe('renderMiniMarkdown', () => {
  it('draws a table with its header, alignment and a scroll box of its own', () => {
    const el = md('| Change | Words |\n| :--- | ---: |\n| Cover title | 6 |\n| Demo | 2 |');
    const box = el.querySelector('.call-md-table');
    expect(box?.getAttribute('role')).toBe('region');
    expect(box?.getAttribute('tabindex')).toBe('0');
    expect([...el.querySelectorAll('th')].map((c) => c.textContent)).toEqual(['Change', 'Words']);
    expect([...el.querySelectorAll('tbody tr')].map((r) => [...r.children].map((c) => c.textContent))).toEqual([['Cover title', '6'], ['Demo', '2']]);
    expect((el.querySelector('tbody td:last-child') as HTMLElement).style.textAlign).toBe('right');
  });

  it('caps a table at its rows and columns', () => {
    const head = `| ${Array.from({ length: TABLE_COLS_MAX + 3 }, (_, i) => `c${i}`).join(' | ')} |`;
    const sep = `| ${Array.from({ length: TABLE_COLS_MAX + 3 }, () => '---').join(' | ')} |`;
    const rows = Array.from({ length: TABLE_ROWS_MAX + 5 }, (_, i) => `| r${i} | x |`);
    const el = md([head, sep, ...rows].join('\n'));
    expect(el.querySelectorAll('th')).toHaveLength(TABLE_COLS_MAX);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(TABLE_ROWS_MAX);
  });

  it('draws a fenced code block as text, with its language left out', () => {
    const el = md('```bash\nnpm run build\necho "<b>hi</b>"\n```');
    expect(el.querySelector('pre code')?.textContent).toBe('npm run build\necho "<b>hi</b>"');
    expect(el.querySelector('b')).toBeNull();
  });

  it('draws headings, lists, quotes and paragraphs', () => {
    const el = md('### Findings\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\nA plain\nparagraph.');
    expect(el.querySelector('.call-md-h')?.textContent).toBe('Findings');
    expect([...el.querySelectorAll('ul li')].map((li) => li.textContent)).toEqual(['one', 'two']);
    expect([...el.querySelectorAll('ol li')].map((li) => li.textContent)).toEqual(['first', 'second']);
    expect(el.querySelector('blockquote')?.textContent).toBe('quoted');
    expect(el.querySelector('p:not(.call-md-h)')?.textContent).toBe('A plain paragraph.');
  });

  it('draws inline code, bold and italics; a link is its text and goes nowhere', () => {
    const el = md('Run `npm test`, **then** check *this* and [the docs](https://example.com).');
    const p = el.querySelector('p');
    expect(p?.querySelector('code')?.textContent).toBe('npm test');
    expect(p?.querySelector('strong')?.textContent).toBe('then');
    expect(p?.querySelector('em')?.textContent).toBe('this');
    expect(p?.textContent).toBe('Run npm test, then check this and the docs.');
    expect(el.querySelector('a')).toBeNull();
  });

  it('never parses HTML: tags and entities stay text', () => {
    const el = md('<img src=x onerror="alert(1)"> &amp; <script>x()</script>\n\n| <b>a</b> |\n| - |\n| <i>b</i> |');
    expect(el.querySelector('img, script, b, i')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror="alert(1)"> &amp; <script>x()</script>');
  });

  it('an unclosed code fence runs to the end; a lone pipe line is a paragraph', () => {
    expect(md('```\nopen').querySelector('pre code')?.textContent).toBe('open');
    expect(md('| just one line |').querySelector('table')).toBeNull();
  });
});
