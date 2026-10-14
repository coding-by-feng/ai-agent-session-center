// PhoneFloatingSheet.test.tsx — the fork window on a phone (AASC-20): a full-height sheet instead of a
// floating window. Hiding never ends the session; only End does, after a confirm. The header's ✦ button
// brings a hidden popup back.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Session } from '@/types';

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));
vi.mock('@/components/terminal/TerminalContainer', () => ({
  default: (p: { terminalId: string; originSessionId?: string; controlSessionId?: string | null; inSheet?: boolean }) => (
    <div data-testid="float-terminal" data-terminal={p.terminalId} data-origin={p.originSessionId}
      data-control={p.controlSessionId ?? ''} data-in-sheet={String(!!p.inSheet)} />
  ),
}));
vi.mock('@/components/session/FloatingTerminalPanel', () => ({ default: () => <div data-testid="float-panel" /> }));

import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { useSessionStore } from '@/stores/sessionStore';
import FloatingTerminalRoot from '@/components/session/FloatingTerminalRoot';
import PhoneFloatsButton from './PhoneFloatsButton';

const float = (terminalId: string, label: string) => ({ terminalId, label, originSessionId: 'root', createdAt: 1 });
const s = (sessionId: string, over: Partial<Session> = {}) => ({ sessionId, status: 'working', events: [], ...over }) as unknown as Session;

let closeSpy: ReturnType<typeof vi.fn<(terminalId: string) => void>>;

beforeEach(() => {
  platform.isMobile = true;
  closeSpy = vi.fn<(terminalId: string) => void>((terminalId) => useFloatingSessionsStore.setState((st) => ({ floats: st.floats.filter((f) => f.terminalId !== terminalId) })));
  useFloatingSessionsStore.setState({
    floats: [float('t-1', 'Explain (English)'), float('t-2', 'Translate → 中文')],
    poppedOut: [], phoneShown: 't-2', close: closeSpy,
  });
  useSessionStore.setState({
    selectedSessionId: 'root',
    sessions: new Map([['root', s('root')], ['fork-2', s('fork-2', { terminalId: 't-2', isFloating: true })]]),
  });
});

describe('the fork sheet', () => {
  it('replaces the floating windows on a phone, full height, with the popup’s own session at the keys', () => {
    render(<FloatingTerminalRoot />);
    expect(screen.queryByTestId('float-panel')).toBeNull();
    const dialog = screen.getByRole('dialog', { name: 'Translate → 中文' });
    const terminal = within(dialog).getByTestId('float-terminal');
    expect(terminal.dataset.terminal).toBe('t-2');
    expect(terminal.dataset.origin).toBe('root');
    expect(terminal.dataset.control).toBe('fork-2');
    expect(terminal.dataset.inSheet).toBe('true');
  });

  it('keeps the desktop’s floating windows on a desktop', () => {
    platform.isMobile = false;
    render(<FloatingTerminalRoot />);
    expect(screen.getAllByTestId('float-panel')).toHaveLength(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('switches between popups with the chips', () => {
    render(<FloatingTerminalRoot />);
    fireEvent.click(screen.getByRole('button', { name: '1. Explain (English)' }));
    expect(screen.getByTestId('float-terminal').dataset.terminal).toBe('t-1');
    expect(screen.getByRole('button', { name: '1. Explain (English)' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('closing the sheet hides the popup and leaves it running', () => {
    render(<FloatingTerminalRoot />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(closeSpy).not.toHaveBeenCalled();
    expect(useFloatingSessionsStore.getState().floats).toHaveLength(2);
  });

  it('End asks first, then closes that popup (saving its answer, killing its terminal)', () => {
    render(<FloatingTerminalRoot />);
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    expect(closeSpy).not.toHaveBeenCalled();
    const confirm = screen.getByRole('dialog', { name: 'End this AI popup?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(closeSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'End this AI popup?' })).getByRole('button', { name: 'End popup' }));
    expect(closeSpy).toHaveBeenCalledWith('t-2');
  });

  it('shows nothing for another session’s popups', () => {
    useSessionStore.setState({ selectedSessionId: 'other' });
    render(<FloatingTerminalRoot />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the header’s ✦ button', () => {
  it('counts the session’s running popups and brings the newest back', () => {
    useFloatingSessionsStore.setState({ phoneShown: null });
    render(<PhoneFloatsButton sessionId="root" />);
    fireEvent.click(screen.getByRole('button', { name: 'AI popups: 2 running. Show' }));
    expect(useFloatingSessionsStore.getState().phoneShown).toBe('t-2');
  });

  it('is absent with none', () => {
    render(<PhoneFloatsButton sessionId="other" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
