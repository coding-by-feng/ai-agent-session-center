// phoneAppearance.test.ts — the phone's theme and text size on <body> (AASC-47, AASC-58).
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  LEGACY_PHONE_TEXT_SCALE_KEY,
  PHONE_TEXT_BASE,
  PHONE_TEXT_SCALES,
  PHONE_TEXT_SCALE_KEY,
  readPhoneTextScale,
  resetPhoneAppearanceForTest,
  setPhoneTextScale,
  stepPhoneTextScale,
  usePhoneAppearanceOnBody,
} from './phoneAppearance';
import { PHONE_PALETTES, PHONE_SCHEME_ATTR } from './phoneThemes';
import { useSettingsStore } from '@/stores/settingsStore';

describe('phoneAppearance', () => {
  beforeEach(() => {
    localStorage.clear();
    resetPhoneAppearanceForTest();
    document.body.removeAttribute(PHONE_SCHEME_ATTR);
    document.body.removeAttribute('style');
    useSettingsStore.setState({ themeName: 'windows-xp' });
  });

  it('keeps a text size of this phone’s own, default 100%, ignoring junk', () => {
    expect(readPhoneTextScale()).toBe(1);
    localStorage.setItem(PHONE_TEXT_SCALE_KEY, '7');
    expect(readPhoneTextScale()).toBe(1);
    setPhoneTextScale(1.25);
    expect(localStorage.getItem(PHONE_TEXT_SCALE_KEY)).toBe('1.25');
    expect(readPhoneTextScale()).toBe(1.25);
    setPhoneTextScale(1);
    expect(localStorage.getItem(PHONE_TEXT_SCALE_KEY)).toBeNull();
  });

  // Oct 21 2026: what used to be 80 % is the default and reads 100 %; 125 % is the old 100 %.
  it('labels sizes from a base of 0.8, with the old default one step at 125 %', () => {
    expect(PHONE_TEXT_BASE).toBe(0.8);
    expect(PHONE_TEXT_SCALES).toEqual([0.85, 0.9, 1, 1.1, 1.25, 1.5]);
    expect(1.25 * PHONE_TEXT_BASE).toBe(1);
  });

  it('moves a size saved under the old physical scale to the nearest new step', () => {
    const cases: [string, number][] = [['0.8', 1], ['0.85', 1.1], ['0.9', 1.1], ['1', 1.25], ['1.15', 1.5], ['1.3', 1.5]];
    for (const [old, label] of cases) {
      localStorage.clear();
      localStorage.setItem(LEGACY_PHONE_TEXT_SCALE_KEY, old);
      resetPhoneAppearanceForTest();
      expect(readPhoneTextScale()).toBe(label);
      expect(localStorage.getItem(LEGACY_PHONE_TEXT_SCALE_KEY)).toBeNull();
      expect(localStorage.getItem(PHONE_TEXT_SCALE_KEY)).toBe(label === 1 ? null : String(label));
    }
  });

  it('steps through the sizes and stops at either end', () => {
    expect(PHONE_TEXT_SCALES[0]).toBeLessThan(1);
    expect(PHONE_TEXT_SCALES.at(-1)).toBeGreaterThan(1);
    expect(stepPhoneTextScale(1, 1)).toBe(PHONE_TEXT_SCALES[PHONE_TEXT_SCALES.indexOf(1) + 1]);
    expect(stepPhoneTextScale(PHONE_TEXT_SCALES[0], -1)).toBe(PHONE_TEXT_SCALES[0]);
    expect(stepPhoneTextScale(PHONE_TEXT_SCALES.at(-1)!, 1)).toBe(PHONE_TEXT_SCALES.at(-1));
  });

  it('puts the chosen theme, its light / dark and the text size on <body>, follows changes, and clears all of it after', () => {
    const { unmount } = renderHook(() => usePhoneAppearanceOnBody());
    const body = document.body;
    expect(body.getAttribute(PHONE_SCHEME_ATTR)).toBe('light');
    expect(body.style.getPropertyValue('--ph-bg')).toBe(PHONE_PALETTES['windows-xp'].bg);
    expect(body.style.getPropertyValue('--ph-text-scale')).toBe('0.8');

    act(() => useSettingsStore.setState({ themeName: 'dracula' }));
    expect(body.getAttribute(PHONE_SCHEME_ATTR)).toBe('dark');
    expect(body.style.getPropertyValue('--ph-bg')).toBe(PHONE_PALETTES.dracula.bg);
    expect(body.style.getPropertyValue('--ph-accent')).toBe(PHONE_PALETTES.dracula.accent);

    act(() => setPhoneTextScale(1.25));
    expect(body.style.getPropertyValue('--ph-text-scale')).toBe('1');

    unmount();
    expect(body.hasAttribute(PHONE_SCHEME_ATTR)).toBe(false);
    expect(body.style.getPropertyValue('--ph-bg')).toBe('');
    expect(body.style.getPropertyValue('--ph-text-scale')).toBe('');
  });
});
