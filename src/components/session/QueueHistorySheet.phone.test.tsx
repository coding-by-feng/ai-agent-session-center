/**
 * The queue history sheet on a phone (AASC-18): portaled to <body> (its full-screen
 * layout is CSS, checked in the phone harness) and Remove asks first. A desktop
 * removes at once, as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import QueueHistorySheet from './QueueHistorySheet';
import { useQueueHistoryStore, type QueueHistoryEntry } from '@/stores/queueHistoryStore';

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));
vi.mock('./QueueItemEditModal', () => ({ default: () => null }));

const entry: QueueHistoryEntry = {
  id: 3, alias: 'Nightly e2e', sourceSessionTitle: 'AASC', sourceSessionId: 's1', usedCount: 2,
  createdAt: 1, lastUsedAt: null,
  item: { id: 9, sessionId: 's1', text: 'run the e2e suite and fix whatever fails', position: 0, createdAt: 1 },
};

let removeEntry: ReturnType<typeof vi.fn>;
beforeEach(() => {
  platform.isMobile = true;
  removeEntry = vi.fn(async () => {});
  useQueueHistoryStore.setState({ entries: [entry], removeEntry } as Partial<ReturnType<typeof useQueueHistoryStore.getState>>);
});

const renderSheet = () => render(
  <div data-testid="panel">
    <QueueHistorySheet open onClose={vi.fn()} currentSessionId="s1" currentSessionTitle="AASC" />
  </div>,
);

describe('QueueHistorySheet on a phone', () => {
  it('is portaled out of the queue panel', () => {
    renderSheet();
    const overlay = document.querySelector('[data-queue-history]') as HTMLElement;
    expect(overlay.parentElement).toBe(document.body);
    expect(within(screen.getByTestId('panel')).queryByText('Nightly e2e')).toBeNull();
  });

  it('Remove asks first: Cancel keeps the entry, Remove removes it', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: /Remove/ }));
    expect(removeEntry).not.toHaveBeenCalled();
    const confirm = screen.getByRole('dialog', { name: 'Remove from history?' });
    expect(within(confirm).getByText(/Nightly e2e/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(removeEntry).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Remove/ }));
    await user.click(within(screen.getByRole('dialog', { name: 'Remove from history?' })).getByRole('button', { name: 'Remove' }));
    expect(removeEntry).toHaveBeenCalledWith(3);
  });

  it('on a desktop it stays in place and removes at once', async () => {
    platform.isMobile = false;
    renderSheet();
    expect(within(screen.getByTestId('panel')).getByText('Nightly e2e')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /Remove/ }));
    expect(removeEntry).toHaveBeenCalledWith(3);
  });
});
