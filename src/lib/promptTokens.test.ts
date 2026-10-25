// promptTokens.test.ts — which words of a queued prompt are skills / commands (Oct 21 2026).
import { describe, expect, it } from 'vitest';
import { splitPromptTokens } from './promptTokens';

const tokens = (text: string, cli: 'claude' | 'codex' | null = 'claude') =>
  splitPromptTokens(text, cli).filter((r) => r.token).map((r) => r.text);

describe('splitPromptTokens', () => {
  it('marks a /name that starts a word, and keeps every character of the text', () => {
    const text = 'when I click the context window, I can view the details of it /raab';
    const runs = splitPromptTokens(text, 'claude');
    expect(runs.map((r) => r.text).join('')).toBe(text);
    expect(tokens(text)).toEqual(['/raab']);
    expect(tokens('/krt-work take EE-86, then /simplify')).toEqual(['/krt-work', '/simplify']);
    expect(tokens('/plugin:review-pr 12')).toEqual(['/plugin:review-pr']);
  });

  it('leaves paths, URLs and mid-word slashes plain', () => {
    expect(tokens('look at /Users/me/app/src and /tmp/claude-queue-images/a.png')).toEqual([]);
    expect(tokens('and/or https://aasc.work/pair 1/2 //x /')).toEqual([]);
  });

  it('lets punctuation open or close a token', () => {
    expect(tokens('try (/raab) or "/rcp", then /review.')).toEqual(['/raab', '/rcp', '/review']);
    expect(tokens('line one\n/raab on line two')).toEqual(['/raab']);
  });

  it('counts $name only on Codex: on Claude it is ordinary text', () => {
    expect(tokens('use $krt-work for EE-86', 'codex')).toEqual(['$krt-work']);
    expect(tokens('echo $HOME costs $5', 'claude')).toEqual([]);
    expect(tokens('use $krt-work', null)).toEqual([]);
  });

  it('gives back one plain run for a prompt with no token', () => {
    expect(splitPromptTokens('just words', 'claude')).toEqual([{ text: 'just words', token: false }]);
    expect(splitPromptTokens('', 'claude')).toEqual([]);
  });
});
