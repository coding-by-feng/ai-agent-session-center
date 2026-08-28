// useMediaQuery.test.ts — backs the PROJECT toolbar's mobile overflow menu.
//
// This hook decides STRUCTURE, not styling: below the breakpoint the toolbar's
// tail is moved into a portaled "⋯" menu, above it those same buttons render
// inline. Getting the boolean wrong doesn't just look off — it either strands
// the icons off-screen again (the original bug) or renders them twice.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMediaQuery } from './useMediaQuery';

type Listener = (e: MediaQueryListEvent) => void;

/** Installs a controllable matchMedia and returns a setter that flips the
 *  match state and notifies subscribers, like a real resize would. */
function stubMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>();
  let matches = initial;
  const mql = {
    get matches() { return matches; },
    addEventListener: (_: string, l: Listener) => { listeners.add(l); },
    removeEventListener: (_: string, l: Listener) => { listeners.delete(l); },
  };
  vi.stubGlobal('matchMedia', vi.fn(() => mql));
  return {
    set(next: boolean) {
      matches = next;
      listeners.forEach((l) => l({ matches: next } as MediaQueryListEvent));
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useMediaQuery', () => {
  it('returns the initial match state synchronously', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery('(max-width: 480px)'));
    expect(result.current).toBe(true);
  });

  it('returns false when the query does not match', () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(max-width: 480px)'));
    expect(result.current).toBe(false);
  });

  it('updates when the query starts matching (resize / rotate)', () => {
    const mm = stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(max-width: 480px)'));
    expect(result.current).toBe(false);

    act(() => mm.set(true));
    expect(result.current).toBe(true);
  });

  it('updates when the query stops matching', () => {
    const mm = stubMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery('(max-width: 480px)'));
    act(() => mm.set(false));
    expect(result.current).toBe(false);
  });

  it('unsubscribes on unmount — no listener left behind', () => {
    const mm = stubMatchMedia(false);
    const { unmount } = renderHook(() => useMediaQuery('(max-width: 480px)'));
    expect(mm.listenerCount()).toBe(1);
    unmount();
    expect(mm.listenerCount()).toBe(0);
  });

  it('returns false rather than throwing when matchMedia is unavailable', () => {
    // jsdom/SSR without matchMedia must degrade to the desktop layout, not
    // crash the whole PROJECT tab.
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useMediaQuery('(max-width: 480px)'));
    expect(result.current).toBe(false);
  });
});
