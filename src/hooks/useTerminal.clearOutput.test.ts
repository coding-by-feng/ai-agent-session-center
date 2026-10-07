/**
 * The terminal toolbar's "Clear output", through the REAL useTerminal hook
 * (real xterm.js in jsdom, as in useTerminal.wsSubscribeRace.test.ts).
 *
 * The output is the session's: every device paints the same PTY and every
 * remount replays the server's ring. So a click only ASKS the server
 * (`terminal_clear`); the screen is cleared when the server announces it
 * (`terminal_cleared`), on every device at the same point of the output stream
 * as the ring reset. Only with no way to ask (the socket is not open) does the
 * click clear locally. Nothing is ever written to the PTY.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
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

function fakeSocket(readyState: number) {
  return { readyState, send: vi.fn() } as unknown as WebSocket;
}

function sizedContainer() {
  const div = document.createElement('div');
  document.body.appendChild(div);
  Object.defineProperty(div, 'offsetWidth', { value: 400, configurable: true });
  Object.defineProperty(div, 'offsetHeight', { value: 200, configurable: true });
  return div;
}

const sentOfType = (ws: WebSocket, type: string) =>
  (ws.send as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
    .filter((m) => m.type === type);

async function attached(ws: WebSocket, terminalId: string) {
  const hook = renderHook(({ ws }) => useTerminal({ ws }), { initialProps: { ws } });
  act(() => { hook.result.current.containerRef.current = sizedContainer(); });
  await act(async () => {
    hook.result.current.attach(terminalId);
    await new Promise((r) => setTimeout(r, 300)); // setupWhenReady's rAF + timeout chain
  });
  return hook;
}

let clearSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { clearSpy = vi.spyOn(Terminal.prototype, 'clear'); });
afterEach(() => { clearSpy.mockRestore(); });

describe('useTerminal — clearing the output', () => {
  it('asks the server to clear, and leaves the screen to the announcement', async () => {
    const ws = fakeSocket(1);
    const { result } = await attached(ws, 'term-clear');
    clearSpy.mockClear();

    act(() => result.current.clearOutput());

    expect(sentOfType(ws, 'terminal_clear')).toEqual([{ type: 'terminal_clear', terminalId: 'term-clear' }]);
    expect(clearSpy).not.toHaveBeenCalled();
    // Never typed into the CLI.
    expect(sentOfType(ws, 'terminal_input')).toEqual([]);
  });

  it('clears the screen when the server announces it for this terminal, and only this one', async () => {
    const ws = fakeSocket(1);
    const { result } = await attached(ws, 'term-clear');
    clearSpy.mockClear();

    act(() => result.current.handleTerminalCleared('term-someone-else'));
    expect(clearSpy).not.toHaveBeenCalled();

    act(() => result.current.handleTerminalCleared('term-clear'));
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('with the socket not open, clears locally (there is no one to ask)', async () => {
    const ws = fakeSocket(3); // CLOSED
    const { result } = await attached(ws, 'term-offline');
    clearSpy.mockClear();

    act(() => result.current.clearOutput());

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(sentOfType(ws, 'terminal_clear')).toEqual([]);
  });
});
