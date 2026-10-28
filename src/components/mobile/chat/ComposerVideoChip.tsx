/**
 * ComposerVideoChip — one video in the composer's attachment strip (Oct 27 2026):
 *
 *   ┌──────────┐
 *   │ ▶ 0:42 ✕ │   first frame, length, remove
 *   └──────────┘
 *
 * While it uploads to the Mac the frame dims under "Uploading" (a live status, so a
 * screen reader hears it start and end). The first frame comes from the clip itself:
 * `#t=0.1` makes iOS draw a frame without playing it.
 */
import type { SyntheticEvent } from 'react';
import { CloseIcon } from '../kit/kitIcons';
import { formatVideoLength } from '@/lib/chat/videoAttach';
import type { ComposerVideo } from './useComposerVideos';
import styles from '@/styles/modules/mobile/Composer.module.css';

interface ComposerVideoChipProps {
  video: ComposerVideo;
  onRemove: (key: string) => void;
  onDuration: (key: string, seconds: number) => void;
}

export default function ComposerVideoChip({ video, onRemove, onDuration }: ComposerVideoChipProps) {
  const length = formatVideoLength(video.duration);
  const uploading = video.status === 'uploading';
  const readLength = (e: SyntheticEvent<HTMLVideoElement>) => onDuration(video.key, e.currentTarget.duration);
  return (
    <li className={`${styles.thumb} ${styles.videoThumb}`} data-uploading={uploading || undefined} data-testid={`composer-clip-${video.key}`}>
      {video.previewUrl ? (
        <video src={`${video.previewUrl}#t=0.1`} muted playsInline preload="metadata" onLoadedMetadata={readLength} aria-hidden="true" />
      ) : (
        <span className={styles.videoBlank} aria-hidden="true" />
      )}
      <span className={styles.videoBadge} aria-hidden="true">▶{length ? ` ${length}` : ''}</span>
      <span className={uploading ? styles.videoUploading : styles.srOnly} role="status">
        {uploading ? 'Uploading' : `${video.name} ready`}
      </span>
      <button type="button" className={styles.thumbRemove} onClick={() => onRemove(video.key)} aria-label={`Remove video ${video.name}`}>
        <CloseIcon />
      </button>
    </li>
  );
}
