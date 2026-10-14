// NotesTab.phone.test.tsx — notes on a phone (AASC-20): a photo from the camera through the same upload
// as a pasted image, a delete that confirms first, and no camera on a desktop.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));
const photo = vi.hoisted(() => ({ prepare: vi.fn(async (f: File) => new File(['small'], f.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' })) }));
vi.mock('@/lib/cameraPhoto', () => ({ preparePhoto: photo.prepare }));
vi.mock('./NoteMarkdown', () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import { useNotesStore } from '@/stores/notesStore';
import NotesTab from './NotesTab';

const uploadMedia = vi.fn(async () => ({ ok: true as const, media: { id: 'a'.repeat(32), url: `/api/note-media/${'a'.repeat(32)}`, mime: 'image/jpeg', size: 5 } }));
const deleteNote = vi.fn(async () => true);

beforeEach(() => {
  vi.clearAllMocks();
  platform.isMobile = true;
  useNotesStore.setState({
    notes: new Map([['s1', [{ id: 7, sessionId: 's1', text: 'keep this', createdAt: 1, updatedAt: 1 }]]]),
    loadNotes: vi.fn(async () => true),
    uploadMedia,
    deleteNote,
  } as never);
});

describe('NOTES on a phone', () => {
  it('opens the camera through a plain file input', () => {
    render(<NotesTab sessionId="s1" />);
    const input = screen.getByTestId('note-camera-input') as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.accept).toBe('image/*');
    expect(input.getAttribute('capture')).toBe('environment');
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Photo' }));
    expect(click).toHaveBeenCalled();
  });

  it('uploads the photo, scaled, through the note-media route and drops it into the note', async () => {
    render(<NotesTab sessionId="s1" />);
    const input = screen.getByTestId('note-camera-input') as HTMLInputElement;
    const shot = new File(['big'], 'IMG_0042.HEIC', { type: 'image/heic' });
    await act(async () => { fireEvent.change(input, { target: { files: [shot] } }); });
    await waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    expect(photo.prepare).toHaveBeenCalledWith(shot);
    expect(uploadMedia).toHaveBeenCalledWith('s1', expect.objectContaining({ name: 'IMG_0042.jpg' }));
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toContain(`](/api/note-media/${'a'.repeat(32)})`));
  });

  it('asks before deleting a note', async () => {
    render(<NotesTab sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'DELETE' }));
    expect(deleteNote).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Delete this note?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete note' }));
    await waitFor(() => expect(deleteNote).toHaveBeenCalledWith('s1', 7));
  });
});

describe('NOTES on a desktop', () => {
  it('has no camera and deletes as before', async () => {
    platform.isMobile = false;
    render(<NotesTab sessionId="s1" />);
    expect(screen.queryByTestId('note-camera-input')).toBeNull();
    expect(screen.getByText(/⌘⏎ save/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'DELETE' }));
    await waitFor(() => expect(deleteNote).toHaveBeenCalledWith('s1', 7));
  });
});
