import { useCallback, useEffect, useState } from 'react';
import { useUiStore } from '@/stores/uiStore';
import styles from '@/styles/modules/WorkspaceLoadingOverlay.module.css';

// ---------------------------------------------------------------------------
// Failed-title channel — module-level subscriber pattern so the auto-load hook
// can publish failed session titles without coupling to a Zustand store.
// Mirrors the showToast() pattern in ToastContainer.tsx.
// ---------------------------------------------------------------------------
type Listener = (titles: string[]) => void;
const listeners = new Set<Listener>();

/**
 * Publish the list of session titles that failed to restore. The overlay will
 * remain visible (showing an error panel) until the user dismisses it.
 * Pass an empty array to clear any prior errors before a fresh load.
 */
export function reportWorkspaceLoadErrors(failedTitles: string[]): void {
  for (const listener of listeners) {
    listener(failedTitles);
  }
}

export default function WorkspaceLoadingOverlay() {
  const { active, total, done, currentTitle } = useUiStore((s) => s.workspaceLoad);
  const [failedTitles, setFailedTitles] = useState<string[]>([]);

  useEffect(() => {
    const handler: Listener = (titles) => setFailedTitles(titles);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  const dismiss = useCallback(() => {
    setFailedTitles([]);
  }, []);

  const showErrorPanel = !active && failedTitles.length > 0;

  if (!active && !showErrorPanel) return null;

  if (showErrorPanel) {
    return (
      <div className={styles.overlay}>
        <div className={styles.content}>
          <div className={`${styles.title} ${styles.titleError}`}>WORKSPACE LOADED WITH ERRORS</div>
          <div className={styles.subtitleError}>
            {failedTitles.length} session{failedTitles.length === 1 ? '' : 's'} failed to restore
          </div>
          <ul className={styles.failedList}>
            {failedTitles.map((title, idx) => (
              <li key={`${title}-${idx}`} className={styles.failedItem}>
                {title || '(untitled)'}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={styles.dismissBtn}
            onClick={dismiss}
            autoFocus
          >
            DISMISS
          </button>
        </div>
      </div>
    );
  }

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className={styles.overlay}>
      <div className={styles.content}>
        <div className={styles.title}>LOADING WORKSPACE</div>
        <div className={styles.subtitle}>
          {currentTitle ? `Starting: ${currentTitle}` : 'Preparing sessions…'}
        </div>
        <div className={styles.barWrap}>
          <div className={styles.bar} style={{ width: `${pct}%` }} />
        </div>
        <div className={styles.counter}>{done} / {total} sessions</div>
      </div>
    </div>
  );
}
