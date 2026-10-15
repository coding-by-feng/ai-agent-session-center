/**
 * usePhoneUi — which phone layout this device shows (AASC-38).
 *
 *   localStorage['aasc.phoneUi'] = 'classic' | 'app'     (default 'classic')
 *
 * 'app' is the redesigned phone frame (tab bar, stacks, sheets), built behind
 * this switch until it reaches parity (docs/plans/mobile/11 §8). Only a phone-sized
 * viewport reads it: App.tsx shows the frame when `useIsMobile()` AND this is
 * 'app', so the desktop never changes. Per device, like every phone setting, and
 * nothing secret. Storage can be missing or throw (a private window): it then
 * reads as 'classic' and a switch lasts for the page's life.
 *
 * Tiny on purpose: App.tsx imports it, so it sits in the desktop's entry chunk.
 */
import { useCallback, useSyncExternalStore } from 'react';

export type PhoneUi = 'classic' | 'app';

export const PHONE_UI_KEY = 'aasc.phoneUi';

const listeners = new Set<() => void>();
/** The value set on this page when storage refused it. */
let memory: PhoneUi | null = null;

export function readPhoneUi(): PhoneUi {
  try {
    const stored = localStorage.getItem(PHONE_UI_KEY);
    if (stored === 'app' || stored === 'classic') return stored;
  } catch {
    /* storage unavailable */
  }
  return memory ?? 'classic';
}

export function writePhoneUi(next: PhoneUi): void {
  memory = next;
  try {
    localStorage.setItem(PHONE_UI_KEY, next);
  } catch {
    /* storage unavailable: kept in memory for this page */
  }
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab of the same page flipped it.
  const onStorage = (e: StorageEvent) => {
    if (e.key === PHONE_UI_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}

const serverSnapshot = (): PhoneUi => 'classic';

export function usePhoneUi(): [PhoneUi, (next: PhoneUi) => void] {
  const value = useSyncExternalStore(subscribe, readPhoneUi, serverSnapshot);
  const set = useCallback((next: PhoneUi) => writePhoneUi(next), []);
  return [value, set];
}
