/**
 * useVisibleHeight — how much of the screen the page can show right now, in px
 * (AASC-43): the visual viewport, so an open on-screen keyboard is taken off
 * whether the WebView shrinks for it (the phone app) or lays it over the page
 * (a phone browser). 0 before there is a window.
 */
import { useSyncExternalStore } from 'react';

function read(): number {
  if (typeof window === 'undefined') return 0;
  return Math.round(window.visualViewport?.height ?? window.innerHeight);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  window.visualViewport?.addEventListener('resize', onChange);
  return () => {
    window.removeEventListener('resize', onChange);
    window.visualViewport?.removeEventListener('resize', onChange);
  };
}

export function useVisibleHeight(): number {
  return useSyncExternalStore(subscribe, read, () => 0);
}
