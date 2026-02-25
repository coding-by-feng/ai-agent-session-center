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
  pasteToTerminal: () => void;
  refitTerminal: () => void;
  setTheme: (themeName: string) => void;
  handleTerminalOutput: (terminalId: string, base64Data: string) => void;
  handleTerminalReady: (terminalId: string) => void;
  handleTerminalClosed: (terminalId: string, reason?: string) => void;
  /** Move the xterm element to a different container (e.g. for fullscreen) */
  reparent: (container: HTMLElement) => void;
  scrollToBottom: () => void;
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
    fitAddon.fit();
    sendResize(ws, terminalId, term.cols, term.rows);
    term.refresh(0, term.rows - 1);
    if (activeRef.current) {
      activeRef.current.layoutReady = true;
    }
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTerminal({ ws, themeName = 'auto' }: UseTerminalOptions): UseTerminalReturn {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<ActiveTerminal | null>(null);
  const pendingOutputRef = useRef<Map<string, string[]>>(new Map());
  const pendingOutputTtlRef = useRef<Map<string, number>>(new Map());
  const themeNameRef = useRef(themeName);
  const wsRef = useRef(ws);
  /** Track which terminalId is currently subscribed on the server to avoid double-subscribe (#74) */
  const subscribedTerminalIdRef = useRef<string | null>(null);
  /** RAF handle for batched output writes (#76) */
  const outputRafRef = useRef<number | null>(null);

  const [isAttached, setIsAttached] = useState(false);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Keep refs in sync
  useEffect(() => {
    themeNameRef.current = themeName;
  }, [themeName]);

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
    // Cancel any pending RAF output flush (#76)
    if (outputRafRef.current !== null) {
      cancelAnimationFrame(outputRafRef.current);
      outputRafRef.current = null;
    }
    if (activeRef.current) {
      const { terminalId } = activeRef.current;
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
        if (container.offsetWidth > 0 && container.offsetHeight > 0) {
          doSetup();
        } else if (retries > 0) {
          requestAnimationFrame(() => setTimeout(() => setupWhenReady(retries - 1), 50));
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
          const webLinks = new WebLinksAddon();
          term.loadAddon(webLinks);
        } catch {
          // WebLinks addon not available
        }

        term.open(container);

        // Escape key handler
        term.attachCustomKeyEventHandler((e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            if (e.type === 'keydown' && wsRef.current && wsRef.current.readyState === 1) {
              wsRef.current.send(JSON.stringify({ type: 'terminal_input', terminalId, data: '\x1b' }));
            }
            return false;
          }
          return true;
        });

        fitAddon.fit();
        sendResize(wsRef.current, terminalId, term.cols, term.rows);

        // Send keystrokes
        term.onData((data) => {
          if (wsRef.current && wsRef.current.readyState === 1) {
            wsRef.current.send(JSON.stringify({ type: 'terminal_input', terminalId, data }));
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
            fitAddon.fit();
            sendResize(wsRef.current, terminalId, term.cols, term.rows);
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
              for (const data of buffered) {
                const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
                term.write(bytes);
              }
              pendingOutputRef.current.delete(terminalId);
              pendingOutputTtlRef.current.delete(terminalId);
            }
          });
        });
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
          // #88: Only auto-scroll if user hasn't scrolled up to review history
          const wasAtBottom = isAtBottom(term);
          for (const chunk of pending) {
            const bytes = Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0));
            term.write(bytes);
          }
          // Scroll once after all chunks written (#76: not per-write)
          if (wasAtBottom) {
            term.scrollToBottom();
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
        const prevCols = activeRef.current.term.cols;
        const prevRows = activeRef.current.term.rows;
        activeRef.current.fitAddon.fit();
        const newCols = activeRef.current.term.cols;
        const newRows = activeRef.current.term.rows;
        if (newCols !== prevCols || newRows !== prevRows) {
          sendResize(wsRef.current, terminalId, newCols, newRows);
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

    wsRef.current.send(
      JSON.stringify({ type: 'terminal_input', terminalId, data: text }),
    );
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
      fitAddon.fit();
      sendResize(wsRef.current, terminalId, term.cols, term.rows);
      term.refresh(0, term.rows - 1);
      term.scrollToBottom();
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
      activeRef.current.term.scrollToBottom();
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
    pasteToTerminal,
    refitTerminal,
    setTheme: setThemeFn,
    handleTerminalOutput,
    handleTerminalReady,
    handleTerminalClosed,
    reparent,
    scrollToBottom,
  };
}
