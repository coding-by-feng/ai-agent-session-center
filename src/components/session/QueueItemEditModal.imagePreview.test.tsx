/**
 * The edit form's photo thumbnails open the photo full size (ImagePreview), like the queue
 * compose strip's: a tap on a phone, a click on a desktop. Closing the photo — Esc, its ✕,
 * the backdrop — leaves the editor open with its unsaved edits. The ✕ still only removes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import QueueItemEditModal from './QueueItemEditModal';
import type { QueueItem } from '@/stores/queueStore';

const platform = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));

const IMAGES = [
  { name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' },
  { name: 'b.png', dataUrl: 'data:image/png;base64,BBBB' },
];

const item: QueueItem = {
  id: 1, sessionId: 'sess', text: 'main prompt', position: 0, createdAt: 0, images: IMAGES,
};

function renderEditor() {
  const onClose = vi.fn();
  const onSave = vi.fn();
  render(
    <QueueItemEditModal
      item={item}
      autoSendEnabled
      sessionId="sess"
      onClose={onClose}
      onSave={onSave}
      onDelete={vi.fn()}
    />,
  );
  return { onClose, onSave };
}

const preview = (name: string) => screen.queryByRole('dialog', { name });
const editor = () => screen.queryByRole('dialog', { name: 'Edit queue item' });

beforeEach(() => { platform.isMobile = false; });

describe('QueueItemEditModal — photo thumbnails', () => {
  it('a click on a thumbnail opens that photo full size', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'View b.png' }));
    expect(preview('b.png')?.querySelector('img')?.getAttribute('src')).toBe(IMAGES[1].dataUrl);
  });

  it('Esc closes the photo first and leaves the editor open', () => {
    const { onClose } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'View a.png' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(preview('a.png')).toBeNull();
    expect(editor()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the backdrop and the photo’s ✕ close only the photo', () => {
    const { onClose } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'View a.png' }));
    fireEvent.click(screen.getByTestId('image-preview-backdrop'));
    expect(preview('a.png')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View a.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(preview('a.png')).toBeNull();
    expect(editor()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('✕ on a thumbnail removes it and opens nothing', () => {
    const { onSave } = renderEditor();
    fireEvent.click(screen.getAllByTitle('Remove image')[0]);
    expect(screen.queryByRole('button', { name: 'View a.png' })).toBeNull();
    expect(preview('a.png')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0][0].images).toEqual([IMAGES[1]]);
  });

  it('on a phone the photo lands after the full-screen editor in <body>, so it is on top', () => {
    platform.isMobile = true;
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'View b.png' }));
    const backdrop = screen.getByTestId('image-preview-backdrop');
    const fullScreenEditor = document.querySelector('[data-queue-edit="fullscreen"]');
    expect(backdrop.parentElement).toBe(document.body);
    expect(fullScreenEditor?.parentElement).toBe(document.body);
    expect(fullScreenEditor!.compareDocumentPosition(backdrop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
