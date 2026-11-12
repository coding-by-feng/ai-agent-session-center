/**
 * QueuePhotoButtons — the queue compose box's photo library and camera on a
 * phone (AASC-20), in place of the desktop's paperclip. Picked photos are shrunk
 * to the queue's limits (lib/queueImageAttach) and added to the session's
 * compose draft. QueueTab loads this on a phone only (AASC-31).
 *
 * `PhotoPickButtons` is the same pair with the destination left to the caller
 * (Nov 7 2026): the phone's Edit queue item screen adds to the item it edits.
 *
 * A picked or recorded video (Oct 27 2026) is too big to ride the queue: it uploads
 * to the Mac at once (lib/chat/videoAttach) and its saved path is added to the
 * prompt's text on its own line, where it can be read and deleted like any text.
 * Videos come from the library; the camera stays photos only, because Android's
 * capture turns any `video/*` in its list into a video-only camera.
 */
import { useCallback, useRef, type ChangeEvent } from 'react';
import { useQueueStore } from '@/stores/queueStore';
import { showToast } from '@/components/ui/ToastContainer';
import { addImagesToPrompt, MAX_QUEUE_IMAGES, readQueueImages } from '@/lib/queueImageAttach';
import { splitMediaFiles, uploadVideo, withVideoPaths } from '@/lib/chat/videoAttach';
import { CameraIcon, PhotoIcon } from './projectIcons';
import type { QueueImageAttachment } from '@/stores/queueStore';

export interface PhotoPickButtonsProps {
  /** Images already in the prompt. */
  count: number;
  /** The compose row's button classes (Terminal.module.css). */
  buttonClassName: string;
  /** The prompt's images as they are now: read again after each async step. */
  getImages: () => readonly QueueImageAttachment[];
  /** Picked photos, shrunk and within the caps, to add to the prompt. */
  onImages: (images: QueueImageAttachment[]) => void;
  /** An uploaded video's saved path, to add to the prompt's text. */
  onVideoPath: (path: string) => void;
}

/** The photo library and camera buttons, adding to whatever prompt the caller names. */
export function PhotoPickButtons({ count, buttonClassName, getImages, onImages, onVideoPath }: PhotoPickButtonsProps) {
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const handlePhoneImages = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // Reset so the same photo can be picked again.
    e.target.value = '';
    if (files.length === 0) return;
    const { images: photoFiles, videos } = splitMediaFiles(files);
    for (const video of videos) {
      void uploadVideo(video).then((result) => {
        if (!result.ok) {
          showToast(result.message, 'warning');
          return;
        }
        onVideoPath(result.path);
        showToast(`Video added: ${video.name}`, 'success');
      });
    }
    if (photoFiles.length === 0) return;
    const held = getImages();
    void readQueueImages(photoFiles, held.length, undefined, held.reduce((n, i) => n + i.dataUrl.length, 0)).then(({ images, message }) => {
      if (images.length > 0) onImages(images);
      if (message) showToast(message, 'warning');
    });
  }, [getImages, onImages, onVideoPath]);

  const full = count >= MAX_QUEUE_IMAGES;
  return (
    <>
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*,video/*"
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
        type="button"
        className={buttonClassName}
        onClick={() => photoInputRef.current?.click()}
        disabled={full}
        aria-label={`Attach photos or videos (${count} of ${MAX_QUEUE_IMAGES})`}
      >
        <PhotoIcon />
      </button>
      <button
        type="button"
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

export interface QueuePhotoButtonsProps {
  sessionId: string;
  /** Images already in the compose draft. */
  count: number;
  /** The compose row's button classes (Terminal.module.css). */
  buttonClassName: string;
}

/** The compose box's pair: adds to the session's compose draft. */
export default function QueuePhotoButtons({ sessionId, count, buttonClassName }: QueuePhotoButtonsProps) {
  const setComposeDraftPatch = useQueueStore((s) => s.setComposeDraft);
  // Read the draft again at each step: it may have been typed into, or an image
  // removed, while a video went up or the photos were read.
  const getImages = useCallback(() => useQueueStore.getState().composeDrafts.get(sessionId)?.images ?? [], [sessionId]);
  const onImages = useCallback((images: QueueImageAttachment[]) => {
    setComposeDraftPatch(sessionId, { images: addImagesToPrompt([...getImages()], images).images });
  }, [getImages, sessionId, setComposeDraftPatch]);
  const onVideoPath = useCallback((path: string) => {
    const text = useQueueStore.getState().composeDrafts.get(sessionId)?.text ?? '';
    setComposeDraftPatch(sessionId, { text: withVideoPaths(text, [path]) });
  }, [sessionId, setComposeDraftPatch]);
  return (
    <PhotoPickButtons
      count={count}
      buttonClassName={buttonClassName}
      getImages={getImages}
      onImages={onImages}
      onVideoPath={onVideoPath}
    />
  );
}
