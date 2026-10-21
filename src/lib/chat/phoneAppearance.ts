/**
 * phoneAppearance.ts — what More → Settings → Appearance changes on the phone
 * (AASC-47; themes AASC-58):
 *
 *  - the theme: one of the desktop's ten (`settingsStore.themeName`, kept in
 *    this device's own IndexedDB like every setting, so a phone's choice never
 *    reaches the Mac's). Light or dark follows the theme (phoneThemes.ts);
 *  - the text size: a scale on every phone type token (`--ph-text-scale`),
 *    this phone only (`localStorage['aasc.phoneTextSize']`, a label: 100 % is
 *    `PHONE_TEXT_BASE`).
 *
 * The frame mirrors both onto <body> while it is mounted, so the frame and
 * everything portaled to <body> (sheets, menus, toasts) wear them.
 */
import { useLayoutEffect, useSyncExternalStore } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { applyPhoneTheme, clearPhoneTheme } from './phoneThemes';

/**
 * The label 100 % is this physical scale. Oct 21 2026: what used to be the
 * smallest step (80 %) became the default, so the labels count from it.
 */
export const PHONE_TEXT_BASE = 0.8;
/** 85 · 90 · 100 (default) · 110 · 125 (the old 100 %) · 150 %, as labels. */
export const PHONE_TEXT_SCALES: readonly number[] = [0.85, 0.9, 1, 1.1, 1.25, 1.5];
/** A label, not the physical scale: a new key, so an old physical value is never read as one. */
export const PHONE_TEXT_SCALE_KEY = 'aasc.phoneTextSize';
/** Before Oct 21 2026: the physical scale (0.8 · 0.85 · 0.9 · 1 · 1.15 · 1.3). */
export const LEGACY_PHONE_TEXT_SCALE_KEY = 'aasc.phoneTextScale';
const DEFAULT_SCALE = 1;
const TEXT_SCALE_VAR = '--ph-text-scale';

const listeners = new Set<() => void>();

function parse(value: string | null): number {
  const n = value === null ? NaN : Number(value);
  return PHONE_TEXT_SCALES.includes(n) ? n : DEFAULT_SCALE;
}

/** The step whose physical size is closest to an old physical scale (ties go up). */
function labelForPhysical(physical: number): number {
  return PHONE_TEXT_SCALES.reduce((best, s) =>
    Math.abs(s * PHONE_TEXT_BASE - physical) <= Math.abs(best * PHONE_TEXT_BASE - physical) ? s : best);
}

/** Move a size saved under the old key, so the text keeps its size through the update. */
function migrateLegacy(): void {
  const old = localStorage.getItem(LEGACY_PHONE_TEXT_SCALE_KEY);
  if (old === null) return;
  localStorage.removeItem(LEGACY_PHONE_TEXT_SCALE_KEY);
  const physical = Number(old);
  if (!Number.isFinite(physical) || physical <= 0 || localStorage.getItem(PHONE_TEXT_SCALE_KEY) !== null) return;
  const label = labelForPhysical(physical);
  if (label !== DEFAULT_SCALE) localStorage.setItem(PHONE_TEXT_SCALE_KEY, String(label));
}

export function readPhoneTextScale(): number {
  try {
    migrateLegacy();
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

/** The multiplier the type tokens use for a label (1 → 0.8). Rounded: 1.1 × 0.8 is 0.8800000000000001. */
export function phoneTextPhysicalScale(label: number): number {
  return Math.round(label * PHONE_TEXT_BASE * 1000) / 1000;
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
    document.body.style.setProperty(TEXT_SCALE_VAR, String(phoneTextPhysicalScale(scale)));
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
