/**
 * useTerminal hook manages xterm.js terminal lifecycle.
 * Handles creation, attachment, resize, fullscreen, and WS relay.
 * Ported from public/js/terminalManager.js.
 */
import { useRef, useCallback, useEffect, useState } from 'react';
import { Terminal } from 'xterm';
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
  refitTerminal: () => void;
  setTheme: (themeName: string) => void;
  handleTerminalOutput: (terminalId: string, base64Data: string) => void;
  handleTerminalReady: (terminalId: string) => void;
  handleTerminalClosed: (terminalId: string, reason?: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const savedCols = term.cols;
  const savedRows = term.rows;

  requestAnimationFrame(() => {
    if (!activeRef.current || activeRef.current.terminalId !== terminalId) return;
    if (savedCols > 2) {
      term.resize(savedCols - 1, savedRows);
    }
    requestAnimationFrame(() => {
      if (!activeRef.current || activeRef.current.terminalId !== terminalId) return;
      fitAddon.fit();
      sendResize(ws, terminalId, term.cols, term.rows);
    });
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTerminal({ ws, themeName = 'auto' }: UseTerminalOptions): UseTerminalReturn {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<ActiveTerminal | null>(null);
  const pendingOutputRef = useRef<Map<string, string[]>>(new Map());
  const hasReceivedFirstOutputRef = useRef(false);
  const themeNameRef = useRef(themeName);
  const wsRef = useRef(ws);

  const [isAttached, setIsAttached] = useState(false);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Keep refs in sync
  useEffect(() => {
    themeNameRef.current = themeName;
  }, [themeName]);

  useEffect(() => {
    wsRef.current = ws;
    // Re-subscribe on WS reconnect
    if (activeRef.current && ws && ws.readyState === 1) {
      activeRef.current.term.clear();
      ws.send(JSON.stringify({ type: 'terminal_subscribe', terminalId: activeRef.current.terminalId }));
    }
  }, [ws]);

  // Detach
  const detach = useCallback(() => {
    if (activeRef.current) {
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
  }, []);

  // Attach
  const attach = useCallback(
    (terminalId: string) => {
      detach();
      hasReceivedFirstOutputRef.current = false;

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

      // Clear stale pending output
      pendingOutputRef.current.delete(terminalId);

      // Subscribe for output
      if (wsRef.current && wsRef.current.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: 'terminal_subscribe', terminalId }));
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
          scrollback: 10000,
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

        // Resize observer
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
        const resizeObserver = new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            fitAddon.fit();
            sendResize(wsRef.current, terminalId, term.cols, term.rows);
          }, 50);
        });
        resizeObserver.observe(container);

        activeRef.current = { terminalId, term, fitAddon, resizeObserver };
        setIsAttached(true);
        setActiveTerminalId(terminalId);

        // Flush buffered output
        const buffered = pendingOutputRef.current.get(terminalId);
        if (buffered) {
          for (const data of buffered) {
            const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
            term.write(bytes);
          }
          pendingOutputRef.current.delete(terminalId);
        }

        term.focus();
        forceCanvasRepaint(wsRef.current, terminalId, term, fitAddon, activeRef);
      }

      setupWhenReady(60);
    },
    [detach],
  );

  // Terminal output handler
  const handleTerminalOutput = useCallback((terminalId: string, base64Data: string) => {
    if (activeRef.current && activeRef.current.terminalId === terminalId) {
      const bytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
      activeRef.current.term.write(bytes);

      if (!hasReceivedFirstOutputRef.current) {
        hasReceivedFirstOutputRef.current = true;
        setTimeout(() => {
          if (activeRef.current && activeRef.current.terminalId === terminalId) {
            activeRef.current.term.refresh(0, activeRef.current.term.rows - 1);
          }
        }, 100);
      }
    } else {
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

  const refitTerminal = useCallback(() => {
    if (!activeRef.current) return;
    const { terminalId, term, fitAddon } = activeRef.current;
    forceCanvasRepaint(wsRef.current, terminalId, term, fitAddon, activeRef);
  }, []);

  const toggleFullscreenFn = useCallback(() => {
    setIsFullscreen((prev) => !prev);
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
    refitTerminal,
    setTheme: setThemeFn,
    handleTerminalOutput,
    handleTerminalReady,
    handleTerminalClosed,
  };
}
