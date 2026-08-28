import { useCallback, useSyncExternalStore } from 'react';

/**
 * Subscribe to a CSS media query from JS.
 *
 * Needed when a breakpoint has to change STRUCTURE, not just styling — e.g.
 * moving toolbar buttons into an overflow menu rather than merely restyling
 * them. Pure CSS can't relocate a node into a portal, and duplicating the
 * buttons in both places would double their event handlers and ids.
 *
 * Built on `useSyncExternalStore` rather than `useState` + `useEffect`.
 * `matchMedia` IS an external store, and this is the API React provides for
 * reading one: it re-reads the snapshot during render, so a match that flips
 * between render and subscription can't leave a stale value on screen — the
 * exact gap an effect-based version has to paper over with a synchronous
 * `setState` in the effect body (which is both a cascading-render hazard and
 * something the project's lint config rejects outright).
 *
 * SSR/JSDOM-safe: falls back to `false` when `matchMedia` is unavailable,
 * so an environment without it renders the desktop layout rather than
 * throwing.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  }, [query]);

  // Server render has no viewport — desktop layout is the safe default.
  const getServerSnapshot = useCallback(() => false, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
