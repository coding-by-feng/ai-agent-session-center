/**
 * useTerminal hook manages xterm.js terminal lifecycle.
 * Handles creation, attachment, resize, fullscreen, and WS relay.
 * Ported from public/js/terminalManager.js.
 */
import { useRef, useCallback, useEffect, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { resolveTheme } from '@/components/terminal/themes';
import { useUiStore } from '@/stores/uiStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActiveTerminal {
  terminalId: string;
  term: Terminal;
  fitAddon: FitAddon;
  resizeObserver: ResizeObserver;
  /** True after fitAddon.fit() has run and layout is stable */
  layoutReady: boolean;
}

interface UseTerminalOptions {
  /** WebSocket instance for relay */
  ws: WebSocket | null;
  /** Terminal theme name */
  themeName?: string;
  /** Project root path — enables clickable file paths in terminal output */
  projectPath?: string;
}

export interface TerminalBookmarkPosition {
  /** Absolute buffer line to scroll to */
  scrollLine: number;
  /** Selected text at capture time */
  selectedText: string;
  /** Selection start column */
  selStartX: number;
  /** Selection start row (absolute buffer line) */
  selStartY: number;
  /** Selection end column */
  selEndX: number;
  /** Selection end row (absolute buffer line) */
  selEndY: number;
}

interface UseTerminalReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  attach: (terminalId: string) => void;
  detach: () => void;
  isAttached: boolean;
  activeTerminalId: string | null;
  toggleFullscreen: () => void;
  isFullscreen: boolean;
  sendEscape: () => void;
  sendArrowUp: () => void;
  sendArrowDown: () => void;
  sendEnter: () => void;
  pasteToTerminal: () => void;
  refitTerminal: () => void;
  setTheme: (themeName: string) => void;
  handleTerminalOutput: (terminalId: string, base64Data: string) => void;
  handleTerminalReady: (terminalId: string) => void;
  handleTerminalClosed: (terminalId: string, reason?: string) => void;
  /** Move the xterm element to a different container (e.g. for fullscreen) */
  reparent: (container: HTMLElement) => void;
  scrollToBottom: () => void;
  /** Clear terminal display and replay buffered output from the server. */
  refreshOutput: () => void;
  scrollPageUp: () => void;
  scrollPageDown: () => void;
  /** Capture current selection + viewport position for bookmarking. Returns null if nothing selected. */
  getTerminalBookmark: () => TerminalBookmarkPosition | null;
  /** Scroll terminal to the given buffer line. */
  scrollToLine: (line: number) => void;
  /** Scroll to bookmark and briefly highlight the original selection. */
  jumpToBookmark: (bm: TerminalBookmarkPosition) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the terminal viewport is scrolled to the bottom (or within 1 row). */
function isAtBottom(term: Terminal): boolean {
  const buf = term.buffer.active;
  return buf.viewportY >= buf.baseY;
}

function getResponsiveFontSize(): number {
  const width = window.innerWidth;
  if (width <= 480) return 11;
  if (width <= 640) return 12;
  return 14;
}

function sendResize(ws: WebSocket | null, terminalId: string, cols: number, rows: number): void {
  if (ws && ws.readyState === 1 && cols > 0 && rows > 0) {
    ws.send(JSON.stringify({ type: 'terminal_resize', terminalId, cols, rows }));
  }
}

function forceCanvasRepaint(
  ws: WebSocket | null,
  terminalId: string,
  term: Terminal,
  fitAddon: FitAddon,
  activeRef: React.MutableRefObject<ActiveTerminal | null>,
): void {
  // Use term.refresh() to force canvas repaint without resizing.
  // This avoids the shrink→expand flicker of the old 2-frame resize trick.
  requestAnimationFrame(() => {
    if (!activeRef.current || activeRef.current.terminalId !== terminalId) return;
    const wasBottom = isAtBottom(term);
    const savedViewportY = term.buffer.active.viewportY;
    fitAddon.fit();
    sendResize(ws, terminalId, term.cols, term.rows);
    term.refresh(0, term.rows - 1);
    if (wasBottom) {
      term.scrollToBottom();
    } else {
      // Restore scroll position after fit to prevent layout-triggered viewport jump
      term.scrollToLine(savedViewportY);
    }
    if (activeRef.current) {
      activeRef.current.layoutReady = true;
    }
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTerminal({ ws, themeName = 'auto', projectPath }: UseTerminalOptions): UseTerminalReturn {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<ActiveTerminal | null>(null);
  const pendingOutputRef = useRef<Map<string, string[]>>(new Map());
  const pendingOutputTtlRef = useRef<Map<string, number>>(new Map());
  /** Saved scroll offsets (lines above bottom) per terminalId — restored after session switch */
  const savedScrollRef = useRef<Map<string, number>>(new Map());
  const themeNameRef = useRef(themeName);
  const wsRef = useRef(ws);
  const projectPathRef = useRef(projectPath);
  /** Track which terminalId is currently subscribed on the server to avoid double-subscribe (#74) */
  const subscribedTerminalIdRef = useRef<string | null>(null);
  /** RAF handle for batched output writes (#76) */
  const outputRafRef = useRef<number | null>(null);
  /** Force scroll-to-bottom on next output batch (set when user sends Enter) */
  const forceScrollRef = useRef(false);
  /**
   * Persistent auto-scroll flag — true when the terminal should follow new output.
   * Unlike isAtBottom() which can return stale results during async write processing,
   * this flag is only set to false when the user explicitly scrolls up, and set to
   * true when scrollToBottom() is called or the user scrolls to the bottom.
   * This prevents the race condition where RAF N+1 reads isAtBottom()=false because
   * RAF N's scrollToBottom callback hasn't fired yet, causing viewport to jump.
   */
  const autoScrollActiveRef = useRef(true);
  /** IntersectionObserver fallback for hidden containers (always-mounted tabs like COMMANDS) */
  const pendingSetupObserverRef = useRef<IntersectionObserver | null>(null);

  const [isAttached, setIsAttached] = useState(false);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Keep refs in sync
  useEffect(() => {
    themeNameRef.current = themeName;
  }, [themeName]);

  useEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

  useEffect(() => {
    wsRef.current = ws;
    // Re-subscribe on WS reconnect (#74: unsubscribe old before subscribing new)
    if (activeRef.current && ws && ws.readyState === 1) {
      const { terminalId } = activeRef.current;
      // Unsubscribe previous subscription to prevent duplicate output streams
      if (subscribedTerminalIdRef.current && subscribedTerminalIdRef.current !== terminalId) {
        ws.send(JSON.stringify({ type: 'terminal_disconnect', terminalId: subscribedTerminalIdRef.current }));
      }
      // Don't clear terminal content on reconnect — let server replay append to existing (#24)
      ws.send(JSON.stringify({ type: 'terminal_subscribe', terminalId }));
      subscribedTerminalIdRef.current = terminalId;
    }
  }, [ws]);

  // Detach
  const detach = useCallback(() => {
    // Cancel pending IntersectionObserver from setupWhenReady fallback
    if (pendingSetupObserverRef.current) {
      pendingSetupObserverRef.current.disconnect();
      pendingSetupObserverRef.current = null;
    }
    // Cancel any pending RAF output flush (#76)
    if (outputRafRef.current !== null) {
      cancelAnimationFrame(outputRafRef.current);
      outputRafRef.current = null;
    }
    if (activeRef.current) {
      const { terminalId, term } = activeRef.current;
      // Save scroll position to localStorage for cross-mount restoration
      try {
        const buf = term.buffer.active;
        const offset = buf.baseY - buf.viewportY;
        if (offset > 0) {
          localStorage.setItem(`term-scroll:${terminalId}`, String(offset));
        }
      } catch { /* ignore */ }
      // Clear active terminal's batched output buffer
      pendingOutputRef.current.delete(`__active__${terminalId}`);
      activeRef.current.resizeObserver.disconnect();
      activeRef.current.term.dispose();
      activeRef.current = null;
    }
    if (containerRef.current) {
      containerRef.current.innerHTML = '';
    }
    setIsAttached(false);
    setActiveTerminalId(null);
    setIsFullscreen(false);
    // #85: Remove terminal-focused class to resume scanline animation
    document.body.classList.remove('terminal-focused');
  }, []);

  // Attach
  const attach = useCallback(
    (terminalId: string) => {
      // Skip re-attach if already attached to the same terminal (prevents scroll position reset)
      if (activeRef.current?.terminalId === terminalId) return;

      // Save scroll position of the outgoing terminal as "lines above bottom"
      // so we can restore it when the user switches back.
      if (activeRef.current) {
        const buf = activeRef.current.term.buffer.active;
        savedScrollRef.current.set(activeRef.current.terminalId, buf.baseY - buf.viewportY);
      }

      detach();

      const containerOrNull = containerRef.current;
      if (!containerOrNull) return;
      const container: HTMLDivElement = containerOrNull;
      container.innerHTML = '';

      // Restore theme
      const savedTheme = (() => {
        try {
          return localStorage.getItem('terminal-theme') || 'auto';
        } catch {
          return 'auto';
        }
      })();
      themeNameRef.current = savedTheme;

      const theme = resolveTheme(savedTheme);
      container.style.background = theme.background || '';

      // Clear stale pending output for this terminal
      pendingOutputRef.current.delete(terminalId);
      pendingOutputTtlRef.current.delete(terminalId);
      // Reset auto-scroll to true for fresh terminal attachment
      autoScrollActiveRef.current = true;

      // Subscribe for output (#74: track subscription to prevent duplicates)
      if (wsRef.current && wsRef.current.readyState === 1) {
        // Unsubscribe previous terminal if different
        if (subscribedTerminalIdRef.current && subscribedTerminalIdRef.current !== terminalId) {
          wsRef.current.send(JSON.stringify({ type: 'terminal_disconnect', terminalId: subscribedTerminalIdRef.current }));
        }
        wsRef.current.send(JSON.stringify({ type: 'terminal_subscribe', terminalId }));
        subscribedTerminalIdRef.current = terminalId;
      }

      // Wait for container dimensions
      function setupWhenReady(retries: number) {
        // Guard: another attach call may have already set up the terminal
        if (activeRef.current?.terminalId === terminalId) return;
        if (container.offsetWidth > 0 && container.offsetHeight > 0) {
          doSetup();
        } else if (retries > 0) {
          requestAnimationFrame(() => setTimeout(() => setupWhenReady(retries - 1), 50));
        } else {
          // Fallback: container is still hidden (e.g. always-mounted COMMANDS tab).
          // Use IntersectionObserver to wait indefinitely for it to become visible.
          const observer = new IntersectionObserver((entries) => {
            if (
              entries[0]?.isIntersecting &&
              container.offsetWidth > 0 &&
              container.offsetHeight > 0
            ) {
              observer.disconnect();
              pendingSetupObserverRef.current = null;
              if (!activeRef.current || activeRef.current.terminalId !== terminalId) {
                doSetup();
              }
            }
          });
          observer.observe(container);
          pendingSetupObserverRef.current = observer;
        }
      }

      function doSetup() {
        const term = new Terminal({
          cursorBlink: false,
          cursorStyle: 'bar',
          fontSize: getResponsiveFontSize(),
          fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Menlo', monospace",
          fontWeight: '400',
          fontWeightBold: '700',
          lineHeight: 1.15,
          letterSpacing: 0,
          theme: resolveTheme(themeNameRef.current),
          allowProposedApi: true,
          scrollback: 5000, // #86: reduced from 10000 to save ~1MB per terminal
          convertEol: false,
          drawBoldTextInBrightColors: true,
          minimumContrastRatio: 1,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);

        try {
          const unicode11 = new Unicode11Addon();
          term.loadAddon(unicode11);
          term.unicode.activeVersion = '11';
        } catch {
          // Unicode11 addon not available
        }

        try {
          const webLinks = new WebLinksAddon((_event, uri) => {
            // In Electron, window.open triggers setWindowOpenHandler → shell.openExternal.
            // In browser, window.open opens a new tab.
            window.open(uri, '_blank');
          });
          term.loadAddon(webLinks);
        } catch {
          // WebLinks addon not available
        }

        // File path link provider — makes file paths clickable to open in PROJECT tab
        // Matches: path/to/file.ext, ./path/to/file.ext, ../path/to/file.ext
        const FILE_PATH_RE = /(?:\.{0,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.[\w]+/g;
        term.registerLinkProvider({
          provideLinks(bufferLineNumber, callback) {
            const line = term.buffer.active.getLine(bufferLineNumber - 1);
            if (!line) { callback(undefined); return; }
            const text = line.translateToString(true);
            const links: Array<{
              range: { start: { x: number; y: number }; end: { x: number; y: number } };
              text: string;
              activate: () => void;
              tooltip?: string;
            }> = [];
            let match: RegExpExecArray | null;
            FILE_PATH_RE.lastIndex = 0;
            while ((match = FILE_PATH_RE.exec(text)) !== null) {
              const filePath = match[0];
              const startX = match.index + 1; // xterm columns are 1-indexed
              const endX = startX + filePath.length - 1;
              links.push({
                range: {
                  start: { x: startX, y: bufferLineNumber },
                  end: { x: endX, y: bufferLineNumber },
                },
                text: filePath,
                tooltip: 'Click to open in Project tab',
                activate() {
                  const clean = filePath.replace(/^\.\//, '');
                  const pp = projectPathRef.current;
                  useUiStore.getState().openFileInProject(clean, pp || '');
                },
              });
            }
            callback(links.length > 0 ? links : undefined);
          },
        });

        term.open(container);

        // Track user scroll intent: if user scrolls away from bottom, disable
        // auto-scroll. If user scrolls back to bottom, re-enable it.
        // Also cancel forceScrollRef when user scrolls up.
        term.onScroll(() => {
          const atBottom = isAtBottom(term);
          autoScrollActiveRef.current = atBottom;
          if (!atBottom) {
            forceScrollRef.current = false;
          }
        });

        // Custom key handler
        term.attachCustomKeyEventHandler((e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            if (e.type === 'keydown' && wsRef.current && wsRef.current.readyState === 1) {
              wsRef.current.send(JSON.stringify({ type: 'terminal_input', terminalId, data: '\x1b' }));
            }
            return false;
          }
          // Shift+Enter → same as Alt+Enter (sends ESC + newline)
          if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            if (e.type === 'keydown' && wsRef.current && wsRef.current.readyState === 1) {
              wsRef.current.send(JSON.stringify({ type: 'terminal_input', terminalId, data: '\x1b\n' }));
            }
            return false;
          }
          // Cmd+Alt+1-9 (macOS) / Ctrl+Alt+1-9 (Win/Linux): session-switch
          // shortcuts — prevent xterm from processing these and let the event
          // bubble to the global handler in useKeyboardShortcuts.
          if (e.altKey && (e.metaKey || e.ctrlKey) && /^Digit[0-9]$/.test(e.code)) {
            return false;
          }
          return true;
        });

        fitAddon.fit();
        sendResize(wsRef.current, terminalId, term.cols, term.rows);

        // Send keystrokes (chunk large pastes to stay within 8 KB server limit)
        const CHUNK_SIZE = 4096;
        term.onData((data) => {
          if (!wsRef.current || wsRef.current.readyState !== 1) return;
          if (data.length <= CHUNK_SIZE) {
            wsRef.current.send(JSON.stringify({ type: 'terminal_input', terminalId, data }));
          } else {
            const ws = wsRef.current;
            for (let i = 0; i < data.length; i += CHUNK_SIZE) {
              const chunk = data.slice(i, i + CHUNK_SIZE);
              if (ws.readyState !== 1) break;
              ws.send(JSON.stringify({ type: 'terminal_input', terminalId, data: chunk }));
            }
          }
        });

        term.onBinary((data) => {
          if (wsRef.current && wsRef.current.readyState === 1) {
            wsRef.current.send(JSON.stringify({ type: 'terminal_input', terminalId, data }));
          }
        });

        // Resize observer — 200ms debounce (#83: was 50ms, caused excessive resize messages)
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
        const resizeObserver = new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            const wasBottom = isAtBottom(term);
            const savedViewportY = term.buffer.active.viewportY;
            fitAddon.fit();
            sendResize(wsRef.current, terminalId, term.cols, term.rows);
            // Restore scroll position after fit to prevent layout-triggered viewport jump
            if (wasBottom) {
              term.scrollToBottom();
            } else {
              term.scrollToLine(savedViewportY);
            }
          }, 200);
        });
        resizeObserver.observe(container);

        activeRef.current = { terminalId, term, fitAddon, resizeObserver, layoutReady: false };
        setIsAttached(true);
        setActiveTerminalId(terminalId);

        term.focus();
        // #85: Add terminal-focused class to pause scanline animation
        document.body.classList.add('terminal-focused');
        // #77 + #78: single forceCanvasRepaint call that also sets layoutReady=true.
        // Buffered output is flushed after layout is confirmed stable (inside forceCanvasRepaint).
        forceCanvasRepaint(wsRef.current, terminalId, term, fitAddon, activeRef);

        // Flush buffered output after layout is ready (#77: prevent flush before layout stabilizes)
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!activeRef.current || activeRef.current.terminalId !== terminalId) return;
            const buffered = pendingOutputRef.current.get(terminalId);
            if (buffered && buffered.length > 0) {
              let remaining = buffered.length;
              for (const data of buffered) {
                const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
                term.write(bytes, () => {
                  if (--remaining === 0 && activeRef.current?.term === term) {
                    // Restore scroll: check in-memory ref first, then localStorage fallback
                    let savedOffset = savedScrollRef.current.get(terminalId) ?? 0;
                    if (savedOffset === 0) {
                      try {
                        savedOffset = parseInt(localStorage.getItem(`term-scroll:${terminalId}`) ?? '0', 10) || 0;
                        // Clear after reading — one-shot restore
                        localStorage.removeItem(`term-scroll:${terminalId}`);
                      } catch { /* ignore */ }
                    }
                    if (savedOffset > 0) {
                      // Restore the same "lines above bottom" offset the user was at
                      const buf = term.buffer.active;
                      term.scrollToLine(Math.max(0, buf.baseY - savedOffset));
                    } else {
                      term.scrollToBottom();
                    }
                    // Force canvas repaint after output flush to prevent blank terminal
                    fitAddon.fit();
                    term.refresh(0, term.rows - 1);
                  }
                });
              }
              pendingOutputRef.current.delete(terminalId);
              pendingOutputTtlRef.current.delete(terminalId);
            }
          });
        });

        // Safety-net repaint: if the initial forceCanvasRepaint ran before the
        // container dimensions stabilised (e.g. during a session switch with CSS
        // transitions), this delayed repaint catches it. Without it the canvas
        // stays blank until the user manually resizes (e.g. minimize+restore).
        setTimeout(() => {
          if (!activeRef.current || activeRef.current.terminalId !== terminalId) return;
          const wasBottom = isAtBottom(term);
          const savedViewportY = term.buffer.active.viewportY;
          fitAddon.fit();
          sendResize(wsRef.current, terminalId, term.cols, term.rows);
          term.refresh(0, term.rows - 1);
          // Restore scroll position after safety-net fit
          if (wasBottom) {
            term.scrollToBottom();
          } else {
            term.scrollToLine(savedViewportY);
          }
        }, 150);
      }

      setupWhenReady(60);
    },
    [detach],
  );

  // Terminal output handler — batches writes via requestAnimationFrame (#76)
  const handleTerminalOutput = useCallback((terminalId: string, base64Data: string) => {
    if (activeRef.current && activeRef.current.terminalId === terminalId) {
      // Buffer this chunk for the active terminal; flush via RAF
      const activeBuf = pendingOutputRef.current.get(`__active__${terminalId}`) || [];
      activeBuf.push(base64Data);
      pendingOutputRef.current.set(`__active__${terminalId}`, activeBuf);

      if (outputRafRef.current === null) {
        outputRafRef.current = requestAnimationFrame(() => {
          outputRafRef.current = null;
          if (!activeRef.current) return;
          const tid = activeRef.current.terminalId;
          const pending = pendingOutputRef.current.get(`__active__${tid}`);
          if (!pending || pending.length === 0) return;
          pendingOutputRef.current.delete(`__active__${tid}`);

          const { term } = activeRef.current;
          // #88: Only auto-scroll if user hasn't scrolled up to review history.
          // Use the persistent autoScrollActiveRef flag instead of isAtBottom() to
          // avoid a race condition: when RAF N's scrollToBottom callback hasn't fired
          // yet, RAF N+1's isAtBottom() returns false, causing the viewport to jump
          // to a stale position. The persistent flag survives across RAF batches.
          const shouldScroll = autoScrollActiveRef.current || forceScrollRef.current;
          forceScrollRef.current = false;
          // Use write callbacks so scrollToBottom fires after xterm processes writes
          // and updates baseY. Without this, scrollToBottom() called synchronously
          // after write() is a no-op because baseY hasn't been updated yet (#scroll-fix).
          if (shouldScroll && pending.length > 0) {
            let remaining = pending.length;
            for (const chunk of pending) {
              const bytes = Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0));
              term.write(bytes, () => {
                if (--remaining === 0 && activeRef.current?.term === term) {
                  term.scrollToBottom();
                }
              });
            }
          } else {
            // User is scrolled up — preserve viewport position after writes.
            // Without this, escape sequences (cursor home, alt-screen switch,
            // screen clear) processed by term.write() yank the viewport to
            // the top or middle of the buffer.
            const savedViewportY = term.buffer.active.viewportY;
            let remaining = pending.length;
            for (const chunk of pending) {
              const bytes = Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0));
              term.write(bytes, () => {
                if (--remaining === 0 && activeRef.current?.term === term) {
                  if (term.buffer.active.viewportY !== savedViewportY) {
                    term.scrollToLine(savedViewportY);
                  }
                }
              });
            }
          }
        });
      }
    } else {
      // TTL-based cleanup for stale buffers (#27)
      const now = Date.now();
      pendingOutputTtlRef.current.set(terminalId, now);
      // Evict buffers older than 60s
      for (const [id, ts] of pendingOutputTtlRef.current) {
        if (now - ts > 60000) {
          pendingOutputRef.current.delete(id);
          pendingOutputTtlRef.current.delete(id);
        }
      }

      const buf = pendingOutputRef.current.get(terminalId) || [];
      buf.push(base64Data);
      if (buf.length > 500) buf.shift();
      pendingOutputRef.current.set(terminalId, buf);
    }
  }, []);

  const handleTerminalReady = useCallback((terminalId: string) => {
    if (activeRef.current && activeRef.current.terminalId === terminalId) {
      requestAnimationFrame(() => {
        if (!activeRef.current || !activeRef.current.fitAddon) return;
        const { term, fitAddon } = activeRef.current;
        const wasBottom = isAtBottom(term);
        const savedViewportY = term.buffer.active.viewportY;
        const prevCols = term.cols;
        const prevRows = term.rows;
        fitAddon.fit();
        const newCols = term.cols;
        const newRows = term.rows;
        if (newCols !== prevCols || newRows !== prevRows) {
          sendResize(wsRef.current, terminalId, newCols, newRows);
        }
        // Restore scroll position after fit to prevent viewport jump
        if (wasBottom) {
          term.scrollToBottom();
        } else {
          term.scrollToLine(savedViewportY);
        }
      });
    }
  }, []);

  const handleTerminalClosed = useCallback((terminalId: string, reason?: string) => {
    if (activeRef.current && activeRef.current.terminalId === terminalId) {
      activeRef.current.term.write(
        `\r\n\x1b[31m--- Terminal ${reason || 'closed'} ---\x1b[0m\r\n`,
      );
    }
  }, []);

  const sendEscapeKey = useCallback(() => {
    if (!activeRef.current || !wsRef.current || wsRef.current.readyState !== 1) return;
    wsRef.current.send(
      JSON.stringify({ type: 'terminal_input', terminalId: activeRef.current.terminalId, data: '\x1b' }),
    );
    activeRef.current.term.focus();
  }, []);

  const sendArrowUp = useCallback(() => {
    if (!activeRef.current || !wsRef.current || wsRef.current.readyState !== 1) return;
    wsRef.current.send(
      JSON.stringify({ type: 'terminal_input', terminalId: activeRef.current.terminalId, data: '\x1b[A' }),
    );
    activeRef.current.term.focus();
  }, []);

  const sendArrowDown = useCallback(() => {
    if (!activeRef.current || !wsRef.current || wsRef.current.readyState !== 1) return;
    wsRef.current.send(
      JSON.stringify({ type: 'terminal_input', terminalId: activeRef.current.terminalId, data: '\x1b[B' }),
    );
    activeRef.current.term.focus();
  }, []);

  const sendEnter = useCallback(() => {
    if (!activeRef.current || !wsRef.current || wsRef.current.readyState !== 1) return;
    wsRef.current.send(
      JSON.stringify({ type: 'terminal_input', terminalId: activeRef.current.terminalId, data: '\r' }),
    );
    activeRef.current.term.focus();
  }, []);

  const pasteToTerminal = useCallback(async () => {
    if (!activeRef.current || !wsRef.current || wsRef.current.readyState !== 1) return;
    const { terminalId } = activeRef.current;

    let text: string | null = null;

    // Strategy 1: Clipboard API (requires secure context + user gesture + permission)
    if (navigator.clipboard?.readText) {
      try {
        text = await navigator.clipboard.readText();
      } catch {
        // Permission denied or not supported — fall through to fallback
      }
    }

    // Strategy 2: Hidden textarea + execCommand fallback (works in more contexts)
    if (!text) {
      try {
        const textarea = document.createElement('textarea');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        document.execCommand('paste');
        text = textarea.value;
        document.body.removeChild(textarea);
      } catch {
        // execCommand paste not supported
      }
    }

    // Strategy 3: Prompt as last resort
    if (!text) {
      text = window.prompt('Paste text to send to terminal:');
    }

    if (!text) return;

    // Chunk large pastes to stay within server's per-message limit (8 KB)
    const CHUNK_SIZE = 4096;
    if (text.length <= CHUNK_SIZE) {
      wsRef.current.send(
        JSON.stringify({ type: 'terminal_input', terminalId, data: text }),
      );
    } else {
      const ws = wsRef.current;
      for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        const chunk = text.slice(i, i + CHUNK_SIZE);
        // Small delay between chunks to avoid overwhelming the PTY buffer
        if (i > 0) {
          await new Promise((r) => setTimeout(r, 5));
        }
        if (ws.readyState !== 1) break;
        ws.send(
          JSON.stringify({ type: 'terminal_input', terminalId, data: chunk }),
        );
      }
    }
    // Re-focus the terminal after paste
    activeRef.current?.term.focus();
  }, []);

  const refitTerminal = useCallback(() => {
    if (!activeRef.current) return;
    const { terminalId, term, fitAddon } = activeRef.current;

    // #79: Don't clear terminal — preserve scrollback context.
    // Just refit and refresh canvas to fix layout issues.
    requestAnimationFrame(() => {
      if (!activeRef.current || activeRef.current.terminalId !== terminalId) return;
      const wasBottom = isAtBottom(term);
      const savedViewportY = term.buffer.active.viewportY;
      fitAddon.fit();
      sendResize(wsRef.current, terminalId, term.cols, term.rows);
      term.refresh(0, term.rows - 1);
      // Restore scroll position after fit to prevent layout-triggered viewport jump
      if (wasBottom) {
        term.scrollToBottom();
      } else {
        term.scrollToLine(savedViewportY);
      }
    });
  }, []);

  const toggleFullscreenFn = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  const reparent = useCallback((newContainer: HTMLElement) => {
    if (!activeRef.current) return;
    const { terminalId, term, fitAddon, resizeObserver } = activeRef.current;
    const xtermEl = term.element;
    if (!xtermEl || xtermEl.parentElement === newContainer) return;

    // Move xterm element to new container
    newContainer.appendChild(xtermEl);

    // Replace resize observer to track new container dimensions (#29: disconnect old before replacing)
    resizeObserver.disconnect();
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const newObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!activeRef.current) return;
        activeRef.current.fitAddon.fit();
        sendResize(wsRef.current, activeRef.current.terminalId,
          activeRef.current.term.cols, activeRef.current.term.rows);
      }, 200); // #83: match main resize debounce
    });
    newObserver.observe(newContainer);
    activeRef.current.resizeObserver = newObserver;

    // Refit + repaint in the new container
    requestAnimationFrame(() => {
      if (!activeRef.current || activeRef.current.terminalId !== terminalId) return;
      forceCanvasRepaint(wsRef.current, terminalId, term, fitAddon, activeRef);
      term.focus();
    });
  }, []);

  const scrollToBottom = useCallback(() => {
    if (activeRef.current) {
      autoScrollActiveRef.current = true;
      activeRef.current.term.scrollToBottom();
    }
  }, []);

  // Listen for global shortcut event to scroll terminal to bottom
  useEffect(() => {
    const handler = () => scrollToBottom();
    document.addEventListener('terminal:scrollToBottom', handler);
    return () => document.removeEventListener('terminal:scrollToBottom', handler);
  }, [scrollToBottom]);

  /** Clear the terminal display and replay buffered output from the server. */
  const refreshOutput = useCallback(() => {
    if (!activeRef.current) return;
    const { term, terminalId } = activeRef.current;
    term.clear();
    autoScrollActiveRef.current = true; // Follow replayed output
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'terminal_subscribe', terminalId }));
    }
  }, []);

  const scrollPageUp = useCallback(() => {
    if (activeRef.current) {
      activeRef.current.term.scrollPages(-1);
    }
  }, []);

  const scrollPageDown = useCallback(() => {
    if (activeRef.current) {
      activeRef.current.term.scrollPages(1);
    }
  }, []);

  const getTerminalBookmark = useCallback((): TerminalBookmarkPosition | null => {
    if (!activeRef.current) return null;
    const { term } = activeRef.current;
    const selectedText = term.getSelection();
    if (!selectedText) return null;
    const selPos = term.getSelectionPosition();
    const baseY = term.buffer.active.baseY;
    const scrollLine = selPos
      ? selPos.start.y + baseY
      : term.buffer.active.viewportY;
    return {
      scrollLine,
      selectedText,
      selStartX: selPos?.start.x ?? 0,
      selStartY: selPos ? selPos.start.y + baseY : scrollLine,
      selEndX: selPos?.end.x ?? 0,
      selEndY: selPos ? selPos.end.y + baseY : scrollLine,
    };
  }, []);

  const scrollToLine = useCallback((line: number) => {
    if (activeRef.current) {
      activeRef.current.term.scrollToLine(line);
    }
  }, []);

  const jumpToBookmark = useCallback((bm: TerminalBookmarkPosition) => {
    if (!activeRef.current) return;
    const { term } = activeRef.current;
    term.scrollToLine(bm.scrollLine);
    const baseY = term.buffer.active.baseY;
    const startRow = bm.selStartY - baseY;
    const endRow = bm.selEndY - baseY;
    const length = endRow === startRow
      ? bm.selEndX - bm.selStartX
      : (term.cols - bm.selStartX) + bm.selEndX + Math.max(0, endRow - startRow - 1) * term.cols;
    if (length > 0) {
      term.select(bm.selStartX, startRow, length);
      setTimeout(() => term.clearSelection(), 2000);
    }
  }, []);

  const setThemeFn = useCallback((name: string) => {
    themeNameRef.current = name;
    try {
      localStorage.setItem('terminal-theme', name);
    } catch {
      // ignore
    }
    if (activeRef.current) {
      const theme = resolveTheme(name);
      activeRef.current.term.options.theme = theme;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pendingSetupObserverRef.current) {
        pendingSetupObserverRef.current.disconnect();
        pendingSetupObserverRef.current = null;
      }
      if (outputRafRef.current !== null) {
        cancelAnimationFrame(outputRafRef.current);
        outputRafRef.current = null;
      }
      if (activeRef.current) {
        activeRef.current.resizeObserver.disconnect();
        activeRef.current.term.dispose();
        activeRef.current = null;
      }
    };
  }, []);

  // Alt+F11 fullscreen
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F11' && e.altKey && activeRef.current) {
        e.preventDefault();
        setIsFullscreen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return {
    containerRef,
    attach,
    detach,
    isAttached,
    activeTerminalId,
    toggleFullscreen: toggleFullscreenFn,
    isFullscreen,
    sendEscape: sendEscapeKey,
    sendArrowUp,
    sendArrowDown,
    sendEnter,
    pasteToTerminal,
    refitTerminal,
    setTheme: setThemeFn,
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
  };
}
