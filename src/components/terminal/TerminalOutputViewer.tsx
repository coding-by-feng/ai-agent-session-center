/**
 * TerminalOutputViewer — DOM-based read-only terminal output viewer.
 * Renders ANSI-colored output as HTML with native smooth scrolling.
 * Replaces xterm.js for read-only use cases.
 */
import { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { AnsiUp } from 'ansi_up';
import { useTerminalOutput } from '@/hooks/useTerminalOutput';
import { resolveTheme, toCssVariables, getThemeNames } from './themes';
import Select from '@/components/ui/Select';
import type { SelectOption } from '@/components/ui/Select';
import styles from '@/styles/modules/TerminalOutput.module.css';

interface TerminalOutputViewerProps {
  terminalId: string | null;
  ws: WebSocket | null;
  showReconnect?: boolean;
  onReconnect?: () => void;
  bookmarkPortalTarget?: HTMLDivElement | null;
  projectPath?: string;
}

const ansiUp = new AnsiUp();
ansiUp.use_classes = true;
ansiUp.escape_html = true;

export default memo(function TerminalOutputViewer({
  terminalId,
  ws,
  showReconnect = false,
  onReconnect,
}: TerminalOutputViewerProps) {
  const [themeName, setThemeName] = useState<string>(() => {
    try {
      return localStorage.getItem('terminal-theme') || 'auto';
    } catch {
      return 'auto';
    }
  });
  const [wordWrap, setWordWrap] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const {
    lines,
    scrollContainerRef,
    isAutoScrolling,
    scrollToBottom,
    clearOutput,
    handleTerminalOutput,
    handleTerminalClosed,
    getSelectedText,
    getScrollOffset,
    scrollToOffset,
  } = useTerminalOutput({ ws, terminalId });

  // WS message handler
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'terminal_output' && msg.terminalId) {
          handleTerminalOutput(msg.terminalId, msg.data);
        } else if (msg.type === 'terminal_closed' && msg.terminalId) {
          handleTerminalClosed(msg.terminalId, msg.reason);
        }
      } catch {
        // not JSON or not terminal message
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, handleTerminalOutput, handleTerminalClosed]);

  // Theme CSS variables
  const themeStyle = useMemo(() => {
    const theme = resolveTheme(themeName);
    return toCssVariables(theme);
  }, [themeName]);

  const handleThemeChange = useCallback((name: string) => {
    setThemeName(name);
    try { localStorage.setItem('terminal-theme', name); } catch { /* ignore */ }
  }, []);

  const handleCopyAll = useCallback(() => {
    const text = lines.join('\n');
    navigator.clipboard.writeText(text).catch(() => {});
  }, [lines]);

  // Bookmark support
  const [bookmarks, setBookmarks] = useState<Array<{
    id: string; scrollOffset: number; selectedText: string; note: string; timestamp: number;
  }>>([]);

  // Load bookmarks
  useEffect(() => {
    if (!terminalId) { setBookmarks([]); return; }
    try {
      const saved = localStorage.getItem(`term-bookmarks:${terminalId}`);
      setBookmarks(saved ? JSON.parse(saved) : []);
    } catch { setBookmarks([]); }
  }, [terminalId]);

  // Persist bookmarks
  useEffect(() => {
    if (!terminalId) return;
    try {
      localStorage.setItem(`term-bookmarks:${terminalId}`, JSON.stringify(bookmarks));
    } catch { /* ignore */ }
  }, [terminalId, bookmarks]);

  const handleBookmark = useCallback(() => {
    const selectedText = getSelectedText();
    if (selectedText) {
      setBookmarks((prev) => [{
        id: `tbm-${Date.now()}`,
        scrollOffset: getScrollOffset(),
        selectedText,
        note: '',
        timestamp: Date.now(),
      }, ...prev]);
    }
  }, [getSelectedText, getScrollOffset]);

  // Alt+F11 fullscreen
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F11' && e.altKey) {
        e.preventDefault();
        setIsFullscreen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Fullscreen body class
  useEffect(() => {
    if (isFullscreen) {
      document.body.classList.add('term-fullscreen');
    } else {
      document.body.classList.remove('term-fullscreen');
    }
    return () => document.body.classList.remove('term-fullscreen');
  }, [isFullscreen]);

  // Convert lines to HTML once
  const htmlLinesRef = useRef<string[]>([]);
  const htmlLines = useMemo(() => {
    // Only re-parse lines that are new
    const cached = htmlLinesRef.current;
    if (lines.length < cached.length) {
      // Lines were cleared
      htmlLinesRef.current = lines.map((l) => ansiUp.ansi_to_html(l));
    } else {
      // Append new lines
      for (let i = cached.length; i < lines.length; i++) {
        cached.push(ansiUp.ansi_to_html(lines[i]));
      }
      htmlLinesRef.current = cached;
    }
    return [...htmlLinesRef.current];
  }, [lines]);

  // Theme options for dropdown
  const themeOptions = useMemo<SelectOption[]>(() => [
    { value: 'auto', label: 'Auto' },
    ...getThemeNames().map((name) => ({
      value: name,
      label: name.charAt(0).toUpperCase() + name.slice(1),
    })),
  ], []);

  // Toolbar component (shared between inline and fullscreen)
  const toolbarNode = useMemo(() => (
    <div className={styles.toolbar}>
      <Select
        value={themeName}
        onChange={handleThemeChange}
        options={themeOptions}
        title="Terminal theme"
      />

      <button
        className={`${styles.toolbarBtn} ${wordWrap ? styles.activeBtn : ''}`}
        onClick={() => setWordWrap((w) => !w)}
        title="Toggle word wrap"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="6" x2="21" y2="6" />
          <path d="M3 12h15a3 3 0 1 1 0 6h-4" />
          <polyline points="16 16 14 18 16 20" />
        </svg>
      </button>

      <button className={styles.toolbarBtn} onClick={handleCopyAll} title="Copy all output">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>

      <button className={styles.toolbarBtn} onClick={clearOutput} title="Clear output">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>

      <button
        className={`${styles.toolbarBtn} ${bookmarks.length > 0 ? styles.activeBtn : ''}`}
        onClick={handleBookmark}
        title={bookmarks.length > 0 ? `Bookmarks (${bookmarks.length}) — select text to add` : 'Select terminal text then click to bookmark'}
        style={{ position: 'relative' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24"
          fill={bookmarks.length > 0 ? 'currentColor' : 'none'}
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      <button
        className={styles.toolbarBtn}
        onClick={scrollToBottom}
        title="Scroll to bottom"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="4" x2="12" y2="16" />
          <polyline points="5 10 12 17 19 10" />
          <line x1="4" y1="20" x2="20" y2="20" />
        </svg>
      </button>

      <button
        className={styles.toolbarBtn}
        onClick={() => setIsFullscreen((f) => !f)}
        title={isFullscreen ? 'Exit fullscreen (Alt+F11)' : 'Fullscreen (Alt+F11)'}
      >
        {isFullscreen ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 14 10 14 10 20" />
            <polyline points="20 10 14 10 14 4" />
            <line x1="14" y1="10" x2="21" y2="3" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        )}
      </button>

      {showReconnect && onReconnect && (
        <button
          className={styles.toolbarBtn}
          style={{ color: 'var(--accent-green)', borderColor: 'rgba(80,250,123,0.3)' }}
          onClick={onReconnect}
          title="Reconnect terminal"
        >
          RECONNECT
        </button>
      )}
    </div>
  ), [themeName, wordWrap, bookmarks.length, showReconnect, onReconnect, isFullscreen,
    handleThemeChange, themeOptions, handleCopyAll, clearOutput, handleBookmark, scrollToBottom]);

  // Output render
  const outputNode = (ref: React.RefObject<HTMLDivElement | null>) => (
    <div
      ref={ref}
      className={styles.outputContainer}
      style={themeStyle as React.CSSProperties}
    >
      {htmlLines.length === 0 ? (
        <div className={styles.emptyPlaceholder}>
          {terminalId ? 'Waiting for output...' : 'No terminal attached.'}
        </div>
      ) : (
        htmlLines.map((html, i) => (
          <div
            key={i}
            className={`${styles.outputLine} ${wordWrap ? styles.wrap : ''} ${!html ? styles.emptyLine : ''}`}
            dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }}
          />
        ))
      )}
    </div>
  );

  // Fullscreen ref (separate from main scroll ref) — must be before any conditional returns
  const fsScrollRef = useRef<HTMLDivElement | null>(null);

  if (!terminalId) {
    return (
      <div className={styles.viewer} style={themeStyle as React.CSSProperties}>
        <div className={styles.emptyPlaceholder}>
          <div>
            No terminal attached. Create an SSH session or select a session with a terminal.
            {onReconnect && (
              <button
                style={{
                  display: 'block', margin: '14px auto 0', padding: '8px 20px',
                  background: 'rgba(80,250,123,0.08)', border: '1px solid rgba(80,250,123,0.35)',
                  borderRadius: '4px', color: 'var(--accent-green, #50fa7b)',
                  fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 600,
                  letterSpacing: '1px', textTransform: 'uppercase', cursor: 'pointer',
                }}
                onClick={onReconnect}
              >
                Reconnect Terminal
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={styles.viewer} style={themeStyle as React.CSSProperties}>
        {toolbarNode}
        <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {outputNode(scrollContainerRef)}
          {!isAutoScrolling && (
            <button className={styles.scrollToBottomBtn} onClick={scrollToBottom} title="Scroll to bottom">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {/* Fullscreen overlay */}
      {createPortal(
        <div
          className={styles.fullscreenOverlay}
          style={{ display: isFullscreen ? 'flex' : 'none', ...themeStyle as React.CSSProperties }}
        >
          <div className={styles.fullscreenTopbar}>
            {toolbarNode}
          </div>
          <div className={styles.fullscreenBody}>
            {isFullscreen && outputNode(fsScrollRef)}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
});
