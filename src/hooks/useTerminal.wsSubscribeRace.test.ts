/**
 * Regression test for the blank-pop-out-window bug (Aug 2026).
 *
 * `WsClient` assigns `this.ws = new WebSocket(url)` exactly once per
 * `connect()` call — `onopen` only flips a status flag, it never replaces
 * `this.ws`. So across the CONNECTING -> OPEN transition of the FIRST
 * connection after mount, the `ws` object passed into `useTerminal` is the
 * SAME reference throughout; only its internal `readyState` mutates. An
 * effect keyed on `[ws]` alone compares that reference with `Object.is()` and
 * sees no change, so it silently never re-runs for this transition.
 *
 * This is invisible in the MAIN window, whose socket has typically been open
 * for minutes before any terminal is ever attached — `attach()`'s own inline
 * subscribe already succeeds by the time it runs. A freshly-opened POPOUT
 * window has no such head start: it constructs its WebSocket and calls
 * `attach()` in the same render pass, so the socket is still CONNECTING when
 * `attach()` runs and correctly skips subscribing. Without a second
 * dependency that reacts to the readyState mutation itself, nothing ever
 * subscribes afterwards — the terminal opens, the toolbar renders, but no
 * output ever arrives. No error fires, because nothing failed; the terminal
 * was simply never subscribed in the first place.
 *
 * These tests exercise the REAL `useTerminal` hook end to end (real xterm.js
 * construction against a jsdom container, not a mock of the hook's internals)
 * — this class of bug is exactly what "confirmed via harness, not reasoned
 * about" exists to catch, and reasoning about the effect in isolation would
 * not have caught the reference-vs-value distinction that caused it.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminal } from './useTerminal';
import { useWsStore } from '@/stores/wsStore';

beforeAll(() => {
  // jsdom has no matchMedia; xterm's DOM renderer needs it for DPR-change
  // detection at construction time.
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  // jsdom implements neither observer; useTerminal constructs both
  // unconditionally on attach. No-op stand-ins are fine — these tests only
  // care about the ws-subscribe effect, not resize/visibility behavior.
  class NoopObserver {
    observe() { /* noop */ }
    unobserve() { /* noop */ }
    disconnect() { /* noop */ }
  }
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= NoopObserver;
  (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver ??= NoopObserver;
});

/** A minimal stand-in exposing only what useTerminal actually reads on `ws`
 *  (confirmed by grep: `.send()` and `.readyState`, nothing else). */
function fakeSocket(readyState: number) {
  return { readyState, send: vi.fn() } as unknown as WebSocket;
}

/** A real jsdom div with layout dimensions forced nonzero, so
 *  `setupWhenReady`'s poll succeeds immediately instead of falling through to
 *  the (also-polyfilled) IntersectionObserver fallback. */
function sizedContainer() {
  const div = document.createElement('div');
  document.body.appendChild(div);
  Object.defineProperty(div, 'offsetWidth', { value: 400, configurable: true });
  Object.defineProperty(div, 'offsetHeight', { value: 200, configurable: true });
  return div;
}

function subscribeCallsFor(ws: WebSocket) {
  return (ws.send as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => String(c[0]).includes('terminal_subscribe'));
}

describe('useTerminal — subscribes once the socket actually opens', () => {
  it('subscribes when the SAME ws object mutates readyState 0 -> 1 (the popout race)', async () => {
    const ws = fakeSocket(0); // CONNECTING — matches a freshly-constructed WsClient
    const { result, rerender } = renderHook(
      ({ ws }) => useTerminal({ ws }),
      { initialProps: { ws } },
    );

    act(() => { result.current.containerRef.current = sizedContainer(); });
    await act(async () => {
      result.current.attach('term-popout-race');
      // Let setupWhenReady's rAF+setTimeout chain run to completion.
      await new Promise((r) => setTimeout(r, 300));
    });

    // Nothing subscribed yet — the socket was still CONNECTING when attach()
    // ran, so its inline subscribe correctly skipped.
    expect(subscribeCallsFor(ws).length).toBe(0);

    // `onopen` firing on a real WebSocket does exactly this: it mutates
    // readyState in place. WsClient never replaces the object here.
    (ws as unknown as { readyState: number }).readyState = 1;
    rerender({ ws }); // SAME reference — this is the case `[ws]` alone misses

    expect(subscribeCallsFor(ws).length).toBeGreaterThan(0);
  });

  it('still subscribes when a genuinely NEW object arrives already open (normal reconnect)', async () => {
    // Guards the other direction: the fix must not have narrowed this to
    // "readyState changes only" and broken the reference-change path that
    // already worked correctly for real reconnects.
    const ws1 = fakeSocket(0);
    const { result, rerender } = renderHook(
      ({ ws }) => useTerminal({ ws }),
      { initialProps: { ws: ws1 } },
    );
    act(() => { result.current.containerRef.current = sizedContainer(); });
    await act(async () => {
      result.current.attach('term-reconnect');
      await new Promise((r) => setTimeout(r, 300));
    });

    const ws2 = fakeSocket(1); // scheduleReconnect() -> connect() -> a new WebSocket
    rerender({ ws: ws2 });

    expect(subscribeCallsFor(ws2).length).toBeGreaterThan(0);
  });

  it('does not subscribe on a render where neither ws nor readyState changed', async () => {
    // The dependency addition must not turn this into an every-render
    // resubscribe loop — only a genuine transition should fire it.
    const ws = fakeSocket(1); // already open from the start
    const { result, rerender } = renderHook(
      ({ ws, themeName }: { ws: WebSocket; themeName: string }) => useTerminal({ ws, themeName }),
      { initialProps: { ws, themeName: 'auto' } },
    );
    act(() => { result.current.containerRef.current = sizedContainer(); });
    await act(async () => {
      result.current.attach('term-stable');
      await new Promise((r) => setTimeout(r, 300));
    });

    const before = subscribeCallsFor(ws).length;
    expect(before).toBeGreaterThan(0); // sanity: the initial subscribe did happen

    // Re-render for an UNRELATED reason (a different prop), same ws, same
    // readyState.
    rerender({ ws, themeName: 'dracula' });

    expect(subscribeCallsFor(ws).length).toBe(before); // unchanged — no extra send
  });
});

describe('useTerminal — the socket opening must not depend on a parent re-render', () => {
  beforeEach(() => { useWsStore.setState({ connected: false }); });

  it('subscribes when the store reports the socket open, with no rerender from the parent', async () => {
    // memo(TerminalContainer) swallows the parent re-render that follows onopen.
    const ws = fakeSocket(0);
    const { result } = renderHook(({ ws }) => useTerminal({ ws }), { initialProps: { ws } });
    act(() => { result.current.containerRef.current = sizedContainer(); });
    await act(async () => {
      result.current.attach('term-memo-boundary');
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(subscribeCallsFor(ws).length).toBe(0);

    (ws as unknown as { readyState: number }).readyState = 1;
    act(() => { useWsStore.setState({ connected: true }); });

    expect(subscribeCallsFor(ws).length).toBe(1);
  });

  it('still subscribes once setup finishes when the socket opened before the container had a size', async () => {
    const ws = fakeSocket(0);
    const { result } = renderHook(({ ws }) => useTerminal({ ws }), { initialProps: { ws } });
    const div = document.createElement('div');
    document.body.appendChild(div);
    let height = 0;
    Object.defineProperty(div, 'offsetWidth', { configurable: true, get: () => height * 2 });
    Object.defineProperty(div, 'offsetHeight', { configurable: true, get: () => height });
    act(() => { result.current.containerRef.current = div; });
    act(() => { result.current.attach('term-late-layout'); });

    (ws as unknown as { readyState: number }).readyState = 1;
    act(() => { useWsStore.setState({ connected: true }); });
    expect(subscribeCallsFor(ws).length).toBe(0); // no xterm to replay into yet

    height = 200;
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });

    expect(subscribeCallsFor(ws).length).toBe(1);
  });

  it('sends exactly one subscribe for a socket already open at attach — each one replays the scrollback', async () => {
    const ws = fakeSocket(1);
    const { result, rerender } = renderHook(({ ws }) => useTerminal({ ws }), { initialProps: { ws } });
    act(() => { result.current.containerRef.current = sizedContainer(); });
    await act(async () => {
      result.current.attach('term-single-replay');
      await new Promise((r) => setTimeout(r, 300));
    });
    act(() => { useWsStore.setState({ connected: true }); });
    rerender({ ws });

    expect(subscribeCallsFor(ws).length).toBe(1);
  });
});
