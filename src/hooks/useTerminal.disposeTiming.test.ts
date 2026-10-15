/**
 * Disposing a terminal right after it opened, through the REAL useTerminal hook
 * (real xterm.js in jsdom, as in useTerminal.clearOutput.test.ts).
 *
 * xterm 5.5's Viewport schedules `setTimeout(syncScrollArea)` inside `open()`
 * and never checks for a disposal before it fires: a terminal disposed in the
 * same task threw "Cannot read properties of undefined (reading 'dimensions')"
 * from that timer. React's StrictMode does exactly that in development (mount,
 * unmount, mount), so every phone Terminal segment logged it (AASC-48). The hook
 * now lets xterm's pending timer run before it disposes.
 *
 * jsdom never reaches xterm's render path, so it can't throw that error itself:
 * these pin the timing (and that nothing leaks on the way); the browser check is
 * the phone harness in development, where the error no longer appears.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';
import { useTerminal } from './useTerminal';

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  class NoopObserver {
    observe() { /* noop */ }
    unobserve() { /* noop */ }
    disconnect() { /* noop */ }
  }
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= NoopObserver;
  (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver ??= NoopObserver;
});

function sizedContainer() {
  const div = document.createElement('div');
  document.body.appendChild(div);
  Object.defineProperty(div, 'offsetWidth', { value: 400, configurable: true });
  Object.defineProperty(div, 'offsetHeight', { value: 200, configurable: true });
  return div;
}

const fakeSocket = () => ({ readyState: 1, send: vi.fn() }) as unknown as WebSocket;
const nextTask = () => new Promise((r) => setTimeout(r, 20));

afterEach(() => { vi.restoreAllMocks(); });

describe('useTerminal — disposing a terminal that just opened', () => {
  it('a terminal unmounted in the same task as open() is still disposed, and nothing throws', async () => {
    const errors: string[] = [];
    const onError = (e: ErrorEvent) => { errors.push(String(e.message)); e.preventDefault(); };
    window.addEventListener('error', onError);
    const dispose = vi.spyOn(Terminal.prototype, 'dispose');
    const realOpen = Terminal.prototype.open;
    let unmountNow: (() => void) | null = null;
    vi.spyOn(Terminal.prototype, 'open').mockImplementation(function (this: Terminal, el: HTMLElement) {
      realOpen.call(this, el);
      // Gone in the same task (after the hook has taken the terminal), before
      // xterm's own setTimeout(syncScrollArea) runs: StrictMode's mount → unmount.
      queueMicrotask(() => unmountNow?.());
    });

    const hook = renderHook(() => useTerminal({ ws: fakeSocket() }));
    unmountNow = () => hook.unmount();
    act(() => { hook.result.current.containerRef.current = sizedContainer(); });
    await act(async () => {
      hook.result.current.attach('term-quick');
      await new Promise((r) => setTimeout(r, 300)); // setupWhenReady's rAF + timeout chain
    });
    await nextTask();
    window.removeEventListener('error', onError);

    expect(Terminal.prototype.open).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect(errors.filter((m) => m.includes('dimensions'))).toEqual([]);
  });

  it('disposes after a task, never inside the unmount itself', async () => {
    const dispose = vi.spyOn(Terminal.prototype, 'dispose');
    const hook = renderHook(() => useTerminal({ ws: fakeSocket() }));
    act(() => { hook.result.current.containerRef.current = sizedContainer(); });
    await act(async () => {
      hook.result.current.attach('term-later');
      await new Promise((r) => setTimeout(r, 300));
    });
    dispose.mockClear();

    hook.unmount();
    expect(dispose).not.toHaveBeenCalled();
    await nextTask();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
