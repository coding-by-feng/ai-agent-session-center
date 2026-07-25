import { describe, it, expect } from 'vitest';
import { splitIntoChunks, DEFAULT_KOKORO_VOICE } from './kokoroTts';

describe('splitIntoChunks', () => {
  it('returns nothing for empty / whitespace-only input', () => {
    expect(splitIntoChunks('')).toEqual([]);
    expect(splitIntoChunks('   \n\t  ')).toEqual([]);
  });

  it('collapses whitespace and trims', () => {
    expect(splitIntoChunks('  hello   world  ')).toEqual(['hello world']);
  });

  it('keeps a single short sentence intact with its punctuation', () => {
    expect(splitIntoChunks('Life is like a box of chocolates.')).toEqual([
      'Life is like a box of chocolates.',
    ]);
  });

  it('groups multiple short sentences into one chunk under the limit', () => {
    const out = splitIntoChunks('One. Two. Three.');
    expect(out).toEqual(['One. Two. Three.']);
  });

  it('splits into separate chunks when the max length is exceeded', () => {
    const a = 'A'.repeat(300) + '.';
    const b = 'B'.repeat(300) + '.';
    const out = splitIntoChunks(`${a} ${b}`, 500);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('A');
    expect(out[1]).toContain('B');
  });

  it('never emits empty chunks', () => {
    const out = splitIntoChunks('Hi!!!   ...   \n\n  Bye?');
    expect(out.every((c) => c.trim().length > 0)).toBe(true);
  });

  it('falls back to the whole string when there is no sentence punctuation', () => {
    expect(splitIntoChunks('just some words no punctuation')).toEqual([
      'just some words no punctuation',
    ]);
  });

  it('splits a very long unpunctuated-ish run so no chunk grossly exceeds maxLen', () => {
    // Long text made of many short punctuated fragments.
    const text = Array.from({ length: 50 }, (_, i) => `Item ${i}.`).join(' ');
    const out = splitIntoChunks(text, 100);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(110); // maxLen + last fragment slack
  });

  it('exposes a stable default voice', () => {
    expect(DEFAULT_KOKORO_VOICE).toBe('af_heart');
  });
});
