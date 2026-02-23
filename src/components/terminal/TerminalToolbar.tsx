/**
 * TerminalToolbar shows theme selector, reconnect, and ESC button.
 * Fullscreen is handled via Alt+F11 hotkey only (no button).
 */
import { useCallback } from 'react';
import { getThemeNames } from './themes';
import styles from '@/styles/modules/Terminal.module.css';

interface TerminalToolbarProps {
  themeName: string;
  onThemeChange: (theme: string) => void;
  onSendEscape: () => void;
  onReconnect?: () => void;
  showReconnect?: boolean;
}

export default function TerminalToolbar({
  themeName,
  onThemeChange,
  onSendEscape,
  onReconnect,
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
