/**
 * Fit mode and the phone's text size (AASC-45), through the REAL useTerminal hook
 * (real xterm.js in jsdom, as in useTerminal.clearOutput.test.ts).
 *
 * Fit shrinks the local font so the PTY's real columns fit the screen. It must
 * never become a resize: a phone that pushed its own width to the shared PTY
 * would hard-wrap every device's scrollback for good (terminalGeometry.ts). jsdom
 * can't measure a glyph, so here fit always falls back to panning at the reading
 * size, which is exactly the path that must stay safe.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';

const platform = vi.hoisted(() => ({ mobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform')>();
  return { ...actual, useIsMobile: () => platform.mobile, useIsNativeMobileApp: () => false };
});

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

afterEach(() => {
  platform.mobile = true;
  vi.restoreAllMocks();
});

function fakeSocket() {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket;
}

function sizedContainer() {
  const div = document.createElement('div');
  document.body.appendChild(div);
  Object.defineProperty(div, 'offsetWidth', { value: 390, configurable: true });
  Object.defineProperty(div, 'offsetHeight', { value: 300, configurable: true });
  return div;
}

const sentOfType = (ws: WebSocket, type: string) =>
  (ws.send as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
    .filter((m) => m.type === type);

/** Attach a terminal; hands back the hook and the xterm instance it opened. */
async function attached(ws: WebSocket, terminalId: string) {
  const opened: Terminal[] = [];
  const realOpen = Terminal.prototype.open;
  vi.spyOn(Terminal.prototype, 'open').mockImplementation(function (this: Terminal, parent: HTMLElement) {
    opened.push(this);
    return realOpen.call(this, parent);
  });
  const hook = renderHook(({ ws }) => useTerminal({ ws }), { initialProps: { ws } });
  act(() => { hook.result.current.containerRef.current = sizedContainer(); });
  await act(async () => {
    hook.result.current.attach(terminalId);
    await new Promise((r) => setTimeout(r, 300)); // setupWhenReady's rAF + timeout chain
  });
  return { hook, term: () => opened[opened.length - 1] };
}

const nextFrame = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

describe('useTerminal — fit mode on a phone', () => {
  it('never sends the PTY a size, whatever the mode, the PTY width or the text size', async () => {
    const ws = fakeSocket();
    const { hook } = await attached(ws, 'term-fit');

    act(() => hook.result.current.setWidthMode('fit'));
    act(() => hook.result.current.handleTerminalGeometry('term-fit', 160));
    act(() => hook.result.current.setTextSize(13));
    act(() => hook.result.current.refitTerminal());
    await nextFrame();
    act(() => hook.result.current.setWidthMode('pan'));
    act(() => hook.result.current.setWidthMode('wrap'));
    await nextFrame();

    expect(sentOfType(ws, 'terminal_resize')).toEqual([]);
  });

  it('pans at the reading size when the columns cannot be fitted, and says so', async () => {
    const ws = fakeSocket();
    const { hook, term } = await attached(ws, 'term-fit');

    act(() => hook.result.current.setTextSize(12));
    act(() => hook.result.current.handleTerminalGeometry('term-fit', 160));
    act(() => hook.result.current.setWidthMode('fit'));

    expect(hook.result.current.widthMode).toBe('fit');
    expect(hook.result.current.fitState).toEqual({ fontSize: 12, fitted: false });
    expect(term().options.fontSize).toBe(12);
    // Rendered at the PTY's own width, panned: never soft-wrapped to the phone's.
    expect(term().cols).toBe(160);
  });

  it('applies a new text size to the open terminal', async () => {
    const ws = fakeSocket();
    const { hook, term } = await attached(ws, 'term-size');

    act(() => hook.result.current.setTextSize(14));

    expect(hook.result.current.textSize).toBe(14);
    expect(term().options.fontSize).toBe(14);
  });

  it('forgets the fit state outside fit mode', async () => {
    const ws = fakeSocket();
    const { hook } = await attached(ws, 'term-fit');
    act(() => hook.result.current.setWidthMode('fit'));
    act(() => hook.result.current.setWidthMode('pan'));

    expect(hook.result.current.fitState).toBeNull();
  });
});

describe('useTerminal — the desktop is unchanged', () => {
  it('leaves the font alone when nobody chose a text size', async () => {
    platform.mobile = false;
    const ws = fakeSocket();
    const { hook, term } = await attached(ws, 'term-desk');
    const before = term().options.fontSize;

    act(() => hook.result.current.refitTerminal());
    await nextFrame();

    expect(hook.result.current.widthMode).toBe('wrap');
    expect(term().options.fontSize).toBe(before);
    expect(hook.result.current.fitState).toBeNull();
  });
});
