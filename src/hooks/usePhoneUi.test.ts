// usePhoneUi.test.ts — the "New design" switch (AASC-38): classic by default, read
// back from storage, shared by every component that asks, safe without storage.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { PHONE_UI_KEY, readPhoneUi, usePhoneUi, writePhoneUi } from './usePhoneUi';

afterEach(() => {
  vi.restoreAllMocks();
  writePhoneUi('classic');
});

describe('usePhoneUi', () => {
  it('is classic until the switch is turned on', () => {
    localStorage.removeItem(PHONE_UI_KEY);
    expect(readPhoneUi()).toBe('classic');
  });

  it('reads a stored value and ignores anything else', () => {
    localStorage.setItem(PHONE_UI_KEY, 'app');
    expect(readPhoneUi()).toBe('app');
    localStorage.setItem(PHONE_UI_KEY, 'fancy');
    // An unknown value falls back to the last one this page set (classic here).
    expect(readPhoneUi()).toBe('classic');
  });

  it('re-renders every user of the hook when one of them flips it', () => {
    const a = renderHook(() => usePhoneUi());
    const b = renderHook(() => usePhoneUi());
    expect(a.result.current[0]).toBe('classic');
    act(() => a.result.current[1]('app'));
    expect(a.result.current[0]).toBe('app');
    expect(b.result.current[0]).toBe('app');
    expect(localStorage.getItem(PHONE_UI_KEY)).toBe('app');
  });

  it('keeps working for the page when storage throws', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { result } = renderHook(() => usePhoneUi());
    expect(result.current[0]).toBe('classic');
    act(() => result.current[1]('app'));
    expect(result.current[0]).toBe('app');
  });
});
