/**
 * TerminalToolbar shows theme selector, ESC, paste icon, fullscreen toggle, and reconnect.
 */
import { useCallback } from 'react';
import { getThemeNames } from './themes';
import styles from '@/styles/modules/Terminal.module.css';

/** Clipboard/paste SVG icon (16x16). */
function PasteIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

interface TerminalToolbarProps {
  themeName: string;
  onThemeChange: (theme: string) => void;
  onFullscreen: () => void;
  onSendEscape: () => void;
  onPaste: () => void;
  onReconnect?: () => void;
  isFullscreen: boolean;
  showReconnect?: boolean;
}

export default function TerminalToolbar({
  themeName,
  onThemeChange,
  onFullscreen,
  onSendEscape,
  onPaste,
  onReconnect,
  isFullscreen,
  showReconnect = false,
}: TerminalToolbarProps) {
  const themeNames = getThemeNames();

  const handleThemeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onThemeChange(e.target.value);
    },
    [onThemeChange],
  );

  return (
    <div className={styles.toolbar}>
      <select
        className={styles.themeSelect}
        value={themeName}
        onChange={handleThemeChange}
        title="Terminal theme"
      >
        <option value="auto">Auto</option>
        {themeNames.map((name) => (
          <option key={name} value={name}>
            {name.charAt(0).toUpperCase() + name.slice(1)}
          </option>
        ))}
      </select>

      <button
        className={styles.toolbarBtn}
        onClick={onSendEscape}
        title="Send Escape key to terminal"
      >
        ESC
      </button>

      <button
        className={styles.toolbarBtn}
        onClick={onPaste}
        title="Paste clipboard to terminal"
      >
        <PasteIcon />
      </button>

      <button
        className={styles.toolbarBtn}
        onClick={onFullscreen}
        title={isFullscreen ? 'Exit fullscreen (Alt+F11)' : 'Fullscreen (Alt+F11)'}
      >
        {isFullscreen ? 'EXIT FS' : 'FULLSCREEN'}
        <kbd className={styles.kbdHint}>Alt+F11</kbd>
      </button>

      {showReconnect && onReconnect && (
        <button
          className={`${styles.toolbarBtn} ${styles.reconnectBtn}`}
          onClick={onReconnect}
          title="Reconnect terminal"
        >
          RECONNECT
        </button>
      )}
    </div>
  );
}
