/**
 * QueuePhotoButtons — the queue compose box's photo library and camera on a
 * phone (AASC-20), in place of the desktop's paperclip. Picked photos are shrunk
 * to the queue's limits (lib/queueImageAttach) and added to the session's
 * compose draft. QueueTab loads this on a phone only (AASC-31).
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
    const { images: photoFiles, videos } = splitMediaFiles(files);
    for (const video of videos) {
      void uploadVideo(video).then((result) => {
        if (!result.ok) {
          showToast(result.message, 'warning');
          return;
        }
        // Read the draft again: it may have been typed into while the video went up.
        const text = useQueueStore.getState().composeDrafts.get(sessionId)?.text ?? '';
        setComposeDraftPatch(sessionId, { text: withVideoPaths(text, [result.path]) });
        showToast(`Video added: ${video.name}`, 'success');
      });
    }
    if (photoFiles.length === 0) return;
    const draftImages = () => useQueueStore.getState().composeDrafts.get(sessionId)?.images ?? [];
    const held = draftImages();
    void readQueueImages(photoFiles, held.length, undefined, held.reduce((n, i) => n + i.dataUrl.length, 0)).then(({ images, message }) => {
      // Read the draft again: an image removed while these were being read stays removed.
      if (images.length > 0) {
        setComposeDraftPatch(sessionId, { images: addImagesToPrompt(draftImages(), images).images });
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
        className={buttonClassName}
        onClick={() => photoInputRef.current?.click()}
        disabled={full}
        aria-label={`Attach photos or videos (${count} of ${MAX_QUEUE_IMAGES})`}
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
