/**
 * FileOpenChooser — anchored popover shown when a file-path link is clicked
 * (conversation LinkifiedText or terminal link provider). Offers three ways
 * to open the file: in-app viewer, OS default application, or reveal in the
 * OS file manager. Mounted once per React root (AppLayout, PopoutTerminalView).
 */
import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '@/stores/uiStore';
import { useClickOutside } from '@/hooks/useClickOutside';
import { getFileSystemProvider } from '@/lib/fileSystemProvider';
import styles from '@/styles/modules/FileOpenChooser.module.css';

const POPUP_W = 240;
// Header + three actions + divider + cancel; used only for viewport clamping.
const POPUP_H = 196;
const VIEWPORT_MARGIN = 12;

function clampToViewport(x: number, y: number): { x: number; y: number } {
  if (typeof window === 'undefined') return { x, y };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.max(VIEWPORT_MARGIN, Math.min(vw - POPUP_W - VIEWPORT_MARGIN, x)),
    y: Math.max(VIEWPORT_MARGIN, Math.min(vh - POPUP_H - VIEWPORT_MARGIN, y)),
  };
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const REVEAL_LABEL = isMac ? 'Reveal in Finder' : 'Reveal in file explorer';

export default function FileOpenChooser() {
  const chooser = useUiStore((s) => s.pendingFileChooser);
  const popupRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    useUiStore.getState().clearFileChooser();
  }, []);

  useClickOutside(popupRef, close, !!chooser);

  // Esc closes; focus the first action on open.
  useEffect(() => {
    if (!chooser) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const first = popupRef.current?.querySelector<HTMLButtonElement>('button');
    first?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [chooser, close]);

  const openInApp = useCallback(() => {
    if (!chooser) return;
    useUiStore.getState().openFileInProject(chooser.filePath, chooser.projectPath);
    close();
  }, [chooser, close]);

  const openWithDefaultApp = useCallback(() => {
    if (!chooser) return;
    void getFileSystemProvider().openExternal(chooser.projectPath, chooser.filePath);
    close();
  }, [chooser, close]);

  const revealInFinder = useCallback(() => {
    if (!chooser) return;
    void getFileSystemProvider().reveal(chooser.projectPath, chooser.filePath);
    close();
  }, [chooser, close]);

  if (!chooser) return null;

  const pos = clampToViewport(chooser.anchor.x, chooser.anchor.y + 6);
  const fileName = chooser.filePath.split('/').pop() || chooser.filePath;
  const hasProject = !!chooser.projectPath;

  return createPortal(
    <div
      ref={popupRef}
      className={styles.popup}
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      aria-label={`Open ${fileName}`}
    >
      <div className={styles.header} title={chooser.filePath}>{fileName}</div>
      <button type="button" role="menuitem" className={styles.action} onClick={openInApp}>
        Open in app
      </button>
      <button
        type="button"
        role="menuitem"
        className={styles.action}
        onClick={openWithDefaultApp}
        disabled={!hasProject}
        title={hasProject ? undefined : 'No project path known for this session'}
      >
        Open with default app
      </button>
      <button
        type="button"
        role="menuitem"
        className={styles.action}
        onClick={revealInFinder}
        disabled={!hasProject}
        title={hasProject ? undefined : 'No project path known for this session'}
      >
        {REVEAL_LABEL}
      </button>
      <div className={styles.divider} />
      <button type="button" role="menuitem" className={styles.cancel} onClick={close}>
        Cancel
      </button>
    </div>,
    document.body,
  );
}
