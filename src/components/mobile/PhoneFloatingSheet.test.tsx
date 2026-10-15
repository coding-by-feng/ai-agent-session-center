// PhoneFloatingSheet.test.tsx — the fork window on a phone (AASC-20): a full-height sheet instead of a
// floating window. Hiding never ends the session; only End does, after a confirm. Info → AI popups
// ("Open") brings a hidden popup back, even with its session's screen under Info (AASC-48).
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
import { settleLazy } from '@/__tests__/settleLazy';

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
  it('replaces the floating windows on a phone, full height, with the popup’s own session at the keys', async () => {
    render(<FloatingTerminalRoot />);
    const dialog = await screen.findByRole('dialog', { name: 'Translate → 中文' });
    expect(screen.queryByTestId('float-panel')).toBeNull();
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

  it('switches between popups with the chips', async () => {
    render(<FloatingTerminalRoot />);
    fireEvent.click(await screen.findByRole('button', { name: '1. Explain (English)' }));
    expect(screen.getByTestId('float-terminal').dataset.terminal).toBe('t-1');
    expect(screen.getByRole('button', { name: '1. Explain (English)' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('closing the sheet hides the popup and leaves it running', async () => {
    render(<FloatingTerminalRoot />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(closeSpy).not.toHaveBeenCalled();
    expect(useFloatingSessionsStore.getState().floats).toHaveLength(2);
  });

  it('End asks first, then closes that popup (saving its answer, killing its terminal)', async () => {
    render(<FloatingTerminalRoot />);
    fireEvent.click(await screen.findByRole('button', { name: 'End' }));
    expect(closeSpy).not.toHaveBeenCalled();
    const confirm = screen.getByRole('dialog', { name: 'End this AI popup?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(closeSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'End this AI popup?' })).getByRole('button', { name: 'End popup' }));
    expect(closeSpy).toHaveBeenCalledWith('t-2');
  });

  it('opens from Info → AI popups, where no session is selected (AASC-48)', async () => {
    useSessionStore.setState({ selectedSessionId: null });
    render(<FloatingTerminalRoot />);
    const dialog = await screen.findByRole('dialog', { name: 'Translate → 中文' });
    expect(within(dialog).getByTestId('float-terminal').getAttribute('data-terminal')).toBe('t-2');
  });

  it('shows nothing with no session selected and no popup asked for', async () => {
    useSessionStore.setState({ selectedSessionId: null });
    useFloatingSessionsStore.setState({ phoneShown: null });
    render(<FloatingTerminalRoot />);
    await settleLazy(() => import('./PhoneFloatingSheet'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows nothing for another session’s popups', async () => {
    useSessionStore.setState({ selectedSessionId: 'other' });
    render(<FloatingTerminalRoot />);
    await settleLazy(() => import('./PhoneFloatingSheet'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
