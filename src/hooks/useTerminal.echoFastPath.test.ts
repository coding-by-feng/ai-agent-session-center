/**
 * The echo fast path through the REAL hook and xterm.js in jsdom (harness as in
 * useTerminal.inputTap.test.ts): output right after a typed key is written to
 * xterm at once; other output still waits for the frame batch. With the typing
 * probe on, the sampled key carries a probe id to the server.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';
import { useTerminal } from './useTerminal';
import { TYPING_PROBE_KEY } from '@/lib/typingProbe';

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

let spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  spies.forEach((s) => s.mockRestore());
  spies = [];
  localStorage.removeItem(TYPING_PROBE_KEY);
});

function sizedContainer() {
  const div = document.createElement('div');
  document.body.appendChild(div);
  Object.defineProperty(div, 'offsetWidth', { value: 400, configurable: true });
  Object.defineProperty(div, 'offsetHeight', { value: 200, configurable: true });
  return div;
}

async function attached() {
  let term: Terminal | null = null;
  spies.push(vi.spyOn(Terminal.prototype, 'attachCustomKeyEventHandler').mockImplementation(
    function (this: Terminal) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      term = this;
    },
  ));
  const ws = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
  const hook = renderHook(() => useTerminal({ ws }));
  act(() => { hook.result.current.containerRef.current = sizedContainer(); });
  await act(async () => {
    hook.result.current.attach('term-echo');
    await new Promise((r) => setTimeout(r, 300));
  });
  const t = term! as Terminal;
  const write = vi.spyOn(t, 'write');
  spies.push(write);
  return { ws, hook, term: t, write };
}

const b64 = (s: string) => btoa(s);

describe('useTerminal — echo fast path', () => {
  it('writes the echo of a typed key at once', async () => {
    const { hook, term, write } = await attached();
    act(() => term.input('a', true));
    write.mockClear();
    act(() => hook.result.current.handleTerminalOutput('term-echo', b64('a')));
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('leaves output nobody typed for on the frame batch', async () => {
    const { hook, write } = await attached();
    write.mockClear();
    act(() => hook.result.current.handleTerminalOutput('term-echo', b64('tick')));
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps a big chunk after a key on the frame batch', async () => {
    const { hook, term, write } = await attached();
    act(() => term.input('a', true));
    write.mockClear();
    act(() => hook.result.current.handleTerminalOutput('term-echo', b64('x'.repeat(2000))));
    expect(write).not.toHaveBeenCalled();
  });

  it('sends a probe id with a sampled key only when the probe is on', async () => {
    const off = await attached();
    act(() => off.term.input('a', true));
    const sent = (ws: WebSocket) => (ws.send as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => JSON.parse(String(c[0])) as { type: string; probe?: number })
      .filter((m) => m.type === 'terminal_input');
    expect(sent(off.ws).every((m) => m.probe === undefined)).toBe(true);
    off.hook.unmount();
    spies.forEach((s) => s.mockRestore());
    spies = [];

    localStorage.setItem(TYPING_PROBE_KEY, '1');
    const on = await attached();
    act(() => on.term.input('a', true));
    expect(sent(on.ws).at(-1)?.probe).toBe(1);
  });
});
