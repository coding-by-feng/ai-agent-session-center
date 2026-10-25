/**
 * ImagePreview — one attached image at full size, over everything.
 *
 * Portaled to <body> so a docked panel, a pop-out or a scroller can't clip it (see the
 * "floating overlays" invariant). Esc, Android Back, the backdrop and ✕ all close it; a click
 * on the image itself does not.
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useBackLayer } from '@/lib/backLayers';
import styles from '@/styles/modules/ImagePreview.module.css';

interface ImagePreviewProps {
  src: string;
  name: string;
  onClose: () => void;
}

export default function ImagePreview({ src, name, onClose }: ImagePreviewProps) {
  useBackLayer(true, onClose);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className={styles.backdrop}
      data-testid="image-preview-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-label={name} className={styles.frame}>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close preview" autoFocus>
          ✕
        </button>
        <img src={src} alt={name} className={styles.image} />
        <div className={styles.caption}>{name}</div>
      </div>
    </div>,
    document.body,
  );
}
