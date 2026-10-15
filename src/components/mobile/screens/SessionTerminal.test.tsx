// SessionTerminal.test.tsx — the Terminal segment (AASC-45): the key bar and its
// sticky Ctrl, the raw input line, Fit / Pan and the text size (local only), the
// "driving elsewhere" lock, and the ⋯ sheet's confirmed Clear.
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
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const term = vi.hoisted(() => ({
  sendKeys: vi.fn(),
  setWidthMode: vi.fn(),
  setTextSize: vi.fn(),
  clearOutput: vi.fn(),
  attach: vi.fn(),
  handleTerminalGeometry: vi.fn(),
  fitState: null as null | { fontSize: number; fitted: boolean },
}));
vi.mock('@/hooks/useTerminal', () => ({
  useTerminal: () => ({
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
    scrollToBottom: vi.fn(),
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
  presence();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SessionTerminal', () => {
  it('shows the PTY’s real size once the Mac reports it', () => {
    render(<SessionTerminal session={session} />);
    push({ type: 'terminal_geometry', terminalId: 'term-1', cols: 160, rows: 40 });
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('160×40')).toBeInTheDocument();
    expect(term.handleTerminalGeometry).toHaveBeenCalledWith('term-1', 160);
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

  it('switches Fit and Pan locally, and remembers it on this phone', () => {
    render(<SessionTerminal session={session} />);
    expect(term.setWidthMode).toHaveBeenLastCalledWith('fit');
    fireEvent.click(screen.getByRole('button', { name: 'Pan' }));
    expect(term.setWidthMode).toHaveBeenLastCalledWith('pan');
    expect(JSON.parse(localStorage.getItem('aasc.phoneTerminal') ?? '{}')).toMatchObject({ mode: 'pan' });
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('terminal_resize'));
  });

  it('A+ from a fitted view reads one size up from what shows, panning', () => {
    term.fitState = { fontSize: 8.75, fitted: true };
    render(<SessionTerminal session={session} />);
    fireEvent.click(screen.getByRole('button', { name: 'Larger text' }));
    expect(term.setTextSize).toHaveBeenLastCalledWith(9);
    expect(term.setWidthMode).toHaveBeenLastCalledWith('pan');
  });

  it('says so when the PTY is too wide to fit at a readable size', () => {
    term.fitState = { fontSize: 11, fitted: false };
    render(<SessionTerminal session={session} />);
    push({ type: 'terminal_geometry', terminalId: 'term-1', cols: 160, rows: 40 });
    expect(screen.getByText(/Too wide to fit at a readable size/)).toBeInTheDocument();
  });

  it('turns typing off while another device drives, with the banner', () => {
    presence(true);
    render(<SessionTerminal session={session} />);
    expect(screen.getByTestId('raw-input')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Escape' })).toBeDisabled();
    expect(screen.getByTestId('driving-banner')).toHaveTextContent('Your Mac is driving');
  });

  it('shows the Mac’s word on keystrokes that reached nothing', () => {
    render(<SessionTerminal session={session} />);
    push({ type: 'terminal_error', terminalId: 'term-1', error: 'A phone can type only while the agent is running' });
    expect(screen.getByRole('alert')).toHaveTextContent('A phone can type only while the agent is running');
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
