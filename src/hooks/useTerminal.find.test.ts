/**
 * ⌘F (Ctrl+F off a Mac) inside the terminal opens its find bar (Nov 6 2026), through the REAL hook and
 * xterm.js in jsdom (harness as useTerminal.paste.test.ts): nothing reaches the program, and the page's
 * own ⌘F ("find in file") never sees it.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';
import { useTerminal } from './useTerminal';
import { isMac } from '@/lib/shortcutKeys';

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
afterEach(() => {
  keySpy?.mockRestore();
  keySpy = null;
  vi.unstubAllGlobals();
});

async function attached(onFindRequest?: () => void) {
  let term: Terminal | null = null;
  let keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  keySpy = vi.spyOn(Terminal.prototype, 'attachCustomKeyEventHandler').mockImplementation(
    function (this: Terminal, handler: (e: KeyboardEvent) => boolean) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      term = this;
      keyHandler = handler;
    },
  );
  const ws = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
  const hook = renderHook(() => useTerminal({ ws, onFindRequest }));
  act(() => { hook.result.current.containerRef.current = sizedContainer(); });
  await act(async () => {
    hook.result.current.attach('term-paste');
    await new Promise((r) => setTimeout(r, 300));
  });
  return { ws, hook, term: term! as Terminal, keyHandler: keyHandler! as (e: KeyboardEvent) => boolean };
}

const key = (mod: Partial<KeyboardEvent>) =>
  ({ key: 'f', type: 'keydown', stopPropagation: vi.fn(), preventDefault: vi.fn(), shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mod } as unknown as KeyboardEvent);

describe('useTerminal — find key', () => {
  it('the platform\'s find key opens the find bar, sends nothing, and stops at the terminal', async () => {
    const onFind = vi.fn();
    const { ws, keyHandler } = await attached(onFind);
    const e = key(isMac ? { metaKey: true } : { ctrlKey: true });
    expect(keyHandler(e)).toBe(false);
    expect(onFind).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(inputs(ws)).toEqual([]);
  });

  it('the keyup of it opens nothing a second time', async () => {
    const onFind = vi.fn();
    const { keyHandler } = await attached(onFind);
    keyHandler(key({ type: 'keyup', ...(isMac ? { metaKey: true } : { ctrlKey: true }) }));
    expect(onFind).not.toHaveBeenCalled();
  });

  it('leaves ⇧⌘F and the other modifier alone, and a terminal with no find bar keeps the old behaviour', async () => {
    const onFind = vi.fn();
    const { keyHandler } = await attached(onFind);
    expect(keyHandler(key({ shiftKey: true, ...(isMac ? { metaKey: true } : { ctrlKey: true }) }))).toBe(true);
    if (isMac) expect(keyHandler(key({ ctrlKey: true }))).toBe(true); // ^F stays readline's forward-char
    expect(onFind).not.toHaveBeenCalled();
    keySpy?.mockRestore();
    const bare = await attached();
    const e = key(isMac ? { metaKey: true } : { ctrlKey: true });
    bare.keyHandler(e);
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });

  it('hands out the attached terminal\'s search addon', async () => {
    const { hook } = await attached(vi.fn());
    expect(hook.result.current.getSearchAddon()).not.toBeNull();
  });
});
