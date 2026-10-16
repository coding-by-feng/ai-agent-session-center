// codeLines.test.ts — the phone's code view (AASC-56): highlight.js output cut
// into numbered lines (a token spanning lines keeps its colour on each), find in
// the file with the one search rule (textHighlight), and the marks laid over the
// coloured pieces without ever changing the text.
import { describe, expect, it } from 'vitest';
import {
  MAX_FIND_MATCHES,
  findLineMatches,
  highlightedLines,
  languageForFile,
  markPieces,
  plainLines,
  type CodePiece,
} from './codeLines';

const text = (line: readonly CodePiece[]) => line.map((p) => p.text).join('');

describe('highlightedLines', () => {
  it('cuts highlight.js HTML into lines of coloured pieces, unescaping the text', () => {
    const html = '<span class="hljs-keyword">const</span> a = <span class="hljs-string">&quot;x &lt;y&gt; &amp; &#x27;z&#x27;&quot;</span>;\nb();';
    const lines = highlightedLines(html);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual([
      { text: 'const', cls: 'hljs-keyword' },
      { text: ' a = ', cls: '' },
      { text: '"x <y> & \'z\'"', cls: 'hljs-string' },
      { text: ';', cls: '' },
    ]);
    expect(text(lines[1])).toBe('b();');
  });

  it('keeps a token’s colour on every line it spans, nested classes included', () => {
    const html = '<span class="hljs-comment">/* one\ntwo <span class="hljs-doctag">@x</span>\nthree */</span>';
    const lines = highlightedLines(html);
    expect(lines.map(text)).toEqual(['/* one', 'two @x', 'three */']);
    expect(lines[1]).toEqual([{ text: 'two ', cls: 'hljs-comment' }, { text: '@x', cls: 'hljs-comment hljs-doctag' }]);
    expect(lines[2]).toEqual([{ text: 'three */', cls: 'hljs-comment' }]);
  });

  it('gives an empty line no pieces of text but still a line', () => {
    expect(highlightedLines('a\n\nb').map(text)).toEqual(['a', '', 'b']);
  });

  it('matches plainLines on unhighlighted text', () => {
    expect(plainLines('a\nb')).toEqual([[{ text: 'a', cls: '' }], [{ text: 'b', cls: '' }]]);
  });
});

describe('languageForFile', () => {
  const known = new Set(['ts', 'tsx', 'js', 'py', 'json', 'md', 'sh', 'dockerfile', 'makefile', 'yaml']);
  const has = (lang: string) => known.has(lang);
  it('names the language by extension, or by a well-known file name', () => {
    expect(languageForFile('a.ts', has)).toBe('ts');
    expect(languageForFile('App.TSX', has)).toBe('tsx');
    expect(languageForFile('run.py', has)).toBe('py');
    expect(languageForFile('Dockerfile', has)).toBe('dockerfile');
    expect(languageForFile('Makefile', has)).toBe('makefile');
    expect(languageForFile('ci.yml', has)).toBe('yaml');
  });

  it('says none for plain text or an unknown kind (no guessing)', () => {
    expect(languageForFile('notes.txt', has)).toBeNull();
    expect(languageForFile('a.weird', has)).toBeNull();
    expect(languageForFile('LICENSE', has)).toBeNull();
  });
});

describe('findLineMatches', () => {
  it('finds every hit, case-insensitively, by line and column', () => {
    const lines = ['Send it', 'nothing', 'send, SEND'];
    expect(findLineMatches(lines, 'send')).toEqual([
      { line: 1, start: 0, end: 4 },
      { line: 3, start: 0, end: 4 },
      { line: 3, start: 6, end: 10 },
    ]);
  });

  it('finds nothing for an empty query', () => {
    expect(findLineMatches(['a'], '   ')).toEqual([]);
  });

  it('stops at MAX_FIND_MATCHES', () => {
    const lines = Array.from({ length: MAX_FIND_MATCHES + 50 }, () => 'a');
    expect(findLineMatches(lines, 'a')).toHaveLength(MAX_FIND_MATCHES);
  });
});

describe('markPieces', () => {
  const line: CodePiece[] = [{ text: 'const ', cls: 'hljs-keyword' }, { text: 'sendPrompt', cls: 'hljs-title' }, { text: '();', cls: '' }];

  it('lays the marks over the pieces, splitting where they start and end', () => {
    const out = markPieces(line, [{ start: 3, end: 8, current: false }, { start: 9, end: 15, current: true }]);
    expect(out.map((p) => p.text).join('')).toBe('const sendPrompt();');
    expect(out).toEqual([
      { text: 'con', cls: 'hljs-keyword' },
      { text: 'st ', cls: 'hljs-keyword', mark: 'match' },
      { text: 'se', cls: 'hljs-title', mark: 'match' },
      { text: 'n', cls: 'hljs-title' },
      { text: 'dPromp', cls: 'hljs-title', mark: 'current' },
      { text: 't', cls: 'hljs-title' },
      { text: '();', cls: '' },
    ]);
  });

  it('returns the pieces as they were without marks', () => {
    expect(markPieces(line, [])).toBe(line);
  });
});
