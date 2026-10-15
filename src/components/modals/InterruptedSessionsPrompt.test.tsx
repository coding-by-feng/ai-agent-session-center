// @vitest-environment jsdom
// InterruptedSessionsPrompt — the reminder after a restore to continue cut-off sessions.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

const runner = vi.hoisted(() => vi.fn(async () => ({ sent: [], skipped: [] })));
vi.mock('@/lib/interruptedRestore', async (orig) => {
  const real = await orig<typeof import('@/lib/interruptedRestore')>();
  return { ...real, continueInterrupted: runner };
});

import InterruptedSessionsPrompt from './InterruptedSessionsPrompt';
import { dismissInterrupted, getInterruptedOffer, offerInterrupted } from '@/lib/interruptedRestore';
import { useUiStore } from '@/stores/uiStore';

const items = [
  { terminalId: 't1', title: 'SMS Development', status: 'working' },
  { terminalId: 't2', title: 'Exmouth Design', status: 'approval' },
];

describe('InterruptedSessionsPrompt', () => {
  beforeEach(() => {
    runner.mockClear();
    useUiStore.setState({ activeModal: null });
  });
  afterEach(() => {
    cleanup();
    act(() => dismissInterrupted());
  });

  it('shows nothing without an offer', () => {
    render(<InterruptedSessionsPrompt />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists the interrupted sessions with what they were doing', () => {
    render(<InterruptedSessionsPrompt />);
    act(() => offerInterrupted({ items, restoreStartedAt: 42 }));
    const dialog = screen.getByRole('dialog', { name: '2 sessions were interrupted when AASC closed' });
    expect(dialog.textContent).toContain('SMS Development');
    expect(dialog.textContent).toContain('working');
    expect(dialog.textContent).toContain('Exmouth Design');
    expect(dialog.textContent).toContain('waiting on approval');
    expect(screen.getByRole('button', { name: 'Continue 2 sessions' })).toBeTruthy();
  });

  it('Continue sends to every listed session and closes the reminder', () => {
    render(<InterruptedSessionsPrompt />);
    act(() => offerInterrupted({ items, restoreStartedAt: 42 }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue 2 sessions' }));
    expect(runner).toHaveBeenCalledWith(items, 42);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getInterruptedOffer()).toBeNull();
  });

  it('Not now sends nothing and closes it; so does Escape', () => {
    render(<InterruptedSessionsPrompt />);
    act(() => offerInterrupted({ items, restoreStartedAt: 42 }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(runner).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => offerInterrupted({ items: items.slice(0, 1), restoreStartedAt: 43 }));
    expect(screen.getByRole('dialog', { name: '1 session was interrupted when AASC closed' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(runner).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getInterruptedOffer()).toBeNull();
  });

  it('waits for another open dialog to close before showing', () => {
    useUiStore.setState({ activeModal: 'kill-confirm' });
    render(<InterruptedSessionsPrompt />);
    act(() => offerInterrupted({ items, restoreStartedAt: 42 }));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => useUiStore.setState({ activeModal: null }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
