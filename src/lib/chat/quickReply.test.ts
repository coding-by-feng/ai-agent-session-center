// quickReply.test.ts — the composer's quick reply (Oct 21 2026): "proceed" unless this phone saved its own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_QUICK_REPLY, QUICK_REPLY_KEY, QUICK_REPLY_MAX, readQuickReply, resetQuickReplyForTest, setQuickReply } from './quickReply';

beforeEach(() => {
  localStorage.clear();
  resetQuickReplyForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('quick reply', () => {
  it('is "proceed" until this phone saves its own', () => {
    expect(DEFAULT_QUICK_REPLY).toBe('proceed');
    expect(readQuickReply()).toBe('proceed');
  });

  it('keeps the text saved, trimmed and capped; a blank or default one removes the key', () => {
    expect(setQuickReply('  go on, use your picks  ')).toBe('go on, use your picks');
    expect(localStorage.getItem(QUICK_REPLY_KEY)).toBe('go on, use your picks');
    expect(readQuickReply()).toBe('go on, use your picks');
    expect(setQuickReply('x'.repeat(QUICK_REPLY_MAX + 20))).toHaveLength(QUICK_REPLY_MAX);
    expect(setQuickReply('   ')).toBe('proceed');
    expect(localStorage.getItem(QUICK_REPLY_KEY)).toBeNull();
    setQuickReply('proceed');
    expect(localStorage.getItem(QUICK_REPLY_KEY)).toBeNull();
  });

  it('falls back to "proceed" when storage is unreadable or holds nothing usable', () => {
    localStorage.setItem(QUICK_REPLY_KEY, '   ');
    expect(readQuickReply()).toBe('proceed');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readQuickReply()).toBe('proceed');
  });
});
