import { useCallback } from 'react';
import styles from '@/styles/modules/BrowseDirButton.module.css';

interface BrowseDirButtonProps {
  /** Called with the chosen absolute directory path. */
  onPick: (path: string) => void;
  /** Seeds the native dialog's starting directory. */
  defaultPath?: string;
}

/**
 * "Browse…" button that opens the native OS folder picker (Electron only).
 *
 * Renders nothing in a plain browser, where the sandbox cannot return an
 * absolute directory path — the Combobox of known/recent dirs stays the
 * fallback there.
 */
export default function BrowseDirButton({ onPick, defaultPath }: BrowseDirButtonProps) {
  const selectDirectory =
    typeof window !== 'undefined' ? window.electronAPI?.selectDirectory : undefined;

  const handleClick = useCallback(async () => {
    if (!selectDirectory) return;
    try {
      const dir = await selectDirectory(defaultPath ? { defaultPath } : undefined);
      if (dir) onPick(dir);
    } catch {
      /* dialog dismissed or failed — keep the current value */
    }
  }, [selectDirectory, defaultPath, onPick]);

  if (!selectDirectory) return null;

  return (
    <button
      type="button"
      className={styles.browseBtn}
      onClick={handleClick}
      title="Browse for a folder…"
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
      Browse…
    </button>
  );
}
