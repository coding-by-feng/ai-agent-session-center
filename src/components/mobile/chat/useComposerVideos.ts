/**
 * useComposerVideos — the videos a phone message carries (Oct 27 2026).
 *
 * Each picked or recorded video uploads to the Mac at once (lib/chat/videoAttach),
 * so Send waits only for what is still going up. Its chip shows the clip's first
 * frame from a local object URL, which is let go when the chip goes. A failed
 * upload drops its chip and says why. On send, `takePaths()` hands over the saved
 * paths for the message text and empties the strip.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { showToast } from '@/components/ui/ToastContainer';
import { uploadVideo } from '@/lib/chat/videoAttach';

export interface ComposerVideo {
  key: string;
  name: string;
  /** The clip itself, for its chip's first frame; null where the browser can't make one. */
  previewUrl: string | null;
  /** Seconds, once the chip has read it. */
  duration: number | null;
  status: 'uploading' | 'ready';
  /** Where the Mac saved it, once uploaded. */
  path: string | null;
}

let nextKey = 0;

function previewOf(file: File): string | null {
  try {
    return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
  } catch {
    return null;
  }
}

function release(url: string | null): void {
  if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

export function useComposerVideos() {
  const [videos, setVideos] = useState<ComposerVideo[]>([]);
  // The latest list for the unmount clean-up, which must not re-run on every change.
  const latest = useRef(videos);
  useEffect(() => { latest.current = videos; }, [videos]);
  useEffect(() => () => { for (const v of latest.current) release(v.previewUrl); }, []);

  const add = useCallback((files: readonly File[]) => {
    for (const file of files) {
      const key = `video-${++nextKey}`;
      const video: ComposerVideo = { key, name: file.name || 'video', previewUrl: previewOf(file), duration: null, status: 'uploading', path: null };
      setVideos((prev) => [...prev, video]);
      void uploadVideo(file).then((result) => {
        if (result.ok) {
          setVideos((prev) => prev.map((v) => (v.key === key ? { ...v, status: 'ready', path: result.path } : v)));
          return;
        }
        release(video.previewUrl);
        setVideos((prev) => prev.filter((v) => v.key !== key));
        showToast(result.message, 'warning');
      });
    }
  }, []);

  const remove = useCallback((key: string) => {
    setVideos((prev) => {
      const gone = prev.find((v) => v.key === key);
      if (gone) release(gone.previewUrl);
      return prev.filter((v) => v.key !== key);
    });
  }, []);

  const setDuration = useCallback((key: string, duration: number) => {
    setVideos((prev) => prev.map((v) => (v.key === key && v.duration === null ? { ...v, duration } : v)));
  }, []);

  /** The saved paths, in order, and an empty strip. */
  const takePaths = useCallback((): string[] => {
    const paths = latest.current.flatMap((v) => (v.path ? [v.path] : []));
    for (const v of latest.current) release(v.previewUrl);
    latest.current = [];
    setVideos([]);
    return paths;
  }, []);

  return {
    videos,
    uploading: videos.some((v) => v.status === 'uploading'),
    add,
    remove,
    setDuration,
    takePaths,
  };
}
