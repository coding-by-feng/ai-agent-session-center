/**
 * TerminalToolbar shows theme selector, ESC, paste icon, expand/collapse,
 * fullscreen toggle, and reconnect.
 */
import { useCallback, useMemo } from 'react';
import { getThemeNames } from './themes';
import Select from '@/components/ui/Select';
import type { SelectOption } from '@/components/ui/Select';
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

/** Enter/return SVG icon. */
function EnterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
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

/** Scroll-to-bottom SVG icon (down arrow with baseline). */
function ScrollToBottomIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="4" x2="12" y2="16" />
      <polyline points="5 10 12 17 19 10" />
      <line x1="4" y1="20" x2="20" y2="20" />
    </svg>
  );
}

/** Bookmark SVG icon (ribbon shape). */
function BookmarkIcon({ active }: { active?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24"
      fill={active ? 'currentColor' : 'none'}
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** Refresh/replay SVG icon (circular arrow). */
function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
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
  onSendEnter: () => void;
  onPaste: () => void;
  onReconnect?: () => void;
  onScrollToBottom?: () => void;
  onRefreshOutput?: () => void;
  onBookmark?: () => void;
  bookmarkCount?: number;
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
  onSendEnter,
  onPaste,
  onReconnect,
  onScrollToBottom,
  onRefreshOutput,
  onBookmark,
  bookmarkCount = 0,
  isFullscreen,
  showReconnect = false,
}: TerminalToolbarProps) {
  const themeOptions = useMemo<SelectOption[]>(() => [
    { value: 'auto', label: 'Auto' },
    ...getThemeNames().map((name) => ({
      value: name,
      label: name.charAt(0).toUpperCase() + name.slice(1),
    })),
  ], []);

  return (
    <div className={styles.toolbar}>
      <Select
        value={themeName}
        onChange={onThemeChange}
        options={themeOptions}
        title="Terminal theme"
      />

      <button
        className={`${styles.toolbarBtn} ${styles.touchOnlyBtn}`}
        onClick={onSendEscape}
        title="Send Escape key to terminal"
      >
        <EscIcon />
      </button>

      <button
        className={`${styles.toolbarBtn} ${styles.touchOnlyBtn}`}
        onClick={onPaste}
        title="Paste clipboard to terminal"
      >
        <PasteIcon />
      </button>

      <button
        className={`${styles.toolbarBtn} ${styles.touchOnlyBtn}`}
        onClick={onSendArrowUp}
        title="Send Up arrow key to terminal"
      >
        <ArrowUpIcon />
      </button>

      <button
        className={`${styles.toolbarBtn} ${styles.touchOnlyBtn}`}
        onClick={onSendArrowDown}
        title="Send Down arrow key to terminal"
      >
        <ArrowDownIcon />
      </button>

      <button
        className={`${styles.toolbarBtn} ${styles.touchOnlyBtn}`}
        onClick={onSendEnter}
        title="Send Enter key to terminal"
      >
        <EnterIcon />
      </button>

      {onScrollToBottom && (
        <button
          className={styles.toolbarBtn}
          onClick={onScrollToBottom}
          title="Scroll to bottom"
        >
          <ScrollToBottomIcon />
        </button>
      )}

      {onRefreshOutput && (
        <button
          className={styles.toolbarBtn}
          onClick={onRefreshOutput}
          title="Refresh terminal output (clear + replay)"
        >
          <RefreshIcon />
        </button>
      )}

      {onBookmark && (
        <button
          className={`${styles.toolbarBtn} ${bookmarkCount > 0 ? styles.bookmarkActiveBtn : ''}`}
          onClick={onBookmark}
          title={bookmarkCount > 0 ? `Bookmarks (${bookmarkCount}) — select text to add, click to toggle panel` : 'Select terminal text then click to bookmark'}
          style={{ position: 'relative' }}
        >
          <BookmarkIcon active={bookmarkCount > 0} />
          {bookmarkCount > 0 && (
            <span className={styles.bookmarkBadge}>{bookmarkCount}</span>
          )}
        </button>
      )}

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
