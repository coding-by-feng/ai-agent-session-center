/**
 * Adding photos while editing a queued prompt on a phone (Nov 7 2026). The edit screen had only
 * the desktop's 12 px paperclip, which read a photo at full size (an iPhone photo blows the
 * prompt's size cap) and offered no camera or video. It now has the compose box's own photo
 * library and camera buttons: photos are shrunk to the queue's limits and added to the item,
 * a video is uploaded and its path added to the prompt, as when composing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import QueueItemEditModal from './QueueItemEditModal';
import type { QueueItem } from '@/stores/queueStore';

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));

const attach = vi.hoisted(() => ({
  readQueueImages: vi.fn(async (files: readonly File[]) => ({
    images: files.map((f) => ({ name: f.name, dataUrl: `data:image/jpeg;base64,${f.name}` })),
    message: null as string | null,
  })),
}));
vi.mock('@/lib/queueImageAttach', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queueImageAttach')>()),
  readQueueImages: attach.readQueueImages,
}));

const video = vi.hoisted(() => ({ uploadVideo: vi.fn(async () => ({ ok: true as const, path: '/tmp/aasc-videos/clip.mov', id: 'v1' })) }));
vi.mock('@/lib/chat/videoAttach', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/videoAttach')>()),
  uploadVideo: video.uploadVideo,
}));

const item: QueueItem = {
  id: 7, sessionId: 'sess', text: 'it’s so slow now why? /rar', position: 0, createdAt: 0,
  images: [{ name: 'first.jpg', dataUrl: 'data:image/jpeg;base64,first' }],
};

function renderEditor() {
  const onSave = vi.fn();
  render(
    <QueueItemEditModal item={item} autoSendEnabled sessionId="sess" onClose={vi.fn()} onSave={onSave} onDelete={vi.fn()} />,
  );
  return { onSave };
}

const pick = (input: HTMLElement, files: File[]) => fireEvent.change(input, { target: { files } });

beforeEach(() => {
  platform.isMobile = true;
  attach.readQueueImages.mockClear();
  video.uploadVideo.mockClear();
});

describe('QueueItemEditModal — photos on a phone', () => {
  it('offers the photo library and the camera, counting the photos it holds', async () => {
    renderEditor();
    expect(await screen.findByRole('button', { name: 'Attach photos or videos (1 of 10)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeInTheDocument();
    expect(screen.queryByTitle('Attach images')).toBeNull();
  });

  it('adds picked photos, shrunk to the limits, to the ones already there and saves them all', async () => {
    const { onSave } = renderEditor();
    const input = await screen.findByTestId('queue-photo-input');
    pick(input, [new File(['x'], 'second.jpg', { type: 'image/jpeg' })]);
    await screen.findByRole('button', { name: 'View second.jpg' });
    // Shrunk against what the item already holds: one image, its data URL's length.
    expect(attach.readQueueImages).toHaveBeenCalledWith(expect.any(Array), 1, undefined, 'data:image/jpeg;base64,first'.length);
    expect(screen.getByRole('button', { name: 'Attach photos or videos (2 of 10)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      images: [
        { name: 'first.jpg', dataUrl: 'data:image/jpeg;base64,first' },
        { name: 'second.jpg', dataUrl: 'data:image/jpeg;base64,second.jpg' },
      ],
    }));
  });

  it('takes a photo with the camera into the same item', async () => {
    renderEditor();
    pick(await screen.findByTestId('queue-camera-input'), [new File(['x'], 'camera.jpg', { type: 'image/jpeg' })]);
    expect(await screen.findByRole('button', { name: 'View camera.jpg' })).toBeInTheDocument();
  });

  it('uploads a picked video and puts its path in the prompt', async () => {
    const { onSave } = renderEditor();
    pick(await screen.findByTestId('queue-photo-input'), [new File(['v'], 'clip.mov', { type: 'video/quicktime' })]);
    await waitFor(() => expect(video.uploadVideo).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      text: 'it’s so slow now why? /rar\n/tmp/aasc-videos/clip.mov',
    })));
  });

  it('a photo can still be removed', async () => {
    renderEditor();
    await screen.findByTestId('queue-photo-input');
    await userEvent.click(screen.getByTitle('Remove image'));
    expect(screen.queryByRole('button', { name: 'View first.jpg' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Attach photos or videos (0 of 10)' })).toBeInTheDocument();
  });
});

describe('QueueItemEditModal — the desktop keeps its paperclip', () => {
  it('shows the paperclip and no phone photo buttons', () => {
    platform.isMobile = false;
    renderEditor();
    expect(screen.getByTitle('Attach images')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Attach photos or videos/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Take a photo' })).toBeNull();
  });
});
