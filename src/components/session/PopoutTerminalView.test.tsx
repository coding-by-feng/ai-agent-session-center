import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import PopoutTerminalView from './PopoutTerminalView';
import { useWsStore } from '@/stores/wsStore';
import type { WsClient } from '@/lib/wsClient';

vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => null }));
vi.mock('@/hooks/useSettingsInit', () => ({ useSettingsInit: () => {} }));
vi.mock('@/components/session/FileOpenChooser', () => ({ default: () => null }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

// jsdom lays nothing out; without a size the terminal never finishes setup.
const LAYOUT = { offsetWidth: 800, offsetHeight: 400 } as const;
const savedLayout = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  class NoopObserver { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= NoopObserver;
  (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver ??= NoopObserver;
  for (const [prop, value] of Object.entries(LAYOUT)) {
    savedLayout.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
});

afterAll(() => {
  for (const [prop, descriptor] of savedLayout) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
  }
});

afterEach(() => {
  useWsStore.setState({ client: null, connected: false });
});

function fakeSocket() {
  return { readyState: 0, send: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
}

function subscribes(sock: ReturnType<typeof fakeSocket>): number {
  return sock.send.mock.calls.filter((c) => String(c[0]).includes('"terminal_subscribe"')).length;
}

describe('PopoutTerminalView — first connection', () => {
  it('subscribes when its socket opens, although memo() hands TerminalContainer the same ws object', async () => {
    render(<PopoutTerminalView terminalId="term-popout" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // useWebSocket's effect: a client whose socket is still CONNECTING.
    const sock = fakeSocket();
    act(() => {
      useWsStore.setState({ client: { getRawSocket: () => sock } as unknown as WsClient });
    });
    expect(subscribes(sock)).toBe(0);

    // A real open: readyState flips in place, then WsClient.onopen reports it.
    sock.readyState = 1;
    act(() => { useWsStore.setState({ connected: true }); });

    expect(subscribes(sock)).toBe(1);
  });
});
