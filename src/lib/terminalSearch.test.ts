// terminalSearch.test.ts — find-in-terminal's pure rules (Nov 6 2026).
import { describe, it, expect } from 'vitest';
import {
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  formatMatchCount,
  isTerminalFindKey,
  addonSearch,
  isValidSearchRegex,
} from './terminalSearch';

const key = (over: Partial<KeyboardEvent>) => ({ key: 'f', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over });

describe('isTerminalFindKey', () => {
  it('is ⌘F on a Mac and Ctrl+F elsewhere', () => {
    expect(isTerminalFindKey(key({ metaKey: true }), true)).toBe(true);
    expect(isTerminalFindKey(key({ ctrlKey: true }), false)).toBe(true);
    expect(isTerminalFindKey(key({ key: 'F', metaKey: true }), true)).toBe(true);
  });

  it('leaves Ctrl+F to the program on a Mac (readline forward-char) and ⌘F alone elsewhere', () => {
    expect(isTerminalFindKey(key({ ctrlKey: true }), true)).toBe(false);
    expect(isTerminalFindKey(key({ metaKey: true }), false)).toBe(false);
  });

  it('never takes ⇧⌘F (session search) or ⌥⌘F', () => {
    expect(isTerminalFindKey(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isTerminalFindKey(key({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isTerminalFindKey(key({ key: 'g', metaKey: true }), true)).toBe(false);
  });
});

describe('formatMatchCount', () => {
  it('says nothing before a query', () => {
    expect(formatMatchCount('', { resultIndex: -1, resultCount: 0 })).toBe('');
  });

  it('counts "current/total", 1-based', () => {
    expect(formatMatchCount('ssh', { resultIndex: 2, resultCount: 12 })).toBe('3/12');
  });

  it('says No results at zero, and before the first answer', () => {
    expect(formatMatchCount('ssh', { resultIndex: -1, resultCount: 0 })).toBe('No results');
    expect(formatMatchCount('ssh', null)).toBe('');
  });

  it('shows the limit with a + once the highlight limit is passed (the addon reports index -1)', () => {
    expect(formatMatchCount('e', { resultIndex: -1, resultCount: TERMINAL_SEARCH_HIGHLIGHT_LIMIT }))
      .toBe(`${TERMINAL_SEARCH_HIGHLIGHT_LIMIT}+`);
  });

  it('never presents a capped count as the real total (the addon stops counting at the limit)', () => {
    expect(formatMatchCount('e', { resultIndex: 4, resultCount: TERMINAL_SEARCH_HIGHLIGHT_LIMIT }))
      .toBe(`5/${TERMINAL_SEARCH_HIGHLIGHT_LIMIT}+`);
    expect(formatMatchCount('e', { resultIndex: 4, resultCount: TERMINAL_SEARCH_HIGHLIGHT_LIMIT - 1 }))
      .toBe(`5/${TERMINAL_SEARCH_HIGHLIGHT_LIMIT - 1}`);
  });
});

describe('isValidSearchRegex', () => {
  it('accepts a regex that compiles and refuses one that does not', () => {
    expect(isValidSearchRegex('ssh.*Host')).toBe(true);
    expect(isValidSearchRegex('(unclosed')).toBe(false);
  });
});

describe('addonSearch', () => {
  it('carries the toggles and highlights every match', () => {
    const { term, options } = addonSearch('ssh', { caseSensitive: true, regex: false });
    expect(term).toBe('ssh');
    expect(options).toMatchObject({ caseSensitive: true, regex: false });
    expect(options.decorations?.matchBackground).toMatch(/^#[0-9a-f]{6}$/i);
    expect(options.decorations?.activeMatchBackground).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('leaves plain text to the addon\'s own case folding', () => {
    expect(addonSearch('SSH', { caseSensitive: false, regex: false }))
      .toMatchObject({ term: 'SSH', options: { caseSensitive: false } });
  });

  it('keeps a case-blind regex\'s upper-case escapes: (?i:…) with the addon matching case', () => {
    // The addon lowercases a case-blind term, which turned \S+ into \s+ (whitespace).
    const { term, options } = addonSearch('\\S+@\\S+', { caseSensitive: false, regex: true });
    expect(options).toMatchObject({ caseSensitive: true, regex: true });
    const re = new RegExp(term, 'g');
    expect('Mail KASON@EXAMPLE.com now'.match(re)).toEqual(['KASON@EXAMPLE.com']);
    expect(new RegExp(term).test('   ')).toBe(false);
  });

  it('leaves a case-sensitive regex as typed', () => {
    expect(addonSearch('Err\\w+', { caseSensitive: true, regex: true }).term).toBe('Err\\w+');
  });
});
