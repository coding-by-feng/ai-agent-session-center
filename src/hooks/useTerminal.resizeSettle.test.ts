/**
 * A window drag reaches the PTY as ONE resize (Nov 18 2026), through the real
 * useTerminal hook (real xterm.js in jsdom, as in useTerminal.fitMode.test.ts).
 *
 * Each resize the PTY hears makes Claude's inline renderer leave its old frame in
 * scrollback, so a slow drag that paused three times printed the working line three
 * times. xterm still re-fits locally on every settled size; only the PTY waits
 * (ptyResizeSettle.ts).
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { PTY_RESIZE_SETTLE_MS } from '@/lib/ptyResizeSettle';

vi.mock('@/lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform')>();
  return { ...actual, useIsMobile: () => false, useIsNativeMobileApp: () => false };
});

import { useTerminal } from './useTerminal';

const resizeObservers: Array<{ cb: ResizeObserverCallback; targets: Element[] }> = [];

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  class RecordingResizeObserver {
    private entry: { cb: ResizeObserverCallback; targets: Element[] };
    constructor(cb: ResizeObserverCallback) {
      this.entry = { cb, targets: [] };
      resizeObservers.push(this.entry);
    }
    observe(el: Element) { this.entry.targets.push(el); }
    unobserve() { /* noop */ }
    disconnect() { this.entry.targets = []; }
  }
  class NoopObserver {
    observe() { /* noop */ }
    unobserve() { /* noop */ }
    disconnect() { /* noop */ }
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
  (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver ??= NoopObserver;
});

afterEach(() => {
  resizeObservers.length = 0;
  vi.restoreAllMocks();
});

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

const resizesSent = (ws: WebSocket) =>
  (ws.send as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
    .filter((m) => m.type === 'terminal_resize');

describe('useTerminal — window drag', () => {
  it('tells the PTY once, after the drag has settled', async () => {
    const ws = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
    const hook = renderHook(() => useTerminal({ ws }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'offsetWidth', { value: 900, configurable: true });
    Object.defineProperty(container, 'offsetHeight', { value: 500, configurable: true });
    act(() => { hook.result.current.containerRef.current = container; });
    await act(async () => {
      hook.result.current.attach('term-drag');
      await new Promise((r) => setTimeout(r, 300));
    });
    // Let anything the attach itself sends land, then count from zero.
    await wait(PTY_RESIZE_SETTLE_MS + 100);
    (ws.send as ReturnType<typeof vi.fn>).mockClear();

    const fire = () => {
      for (const o of resizeObservers) {
        if (o.targets.includes(container)) o.cb([], {} as ResizeObserver);
      }
    };
    // A slow drag: three steps, each followed by a 250 ms pause (the old 200 ms
    // debounce sent a resize after every one of them).
    for (let i = 0; i < 3; i += 1) {
      act(fire);
      await wait(250);
    }
    expect(resizesSent(ws)).toEqual([]);

    await wait(PTY_RESIZE_SETTLE_MS);
    expect(resizesSent(ws)).toHaveLength(1);
    expect(resizesSent(ws)[0]).toMatchObject({ terminalId: 'term-drag' });
  });
});
