/**
 * TerminalContainer wraps xterm.js 5 with FitAddon, Unicode11Addon, and custom URL link provider.
 * Uses the useTerminal hook for lifecycle management.
 * Ported from public/js/terminalManager.js.
 */
import { useEffect, useRef, useState, useCallback, memo } from 'react';
import { createPortal } from 'react-dom';
import { useTerminal } from '@/hooks/useTerminal';
import type { TerminalBookmarkPosition } from '@/hooks/useTerminal';
import TerminalToolbar from './TerminalToolbar';
import { useSettingsStore } from '@/stores/settingsStore';
import { ttsEngine } from '@/lib/ttsEngine';
import styles from '@/styles/modules/Terminal.module.css';
import '@xterm/xterm/css/xterm.css';

interface TerminalBookmark {
  id: string;
  terminalId: string;
  scrollLine: number;
  selectedText: string;
  note: string;
  timestamp: number;
  selStartX: number;
  selStartY: number;
  selEndX: number;
  selEndY: number;
}

interface TerminalContainerProps {
  terminalId: string | null;
  ws: WebSocket | null;
  showReconnect?: boolean;
  onReconnect?: () => void;
  /** When provided, the bookmark panel is rendered via portal into this element instead of inline */
  bookmarkPortalTarget?: HTMLDivElement | null;
  /** Project root path — enables clickable file paths in terminal output */
  projectPath?: string;
  /** Fork the current Claude Code session (--continue --fork-session) */
  onFork?: () => void;
}

const DEFAULT_MIN_HEIGHT = '200px';

export default memo(function TerminalContainer({
  terminalId,
  ws,
  showReconnect = false,
  onReconnect,
  bookmarkPortalTarget,
  projectPath,
  onFork,
}: TerminalContainerProps) {
  const [themeName, setThemeName] = useState<string>(() => {
    try {
      return localStorage.getItem('terminal-theme') || 'auto';
    } catch {
      return 'auto';
    }
  });

  const [bookmarks, setBookmarks] = useState<TerminalBookmark[]>([]);
  const [showBookmarkPanel, setShowBookmarkPanel] = useState(false);
  const [isClosed, setIsClosed] = useState(false);

  const fsContainerRef = useRef<HTMLDivElement | null>(null);

  const {
    containerRef,
    attach,
    detach,
    isFullscreen,
    toggleFullscreen,
    sendEscape,
    sendArrowUp,
    sendArrowDown,
    sendEnter,
    pasteToTerminal,
    refitTerminal,
    setTheme,
    handleTerminalOutput,
    handleTerminalReady,
    handleTerminalClosed,
    reparent,
    scrollToBottom,
    refreshOutput,
    scrollPageUp,
    scrollPageDown,
    getTerminalBookmark,
    scrollToLine,
    jumpToBookmark,
    autoScrollEnabled,
    toggleAutoScroll,
    readRecentText,
  } = useTerminal({ ws, themeName, projectPath });

  // ---- Hold-to-speak (TTS) ----
  const ttsEnabledSetting = useSettingsStore((s) => s.ttsEnabled);
  const ttsApiKey = useSettingsStore((s) => s.googleTtsApiKey);
  const ttsVoiceEn = useSettingsStore((s) => s.ttsVoiceEn);
  const ttsVoiceZh = useSettingsStore((s) => s.ttsVoiceZh);
  const ttsRate = useSettingsStore((s) => s.ttsSpeakingRate);
  // Effective enable: requires both the toggle AND a configured per-user key
  const ttsEnabled = ttsEnabledSetting && ttsApiKey.trim().length > 0;
  const [ttsActive, setTtsActive] = useState(false);
  const ttsActiveRef = useRef(false);
  const ttsLastAbsRef = useRef<number>(-1);
  const ttsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTts = useCallback(() => {
    if (!ttsActiveRef.current) return;
    ttsActiveRef.current = false;
    setTtsActive(false);
    ttsEngine.stop();
    if (ttsPollRef.current) {
      clearInterval(ttsPollRef.current);
      ttsPollRef.current = null;
    }
  }, []);

  const startTts = useCallback(() => {
    if (!ttsEnabled || ttsActiveRef.current) return;
    ttsActiveRef.current = true;
    setTtsActive(true);
    const opts = { apiKey: ttsApiKey, voiceEn: ttsVoiceEn, voiceZh: ttsVoiceZh, speakingRate: ttsRate };
    // Speak the current tail immediately
    const initial = readRecentText({ lines: 20 });
    ttsLastAbsRef.current = initial.absBottom;
    if (initial.text) {
      ttsEngine.speak(initial.text, opts).catch(() => { /* swallowed; stop() will clean */ });
    }
    // Then poll for new lines every 1.2s while held
    ttsPollRef.current = setInterval(() => {
      if (!ttsActiveRef.current) return;
      const snap = readRecentText({ sinceAbsLine: ttsLastAbsRef.current });
      if (snap.absBottom > ttsLastAbsRef.current && snap.text) {
        ttsLastAbsRef.current = snap.absBottom;
        ttsEngine.speak(snap.text, opts).catch(() => { /* ignore */ });
      } else {
        ttsLastAbsRef.current = snap.absBottom;
      }
    }, 1200);
  }, [ttsEnabled, ttsApiKey, ttsVoiceEn, ttsVoiceZh, ttsRate, readRecentText]);

  // Spacebar hold triggers TTS while focus is inside this terminal wrapper
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ttsEnabled) return;
    const isInRoot = (el: EventTarget | null): boolean => {
      if (!(el instanceof Node)) return false;
      return !!rootRef.current && rootRef.current.contains(el);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Ignore when typing in an input or when xterm itself has focus and is capturing
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (!isInRoot(target)) return;
      e.preventDefault();
      startTts();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (ttsActiveRef.current) {
        e.preventDefault();
        stopTts();
      }
    };
    const onBlur = () => stopTts();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      stopTts();
    };
  }, [ttsEnabled, startTts, stopTts]);

  // Stop TTS if it becomes disabled mid-playback
  useEffect(() => {
    if (!ttsEnabled) stopTts();
  }, [ttsEnabled, stopTts]);

  // Attach/detach when terminalId changes
  useEffect(() => {
    setIsClosed(false);
    if (terminalId) {
      attach(terminalId);
    } else {
      detach();
    }
  }, [terminalId, attach, detach]);

  // Load bookmarks when terminalId changes
  useEffect(() => {
    if (!terminalId) { setBookmarks([]); return; }
    try {
      const saved = localStorage.getItem(`term-bookmarks:${terminalId}`);
      setBookmarks(saved ? JSON.parse(saved) : []);
    } catch {
      setBookmarks([]);
    }
  }, [terminalId]);

  // Persist bookmarks whenever they change
  useEffect(() => {
    if (!terminalId) return;
    try {
      localStorage.setItem(`term-bookmarks:${terminalId}`, JSON.stringify(bookmarks));
    } catch {
      // ignore
    }
  }, [terminalId, bookmarks]);

  // Move xterm element between inline and fullscreen containers
  useEffect(() => {
    // Defer one frame so the portal DOM is committed
    requestAnimationFrame(() => {
      if (isFullscreen && fsContainerRef.current) {
        reparent(fsContainerRef.current);
      } else if (!isFullscreen && containerRef.current) {
        reparent(containerRef.current);
      }
    });
  }, [isFullscreen, reparent, containerRef]);

  // Mark body so the DetailPanel overlay can be hidden while terminal is fullscreen,
  // preventing the tab bar from showing through the fullscreen overlay.
  useEffect(() => {
    if (isFullscreen) {
      document.body.classList.add('term-fullscreen');
    } else {
      document.body.classList.remove('term-fullscreen');
    }
    return () => document.body.classList.remove('term-fullscreen');
  }, [isFullscreen]);

  // Listen for terminal WS messages
  useEffect(() => {
    if (!ws) return;

    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'terminal_output' && msg.terminalId) {
          handleTerminalOutput(msg.terminalId, msg.data);
        } else if (msg.type === 'terminal_ready' && msg.terminalId) {
          handleTerminalReady(msg.terminalId);
        } else if (msg.type === 'terminal_closed' && msg.terminalId) {
          handleTerminalClosed(msg.terminalId, msg.reason);
          if (msg.terminalId === terminalId) {
            setIsClosed(true);
          }
        }
      } catch {
        // not JSON or not terminal message
      }
    };

    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, terminalId, handleTerminalOutput, handleTerminalReady, handleTerminalClosed]);

  // Refit on visibility change
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible') {
        refitTerminal();
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [refitTerminal]);

  const handleThemeChange = useCallback(
    (name: string) => {
      setThemeName(name);
      setTheme(name);
    },
    [setTheme],
  );

  const handleBookmark = useCallback(() => {
    const pos: TerminalBookmarkPosition | null = getTerminalBookmark();
    if (pos) {
      const newBookmark: TerminalBookmark = {
        id: `tbm-${Date.now()}`,
        terminalId: terminalId!,
        scrollLine: pos.scrollLine,
        selectedText: pos.selectedText,
        note: '',
        timestamp: Date.now(),
        selStartX: pos.selStartX,
        selStartY: pos.selStartY,
        selEndX: pos.selEndX,
        selEndY: pos.selEndY,
      };
      setBookmarks((prev) => [newBookmark, ...prev]);
      setShowBookmarkPanel(true);
    } else {
      // No selection — toggle panel visibility
      setShowBookmarkPanel((prev) => !prev);
    }
  }, [getTerminalBookmark, terminalId]);

  const handleDeleteBookmark = useCallback((id: string) => {
    setBookmarks((prev) => prev.filter((b) => b.id !== id));
  }, []);

  const handleBookmarkNoteChange = useCallback((id: string, note: string) => {
    setBookmarks((prev) => prev.map((b) => (b.id === id ? { ...b, note } : b)));
  }, []);

  const handleJumpToBookmark = useCallback((bm: TerminalBookmark) => {
    jumpToBookmark({
      scrollLine: bm.scrollLine,
      selectedText: bm.selectedText,
      selStartX: bm.selStartX,
      selStartY: bm.selStartY,
      selEndX: bm.selEndX,
      selEndY: bm.selEndY,
    });
  }, [jumpToBookmark]);

  const bookmarkPanelContent = (
    <div className={styles.termBookmarkPanel}>
      <div className={styles.termBookmarkHeader}>
        <span className={styles.termBookmarkTitle}>Bookmarks</span>
        <button
          className={styles.termBookmarkClose}
          onClick={() => setShowBookmarkPanel(false)}
          title="Close bookmark panel"
        >
          ✕
        </button>
      </div>
      {bookmarks.length === 0 ? (
        <div className={styles.termBookmarkEmpty}>
          Select terminal text then click the bookmark button to save a position.
        </div>
      ) : (
        <div className={styles.termBookmarkList}>
          {bookmarks.map((bm) => (
            <div key={bm.id} className={styles.termBookmarkItem}>
              <div className={styles.termBookmarkPreview} title={bm.selectedText}>
                {bm.selectedText.slice(0, 80)}
              </div>
              <textarea
                className={styles.termBookmarkNote}
                rows={1}
                placeholder="Add note…"
                value={bm.note}
                onChange={(e) => handleBookmarkNoteChange(bm.id, e.target.value)}
              />
              <div className={styles.termBookmarkActions}>
                <button
                  className={styles.termBookmarkJumpBtn}
                  onClick={() => handleJumpToBookmark(bm)}
                  title="Jump to this position"
                >
                  Jump
                </button>
                <button
                  className={styles.termBookmarkDelBtn}
                  onClick={() => handleDeleteBookmark(bm.id)}
                  title="Delete bookmark"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (!terminalId) {
    return (
      <div className={styles.placeholder}>
        <div>
          No terminal attached. Create an SSH session or select a session with a terminal.
          {onReconnect && (
            <button className={styles.reconnectPlaceholderBtn} onClick={onReconnect}>
              Reconnect Terminal
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrapper} ref={rootRef}>
      <TerminalToolbar
        themeName={themeName}
        onThemeChange={handleThemeChange}
        onFullscreen={toggleFullscreen}
        onSendEscape={sendEscape}
        onSendArrowUp={sendArrowUp}
        onSendArrowDown={sendArrowDown}
        onSendEnter={sendEnter}
        onPaste={pasteToTerminal}
        onReconnect={onReconnect}
        onScrollToBottom={scrollToBottom}
        onRefreshOutput={refreshOutput}
        onBookmark={handleBookmark}
        bookmarkCount={bookmarks.length}
        autoScrollEnabled={autoScrollEnabled}
        onToggleAutoScroll={toggleAutoScroll}
        onFork={onFork}
        isFullscreen={isFullscreen}
        showReconnect={showReconnect || (isClosed && !!onReconnect)}
        ttsEnabled={ttsEnabled}
        ttsActive={ttsActive}
        onTtsPressStart={startTts}
        onTtsPressEnd={stopTts}
      />
      <div className={styles.terminalArea} style={{ position: 'relative' }}>
        {isClosed && onReconnect && (
          <div className={styles.closedOverlay}>
            <span className={styles.closedOverlayText}>Terminal disconnected</span>
            <button className={styles.reconnectPlaceholderBtn} onClick={onReconnect}>
              Reconnect
            </button>
          </div>
        )}
        <div className={styles.terminalRow}>
          <div
            ref={containerRef}
            className={styles.container}
            style={{ minHeight: DEFAULT_MIN_HEIGHT }}
          />
        </div>
        {/* Bookmark panel: portal to external target if provided, else render inline */}
        {showBookmarkPanel && (bookmarkPortalTarget
          ? createPortal(bookmarkPanelContent, bookmarkPortalTarget)
          : bookmarkPanelContent
        )}
        <div className={styles.mobileScrollOverlay}>
          <button
            className={styles.mobileScrollBtn}
            onClick={scrollPageUp}
            title="Scroll terminal up"
            aria-label="Scroll terminal up"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button
            className={styles.mobileScrollBtn}
            onClick={scrollPageDown}
            title="Scroll terminal down"
            aria-label="Scroll terminal down"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </div>
      {/* Fullscreen overlay — always mounted, toggled via display.
          This avoids unmounting the portal while the xterm element is still inside it. */}
      {createPortal(
        <div
          className={styles.fullscreenOverlay}
          style={{ display: isFullscreen ? 'flex' : 'none' }}
        >
          <div className={styles.fullscreenTopbar}>
            <TerminalToolbar
              themeName={themeName}
              onThemeChange={handleThemeChange}
              onFullscreen={toggleFullscreen}
              onSendEscape={sendEscape}
              onSendArrowUp={sendArrowUp}
              onSendArrowDown={sendArrowDown}
              onSendEnter={sendEnter}
              onPaste={pasteToTerminal}
              onReconnect={onReconnect}
              onScrollToBottom={scrollToBottom}
              onRefreshOutput={refreshOutput}
              onBookmark={handleBookmark}
              bookmarkCount={bookmarks.length}
              autoScrollEnabled={autoScrollEnabled}
              onToggleAutoScroll={toggleAutoScroll}
              onFork={onFork}
              isFullscreen={isFullscreen}
              showReconnect={showReconnect}
            />
          </div>
          <div className={styles.fullscreenArea}>
            <div ref={fsContainerRef} className={styles.fullscreenContainer} />
            <div className={styles.mobileScrollOverlay}>
              <button
                className={styles.mobileScrollBtn}
                onClick={scrollPageUp}
                title="Scroll terminal up"
                aria-label="Scroll terminal up"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="18 15 12 9 6 15" />
                </svg>
              </button>
              <button
                className={styles.mobileScrollBtn}
                onClick={scrollPageDown}
                title="Scroll terminal down"
                aria-label="Scroll terminal down"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
});
