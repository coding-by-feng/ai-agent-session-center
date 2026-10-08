/**
 * TerminalContainer wraps xterm.js 5 with FitAddon, Unicode11Addon, and custom URL link provider.
 * Uses the useTerminal hook for lifecycle management.
 * Ported from public/js/terminalManager.js.
 */
import { useEffect, useRef, useState, useCallback, memo } from 'react';
import { createPortal } from 'react-dom';
import { useTerminal } from '@/hooks/useTerminal';
import TerminalToolbar from './TerminalToolbar';
import { useSettingsStore } from '@/stores/settingsStore';
import { ttsEngine } from '@/lib/ttsEngine';
import SelectionPopup from '@/components/translate/SelectionPopup';
import { useSelectionPopup } from '@/hooks/useSelectionPopup';
import { useSessionStore } from '@/stores/sessionStore';
import { isAiPopupEnabled } from '@/lib/aiPopup';
import { extractXtermSelection } from '@/lib/selectionExtractors';
import { useIsMobile } from '@/lib/platform';
import styles from '@/styles/modules/Terminal.module.css';
import '@xterm/xterm/css/xterm.css';

interface TerminalContainerProps {
  terminalId: string | null;
  ws: WebSocket | null;
  showReconnect?: boolean;
  onReconnect?: () => void;
  /** Project root path — enables clickable file paths in terminal output */
  projectPath?: string;
  /** Fork the current Claude/Codex session. */
  onFork?: () => void;
  /** Clone — new session running the same startupCommand + config */
  onClone?: () => void;
  /** Restart — quit the agent and reconnect the same session in a fresh terminal.
   *  When omitted the toolbar button is hidden (floating forks, pop-outs, the ops shell). */
  onRestart?: () => void;
  /** A restart is in flight: the toolbar button stays but cannot be pressed again. */
  restartPending?: boolean;
  /** Pop this terminal out into its own OS window (Electron only). When omitted
   *  the toolbar pop-out button is hidden (e.g. floating forks / the popout view
   *  itself, which must not re-pop-out). */
  onPopOut?: () => void;
  /** Originating session id — required for selection-driven translate/explain
   *  popups. When omitted, those actions are hidden (e.g. floating-terminal
   *  hosts that have no source session). */
  originSessionId?: string | null;
}

const DEFAULT_MIN_HEIGHT = '200px';

export default memo(function TerminalContainer({
  terminalId,
  ws,
  showReconnect = false,
  onReconnect,
  projectPath,
  onFork,
  onClone,
  onRestart,
  restartPending,
  onPopOut,
  originSessionId,
}: TerminalContainerProps) {
  const [themeName, setThemeName] = useState<string>(() => {
    try {
      return localStorage.getItem('terminal-theme') || 'auto';
    } catch {
      return 'auto';
    }
  });

  const [isClosed, setIsClosed] = useState(false);

  const fsContainerRef = useRef<HTMLDivElement | null>(null);

  const {
    containerRef,
    attach,
    detach,
    terminalClosed,
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
    handleTerminalGeometry,
    widthMode,
    setWidthMode,
    handleTerminalReady,
    handleTerminalClosed,
    handleTerminalCleared,
    reparent,
    scrollToBottom,
    refreshOutput,
    clearOutput,
    scrollPageUp,
    scrollPageDown,
    autoScrollEnabled,
    toggleAutoScroll,
    readRecentText,
    getXtermSelection,
    hasXtermSelection,
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

  // IPC subscription failures and PTY exits are reported by useTerminal. The
  // WebSocket transport reaches the same state through terminal_closed below.
  const terminalIsClosed = isClosed || terminalClosed?.terminalId === terminalId;

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

  // The wrap/pan toggle is only offered where panning is the default — a
  // desktop terminal already fits its container, so there is nothing to pan to
  // and the button would be a no-op control taking up toolbar space.
  const showWrapToggle = useIsMobile();
  const toggleWrapMode = useCallback(() => {
    setWidthMode(widthMode === 'pan' ? 'wrap' : 'pan');
  }, [widthMode, setWidthMode]);

  // Listen for terminal WS messages
  useEffect(() => {
    if (!ws) return;

    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'terminal_output' && msg.terminalId) {
          handleTerminalOutput(msg.terminalId, msg.data);
        } else if (msg.type === 'terminal_geometry' && msg.terminalId
                   && typeof msg.cols === 'number') {
          // The PTY's real width. On a narrow device this is what the canvas
          // renders at, so it can pan instead of soft-wrapping mid-word.
          handleTerminalGeometry(msg.terminalId, msg.cols);
        } else if (msg.type === 'terminal_cleared' && msg.terminalId) {
          // "Clear output", from this device or another: the server has
          // already emptied the replay ring at this point of the stream.
          handleTerminalCleared(msg.terminalId);
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
  }, [ws, terminalId, handleTerminalOutput, handleTerminalGeometry, handleTerminalCleared, handleTerminalReady, handleTerminalClosed]);

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

  // ---- Select-to-translate / explain popup ----
  const translationEnabled = useSettingsStore((s) => s.translationEnabled);
  const translationTrigger = useSettingsStore((s) => s.translationTrigger);

  const popupExtract = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const term = { getSelection: () => getXtermSelection() ?? '', hasSelection: () => hasXtermSelection() };
      return extractXtermSelection(term, rootRef.current, e);
    },
    [getXtermSelection, hasXtermSelection],
  );
  // Per-session AI-popup toggle. Read through isAiPopupEnabled so a session
  // that has never been toggled (aiPopupEnabled === undefined — i.e. every
  // session that existed before this shipped) resolves to ON.
  const aiPopupEnabled = useSessionStore(
    (st) => isAiPopupEnabled(originSessionId ? st.sessions.get(originSessionId) : undefined),
  );
  const toggleAiPopup = useSessionStore((st) => st.toggleAiPopup);
  const handleToggleAiPopup = useCallback(() => {
    if (originSessionId) toggleAiPopup(originSessionId);
  }, [originSessionId, toggleAiPopup]);

  const popup = useSelectionPopup({
    enabled: translationEnabled && !!originSessionId && aiPopupEnabled,
    trigger: translationTrigger,
    containerRef: rootRef,
    extract: popupExtract,
    // The xterm element is reparented into a body-level fullscreen overlay in
    // distraction-free mode, leaving `rootRef`'s subtree — scope to '.xterm' so
    // the select-to-translate popup still fires there. See useSelectionPopup.
    scopeSelector: '.xterm',
  });

  // Keyboard-shortcut bridge: a 'terminal:action' event (dispatched by
  // useKeyboardShortcuts) runs the matching toolbar action, but ONLY for the
  // selected session's terminal (scoped by terminalId so other mounted /
  // floating terminals never react — clone/fork must not fan out).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ action: string; terminalId: string }>).detail;
      if (!detail || detail.terminalId !== terminalId) return;
      switch (detail.action) {
        case 'toggleAutoScroll': toggleAutoScroll(); break;
        case 'refresh': refreshOutput(); break;
        case 'clone': onClone?.(); break;
        case 'fork': onFork?.(); break;
        case 'popOut': onPopOut?.(); break;
      }
    };
    document.addEventListener('terminal:action', handler);
    return () => document.removeEventListener('terminal:action', handler);
  }, [terminalId, toggleAutoScroll, refreshOutput, onClone, onFork, onPopOut]);

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
        onClearOutput={clearOutput}
        aiPopupEnabled={aiPopupEnabled}
        onToggleAiPopup={originSessionId ? handleToggleAiPopup : undefined}
        autoScrollEnabled={autoScrollEnabled}
        onToggleAutoScroll={toggleAutoScroll}
        wrapMode={showWrapToggle ? widthMode : undefined}
        onToggleWrapMode={showWrapToggle ? toggleWrapMode : undefined}
        onFork={onFork}
        onClone={onClone}
        onRestart={onRestart}
        restartPending={restartPending}
        onPopOut={onPopOut}
        isFullscreen={isFullscreen}
        showReconnect={showReconnect || (terminalIsClosed && !!onReconnect)}
        ttsEnabled={ttsEnabled}
        ttsActive={ttsActive}
        onTtsPressStart={startTts}
        onTtsPressEnd={stopTts}
      />
      {popup.active && originSessionId && (
        <SelectionPopup
          selection={popup.active}
          originSessionId={originSessionId}
          // The host terminal: a popup spawned here forks from this terminal's
          // session (the main terminal forks itself; a float forks recursively).
          spawnTerminalId={terminalId}
          onClose={popup.close}
        />
      )}
      <div className={styles.terminalArea} style={{ position: 'relative' }}>
        {terminalIsClosed && (
          <div className={styles.closedOverlay}>
            <span className={styles.closedOverlayText}>
              {terminalClosed?.reason === 'unavailable' || terminalClosed?.reason === 'Terminal not found'
                ? 'Terminal unavailable'
                : 'Terminal disconnected'}
            </span>
            {onReconnect && (
              <button className={styles.reconnectPlaceholderBtn} onClick={onReconnect}>
                Reconnect
              </button>
            )}
          </div>
        )}
        <div className={styles.terminalRow}>
          <div
            ref={containerRef}
            className={`${styles.container} ${widthMode === 'pan' ? styles.panMode : ''}`}
            style={{ minHeight: DEFAULT_MIN_HEIGHT }}
          />
        </div>
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
              onClearOutput={clearOutput}
                          aiPopupEnabled={aiPopupEnabled}
              onToggleAiPopup={originSessionId ? handleToggleAiPopup : undefined}
              autoScrollEnabled={autoScrollEnabled}
              onToggleAutoScroll={toggleAutoScroll}
              wrapMode={showWrapToggle ? widthMode : undefined}
              onToggleWrapMode={showWrapToggle ? toggleWrapMode : undefined}
              onFork={onFork}
              onRestart={onRestart}
              restartPending={restartPending}
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
