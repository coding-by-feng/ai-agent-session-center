/**
 * phoneAppearance.ts — More → Settings → Appearance on the phone (AASC-47, DU5):
 * follow the system's light / dark setting (the default), or keep one of them.
 *
 * This phone only (`localStorage['aasc.phoneAppearance']`). The frame mirrors it
 * onto <body> as `data-ph-appearance="light|dark"` (absent = system), which
 * phoneTokens.css reads; the accent and status hues still come from the theme.
 */
import { useLayoutEffect, useSyncExternalStore } from 'react';

export type PhoneAppearance = 'system' | 'light' | 'dark';

export const PHONE_APPEARANCES: ReadonlyArray<{ value: PhoneAppearance; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export const PHONE_APPEARANCE_KEY = 'aasc.phoneAppearance';
export const PHONE_APPEARANCE_ATTR = 'data-ph-appearance';

const listeners = new Set<() => void>();

function parse(value: string | null): PhoneAppearance {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function readPhoneAppearance(): PhoneAppearance {
  try {
    return parse(localStorage.getItem(PHONE_APPEARANCE_KEY));
  } catch {
    return 'system';
  }
}

let current: PhoneAppearance = readPhoneAppearance();

export function setPhoneAppearance(value: PhoneAppearance): void {
  try {
    if (value === 'system') localStorage.removeItem(PHONE_APPEARANCE_KEY);
    else localStorage.setItem(PHONE_APPEARANCE_KEY, value);
  } catch {
    /* storage unavailable: the choice lasts until the page reloads */
  }
  current = value;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

export function usePhoneAppearance(): [PhoneAppearance, (value: PhoneAppearance) => void] {
  return [useSyncExternalStore(subscribe, snapshot, snapshot), setPhoneAppearance];
}

/** Put the choice on `el` (absent for system). */
export function applyPhoneAppearance(el: HTMLElement, value: PhoneAppearance): void {
  if (value === 'system') el.removeAttribute(PHONE_APPEARANCE_ATTR);
  else el.setAttribute(PHONE_APPEARANCE_ATTR, value);
}

/** The frame: keep <body> in step with the choice while mounted (before paint: no flash of the other palette). */
export function usePhoneAppearanceOnBody(): void {
  const [value] = usePhoneAppearance();
  useLayoutEffect(() => {
    applyPhoneAppearance(document.body, value);
    return () => document.body.removeAttribute(PHONE_APPEARANCE_ATTR);
  }, [value]);
}

/** Tests: re-read storage. */
export function resetPhoneAppearanceForTest(): void {
  current = readPhoneAppearance();
  listeners.forEach((l) => l());
}
