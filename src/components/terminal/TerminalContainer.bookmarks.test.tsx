// TerminalContainer.bookmarks.test.tsx — the terminal's phone extras (AASC-20): long-press a line to
// bookmark it, the list and jump in the actions sheet, reading the last answer aloud; and none of it
// on a desktop.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));
vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone' }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

const term = vi.hoisted(() => ({
  lineAtClientY: vi.fn<(y: number) => { line: number; text: string } | null>(),
  revealLine: vi.fn<(b: { line: number; text: string }) => boolean>(),
  containerRef: { current: null as HTMLDivElement | null },
}));
const noop = () => {};
vi.mock('@/hooks/useTerminal', () => ({
  useTerminal: () => ({
    containerRef: term.containerRef,
    attach: noop, detach: noop, terminalClosed: null, isFullscreen: false, toggleFullscreen: noop,
    sendEscape: noop, sendArrowUp: noop, sendArrowDown: noop, sendEnter: noop, sendKeys: noop,
    pasteToTerminal: noop, refitTerminal: noop, setTheme: noop, handleTerminalOutput: noop,
    handleTerminalGeometry: noop, widthMode: 'pan', setWidthMode: noop, handleTerminalReady: noop,
    handleTerminalClosed: noop, handleTerminalCleared: noop, reparent: noop, scrollToBottom: noop,
    refreshOutput: noop, clearOutput: noop, scrollPageUp: noop, scrollPageDown: noop,
    autoScrollEnabled: false, toggleAutoScroll: noop, readRecentText: () => ({ text: '', absBottom: 0 }),
    lineAtClientY: term.lineAtClientY, revealLine: term.revealLine,
    getXtermSelection: () => null, hasXtermSelection: () => false,
  }),
}));
vi.mock('./TerminalToolbar', () => ({ default: () => <div data-testid="terminal-toolbar" /> }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { showToast } from '@/components/ui/ToastContainer';
import TerminalContainer from './TerminalContainer';

let terminalN = 0;

/** A touch held on the rendered screen for the long-press time. */
function longPress(clientY: number) {
  const screenEl = document.createElement('div');
  screenEl.className = 'xterm-screen';
  term.containerRef.current!.appendChild(screenEl);
  const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY });
  Object.assign(down, { pointerType: 'touch', pointerId: 1, isPrimary: true });
  act(() => { screenEl.dispatchEvent(down); });
  act(() => { vi.advanceTimersByTime(600); });
}

beforeEach(() => {
  vi.clearAllMocks();
  platform.isMobile = true;
  term.containerRef.current = null;
});

describe('terminal bookmarks on a phone', () => {
  it('a long-press on a line bookmarks it; the sheet lists it and jumps back to it', () => {
    vi.useFakeTimers();
    const terminalId = `term-bm-${++terminalN}`;
    term.lineAtClientY.mockReturnValue({ line: 42, text: '● Bash(npm test)' });
    term.revealLine.mockReturnValue(true);
    render(<TerminalContainer terminalId={terminalId} ws={null} originSessionId="s1" controlSessionId="s1" />);
    longPress(120);
    vi.useRealTimers();
    expect(term.lineAtClientY).toHaveBeenCalledWith(120);
    expect(showToast).toHaveBeenCalledWith('Bookmarked: ● Bash(npm test)', 'success', 2500);
    expect(localStorage.getItem(`aasc:term-bookmarks:${terminalId}`)).toContain('npm test');

    fireEvent.click(screen.getByRole('button', { name: 'Terminal actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to bookmark: ● Bash(npm test)' }));
    expect(term.revealLine).toHaveBeenCalledWith(expect.objectContaining({ line: 42, text: '● Bash(npm test)' }));
  });

  it('a blank line keeps nothing and says what a long-press does', () => {
    vi.useFakeTimers();
    term.lineAtClientY.mockReturnValue(null);
    render(<TerminalContainer terminalId={`term-bm-${++terminalN}`} ws={null} controlSessionId="s1" />);
    longPress(300);
    vi.useRealTimers();
    expect(showToast).toHaveBeenCalledWith('Long-press a line with text on it to bookmark it', 'info', 2500);
    fireEvent.click(screen.getByRole('button', { name: 'Terminal actions' }));
    expect(screen.getByText('Long-press a line in the terminal to bookmark it.')).toBeTruthy();
  });

  it('says so when a bookmarked line has left the scrollback', () => {
    vi.useFakeTimers();
    term.lineAtClientY.mockReturnValue({ line: 3, text: 'old line' });
    term.revealLine.mockReturnValue(false);
    render(<TerminalContainer terminalId={`term-bm-${++terminalN}`} ws={null} controlSessionId="s1" />);
    longPress(50);
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Terminal actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to bookmark: old line' }));
    expect(showToast).toHaveBeenCalledWith('That line is no longer in the terminal’s scrollback', 'info', 3000);
  });

  it('offers read-aloud for the terminal’s own session, and no full screen inside a sheet', () => {
    render(<TerminalContainer terminalId={`term-bm-${++terminalN}`} ws={null} controlSessionId="s1" inSheet />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminal actions' }));
    expect(screen.getByRole('button', { name: 'Read the last answer aloud' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Full screen' })).toBeNull();
  });
});

describe('on a desktop', () => {
  it('a long-press does nothing', () => {
    platform.isMobile = false;
    vi.useFakeTimers();
    term.lineAtClientY.mockReturnValue({ line: 1, text: 'x' });
    render(<TerminalContainer terminalId={`term-bm-${++terminalN}`} ws={null} controlSessionId="s1" />);
    longPress(10);
    vi.useRealTimers();
    expect(term.lineAtClientY).not.toHaveBeenCalled();
  });
});
