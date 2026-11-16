import { describe, it, expect, beforeEach } from 'vitest';
import { readReaderMode, writeReaderMode } from './readerMode';

describe('readerMode', () => {
  beforeEach(() => localStorage.clear());

  it('is off by default and for a missing session', () => {
    expect(readReaderMode('s1')).toBe(false);
    expect(readReaderMode(null)).toBe(false);
  });

  it('remembers per session', () => {
    writeReaderMode('s1', true);
    expect(readReaderMode('s1')).toBe(true);
    expect(readReaderMode('s2')).toBe(false);
    writeReaderMode('s1', false);
    expect(readReaderMode('s1')).toBe(false);
  });
});
