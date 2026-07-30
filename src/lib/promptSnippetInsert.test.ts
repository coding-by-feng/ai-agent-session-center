import { describe, it, expect } from 'vitest';
import { appendSnippet } from './promptSnippetInsert';

describe('appendSnippet', () => {
  it('replaces an empty box outright, with no leading blank line', () => {
    expect(appendSnippet('', '/compact')).toBe('/compact');
  });

  it('treats a whitespace-only box as empty', () => {
    expect(appendSnippet('   \n  ', '/compact')).toBe('/compact');
  });

  it('appends on a new line when the box already has text', () => {
    expect(appendSnippet('analyze recent commits', '/compact')).toBe(
      'analyze recent commits\n/compact',
    );
  });

  it('does not accumulate blank lines across repeated appends', () => {
    const once = appendSnippet('first', 'second');
    const twice = appendSnippet(once, 'third');
    expect(twice).toBe('first\nsecond\nthird');
  });

  it('trims trailing whitespace on the existing text before the separator', () => {
    expect(appendSnippet('prompt\n\n\n', '/compact')).toBe('prompt\n/compact');
  });

  it('trims the snippet itself', () => {
    expect(appendSnippet('prompt', '  /compact \n')).toBe('prompt\n/compact');
  });

  it('preserves internal newlines inside a multi-line snippet', () => {
    expect(appendSnippet('prompt', 'line one\nline two')).toBe(
      'prompt\nline one\nline two',
    );
  });

  it('is a no-op for a blank snippet — never appends an empty line', () => {
    expect(appendSnippet('prompt', '')).toBe('prompt');
    expect(appendSnippet('prompt', '   ')).toBe('prompt');
  });

  it('leaves leading whitespace of the box alone when it is not empty', () => {
    // Only the TRAILING edge is normalized; indentation the user typed stays.
    expect(appendSnippet('  indented', 'x')).toBe('  indented\nx');
  });
});
