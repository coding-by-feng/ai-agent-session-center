/**
 * useSoftKeyboardOpen — is the on-screen keyboard up (AASC-39)? The tab bar
 * hides while it is, so it doesn't ride the keyboard and eat the space above it.
 *
 * A web page can't ask the keyboard directly. It is up when a text field has
 * focus on a touch device (`pointer: coarse`), or when the visual viewport has
 * shrunk well below the window (a keyboard that resizes the viewport, e.g. a
 * phone browser at desktop-class pointer settings). The Capacitor shell resizes
 * the WebView natively (`Keyboard.resize: 'native'`), so focus is what tells.
 */
import { useSyncExternalStore } from 'react';

/** The viewport shrinking by more than this is a keyboard, not a toolbar. */
const KEYBOARD_MIN_PX = 150;

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) {
    return !el.readOnly && !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

function snapshot(): boolean {
  if (typeof document === 'undefined') return false;
  if (!isTextEntry(document.activeElement)) return false;
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const vv = window.visualViewport;
  const shrunk = !!vv && window.innerHeight - vv.height > KEYBOARD_MIN_PX;
  return coarse || shrunk;
}

function subscribe(onChange: () => void): () => void {
  document.addEventListener('focusin', onChange);
  document.addEventListener('focusout', onChange);
  window.visualViewport?.addEventListener('resize', onChange);
  return () => {
    document.removeEventListener('focusin', onChange);
    document.removeEventListener('focusout', onChange);
    window.visualViewport?.removeEventListener('resize', onChange);
  };
}

export function useSoftKeyboardOpen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
