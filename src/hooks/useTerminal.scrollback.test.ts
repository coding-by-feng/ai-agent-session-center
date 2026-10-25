/**
 * Settings ▸ Terminal ▸ Live scrollback reaches xterm, through the REAL
 * useTerminal hook (real xterm.js in jsdom, as in useTerminal.fitMode.test.ts).
 * xterm takes `scrollback` at construction, so a change applies to the next
 * terminal opened and leaves the open one alone.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';

import { useTerminal } from './useTerminal';
import { useSettingsStore } from '@/stores/settingsStore';

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

afterEach(() => vi.restoreAllMocks());

function sizedContainer() {
  const div = document.createElement('div');
  document.body.appendChild(div);
  Object.defineProperty(div, 'offsetWidth', { value: 800, configurable: true });
  Object.defineProperty(div, 'offsetHeight', { value: 400, configurable: true });
  return div;
}

describe('useTerminal — live scrollback setting', () => {
  it('opens each terminal with the current setting; an open one keeps its own', async () => {
    useSettingsStore.setState({ terminalScrollbackLines: 20_000, persistSetting: vi.fn(async () => {}) } as never);
    const opened: Terminal[] = [];
    const realOpen = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, 'open').mockImplementation(function (this: Terminal, parent: HTMLElement) {
      opened.push(this);
      return realOpen.call(this, parent);
    });
    const ws = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
    const hook = renderHook(() => useTerminal({ ws }));
    act(() => { hook.result.current.containerRef.current = sizedContainer(); });

    await act(async () => {
      hook.result.current.attach('term-a');
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(opened.at(-1)!.options.scrollback).toBe(20_000);
    const first = opened.at(-1)!;

    act(() => useSettingsStore.getState().setTerminalScrollbackLines(100_000));
    expect(first.options.scrollback).toBe(20_000);

    await act(async () => {
      hook.result.current.attach('term-b');
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(opened.at(-1)).not.toBe(first);
    expect(opened.at(-1)!.options.scrollback).toBe(100_000);
  });
});
