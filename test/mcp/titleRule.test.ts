// test/mcp/titleRule.test.ts — the title rule (server/mcp/titleRule.ts, Ruling P3-23): a title a central gives is typed
// as `-n "<title>"`, and `ps` stores it back as loose words that a later relaunch types again. So an explicit title is
// refused when it holds shell syntax, a quote, a glob, a line break or a word that starts with a dash, and a derived one
// is cleaned of them. Pure: nothing here reaches a route or a process.
import { describe, expect, it } from 'vitest';
import { cleanTitle, TITLE_REFUSAL, titleRefusal } from '../../server/mcp/titleRule.js';

describe('titleRefusal', () => {
  it('a plain title passes, Unicode and inner dashes included', () => {
    for (const ok of ['New title', 'Fix the login bug', 'Fork of KTS Deployment', 'R2-D2 notes', 'Kason’s boss', '修复登录', 'x']) {
      expect(titleRefusal(ok), ok).toBeNull();
    }
  });

  it('shell syntax, quotes, globs and line breaks are refused', () => {
    for (const ch of [';', '&', '|', '$', '`', '<', '>', '(', ')', '{', '}', '\\', "'", '"', '*', '?', '[', ']', '\n', '\r', '\t', '\u2028']) {
      expect(titleRefusal(`a${ch}b`), JSON.stringify(ch)).toBe(TITLE_REFUSAL);
    }
    expect(titleRefusal('x -y ; touch /tmp/p')).toBe(TITLE_REFUSAL);
  });

  it('a word that starts with a dash is refused, wherever it is', () => {
    for (const bad of ['w --allowedTools Bash', '-n', 'Fix - login', 'a\u00a0--x', '--add-dir /', 'x  -y']) {
      expect(titleRefusal(bad), bad).toBe(TITLE_REFUSAL);
    }
  });

  it('the refusal never repeats the title', () => {
    expect(TITLE_REFUSAL).not.toContain('allowedTools');
    expect(TITLE_REFUSAL).toBe(
      'A title holds no shell syntax, quotes, wildcards or line breaks, and no word of it starts with a dash.',
    );
  });
});

describe('cleanTitle', () => {
  it('removes the characters, strips the leading dashes of words and collapses the spaces', () => {
    expect(cleanTitle('x -y ; touch /tmp/p')).toBe('x y touch /tmp/p');
    expect(cleanTitle('w --allowedTools Bash')).toBe('w allowedTools Bash');
    expect(cleanTitle('R&D (main)')).toBe('RD main');
    expect(cleanTitle('line one\nline two')).toBe('line one line two');
    expect(cleanTitle("Kason's  \"boss\"")).toBe('Kasons boss');
    expect(cleanTitle('Fix [bug] *now*?')).toBe('Fix bug now');
    expect(cleanTitle('Plain title')).toBe('Plain title');
  });

  it('falls back to New session when nothing is left', () => {
    for (const empty of ['', '   ', ';;;', '-- -', '$(){}']) expect(cleanTitle(empty), empty).toBe('New session');
  });

  it('what it answers always passes the rule', () => {
    for (const raw of ['x -y ; touch /tmp/p', '-- --', 'a\r\nb', 'Fork of `id`', '-n "x"', '日本 -語']) {
      expect(titleRefusal(cleanTitle(raw)), raw).toBeNull();
    }
  });
});
