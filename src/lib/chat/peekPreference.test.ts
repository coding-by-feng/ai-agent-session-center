// peekPreference.test.ts — whether this phone shows the terminal's last lines under the
// working strip: hidden unless asked for, remembered, and never a crash without storage.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PEEK_OPEN_KEY, readPeekOpen, writePeekOpen } from './peekPreference';

beforeEach(() => localStorage.removeItem(PEEK_OPEN_KEY));
afterEach(() => vi.restoreAllMocks());

describe('peekPreference', () => {
  it('is closed until the phone says otherwise, then remembers either way', () => {
    expect(readPeekOpen()).toBe(false);
    writePeekOpen(true);
    expect(localStorage.getItem(PEEK_OPEN_KEY)).toBe('1');
    expect(readPeekOpen()).toBe(true);
    writePeekOpen(false);
    expect(readPeekOpen()).toBe(false);
  });

  it('reads closed and writes nothing when storage throws (private mode, blocked site data)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readPeekOpen()).toBe(false);
    expect(() => writePeekOpen(true)).not.toThrow();
  });
});
