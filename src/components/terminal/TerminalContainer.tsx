/**
 * TerminalContainer wraps xterm.js 5 with FitAddon, Unicode11Addon, WebLinksAddon.
 * Uses the useTerminal hook for lifecycle management.
 * Ported from public/js/terminalManager.js.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTerminal } from '@/hooks/useTerminal';
import type { TerminalBookmarkPosition } from '@/hooks/useTerminal';
import TerminalToolbar from './TerminalToolbar';
import styles from '@/styles/modules/Terminal.module.css';
import '@xterm/xterm/css/xterm.css';

interface TerminalBookmark {
  id: string;
  terminalId: string;
  scrollLine: number;
  selectedText: string;
  note: string;
  timestamp: number;
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
}

const DEFAULT_MIN_HEIGHT = '200px';

export default function TerminalContainer({
  terminalId,
  ws,
  showReconnect = false,
  onReconnect,
  bookmarkPortalTarget,
  projectPath,
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
    pasteToTerminal,
    refitTerminal,
    setTheme,
    handleTerminalOutput,
    handleTerminalReady,
    handleTerminalClosed,
    reparent,
    scrollToBottom,
    scrollPageUp,
    scrollPageDown,
    getTerminalBookmark,
    scrollToLine,
  } = useTerminal({ ws, themeName, projectPath });

  // Attach/detach when terminalId changes
  useEffect(() => {
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
        }
      } catch {
        // not JSON or not terminal message
      }
    };

    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, handleTerminalOutput, handleTerminalReady, handleTerminalClosed]);

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

  const handleJumpToBookmark = useCallback((scrollLine: number) => {
    scrollToLine(scrollLine);
  }, [scrollToLine]);

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
                  onClick={() => handleJumpToBookmark(bm.scrollLine)}
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
    <div className={styles.wrapper}>
      <TerminalToolbar
        themeName={themeName}
        onThemeChange={handleThemeChange}
        onFullscreen={toggleFullscreen}
        onSendEscape={sendEscape}
        onSendArrowUp={sendArrowUp}
        onSendArrowDown={sendArrowDown}
        onPaste={pasteToTerminal}
        onReconnect={onReconnect}
        onScrollToBottom={scrollToBottom}
        onBookmark={handleBookmark}
        bookmarkCount={bookmarks.length}
        isFullscreen={isFullscreen}
        showReconnect={showReconnect}
      />
      <div className={styles.terminalArea}>
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
              onPaste={pasteToTerminal}
              onReconnect={onReconnect}
              onScrollToBottom={scrollToBottom}
              onBookmark={handleBookmark}
              bookmarkCount={bookmarks.length}
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
}
