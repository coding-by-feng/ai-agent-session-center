/**
 * TerminalToolbar shows theme selector, fullscreen toggle, reconnect, and ESC button.
 * Ported from the toolbar controls in public/js/terminalManager.js.
 */
import { useCallback } from 'react';
import { getThemeNames } from './themes';
import styles from '@/styles/modules/Terminal.module.css';

interface TerminalToolbarProps {
  themeName: string;
  onThemeChange: (theme: string) => void;
  onFullscreen: () => void;
  onSendEscape: () => void;
  onReconnect?: () => void;
  onRefresh?: () => void;
  isFullscreen: boolean;
  showReconnect?: boolean;
}

export default function TerminalToolbar({
  themeName,
  onThemeChange,
  onFullscreen,
  onSendEscape,
  onReconnect,
  onRefresh,
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
        title="Send Escape key"
      >
        ESC
      </button>

      {onRefresh && (
        <button
          className={styles.toolbarBtn}
          onClick={onRefresh}
          title="Refresh terminal"
        >
          REFRESH
        </button>
      )}

      <button
        className={styles.toolbarBtn}
        onClick={onFullscreen}
        title={isFullscreen ? 'Exit fullscreen (Alt+F11)' : 'Fullscreen (Alt+F11)'}
      >
        {isFullscreen ? 'EXIT FS' : 'FULLSCREEN'}
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
