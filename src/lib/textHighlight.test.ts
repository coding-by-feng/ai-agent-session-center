import { describe, it, expect } from 'vitest';
import { clipToMatch, matchesQuery, normalizeQuery, splitHighlight } from './textHighlight';

describe('normalizeQuery', () => {
  it('lowercases and trims', () => {
    expect(normalizeQuery('  FFmpeg  ')).toBe('ffmpeg');
  });

  it('reduces an all-whitespace query to empty', () => {
    // A stray space must not match every entry and turn "matches only" into a
    // no-op that looks like it is working.
    expect(normalizeQuery('   ')).toBe('');
    expect(normalizeQuery(undefined)).toBe('');
    expect(normalizeQuery(null)).toBe('');
  });
});

describe('matchesQuery', () => {
  it('is case-insensitive', () => {
    expect(matchesQuery('Running FFMPEG now', 'ffmpeg')).toBe(true);
  });

  it('never matches on an empty query', () => {
    expect(matchesQuery('anything', '')).toBe(false);
  });

  it('tolerates null/undefined text', () => {
    expect(matchesQuery(undefined, 'x')).toBe(false);
    expect(matchesQuery(null, 'x')).toBe(false);
  });
});

describe('splitHighlight', () => {
  it('returns a single unmatched segment when there is no query', () => {
    expect(splitHighlight('hello', '')).toEqual([{ text: 'hello', match: false }]);
  });

  it('splits around every occurrence', () => {
    expect(splitHighlight('a-FOO-b-foo', 'foo')).toEqual([
      { text: 'a-', match: false },
      { text: 'FOO', match: true },
      { text: '-b-', match: false },
      { text: 'foo', match: true },
    ]);
  });

  it('preserves the original casing of matches', () => {
    const segs = splitHighlight('Screen Recording', 'screen');
    expect(segs[0]).toEqual({ text: 'Screen', match: true });
  });

  it('handles a match at the very start and end', () => {
    expect(splitHighlight('abc', 'abc')).toEqual([{ text: 'abc', match: true }]);
  });

  it('reassembles to the original text', () => {
    const text = 'ffmpeg -i in.mov out.mp4 # ffmpeg';
    expect(splitHighlight(text, 'ffmpeg').map((s) => s.text).join('')).toBe(text);
  });

  it('does not loop forever on an empty needle', () => {
    expect(splitHighlight('abc', '')).toHaveLength(1);
  });
});

describe('clipToMatch', () => {
  it('leaves short text alone', () => {
    expect(clipToMatch('short text', 'text')).toBe('short text');
  });

  it('windows around a buried match and marks both cuts', () => {
    const text = `${'a'.repeat(500)}NEEDLE${'b'.repeat(500)}`;
    const out = clipToMatch(text, 'needle', { leading: 10, trailing: 10 });
    expect(out).toBe(`…${'a'.repeat(10)}NEEDLE${'b'.repeat(10)}…`);
  });

  it('omits the leading ellipsis when the window starts at 0', () => {
    const out = clipToMatch(`NEEDLE${'b'.repeat(500)}`, 'needle', { leading: 10, trailing: 5 });
    expect(out.startsWith('…')).toBe(false);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns the text unchanged when there is no match or no query', () => {
    expect(clipToMatch('abc', 'zzz')).toBe('abc');
    expect(clipToMatch('abc', '')).toBe('abc');
  });
});
