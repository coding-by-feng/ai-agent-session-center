/**
 * The queue's edit form on a phone (AASC-18): the whole screen, portaled out of
 * the panel, and "Delete item" asks first. On a desktop it is the centred dialog
 * it always was, and Delete acts at once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import QueueItemEditModal from './QueueItemEditModal';
import type { QueueItem } from '@/stores/queueStore';

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));

const item: QueueItem = {
  id: 7, sessionId: 'sess', text: 'run the e2e suite', position: 0, createdAt: 0,
  type: 'loop', intervalMs: 30 * 60_000, beforeChain: [{ id: 1, text: '/context' }],
};

function renderEditor(onDelete = vi.fn()) {
  const { container } = render(
    <div data-testid="panel">
      <QueueItemEditModal
        item={item}
        autoSendEnabled
        sessionId="sess"
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={onDelete}
      />
    </div>,
  );
  return { container, onDelete };
}

const editor = () => document.querySelector('[data-queue-edit]') as HTMLElement;

beforeEach(() => { platform.isMobile = true; });

describe('QueueItemEditModal — full screen on phones only', () => {
  it('on a phone: full screen, portaled to <body>, named by its title', () => {
    const { container } = renderEditor();
    expect(editor().dataset.queueEdit).toBe('fullscreen');
    expect(editor().className).toMatch(/chainModalPhone/);
    expect(editor().parentElement).toBe(document.body);
    expect(container.querySelector('[data-queue-edit]')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Edit queue item' })).toBeInTheDocument();
    // The chains are all there: one editor, every type.
    expect(screen.getByText('Before chain')).toBeInTheDocument();
    expect(screen.getByText('After chain')).toBeInTheDocument();
  });

  it('on a phone it wears the phone dress, like the session queue it opens from', () => {
    // Portaled to <body>, it sits outside Info's dressed page: the class rides on its own root.
    renderEditor();
    expect(editor().className).toMatch(/dress/);
  });

  it('on a desktop: the centred dialog, in place', () => {
    platform.isMobile = false;
    const { container } = renderEditor();
    expect(editor().dataset.queueEdit).toBe('dialog');
    expect(editor().className).not.toMatch(/chainModalPhone/);
    expect(editor().className).not.toMatch(/dress/);
    expect(container.querySelector('[data-queue-edit]')).not.toBeNull();
  });

  it('on a phone, Delete item asks first', async () => {
    const user = userEvent.setup();
    const { onDelete } = renderEditor();
    await user.click(screen.getByRole('button', { name: 'Delete item' }));
    expect(onDelete).not.toHaveBeenCalled();
    const sheet = screen.getByRole('dialog', { name: 'Delete this prompt?' });
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete item' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Delete this prompt?' })).getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('on a desktop, Delete item acts at once', async () => {
    platform.isMobile = false;
    const { onDelete } = renderEditor();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Delete item' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
