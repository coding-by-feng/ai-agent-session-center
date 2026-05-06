/**
 * TerminalToolbar shows theme selector, ESC, paste icon, expand/collapse,
 * fullscreen toggle, and reconnect.
 */
import { useCallback, useMemo } from 'react';
import { getThemeNames } from './themes';
import Select from '@/components/ui/Select';
import type { SelectOption } from '@/components/ui/Select';
import Tooltip from '@/components/ui/Tooltip';
import { tooltips } from '@/lib/tooltips';
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

/** Auto-scroll toggle icon: down arrow with circular "auto" indicator. */
function AutoScrollIcon({ enabled }: { enabled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="7 13 12 18 17 13" />
      <line x1="12" y1="6" x2="12" y2="18" />
      {enabled && <circle cx="12" cy="3" r="2" fill="currentColor" stroke="none" />}
      {!enabled && <line x1="10" y1="1" x2="14" y2="5" />}
      {!enabled && <line x1="14" y1="1" x2="10" y2="5" />}
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

/** Clone/copy SVG icon (new session with same config). */
function CloneIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      <line x1="14" y1="11" x2="14" y2="17" />
      <line x1="11" y1="14" x2="17" y2="14" />
    </svg>
  );
}

/** Fork/branch SVG icon (git fork). */
/** Translate / globe-with-fork SVG icon. Used for select-to-translate
 * toolbar buttons that spawn a floating translation session. */
function TranslateIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12 H21" />
      <path d="M12 3 C8 7, 8 17, 12 21" />
      <path d="M12 3 C16 7, 16 17, 12 21" />
    </svg>
  );
}

function ForkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
      <line x1="12" y1="12" x2="12" y2="15" />
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

/** Microphone SVG icon (hold-to-speak). */
function MicIcon({ active }: { active?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24"
      fill={active ? 'currentColor' : 'none'}
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="9" y1="22" x2="15" y2="22" />
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
  autoScrollEnabled?: boolean;
  onToggleAutoScroll?: () => void;
  onFork?: () => void;
  onClone?: () => void;
  /** Open a floating session that translates the previous assistant answer. */
  onTranslateAnswer?: () => void;
  /** Target language for the translate-answer button label, e.g. "中文". */
  translateAnswerLanguage?: string;
  /** True while the translate-answer request is in-flight. */
  translateAnswerBusy?: boolean;
  isFullscreen: boolean;
  showReconnect?: boolean;
  /** Show hold-to-speak mic button (TTS enabled in settings). */
  ttsEnabled?: boolean;
  ttsActive?: boolean;
  onTtsPressStart?: () => void;
  onTtsPressEnd?: () => void;
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
  autoScrollEnabled = true,
  onToggleAutoScroll,
  onFork,
  onClone,
  onTranslateAnswer,
  translateAnswerLanguage = '',
  translateAnswerBusy = false,
  isFullscreen,
  showReconnect = false,
  ttsEnabled = false,
  ttsActive = false,
  onTtsPressStart,
  onTtsPressEnd,
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
      <Tooltip {...tooltips.termThemePicker}>
        <Select
          value={themeName}
          onChange={onThemeChange}
          options={themeOptions}
        />
      </Tooltip>

      <Tooltip {...tooltips.termSendEsc}>
        <button
          className={`${styles.toolbarBtn} ${styles.touchOnlyBtn}`}
          onClick={onSendEscape}
          aria-label={tooltips.termSendEsc.label}
        >
          <EscIcon />
        </button>
      </Tooltip>

      <Tooltip {...tooltips.termPaste}>
        <button
          className={`${styles.toolbarBtn} ${styles.touchOnlyBtn}`}
          onClick={onPaste}
          aria-label={tooltips.termPaste.label}
        >
          <PasteIcon />
        </button>
      </Tooltip>

      <Tooltip {...tooltips.termSendUp}>
        <button
          className={`${styles.toolbarBtn} ${styles.touchOnlyBtn}`}
          onClick={onSendArrowUp}
          aria-label={tooltips.termSendUp.label}
        >
          <ArrowUpIcon />
        </button>
      </Tooltip>

      <Tooltip {...tooltips.termSendDown}>
        <button
          className={`${styles.toolbarBtn} ${styles.touchOnlyBtn}`}
          onClick={onSendArrowDown}
          aria-label={tooltips.termSendDown.label}
        >
          <ArrowDownIcon />
        </button>
      </Tooltip>

      <Tooltip {...tooltips.termSendEnter}>
        <button
          className={`${styles.toolbarBtn} ${styles.touchOnlyBtn}`}
          onClick={onSendEnter}
          aria-label={tooltips.termSendEnter.label}
        >
          <EnterIcon />
        </button>
      </Tooltip>

      {onToggleAutoScroll && (
        <Tooltip {...(autoScrollEnabled ? tooltips.termAutoScrollOn : tooltips.termAutoScrollOff)}>
          <button
            className={`${styles.toolbarBtn} ${autoScrollEnabled ? styles.autoScrollActiveBtn : ''}`}
            onClick={onToggleAutoScroll}
            aria-label={(autoScrollEnabled ? tooltips.termAutoScrollOn : tooltips.termAutoScrollOff).label}
          >
            <AutoScrollIcon enabled={autoScrollEnabled} />
          </button>
        </Tooltip>
      )}

      {onScrollToBottom && (
        <Tooltip {...tooltips.termScrollBottom}>
          <button
            className={styles.toolbarBtn}
            onClick={onScrollToBottom}
            aria-label={tooltips.termScrollBottom.label}
          >
            <ScrollToBottomIcon />
          </button>
        </Tooltip>
      )}

      {onRefreshOutput && (
        <Tooltip {...tooltips.termRefresh}>
          <button
            className={styles.toolbarBtn}
            onClick={onRefreshOutput}
            aria-label={tooltips.termRefresh.label}
          >
            <RefreshIcon />
          </button>
        </Tooltip>
      )}

      {onBookmark && (
        <Tooltip
          label={tooltips.termBookmark.label}
          description={
            bookmarkCount > 0
              ? `${bookmarkCount} saved. Select text to add a new one, or click to open the panel.`
              : tooltips.termBookmark.description
          }
        >
          <button
            className={`${styles.toolbarBtn} ${bookmarkCount > 0 ? styles.bookmarkActiveBtn : ''}`}
            onClick={onBookmark}
            aria-label={tooltips.termBookmark.label}
            style={{ position: 'relative' }}
          >
            <BookmarkIcon active={bookmarkCount > 0} />
            {bookmarkCount > 0 && (
              <span className={styles.bookmarkBadge}>{bookmarkCount}</span>
            )}
          </button>
        </Tooltip>
      )}

      {onClone && (
        <Tooltip {...tooltips.termClone}>
          <button
            className={styles.toolbarBtn}
            onClick={onClone}
            aria-label={tooltips.termClone.label}
          >
            <CloneIcon />
          </button>
        </Tooltip>
      )}

      {onFork && (
        <Tooltip {...tooltips.termFork}>
          <button
            className={styles.toolbarBtn}
            onClick={onFork}
            aria-label={tooltips.termFork.label}
          >
            <ForkIcon />
          </button>
        </Tooltip>
      )}

      {onTranslateAnswer && (
        <Tooltip
          label={tooltips.termTranslateAnswer.label}
          description={
            translateAnswerLanguage
              ? `Translate the previous assistant answer into ${translateAnswerLanguage}. Opens a floating session.`
              : tooltips.termTranslateAnswer.description
          }
        >
          <button
            className={styles.toolbarBtn}
            onClick={onTranslateAnswer}
            disabled={translateAnswerBusy}
            aria-label={tooltips.termTranslateAnswer.label}
          >
            <TranslateIcon />
          </button>
        </Tooltip>
      )}

      {ttsEnabled && onTtsPressStart && onTtsPressEnd && (
        <Tooltip {...tooltips.termSpeak}>
          <button
            className={`${styles.toolbarBtn}${ttsActive ? ` ${styles.autoScrollActiveBtn}` : ''}`}
            onPointerDown={(e) => { e.preventDefault(); onTtsPressStart(); }}
            onPointerUp={onTtsPressEnd}
            onPointerLeave={() => { if (ttsActive) onTtsPressEnd(); }}
            onPointerCancel={onTtsPressEnd}
            aria-label={tooltips.termSpeak.label}
          >
            <MicIcon active={ttsActive} />
          </button>
        </Tooltip>
      )}

      <Tooltip {...(isFullscreen ? tooltips.termFullscreenExit : tooltips.termFullscreen)}>
        <button
          className={styles.toolbarBtn}
          onClick={onFullscreen}
          aria-label={(isFullscreen ? tooltips.termFullscreenExit : tooltips.termFullscreen).label}
        >
          {isFullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
        </button>
      </Tooltip>

      {showReconnect && onReconnect && (
        <Tooltip {...tooltips.termReconnect}>
          <button
            className={`${styles.toolbarBtn} ${styles.reconnectBtn}`}
            onClick={onReconnect}
            aria-label={tooltips.termReconnect.label}
          >
            RECONNECT
          </button>
        </Tooltip>
      )}
    </div>
  );
}
