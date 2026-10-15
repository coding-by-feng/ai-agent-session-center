/**
 * useTerminal's input tap (the terminal's `/` command list), through the REAL
 * hook and real xterm.js in jsdom, as in useTerminal.clearOutput.test.ts: the
 * tap sees each keystroke with the caret's surroundings read off the screen,
 * the keys it takes never reach the PTY, and the rest still do.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';
import { useTerminal, type TerminalInputTap } from './useTerminal';

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

const inputs = (ws: WebSocket) =>
  (ws.send as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => JSON.parse(String(c[0])) as { type: string; data?: string })
    .filter((m) => m.type === 'terminal_input')
    .map((m) => m.data);

let keySpy: ReturnType<typeof vi.spyOn> | null = null;
afterEach(() => { keySpy?.mockRestore(); keySpy = null; });

async function attachedWithTap(tap: TerminalInputTap) {
  let term: Terminal | null = null;
  let keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  keySpy = vi.spyOn(Terminal.prototype, 'attachCustomKeyEventHandler').mockImplementation(
    function (this: Terminal, handler: (e: KeyboardEvent) => boolean) {
      // The hook builds its Terminal privately; the spy is the only way to reach it.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      term = this;
      keyHandler = handler;
    },
  );
  const ws = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
  const hook = renderHook(() => useTerminal({ ws }));
  act(() => { hook.result.current.containerRef.current = sizedContainer(); });
  await act(async () => {
    hook.result.current.attach('term-tap');
    await new Promise((r) => setTimeout(r, 300));
  });
  act(() => hook.result.current.setInputTap(tap));
  return { ws, hook, term: term! as Terminal, keyHandler: keyHandler! as (e: KeyboardEvent) => boolean };
}

const keydown = (key: string) =>
  ({ key, type: 'keydown', preventDefault: vi.fn(), shiftKey: false, metaKey: false, ctrlKey: false, altKey: false } as unknown as KeyboardEvent);

describe('useTerminal — input tap', () => {
  it('hands each keystroke to the tap with the caret read off the screen, and still sends it', async () => {
    const onData = vi.fn();
    const { ws, term } = await attachedWithTap({ onKey: () => false, onData, onReset: vi.fn() });
    await new Promise<void>((r) => term.write('❯ hello ', r));

    act(() => term.input('/', true));

    expect(onData).toHaveBeenCalledWith('/', { charBefore: ' ', lineBefore: '❯ hello ' });
    expect(inputs(ws)).toContain('/');
  });

  it('a key the tap takes never reaches the PTY; Esc goes through once it lets go', async () => {
    let own = true;
    const { ws, keyHandler } = await attachedWithTap({ onKey: () => own, onData: vi.fn(), onReset: vi.fn() });

    const taken = keydown('Escape');
    expect(keyHandler(taken)).toBe(false);
    expect(taken.preventDefault).toHaveBeenCalled();
    expect(inputs(ws)).not.toContain('\x1b');

    own = false;
    keyHandler(keydown('Escape'));
    expect(inputs(ws)).toContain('\x1b');
  });

  it('resets the tap before every write that skips onData: Shift+Enter, paste, toolbar keys', async () => {
    const onReset = vi.fn();
    const { hook, keyHandler } = await attachedWithTap({ onKey: () => false, onData: vi.fn(), onReset });
    Object.defineProperty(navigator, 'clipboard', { value: { read: vi.fn(async () => []), readText: vi.fn(async () => 'x') }, configurable: true });

    keyHandler({ ...keydown('Enter'), shiftKey: true } as KeyboardEvent);
    expect(onReset).toHaveBeenCalledTimes(1);
    keyHandler({ ...keydown('v'), metaKey: true } as KeyboardEvent);
    expect(onReset).toHaveBeenCalledTimes(2);
    act(() => hook.result.current.sendEnter());
    act(() => hook.result.current.sendKeys('a'));
    expect(onReset).toHaveBeenCalledTimes(4);
  });

  it('reports the caret cell on screen', async () => {
    const { hook } = await attachedWithTap({ onKey: () => false, onData: vi.fn(), onReset: vi.fn() });
    // jsdom lays nothing out, so the screen has no size: no rect rather than a wrong one.
    expect(hook.result.current.getCaretRect()).toBeNull();
  });
});
