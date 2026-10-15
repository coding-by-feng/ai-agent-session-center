// phoneAppearance.test.ts — system / light / dark on the phone (AASC-47).
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  PHONE_APPEARANCE_ATTR,
  PHONE_APPEARANCE_KEY,
  readPhoneAppearance,
  resetPhoneAppearanceForTest,
  setPhoneAppearance,
  usePhoneAppearanceOnBody,
} from './phoneAppearance';

describe('phoneAppearance', () => {
  beforeEach(() => {
    localStorage.clear();
    resetPhoneAppearanceForTest();
    document.body.removeAttribute(PHONE_APPEARANCE_ATTR);
  });

  it('follows the system unless light or dark was chosen', () => {
    expect(readPhoneAppearance()).toBe('system');
    localStorage.setItem(PHONE_APPEARANCE_KEY, 'sepia');
    expect(readPhoneAppearance()).toBe('system');
    setPhoneAppearance('dark');
    expect(localStorage.getItem(PHONE_APPEARANCE_KEY)).toBe('dark');
    setPhoneAppearance('system');
    expect(localStorage.getItem(PHONE_APPEARANCE_KEY)).toBeNull();
  });

  it('mirrors the choice onto <body> while the frame is up, and clears it after', () => {
    const { unmount } = renderHook(() => usePhoneAppearanceOnBody());
    expect(document.body.hasAttribute(PHONE_APPEARANCE_ATTR)).toBe(false);
    act(() => setPhoneAppearance('light'));
    expect(document.body.getAttribute(PHONE_APPEARANCE_ATTR)).toBe('light');
    act(() => setPhoneAppearance('dark'));
    expect(document.body.getAttribute(PHONE_APPEARANCE_ATTR)).toBe('dark');
    act(() => setPhoneAppearance('system'));
    expect(document.body.hasAttribute(PHONE_APPEARANCE_ATTR)).toBe(false);
    act(() => setPhoneAppearance('dark'));
    unmount();
    expect(document.body.hasAttribute(PHONE_APPEARANCE_ATTR)).toBe(false);
  });
});
