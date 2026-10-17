/**
 * phoneAppearance.ts — what More → Settings → Appearance changes on the phone
 * (AASC-47; themes AASC-58):
 *
 *  - the theme: one of the desktop's ten (`settingsStore.themeName`, kept in
 *    this device's own IndexedDB like every setting, so a phone's choice never
 *    reaches the Mac's). Light or dark follows the theme (phoneThemes.ts);
 *  - the text size: a scale on every phone type token (`--ph-text-scale`),
 *    this phone only (`localStorage['aasc.phoneTextScale']`).
 *
 * The frame mirrors both onto <body> while it is mounted, so the frame and
 * everything portaled to <body> (sheets, menus, toasts) wear them.
 */
import { useLayoutEffect, useSyncExternalStore } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { applyPhoneTheme, clearPhoneTheme } from './phoneThemes';

/** 80 · 85 · 90 · 100 (default) · 115 · 130 %: a phone screen is small, so most steps go down. */
export const PHONE_TEXT_SCALES: readonly number[] = [0.8, 0.85, 0.9, 1, 1.15, 1.3];
export const PHONE_TEXT_SCALE_KEY = 'aasc.phoneTextScale';
const DEFAULT_SCALE = 1;
const TEXT_SCALE_VAR = '--ph-text-scale';

const listeners = new Set<() => void>();

function parse(value: string | null): number {
  const n = value === null ? NaN : Number(value);
  return PHONE_TEXT_SCALES.includes(n) ? n : DEFAULT_SCALE;
}

export function readPhoneTextScale(): number {
  try {
    return parse(localStorage.getItem(PHONE_TEXT_SCALE_KEY));
  } catch {
    return DEFAULT_SCALE;
  }
}

let current = readPhoneTextScale();

export function setPhoneTextScale(value: number): void {
  const next = PHONE_TEXT_SCALES.includes(value) ? value : DEFAULT_SCALE;
  try {
    if (next === DEFAULT_SCALE) localStorage.removeItem(PHONE_TEXT_SCALE_KEY);
    else localStorage.setItem(PHONE_TEXT_SCALE_KEY, String(next));
  } catch {
    /* storage unavailable: the choice lasts until the page reloads */
  }
  current = next;
  listeners.forEach((l) => l());
}

/** The next size up (1) or down (-1), staying at the ends. */
export function stepPhoneTextScale(value: number, direction: 1 | -1): number {
  const at = Math.max(0, PHONE_TEXT_SCALES.indexOf(value));
  return PHONE_TEXT_SCALES[Math.min(PHONE_TEXT_SCALES.length - 1, Math.max(0, at + direction))];
}

/** "100%". */
export function phoneTextScaleLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

export function usePhoneTextScale(): [number, (value: number) => void] {
  return [useSyncExternalStore(subscribe, snapshot, snapshot), setPhoneTextScale];
}

/** The frame: keep <body> in step with the theme and text size while mounted (before paint: no flash of the old palette). */
export function usePhoneAppearanceOnBody(): void {
  const themeName = useSettingsStore((s) => s.themeName);
  const [scale] = usePhoneTextScale();
  useLayoutEffect(() => {
    applyPhoneTheme(document.body, themeName);
    return () => clearPhoneTheme(document.body);
  }, [themeName]);
  useLayoutEffect(() => {
    document.body.style.setProperty(TEXT_SCALE_VAR, String(scale));
    return () => {
      document.body.style.removeProperty(TEXT_SCALE_VAR);
    };
  }, [scale]);
}

/** Tests: re-read storage. */
export function resetPhoneAppearanceForTest(): void {
  current = readPhoneTextScale();
  listeners.forEach((l) => l());
}
