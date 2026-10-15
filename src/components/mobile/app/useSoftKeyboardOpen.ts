/**
 * useSoftKeyboardOpen — is the on-screen keyboard up (AASC-39)? The tab bar
 * hides while it is, so it doesn't ride the keyboard and eat the space above it.
 *
 * A web page can't ask the keyboard directly. It is up when a text field has
 * focus AND the screen got shorter: the window itself (the Capacitor shell
 * resizes the WebView, `Keyboard.resize: 'native'`) or the visual viewport (a
 * phone browser lays the keyboard over the page). Focus alone isn't enough:
 * Android's back button closes the keyboard but leaves the field focused, and
 * the tab bar must come back then. The window's full height is remembered per
 * width, so turning the phone doesn't read as a keyboard.
 */
import { useSyncExternalStore } from 'react';

/** Shrinking by more than this is a keyboard, not a toolbar. */
const KEYBOARD_MIN_PX = 150;

/** The tallest window seen at each width (a rotation changes both). */
const fullHeight = new Map<number, number>();

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) {
    return !el.readOnly && !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

function snapshot(): boolean {
  if (typeof window === 'undefined') return false;
  const { innerWidth: w, innerHeight: h } = window;
  const tallest = Math.max(fullHeight.get(w) ?? 0, h);
  fullHeight.set(w, tallest);
  if (!isTextEntry(document.activeElement)) return false;
  const windowShrunk = tallest - h > KEYBOARD_MIN_PX;
  const vv = window.visualViewport;
  const viewportShrunk = !!vv && h - vv.height > KEYBOARD_MIN_PX;
  return windowShrunk || viewportShrunk;
}

function subscribe(onChange: () => void): () => void {
  document.addEventListener('focusin', onChange);
  document.addEventListener('focusout', onChange);
  window.addEventListener('resize', onChange);
  window.visualViewport?.addEventListener('resize', onChange);
  return () => {
    document.removeEventListener('focusin', onChange);
    document.removeEventListener('focusout', onChange);
    window.removeEventListener('resize', onChange);
    window.visualViewport?.removeEventListener('resize', onChange);
  };
}

export function useSoftKeyboardOpen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
