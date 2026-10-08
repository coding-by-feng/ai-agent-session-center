import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import TerminalContainer from './TerminalContainer';

// Mock the useTerminal hook
const mockAttach = vi.fn();
const mockDetach = vi.fn();
const mockToggleFullscreen = vi.fn();
const mockSendEscape = vi.fn();
const mockRefitTerminal = vi.fn();
const mockSetTheme = vi.fn();
const mockHandleTerminalOutput = vi.fn();
const mockHandleTerminalReady = vi.fn();
const mockHandleTerminalClosed = vi.fn();
const mockReparent = vi.fn();
const mockScrollToBottom = vi.fn();
const mockClearOutput = vi.fn();
const mockHandleTerminalCleared = vi.fn();
const mockContainerRef = { current: null };

vi.mock('@/hooks/useTerminal', () => ({
  useTerminal: () => ({
    containerRef: mockContainerRef,
    attach: mockAttach,
    detach: mockDetach,
    isAttached: false,
    isFullscreen: false,
    toggleFullscreen: mockToggleFullscreen,
    sendEscape: mockSendEscape,
    refitTerminal: mockRefitTerminal,
    setTheme: mockSetTheme,
    handleTerminalOutput: mockHandleTerminalOutput,
    handleTerminalReady: mockHandleTerminalReady,
    handleTerminalClosed: mockHandleTerminalClosed,
    handleTerminalCleared: mockHandleTerminalCleared,
    clearOutput: mockClearOutput,
    reparent: mockReparent,
    scrollToBottom: mockScrollToBottom,
  }),
}));

// Mock TerminalToolbar
vi.mock('./TerminalToolbar', () => ({
  default: ({
    themeName,
    onFullscreen,
    onSendEscape,
    onReconnect,
    showReconnect,
    onClearOutput,
    onRestart,
    restartPending,
  }: {
    themeName: string;
    onFullscreen: () => void;
    onSendEscape: () => void;
    onReconnect?: () => void;
    showReconnect?: boolean;
    onClearOutput?: () => void;
    onRestart?: () => void;
    restartPending?: boolean;
  }) => (
    <div data-testid="terminal-toolbar" data-theme={themeName}>
      <button data-testid="escape-btn" onClick={onSendEscape}>ESC</button>
      <button data-testid="fullscreen-btn" onClick={onFullscreen}>Fullscreen</button>
      {onClearOutput && <button data-testid="clear-btn" onClick={onClearOutput}>Clear</button>}
      {onRestart && <button data-testid="restart-btn" onClick={onRestart} disabled={restartPending}>Restart</button>}
      {showReconnect && onReconnect && (
        <button data-testid="reconnect-btn" onClick={onReconnect}>Reconnect</button>
      )}
    </div>
  ),
}));

// Mock xterm CSS
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

describe('TerminalContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows placeholder when no terminalId', () => {
    render(<TerminalContainer terminalId={null} ws={null} />);
    expect(screen.getByText(/No terminal attached/)).toBeInTheDocument();
  });

  // TerminalContainer mounts the toolbar TWICE by design: the inline one, and a
  // second copy inside the fullscreen overlay portal. That overlay stays mounted
  // and is toggled with `display` (TerminalContainer.tsx:632) so the xterm
  // element is never orphaned by unmounting the portal while it lives inside it.
  // Queries here therefore match all copies and assert on the inline one.
  it('renders toolbar and container when terminalId is set', () => {
    render(<TerminalContainer terminalId="term-1" ws={null} />);
    expect(screen.getAllByTestId('terminal-toolbar')[0]).toBeInTheDocument();
    expect(screen.queryByText(/No terminal attached/)).not.toBeInTheDocument();
  });

  it('calls attach when terminalId changes', () => {
    render(<TerminalContainer terminalId="term-1" ws={null} />);
    expect(mockAttach).toHaveBeenCalledWith('term-1');
  });

  it('calls detach when terminalId becomes null', () => {
    const { rerender } = render(<TerminalContainer terminalId="term-1" ws={null} />);
    rerender(<TerminalContainer terminalId={null} ws={null} />);
    expect(mockDetach).toHaveBeenCalled();
  });

  it('does not show reconnect button by default', () => {
    render(<TerminalContainer terminalId="term-1" ws={null} />);
    expect(screen.queryByTestId('reconnect-btn')).not.toBeInTheDocument();
  });

  it('shows reconnect button when showReconnect is true', () => {
    const onReconnect = vi.fn();
    render(
      <TerminalContainer
        terminalId="term-1"
        ws={null}
        showReconnect
        onReconnect={onReconnect}
      />,
    );
    expect(screen.getAllByTestId('reconnect-btn')[0]).toBeInTheDocument();
  });

  // Both toolbar copies (inline and the fullscreen overlay's) offer it.
  it('offers Clear output on both toolbars', () => {
    render(<TerminalContainer terminalId="term-1" ws={null} />);
    const buttons = screen.getAllByTestId('clear-btn');
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    expect(mockClearOutput).toHaveBeenCalledTimes(1);
  });

  it('offers Restart on both toolbars only when the host supplies a handler', () => {
    const { unmount } = render(<TerminalContainer terminalId="term-1" ws={null} />);
    expect(screen.queryAllByTestId('restart-btn')).toHaveLength(0);
    unmount();

    const onRestart = vi.fn();
    render(<TerminalContainer terminalId="term-1" ws={null} onRestart={onRestart} />);
    const buttons = screen.getAllByTestId('restart-btn');
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('hands restartPending to BOTH toolbars, so the double-click protection survives the pass-through', () => {
    render(<TerminalContainer terminalId="term-1" ws={null} onRestart={vi.fn()} restartPending />);
    const buttons = screen.getAllByTestId('restart-btn');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button).toBeDisabled();
  });

  it("hands the server's terminal_cleared to the terminal", () => {
    const mockWs = { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as WebSocket;
    render(<TerminalContainer terminalId="term-1" ws={mockWs} />);
    const handler = (mockWs.addEventListener as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === 'message')?.[1] as (e: MessageEvent) => void;
    handler({ data: JSON.stringify({ type: 'terminal_cleared', terminalId: 'term-1' }) } as MessageEvent);
    expect(mockHandleTerminalCleared).toHaveBeenCalledWith('term-1');
  });

  it('listens for WS terminal messages', () => {
    const mockWs = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as WebSocket;

    render(<TerminalContainer terminalId="term-1" ws={mockWs} />);
    expect(mockWs.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });
});
