/**
 * TerminalContainer wraps xterm.js 5 with FitAddon, Unicode11Addon, WebLinksAddon.
 * Uses the useTerminal hook for lifecycle management.
 * Ported from public/js/terminalManager.js.
 */
import { useEffect, useState, useCallback } from 'react';
import { useTerminal } from '@/hooks/useTerminal';
import TerminalToolbar from './TerminalToolbar';
import styles from '@/styles/modules/Terminal.module.css';
import 'xterm/css/xterm.css';

interface TerminalContainerProps {
  terminalId: string | null;
  ws: WebSocket | null;
  showReconnect?: boolean;
  onReconnect?: () => void;
}

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

  const {
    containerRef,
    attach,
    detach,
    isAttached,
    isFullscreen,
    toggleFullscreen,
    sendEscape,
    refitTerminal,
    setTheme,
    handleTerminalOutput,
    handleTerminalReady,
    handleTerminalClosed,
  } = useTerminal({ ws, themeName });

  // Attach/detach when terminalId changes
  useEffect(() => {
    if (terminalId) {
      attach(terminalId);
    } else {
      detach();
    }
  }, [terminalId, attach, detach]);

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

  const handleRefresh = useCallback(() => {
    refitTerminal();
  }, [refitTerminal]);

  if (!terminalId) {
    return (
      <div className={styles.placeholder}>
        No terminal attached. Create an SSH session or select a session with a terminal.
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
        onRefresh={handleRefresh}
        onReconnect={onReconnect}
        isFullscreen={isFullscreen}
        showReconnect={showReconnect}
      />
      <div
        ref={containerRef}
        className={styles.container}
      />
    </div>
  );
}
