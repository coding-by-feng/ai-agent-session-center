import { describe, it, expect } from 'vitest';
import { foldDashes, normalizeForSearch } from './searchNormalize';

// Dash code points under test
const HYPHEN = '-'; // -
const EN_DASH = '–'; // –
const EM_DASH = '—'; // —
const MINUS = '−'; // −
const NB_HYPHEN = '‑'; // ‑
const FULLWIDTH = '－'; // －

describe('foldDashes', () => {
  it('folds an en-dash range to hyphen so "A1–A21" matches "A1-A21"', () => {
    expect(foldDashes(`A1${EN_DASH}A21`)).toBe('A1-A21');
  });

  it('folds em-dash, minus sign, non-breaking and fullwidth hyphens', () => {
    expect(foldDashes(`x${EM_DASH}y`)).toBe('x-y');
    expect(foldDashes(`x${MINUS}y`)).toBe('x-y');
    expect(foldDashes(`x${NB_HYPHEN}y`)).toBe('x-y');
    expect(foldDashes(`x${FULLWIDTH}y`)).toBe('x-y');
  });

  it('leaves a plain hyphen unchanged', () => {
    expect(foldDashes(`A1${HYPHEN}A21`)).toBe('A1-A21');
  });

  it('is length-preserving (offsets stay aligned)', () => {
    const src = `Table 4.1${EN_DASH}4.6 and pages 10${EM_DASH}20`;
    expect(foldDashes(src)).toHaveLength(src.length);
  });

  it('only touches dash characters', () => {
    expect(foldDashes('plain text, no dashes')).toBe('plain text, no dashes');
  });
});

describe('normalizeForSearch', () => {
  it('makes an en-dash haystack findable with a hyphen needle (case-insensitive)', () => {
    const haystack = normalizeForSearch(`(A1${EN_DASH}A21)`, false);
    const needle = normalizeForSearch('a1-a21', false);
    expect(haystack.includes(needle)).toBe(true);
  });

  it('respects case sensitivity while still folding dashes', () => {
    const haystack = normalizeForSearch(`A1${EN_DASH}A21`, true);
    expect(haystack.includes(normalizeForSearch('A1-A21', true))).toBe(true);
    expect(haystack.includes(normalizeForSearch('a1-a21', true))).toBe(false);
  });

  it('lowercases when case-insensitive', () => {
    expect(normalizeForSearch('ABC', false)).toBe('abc');
  });
});
