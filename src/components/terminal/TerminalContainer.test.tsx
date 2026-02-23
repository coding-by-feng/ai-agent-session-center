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
  }: {
    themeName: string;
    onFullscreen: () => void;
    onSendEscape: () => void;
    onReconnect?: () => void;
    showReconnect?: boolean;
  }) => (
    <div data-testid="terminal-toolbar" data-theme={themeName}>
      <button data-testid="escape-btn" onClick={onSendEscape}>ESC</button>
      <button data-testid="fullscreen-btn" onClick={onFullscreen}>Fullscreen</button>
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

  it('renders toolbar and container when terminalId is set', () => {
    render(<TerminalContainer terminalId="term-1" ws={null} />);
    expect(screen.getByTestId('terminal-toolbar')).toBeInTheDocument();
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
    expect(screen.getByTestId('reconnect-btn')).toBeInTheDocument();
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
