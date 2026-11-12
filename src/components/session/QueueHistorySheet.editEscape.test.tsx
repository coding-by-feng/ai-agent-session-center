/**
 * Escape in the history sheet's editor (the real QueueItemEditModal): the editor owns
 * its Escape, so an open photo closes first and the editor keeps its edits; the next
 * Escape closes the editor, the one after that the sheet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import QueueHistorySheet from './QueueHistorySheet';
import { useQueueHistoryStore, type QueueHistoryEntry } from '@/stores/queueHistoryStore';

const platform = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));

const entry: QueueHistoryEntry = {
  id: 3, alias: 'Nightly e2e', sourceSessionTitle: 'AASC', sourceSessionId: 's1', usedCount: 2,
  createdAt: 1, lastUsedAt: null,
  item: {
    id: 9, sessionId: 's1', text: 'run the e2e suite', position: 0, createdAt: 1,
    images: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' }],
  },
};

beforeEach(() => {
  platform.isMobile = false;
  useQueueHistoryStore.setState({ entries: [entry] } as Partial<ReturnType<typeof useQueueHistoryStore.getState>>);
});

const esc = () => fireEvent.keyDown(document, { key: 'Escape' });
const editor = () => screen.queryByRole('dialog', { name: 'Edit history entry' });

describe('QueueHistorySheet — Escape in its editor', () => {
  it('closes the photo, then the editor, then the sheet — one layer per Escape', () => {
    const onClose = vi.fn();
    render(<QueueHistorySheet open onClose={onClose} currentSessionId="s1" currentSessionTitle="AASC" />);
    fireEvent.click(screen.getByRole('button', { name: /^Edit/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Main prompt' }), { target: { value: 'edited text' } });
    fireEvent.click(screen.getByRole('button', { name: 'View a.png' }));

    esc();
    expect(screen.queryByRole('dialog', { name: 'a.png' })).toBeNull();
    expect(editor()).not.toBeNull();
    expect(screen.getByRole('textbox', { name: 'Main prompt' })).toHaveValue('edited text');

    esc();
    expect(editor()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
