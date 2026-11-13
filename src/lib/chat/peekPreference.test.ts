// peekPreference.test.ts — whether this phone shows the terminal's last lines under the
// working strip: hidden unless asked for, remembered, and never a crash without storage.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PEEK_OPEN_KEY, getPeekOpen, readPeekOpen, setPeekOpen, subscribePeekOpen, writePeekOpen } from './peekPreference';

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

  // Nov 13 2026: the chip under the composer opens the peek, which ChatView draws: two siblings
  // that must agree, so a change reaches every subscriber.
  it('tells every subscriber when the phone opens or closes it', () => {
    const heard = vi.fn();
    const stop = subscribePeekOpen(heard);
    setPeekOpen(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(getPeekOpen()).toBe(true);
    expect(localStorage.getItem(PEEK_OPEN_KEY)).toBe('1');
    stop();
    setPeekOpen(false);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(getPeekOpen()).toBe(false);
  });

  it('still opens for this visit when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    setPeekOpen(true);
    expect(getPeekOpen()).toBe(true);
    setPeekOpen(false);
    expect(getPeekOpen()).toBe(false);
  });
});
