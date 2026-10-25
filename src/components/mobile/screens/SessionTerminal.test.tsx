// SessionTerminal.test.tsx — the Terminal segment (AASC-45): the key bar and its
// sticky Ctrl, the raw input line, the width picked by itself and ↓ Latest (Oct 23 2026), the
// "driving elsewhere" lock, the ⋯ sheet's confirmed Clear, and the palette
// that follows this phone's theme (AASC-58).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DevicePresence, Session } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone' }));
vi.mock('@/lib/presenceClient', () => ({
  claimControl: vi.fn(async () => ({ ok: true, controller: null })),
  requestControl: vi.fn(async () => ({ ok: true })),
  grantControl: vi.fn(async () => ({ ok: true, controller: null })),
  releaseControl: vi.fn(async () => ({ ok: true, released: true })),
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
const platform = vi.hoisted(() => ({ native: false }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  isNativeMobileApp: () => platform.native,
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const term = vi.hoisted(() => ({
  sendKeys: vi.fn(),
  setWidthMode: vi.fn(),
  setTextSize: vi.fn(),
  scrollToBottom: vi.fn(),
  clearOutput: vi.fn(),
  attach: vi.fn(),
  handleTerminalGeometry: vi.fn(),
  fitState: null as null | { fontSize: number; fitted: boolean },
  options: [] as Array<{ palette?: unknown; themeName?: string }>,
}));
vi.mock('@/hooks/useTerminal', () => ({
  useTerminal: (opts: { palette?: unknown; themeName?: string }) => (term.options.push(opts), {
    containerRef: { current: null },
    attach: term.attach,
    detach: vi.fn(),
    isAttached: true,
    terminalClosed: null,
    isFullscreen: false,
    toggleFullscreen: vi.fn(),
    sendKeys: term.sendKeys,
    handleTerminalOutput: vi.fn(),
    handleTerminalGeometry: term.handleTerminalGeometry,
    handleTerminalReady: vi.fn(),
    handleTerminalClosed: vi.fn(),
    handleTerminalCleared: vi.fn(),
    widthMode: 'fit',
    setWidthMode: term.setWidthMode,
    fitState: term.fitState,
    textSize: 11,
    setTextSize: term.setTextSize,
    reparent: vi.fn(),
    scrollToBottom: term.scrollToBottom,
    refreshOutput: vi.fn(),
    clearOutput: term.clearOutput,
    autoScrollEnabled: false,
    toggleAutoScroll: vi.fn(),
    readRecentText: () => ({ text: 'screen text', absBottom: 1 }),
    lineAtClientY: () => null,
    revealLine: () => true,
  }),
}));

const listeners: Array<(e: MessageEvent) => void> = [];
const socket = {
  readyState: 1,
  send: vi.fn(),
  addEventListener: (type: string, fn: (e: MessageEvent) => void) => { if (type === 'message') listeners.push(fn); },
  removeEventListener: vi.fn(),
} as unknown as WebSocket;
vi.mock('@/stores/wsStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/wsStore')>();
  actual.useWsStore.setState({ connected: true, client: { getRawSocket: () => socket } as never });
  return actual;
});

import SessionTerminal from './SessionTerminal';
import { usePresenceStore } from '@/stores/presenceStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { phoneTerminalTheme } from '@/lib/chat/phoneThemes';

function device(clientId: string, isLocal: boolean): DevicePresence {
  return { clientId, label: clientId === 'desk' ? 'MacBook' : 'iPhone', address: '', isLocal, connections: 1, connectedAt: 1, lastSeenAt: 1 };
}

function presence(held = false) {
  usePresenceStore.setState({ pendingRequests: new Map() });
  usePresenceStore.getState().applyPresence({
    devices: [device('phone', false), device('desk', true)],
    controllers: held ? [{ sessionId: 's1', clientId: 'desk', label: 'MacBook', since: 1, lastActivityAt: Date.now(), online: true }] : [],
    restoreOwner: 'desk',
    workspaceWriter: 'desk',
  });
}

const session = { sessionId: 's1', status: 'working', terminalId: 'term-1', projectPath: '/p', source: 'ssh', cliSource: 'claude' } as unknown as Session;

function writes() {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)).data);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
  return calls;
}

beforeAll(() => {
  class NoopObserver {
    observe() { /* noop */ }
    unobserve() { /* noop */ }
    disconnect() { /* noop */ }
  }
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= NoopObserver;
});

const push = (msg: unknown) => act(() => listeners.forEach((fn) => fn({ data: JSON.stringify(msg) } as MessageEvent)));

beforeEach(() => {
  vi.clearAllMocks();
  listeners.length = 0;
  term.fitState = null;
  term.options.length = 0;
  presence();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SessionTerminal', () => {
  it('paints the terminal in this phone’s theme, and repaints it when the theme changes', () => {
    localStorage.setItem('terminal-theme', 'github-dark'); // a desktop choice never overrides the phone's theme
    useSettingsStore.setState({ themeName: 'dracula' });
    render(<SessionTerminal session={session} />);
    expect(term.options.at(-1)?.palette).toEqual(phoneTerminalTheme('dracula'));
    act(() => useSettingsStore.setState({ themeName: 'blonde' }));
    expect(term.options.at(-1)?.palette).toEqual(phoneTerminalTheme('blonde'));
    expect((term.options.at(-1)?.palette as { background: string }).background).toBe('#fdf8ef');
    localStorage.removeItem('terminal-theme');
  });

  it('passes the PTY’s real size on, and keeps the top row to the live state and ⋯', () => {
    term.fitState = { fontSize: 11, fitted: false };
    render(<SessionTerminal session={session} />);
    push({ type: 'terminal_geometry', terminalId: 'term-1', cols: 160, rows: 40 });
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(term.handleTerminalGeometry).toHaveBeenCalledWith('term-1', 160);
    // Oct 23 2026: the controls nobody could use are gone (Fit couldn't fit a 146-column CLI).
    expect(screen.queryByText('160×40')).toBeNull();
    for (const name of ['Fit', 'Pan', 'Smaller text', 'Larger text'])
      expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByText(/Too wide to fit/)).toBeNull();
    expect(screen.getByRole('button', { name: 'More terminal actions' })).toBeInTheDocument();
  });

  it('picks the width by itself: a phone that chose Pan before reads fitted, at its own size', () => {
    localStorage.setItem('aasc.phoneTerminal', JSON.stringify({ mode: 'pan', size: 13 }));
    render(<SessionTerminal session={session} />);
    expect(term.setWidthMode).toHaveBeenLastCalledWith('fit');
    expect(term.setTextSize).toHaveBeenLastCalledWith(13);
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('terminal_resize'));
    localStorage.removeItem('aasc.phoneTerminal');
  });

  it('offers ↓ Latest only while scrolled up, and goes back to the newest line', () => {
    render(<SessionTerminal session={session} />);
    expect(screen.queryByRole('button', { name: 'Jump to the latest output' })).toBeNull();
    // xterm's own scroller sits inside the viewer: scrolled 600 px up from the bottom.
    const viewport = document.createElement('div');
    viewport.className = 'xterm-viewport';
    screen.getByTestId('phone-terminal-viewport').appendChild(viewport);
    const at = (top: number) => {
      Object.defineProperties(viewport, {
        scrollTop: { value: top, configurable: true },
        scrollHeight: { value: 2000, configurable: true },
        clientHeight: { value: 400, configurable: true },
      });
      act(() => viewport.dispatchEvent(new Event('scroll')));
    };
    at(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to the latest output' }));
    expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
    at(1600);
    expect(screen.queryByRole('button', { name: 'Jump to the latest output' })).toBeNull();
  });

  it('writes each key bar key as a terminal keyboard would', () => {
    render(<SessionTerminal session={session} />);
    fireEvent.click(screen.getByRole('button', { name: 'Escape' }));
    fireEvent.click(screen.getByRole('button', { name: 'Left arrow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    expect(term.sendKeys.mock.calls.map((c) => c[0])).toEqual(['\x1b', '\x1b[D', '2', '\r']);
  });

  it('holds Ctrl until the next key: Ctrl then C on the keyboard sends ^C, not a "c"', () => {
    render(<SessionTerminal session={session} />);
    const ctrl = screen.getByRole('button', { name: /^Control/ });
    fireEvent.click(ctrl);
    expect(ctrl).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByTestId('raw-input'), { target: { value: 'c', selectionStart: 1 } });
    expect(term.sendKeys).toHaveBeenCalledWith('\x03');
    expect(screen.getByTestId('raw-input')).toHaveValue('');
    expect(screen.getByRole('button', { name: /^Control/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('Ctrl then an arrow sends the word jump, then lets go', () => {
    render(<SessionTerminal session={session} />);
    fireEvent.click(screen.getByRole('button', { name: /^Control/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Right arrow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Right arrow' }));
    expect(term.sendKeys.mock.calls.map((c) => c[0])).toEqual(['\x1b[1;5C', '\x1b[C']);
  });

  it('types the raw line, then Enter as its own write', async () => {
    const calls = writes();
    render(<SessionTerminal session={session} />);
    fireEvent.change(screen.getByTestId('raw-input'), { target: { value: 'ls -la' } });
    fireEvent.submit(screen.getByTestId('raw-input'));
    await waitFor(() => expect(calls).toEqual(['ls -la', '\r']), { timeout: 3000 });
    expect(screen.getByTestId('raw-input')).toHaveValue('');
  });

  // Oct 2026, by request: no control baton for people. The phone types even while the Mac typed last.
  it('keeps typing on, with no driving banner, while another device typed last', () => {
    presence(true);
    render(<SessionTerminal session={session} />);
    expect(screen.getByTestId('raw-input')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Escape' })).not.toBeDisabled();
    expect(screen.queryByTestId('driving-banner')).toBeNull();
  });

  it('shows the Mac’s word on keystrokes that reached nothing', () => {
    render(<SessionTerminal session={session} />);
    push({ type: 'terminal_error', terminalId: 'term-1', error: 'A phone can type only while the agent is running' });
    expect(screen.getByRole('alert')).toHaveTextContent('A phone can type only while the agent is running');
  });

  it('lists no Commands row in the phone app, which is never given the plain shell (Oct 20 2026)', async () => {
    platform.native = true;
    try {
      render(<SessionTerminal session={session} />);
      fireEvent.click(screen.getByRole('button', { name: 'More terminal actions' }));
      await screen.findByRole('button', { name: 'Clear output…' });
      expect(screen.queryByText('Commands')).toBeNull();
    } finally {
      platform.native = false;
    }
  });

  it('clears the output only after a confirm, from the ⋯ sheet', async () => {
    render(<SessionTerminal session={session} />);
    fireEvent.click(screen.getByRole('button', { name: 'More terminal actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear output…' }));
    expect(term.clearOutput).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear output' }));
    expect(term.clearOutput).toHaveBeenCalledTimes(1);
  });
});
