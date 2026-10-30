/**
 * Pasting into the terminal, through the REAL hook and real xterm.js in jsdom (as useTerminal.inputTap.test.ts).
 * ⌘V no longer cancels the native paste: the paste event carries the text, so a page with no async Clipboard
 * API (a paired remote computer's plain-http window) pastes too, and nothing is typed twice.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';
import { useTerminal, type TerminalInputTap } from './useTerminal';
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

async function attached(tap?: TerminalInputTap) {
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
  const hook = renderHook(() => useTerminal({ ws }));
  act(() => { hook.result.current.containerRef.current = sizedContainer(); });
  await act(async () => {
    hook.result.current.attach('term-paste');
    await new Promise((r) => setTimeout(r, 300));
  });
  if (tap) act(() => hook.result.current.setInputTap(tap));
  return { ws, term: term! as Terminal, keyHandler: keyHandler! as (e: KeyboardEvent) => boolean };
}

/** A paste event as the browser fires it on xterm's textarea (jsdom has no ClipboardEvent / DataTransfer). */
function pasteEvent(text: string, files: File[] = []) {
  const items = files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f }));
  return Object.assign(new Event('paste', { bubbles: true, cancelable: true }), {
    clipboardData: { items, getData: (type: string) => (type === 'text/plain' ? text : '') },
  });
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard);
  else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

const key = (mod: Partial<KeyboardEvent>) =>
  ({ key: 'v', type: 'keydown', preventDefault: vi.fn(), shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mod } as unknown as KeyboardEvent);

describe('useTerminal — paste', () => {
  it('the platform\'s paste key leaves the native paste alone: xterm skips it, nothing is cancelled or sent', async () => {
    const { ws, keyHandler } = await attached();
    const e = key(isMac ? { metaKey: true } : { ctrlKey: true });
    expect(keyHandler(e)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    // The other modifier is no paste: on macOS Ctrl+V reaches the PTY as ^V (xterm's to send).
    expect(keyHandler(key(isMac ? { ctrlKey: true } : { metaKey: true }))).toBe(true);
    expect(inputs(ws)).toEqual([]);
  });

  it('sends the pasted text once, trailing line breaks dropped, with no async Clipboard API at all', async () => {
    // A remote computer's window over plain http:// has no navigator.clipboard.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const { ws, term } = await attached();
    const e = pasteEvent('abc-DEF_123#state\r\n');
    act(() => { term.textarea!.dispatchEvent(e); });
    await flush();
    expect(e.defaultPrevented).toBe(true);
    // Once: xterm's own paste handler on the textarea never ran.
    expect(inputs(ws)).toEqual(['abc-DEF_123#state']);
  });

  it('a paste aimed at xterm\'s root is sent once too', async () => {
    const { ws, term } = await attached();
    act(() => { term.element!.dispatchEvent(pasteEvent('root')); });
    await flush();
    expect(inputs(ws)).toEqual(['root']);
  });

  it('goes out as xterm pastes: lines end in \\r, and bracketed when the app asked for it', async () => {
    const { ws, term } = await attached();
    act(() => { term.textarea!.dispatchEvent(pasteEvent('\n\n')); });
    act(() => { term.textarea!.dispatchEvent(pasteEvent('one\ntwo\n')); });
    await flush();
    expect(inputs(ws)).toEqual(['one\rtwo']);
    await new Promise<void>((r) => term.write('\x1b[?2004h', r));
    act(() => { term.textarea!.dispatchEvent(pasteEvent('rm -rf build\nnpm ci')); });
    await flush();
    expect(inputs(ws).at(-1)).toBe('\x1b[200~rm -rf build\rnpm ci\x1b[201~');
  });

  it('a long paste is chunked like typing, and the / list never follows it', async () => {
    const tap = { onKey: () => false, onData: vi.fn(), onReset: vi.fn() };
    const { ws, term } = await attached(tap as TerminalInputTap);
    const long = 'x'.repeat(10_000);
    act(() => { term.textarea!.dispatchEvent(pasteEvent(long)); });
    await flush();
    expect(inputs(ws).map((d) => d!.length)).toEqual([4096, 4096, 1808]);
    expect(inputs(ws).join('')).toBe(long);
    expect(tap.onReset).toHaveBeenCalled();
    expect(tap.onData).not.toHaveBeenCalled();
  });

  it('a pasted image is uploaded and its saved path typed instead', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ paths: ['/tmp/claude-queue-images/a.png'] }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { ws, term } = await attached();
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    act(() => { term.textarea!.dispatchEvent(pasteEvent('', [png])); });
    await vi.waitFor(() => expect(inputs(ws)).toEqual(['/tmp/claude-queue-images/a.png']));
    expect(fetchMock).toHaveBeenCalledWith('/api/queue-images', expect.objectContaining({ method: 'POST' }));
  });

  it('an image that fails to upload falls back to the pasted text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const { ws, term } = await attached();
    const png = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
    act(() => { term.textarea!.dispatchEvent(pasteEvent('caption', [png])); });
    await vi.waitFor(() => expect(inputs(ws)).toEqual(['caption']));
  });
});
