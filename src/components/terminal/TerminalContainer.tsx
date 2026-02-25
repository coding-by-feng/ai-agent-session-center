/**
 * TerminalContainer wraps xterm.js 5 with FitAddon, Unicode11Addon, WebLinksAddon.
 * Uses the useTerminal hook for lifecycle management.
 * Ported from public/js/terminalManager.js.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTerminal } from '@/hooks/useTerminal';
import TerminalToolbar from './TerminalToolbar';
import styles from '@/styles/modules/Terminal.module.css';
import '@xterm/xterm/css/xterm.css';

interface TerminalContainerProps {
  terminalId: string | null;
  ws: WebSocket | null;
  showReconnect?: boolean;
  onReconnect?: () => void;
}

const DEFAULT_MIN_HEIGHT = '200px';

export default function TerminalContainer({
  terminalId,
  ws,
  showReconnect = false,
  onReconnect,
}: TerminalContainerProps) {
  const [themeName, setThemeName] = useState<string>(() => {
    try {
      return localStorage.getItem('terminal-theme') || 'auto';
    } catch {
      return 'auto';
    }
  });

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
  } = useTerminal({ ws, themeName });

  // Attach/detach when terminalId changes
  useEffect(() => {
    if (terminalId) {
      attach(terminalId);
    } else {
      detach();
    }
  }, [terminalId, attach, detach]);

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
        isFullscreen={isFullscreen}
        showReconnect={showReconnect}
      />
      <div
        ref={containerRef}
        className={styles.container}
        style={{ minHeight: DEFAULT_MIN_HEIGHT }}
      />
      {/* Fullscreen overlay — always mounted, toggled via display.
          This avoids unmounting the portal while the xterm element is still inside it. */}
      {createPortal(
        <div
          className={styles.fullscreenOverlay}
          style={{ display: isFullscreen ? 'flex' : 'none' }}
        >
          <div className={styles.fullscreenTopbar}>
            <span className={styles.fullscreenTitle}>Terminal</span>
            <TerminalToolbar
              themeName={themeName}
              onThemeChange={handleThemeChange}
              onFullscreen={toggleFullscreen}
              onSendEscape={sendEscape}
              onSendArrowUp={sendArrowUp}
              onSendArrowDown={sendArrowDown}
              onPaste={pasteToTerminal}
              onReconnect={onReconnect}
              isFullscreen={isFullscreen}
              showReconnect={showReconnect}
            />
          </div>
          <div ref={fsContainerRef} className={styles.fullscreenContainer} />
        </div>,
        document.body,
      )}
    </div>
  );
}
