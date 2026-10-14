// TerminalContainer.phone.test.tsx — the terminal on a phone (AASC-18): no
// toolbar, a key bar and compose box instead, and the server's terminal_error
// shown next to them. Desktop keeps its toolbar and gets none of it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));
vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone' }));

const mockSendKeys = vi.fn();
const mockClearOutput = vi.fn();
// Stable across renders, as the real hook's callbacks are: TerminalContainer
// re-attaches (and resets its closed state) whenever attach/detach change.
const mockAttach = vi.fn();
const mockDetach = vi.fn();
const mockContainerRef = { current: null };
vi.mock('@/hooks/useTerminal', () => ({
  useTerminal: () => ({
    containerRef: mockContainerRef,
    attach: mockAttach,
    detach: mockDetach,
    terminalClosed: null,
    isFullscreen: false,
    toggleFullscreen: vi.fn(),
    sendEscape: vi.fn(),
    sendArrowUp: vi.fn(),
    sendArrowDown: vi.fn(),
    sendEnter: vi.fn(),
    sendKeys: mockSendKeys,
    pasteToTerminal: vi.fn(),
    refitTerminal: vi.fn(),
    setTheme: vi.fn(),
    handleTerminalOutput: vi.fn(),
    handleTerminalGeometry: vi.fn(),
    widthMode: 'pan',
    setWidthMode: vi.fn(),
    handleTerminalReady: vi.fn(),
    handleTerminalClosed: vi.fn(),
    handleTerminalCleared: vi.fn(),
    reparent: vi.fn(),
    scrollToBottom: vi.fn(),
    refreshOutput: vi.fn(),
    clearOutput: mockClearOutput,
    scrollPageUp: vi.fn(),
    scrollPageDown: vi.fn(),
    autoScrollEnabled: false,
    toggleAutoScroll: vi.fn(),
    readRecentText: () => ({ text: '', absBottom: 0 }),
    getXtermSelection: () => null,
    hasXtermSelection: () => false,
  }),
}));
vi.mock('./TerminalToolbar', () => ({ default: () => <div data-testid="terminal-toolbar" /> }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import TerminalContainer from './TerminalContainer';

function fakeSocket() {
  const listeners: Array<(e: MessageEvent) => void> = [];
  const ws = {
    addEventListener: (type: string, fn: (e: MessageEvent) => void) => { if (type === 'message') listeners.push(fn); },
    removeEventListener: vi.fn(),
  } as unknown as WebSocket;
  const push = (msg: unknown) => act(() => listeners.forEach((fn) => fn({ data: JSON.stringify(msg) } as MessageEvent)));
  return { ws, push };
}

beforeEach(() => {
  vi.clearAllMocks();
  platform.isMobile = true;
});

describe('TerminalContainer on a phone', () => {
  it('draws no toolbar: keys and a compose box instead', () => {
    render(<TerminalContainer terminalId="term-1" ws={null} originSessionId="s1" controlSessionId="s1" />);
    expect(screen.queryByTestId('terminal-toolbar')).toBeNull();
    expect(screen.getByRole('group', { name: 'Terminal keys' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message to send to the terminal' })).toBeInTheDocument();
  });

  it('a key goes straight to the terminal', () => {
    render(<TerminalContainer terminalId="term-1" ws={null} originSessionId="s1" controlSessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose 1' }));
    expect(mockSendKeys).toHaveBeenCalledWith('1');
  });

  it('shows the server\'s terminal_error for this terminal by the compose box', () => {
    const { ws, push } = fakeSocket();
    render(<TerminalContainer terminalId="term-1" ws={ws} originSessionId="s1" controlSessionId="s1" />);
    push({ type: 'terminal_error', terminalId: 'term-other', error: 'not mine' });
    expect(screen.queryByRole('alert')).toBeNull();
    push({ type: 'terminal_error', terminalId: 'term-1', error: 'A phone can type only while the agent is running' });
    expect(screen.getByRole('alert')).toHaveTextContent('A phone can type only while the agent is running');
  });

  it('the terminal actions sheet clears output only after its confirm', () => {
    render(<TerminalContainer terminalId="term-1" ws={null} originSessionId="s1" controlSessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminal actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear output…' }));
    expect(mockClearOutput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear output' }));
    expect(mockClearOutput).toHaveBeenCalledTimes(1);
  });

  it('offers Reconnect only for a closed terminal: on a live one it would start a second agent', () => {
    const { ws, push } = fakeSocket();
    render(<TerminalContainer terminalId="term-1" ws={ws} originSessionId="s1" controlSessionId="s1" onReconnect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminal actions' }));
    expect(screen.queryByRole('button', { name: 'Reconnect terminal' })).toBeNull();
    push({ type: 'terminal_closed', terminalId: 'term-1', reason: 'exited' });
    expect(screen.getByRole('button', { name: 'Reconnect terminal' })).toBeInTheDocument();
  });
});

describe('TerminalContainer on a desktop', () => {
  it('keeps its toolbar and gets no phone input', () => {
    platform.isMobile = false;
    render(<TerminalContainer terminalId="term-1" ws={null} originSessionId="s1" controlSessionId="s1" />);
    expect(screen.getAllByTestId('terminal-toolbar').length).toBeGreaterThan(0);
    expect(screen.queryByRole('group', { name: 'Terminal keys' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Message to send to the terminal' })).toBeNull();
  });
});
