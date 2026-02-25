/**
 * TerminalToolbar shows theme selector, ESC, paste icon, expand/collapse,
 * fullscreen toggle, and reconnect.
 */
import { useCallback } from 'react';
import { getThemeNames } from './themes';
import styles from '@/styles/modules/Terminal.module.css';

/** Clipboard/paste SVG icon. */
function PasteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

/** Arrow-up SVG icon (send Up key). */
function ArrowUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

/** Arrow-down SVG icon (send Down key). */
function ArrowDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

/** Maximize/fullscreen SVG icon. */
function MaximizeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

/** Minimize/exit-fullscreen SVG icon. */
function MinimizeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

/** ESC key SVG icon. */
function EscIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <text x="12" y="15" textAnchor="middle" fill="currentColor" stroke="none"
        fontSize="8" fontWeight="700" fontFamily="sans-serif">ESC</text>
    </svg>
  );
}

interface TerminalToolbarProps {
  themeName: string;
  onThemeChange: (theme: string) => void;
  onFullscreen: () => void;
  onSendEscape: () => void;
  onSendArrowUp: () => void;
  onSendArrowDown: () => void;
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
  onSendArrowUp,
  onSendArrowDown,
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
        <EscIcon />
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
        onClick={onSendArrowUp}
        title="Send Up arrow key to terminal"
      >
        <ArrowUpIcon />
      </button>

      <button
        className={styles.toolbarBtn}
        onClick={onSendArrowDown}
        title="Send Down arrow key to terminal"
      >
        <ArrowDownIcon />
      </button>

      <button
        className={styles.toolbarBtn}
        onClick={onFullscreen}
        title={isFullscreen ? 'Exit fullscreen (Alt+F11)' : 'Fullscreen (Alt+F11)'}
      >
        {isFullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
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
