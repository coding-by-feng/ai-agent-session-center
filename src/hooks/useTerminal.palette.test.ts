/**
 * An explicit palette (the phone app's theme, AASC-58), through the REAL
 * useTerminal hook (real xterm.js in jsdom, as in useTerminal.fitMode.test.ts):
 * it wins over the saved terminal theme when the terminal opens, and a new one
 * restyles the open terminal without reopening it.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Terminal, type ITheme } from '@xterm/xterm';

vi.mock('@/lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform')>();
  return { ...actual, useIsMobile: () => true, useIsNativeMobileApp: () => false };
});

import { useTerminal } from './useTerminal';
import { THEMES } from '@/components/terminal/themes';

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

afterEach(() => {
  localStorage.removeItem('terminal-theme');
  vi.restoreAllMocks();
});

function sizedContainer() {
  const div = document.createElement('div');
  document.body.appendChild(div);
  Object.defineProperty(div, 'offsetWidth', { value: 390, configurable: true });
  Object.defineProperty(div, 'offsetHeight', { value: 300, configurable: true });
  return div;
}

const PHONE: ITheme = { ...THEMES.default, background: '#fdf8ef', foreground: '#292420' };

describe('useTerminal — an explicit palette', () => {
  it('opens in the palette rather than the saved theme, and repaints on a new one', async () => {
    localStorage.setItem('terminal-theme', 'monokai');
    const opened: Terminal[] = [];
    const realOpen = Terminal.prototype.open;
    vi.spyOn(Terminal.prototype, 'open').mockImplementation(function (this: Terminal, parent: HTMLElement) {
      opened.push(this);
      return realOpen.call(this, parent);
    });
    const ws = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
    const hook = renderHook(({ palette }) => useTerminal({ ws, palette }), { initialProps: { palette: PHONE } });
    const container = sizedContainer();
    act(() => { hook.result.current.containerRef.current = container; });
    await act(async () => {
      hook.result.current.attach('term-1');
      await new Promise((r) => setTimeout(r, 300));
    });
    const term = opened.at(-1)!;
    expect(term.options.theme?.background).toBe('#fdf8ef');
    expect(container.style.background).toBe('rgb(253, 248, 239)');

    hook.rerender({ palette: THEMES.dracula });
    expect(opened.at(-1)).toBe(term); // same xterm, restyled
    expect(term.options.theme?.background).toBe(THEMES.dracula.background);
    expect(container.style.background).toBe('rgb(40, 42, 54)');
    expect(localStorage.getItem('terminal-theme')).toBe('monokai'); // the desktop's saved theme is not touched
    hook.unmount();
  });
});
