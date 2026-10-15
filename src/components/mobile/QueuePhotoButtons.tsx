/**
 * QueuePhotoButtons — the queue compose box's photo library and camera on a
 * phone (AASC-20), in place of the desktop's paperclip. Picked photos are shrunk
 * to the queue's limits (lib/queueImageAttach) and added to the session's
 * compose draft. QueueTab loads this on a phone only (AASC-31).
 */
import { useCallback, useRef, type ChangeEvent } from 'react';
import { useQueueStore } from '@/stores/queueStore';
import { showToast } from '@/components/ui/ToastContainer';
import { MAX_QUEUE_IMAGES, readQueueImages } from '@/lib/queueImageAttach';
import { CameraIcon, PhotoIcon } from './projectIcons';

export interface QueuePhotoButtonsProps {
  sessionId: string;
  /** Images already in the compose draft. */
  count: number;
  /** The compose row's button classes (Terminal.module.css). */
  buttonClassName: string;
}

export default function QueuePhotoButtons({ sessionId, count, buttonClassName }: QueuePhotoButtonsProps) {
  const setComposeDraftPatch = useQueueStore((s) => s.setComposeDraft);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const handlePhoneImages = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // Reset so the same photo can be picked again.
    e.target.value = '';
    if (files.length === 0) return;
    const draftImages = () => useQueueStore.getState().composeDrafts.get(sessionId)?.images ?? [];
    void readQueueImages(files, draftImages().length).then(({ images, message }) => {
      // Read the draft again: an image removed while these were being read stays removed.
      if (images.length > 0) {
        setComposeDraftPatch(sessionId, { images: [...draftImages(), ...images].slice(0, MAX_QUEUE_IMAGES) });
      }
      if (message) showToast(message, 'warning');
    });
  }, [sessionId, setComposeDraftPatch]);

  const full = count >= MAX_QUEUE_IMAGES;
  return (
    <>
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={handlePhoneImages}
        data-testid="queue-photo-input"
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={handlePhoneImages}
        data-testid="queue-camera-input"
      />
      <button
        className={buttonClassName}
        onClick={() => photoInputRef.current?.click()}
        disabled={full}
        aria-label={`Attach photos (${count} of ${MAX_QUEUE_IMAGES})`}
      >
        <PhotoIcon />
      </button>
      <button
        className={buttonClassName}
        onClick={() => cameraInputRef.current?.click()}
        disabled={full}
        aria-label="Take a photo"
      >
        <CameraIcon />
      </button>
    </>
  );
}
