/**
 * FileOpenChooser — anchored popover shown when a file-path link is clicked
 * (conversation LinkifiedText or terminal link provider). Offers three ways
 * to open the file: in-app viewer, OS default application, or reveal in the
 * OS file manager. Mounted once per React root (AppLayout, PopoutTerminalView,
 * PopoutProjectView, PopoutSessionView).
 */
import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '@/stores/uiStore';
import { useClickOutside } from '@/hooks/useClickOutside';
import { getFileSystemProvider } from '@/lib/fileSystemProvider';
import { showToast } from '@/components/ui/ToastContainer';
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

/** What the popover is about: the file's name, or for a folder (rooted at itself) the folder's. */
function targetName(chooser: { filePath: string; projectPath: string; kind?: 'dir' }): string {
  const path = chooser.kind === 'dir' ? chooser.projectPath : chooser.filePath;
  return path.split('/').filter(Boolean).pop() || path;
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
    useUiStore.getState().openFileInProject(chooser.filePath, chooser.projectPath, chooser.hostProjectPath, chooser.kind);
    close();
  }, [chooser, close]);

  // Both used to fire and forget, so a refused path did nothing and said nothing (Nov 17 2026).
  const runOnMac = useCallback((verb: string, action: (root: string, path: string) => Promise<void>) => {
    if (!chooser) return;
    const { projectPath, filePath } = chooser;
    const name = targetName(chooser);
    close();
    action(projectPath, filePath).catch((err: unknown) => {
      showToast(`Couldn’t ${verb} ${name}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    });
  }, [chooser, close]);

  const openWithDefaultApp = useCallback(() => {
    const provider = getFileSystemProvider();
    runOnMac('open', (root, path) => provider.openExternal(root, path));
  }, [runOnMac]);

  const revealInFinder = useCallback(() => {
    const provider = getFileSystemProvider();
    runOnMac('reveal', (root, path) => provider.reveal(root, path));
  }, [runOnMac]);

  if (!chooser) return null;

  const pos = clampToViewport(chooser.anchor.x, chooser.anchor.y + 6);
  const fileName = targetName(chooser);
  const isDir = chooser.kind === 'dir';
  const hasProject = !!chooser.projectPath;

  return createPortal(
    <div
      ref={popupRef}
      className={styles.popup}
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      aria-label={`Open ${fileName}`}
    >
      <div className={styles.header} title={isDir ? chooser.projectPath : chooser.filePath}>{fileName}</div>
      <button type="button" role="menuitem" className={styles.action} onClick={openInApp}>
        Open in app
      </button>
      {/* A folder's default app is the file manager: Reveal below covers it. */}
      {!isDir && (
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
      )}
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
