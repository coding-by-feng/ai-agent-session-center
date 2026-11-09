import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

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
const mockFocusTerminal = vi.fn();
const mockSearchAddon = {
  findNext: vi.fn(), findPrevious: vi.fn(), clearDecorations: vi.fn(),
  onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
};
let mockSelection: string | null = null;
const mockClearSelection = vi.fn();
let mockIsFullscreen = false;
/** What the terminal calls on ⌘F (useTerminal's key handler). */
let findRequest: (() => void) | undefined;

vi.mock('@/hooks/useTerminal', () => ({
  useTerminal: (opts: { onFindRequest?: () => void }) => {
    findRequest = opts.onFindRequest;
    return {
    containerRef: mockContainerRef,
    attach: mockAttach,
    detach: mockDetach,
    isAttached: false,
    isFullscreen: mockIsFullscreen,
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
    getSearchAddon: () => mockSearchAddon,
    focusTerminal: mockFocusTerminal,
    getXtermSelection: () => mockSelection,
    clearXtermSelection: mockClearSelection,
    activeTerminalId: 'term-1',
    };
  },
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
    onToggleSearch,
    searchOpen,
  }: {
    themeName: string;
    onFullscreen: () => void;
    onSendEscape: () => void;
    onReconnect?: () => void;
    showReconnect?: boolean;
    onClearOutput?: () => void;
    onRestart?: () => void;
    restartPending?: boolean;
    onToggleSearch?: () => void;
    searchOpen?: boolean;
  }) => (
    <div data-testid="terminal-toolbar" data-theme={themeName}>
      <button data-testid="escape-btn" onClick={onSendEscape}>ESC</button>
      <button data-testid="fullscreen-btn" onClick={onFullscreen}>Fullscreen</button>
      {onClearOutput && <button data-testid="clear-btn" onClick={onClearOutput}>Clear</button>}
      {onRestart && <button data-testid="restart-btn" onClick={onRestart} disabled={restartPending}>Restart</button>}
      {onToggleSearch && <button data-testid="search-btn" aria-pressed={!!searchOpen} onClick={onToggleSearch}>Find</button>}
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

  it('the find button opens the find bar over the terminal, seeded with a one-line selection, and closes it', () => {
    mockSelection = '  BatchMode  ';
    render(<TerminalContainer terminalId="term-1" ws={null} />);
    expect(screen.queryByTestId('terminal-search-bar')).toBeNull();
    act(() => { screen.getAllByTestId('search-btn')[0].click(); });
    expect(screen.getByTestId('terminal-search-bar')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Find in terminal' })).toHaveValue('BatchMode');
    expect(screen.getAllByTestId('search-btn')[0]).toHaveAttribute('aria-pressed', 'true');
    act(() => { screen.getAllByTestId('search-btn')[0].click(); });
    expect(screen.queryByTestId('terminal-search-bar')).toBeNull();
    expect(mockFocusTerminal).toHaveBeenCalled();
    mockSelection = null;
  });

  it('⌘F on an open bar only refocuses it: the addon\'s selected match never overwrites a regex', () => {
    mockSelection = null;
    render(<TerminalContainer terminalId="term-1" ws={null} />);
    act(() => { findRequest?.(); });
    const field = screen.getByRole('textbox', { name: 'Find in terminal' });
    fireEvent.change(field, { target: { value: 'err\\w+' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    mockSelection = 'errors'; // what the addon selected for the current match
    act(() => { findRequest?.(); });
    expect(screen.getByRole('textbox', { name: 'Find in terminal' })).toHaveValue('err\\w+');
    expect(screen.getByRole('button', { name: 'Use regular expression' })).toHaveAttribute('aria-pressed', 'true');
    mockSelection = null;
  });

  it('keeps the query and toggles when the terminal goes fullscreen (the bar remounts there)', () => {
    mockSelection = null;
    render(<TerminalContainer terminalId="term-1" ws={null} />);
    act(() => { findRequest?.(); });
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in terminal' }), { target: { value: 'ECONNRESET' } });
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
    const before = screen.getByRole('textbox', { name: 'Find in terminal' });
    mockIsFullscreen = true;
    try {
      // memo(TerminalContainer) ignores a same-props rerender: a state change re-renders it.
      fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
      expect(screen.getAllByTestId('terminal-search-bar')).toHaveLength(1);
      const after = screen.getByRole('textbox', { name: 'Find in terminal' });
      expect(after).not.toBe(before); // really remounted, in the fullscreen overlay
      expect(after).toHaveValue('ECONNRESET');
      expect(screen.getByRole('button', { name: 'Match case' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Use regular expression' })).toHaveAttribute('aria-pressed', 'true');
    } finally {
      mockIsFullscreen = false;
    }
  });

  it('closing drops the match the addon left selected, and reopening brings the last query back', () => {
    mockSelection = null;
    render(<TerminalContainer terminalId="term-1" ws={null} />);
    act(() => { findRequest?.(); });
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in terminal' }), { target: { value: 'ssh' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Find in terminal' }), { key: 'Escape' });
    expect(screen.queryByTestId('terminal-search-bar')).toBeNull();
    expect(mockClearSelection).toHaveBeenCalledTimes(1);
    expect(mockFocusTerminal).toHaveBeenCalled();
    act(() => { findRequest?.(); });
    expect(screen.getByRole('textbox', { name: 'Find in terminal' })).toHaveValue('ssh');
  });

  it('a multi-line selection does not become the query', () => {
    mockSelection = 'line one\nline two';
    render(<TerminalContainer terminalId="term-1" ws={null} />);
    act(() => { screen.getAllByTestId('search-btn')[0].click(); });
    expect(screen.getByRole('textbox', { name: 'Find in terminal' })).toHaveValue('');
    mockSelection = null;
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
