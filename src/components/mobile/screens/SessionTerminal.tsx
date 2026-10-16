/**
 * SessionTerminal — the session screen's Terminal segment (AASC-45).
 *
 *   ● Live · 132×40      [Fit|Pan]  A−  A+  ⋯      state · the PTY's size · width · text size
 *   ┌──────────────────────────────────────────┐
 *   │ xterm: fitted to the width, or panned     │  pinch = a visual zoom, with pan
 *   └──────────────────────────────────────────┘
 *   Your Mac is driving            [Take control]  only when this phone can't type
 *   [ Type into the terminal…               ⏎ ]   raw input line, not the chat's box
 *   esc tab ctrl ↑ ↓ ← → 1 2 3 ⏎                   key bar, scrolls sideways
 *
 * The phone never resizes the shared PTY (`mayDrivePtyGeometry` is false on
 * phones): Fit shrinks the local font until the PTY's real columns fit (below
 * ~7 px it pans at the reading size), pinch scales the drawn canvas, and A− / A+
 * set the reading size. None of them changes a column. It's built on
 * `useTerminal` directly (TerminalContainer draws the classic phone input), so
 * the replay ring, `verifySettled` and the resize guard all apply as they do there.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '@/types';
import { Button, EmptyState } from '../kit';
import { CloseIcon, EllipsisIcon } from '../kit/kitIcons';
import { useSoftKeyboardOpen } from '../app/useSoftKeyboardOpen';
import DrivingBanner from '../chat/DrivingBanner';
import ZoomViewport from '../terminal/ZoomViewport';
import PhoneKeyBar from '../terminal/PhoneKeyBar';
import RawInputLine from '../terminal/RawInputLine';
import TerminalMoreSheet, { type CommandsRow } from '../terminal/TerminalMoreSheet';
import { ExitFullscreenIcon } from '../phoneIcons';
import { useTerminal } from '@/hooks/useTerminal';
import { useControlBaton } from '@/hooks/useControlBaton';
import { useTerminalBookmarks } from '@/hooks/useTerminalBookmarks';
import { useLongPress, type LongPressPoint } from '@/hooks/useLongPress';
import { useWsStore } from '@/stores/wsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { isNativeMobileApp } from '@/lib/platform';
import { submitComposed } from '@/lib/terminalCompose';
import { bookmarkLabel, type TerminalBookmark } from '@/lib/terminalBookmarks';
import { stepTextSize, type TerminalWidthMode } from '@/lib/terminalGeometry';
import { pressKey, type KeyBarKey } from '@/lib/chat/terminalKeys';
import { zoomLabel } from '@/lib/chat/terminalZoom';
import { copyText } from '@/lib/chat/copyText';
import { phoneTerminalTheme } from '@/lib/chat/phoneThemes';
import { showToast } from '@/components/ui/ToastContainer';
import '@xterm/xterm/css/xterm.css';
import styles from '@/styles/modules/mobile/PhoneTerminal.module.css';

/** The reading size a phone starts at (the classic phone terminal's). */
const DEFAULT_TEXT_SIZE = 11;
const PREFS_KEY = 'aasc.phoneTerminal';

interface Prefs {
  mode: TerminalWidthMode;
  size: number;
}

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    const mode = raw.mode === 'pan' || raw.mode === 'wrap' || raw.mode === 'fit' ? raw.mode : 'fit';
    const size = typeof raw.size === 'number' && raw.size >= 6 && raw.size <= 24 ? raw.size : DEFAULT_TEXT_SIZE;
    return { mode, size };
  } catch {
    return { mode: 'fit', size: DEFAULT_TEXT_SIZE };
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode: the choice lasts until the page reloads */
  }
}

interface ViewProps {
  ws: WebSocket | null;
  session: Session;
  terminalId: string;
  /** The session whose baton gates typing; null for the plain shell (no baton). */
  controlSessionId: string | null;
  commands: CommandsRow | null;
  onReconnect?: () => void;
}

function PhoneTerminalView({ ws, session, terminalId, controlSessionId, commands, onReconnect }: ViewProps) {
  // The phone's theme paints its terminal too (AASC-58), live as it changes.
  const themeName = useSettingsStore((s) => s.themeName);
  const palette = useMemo(() => phoneTerminalTheme(themeName), [themeName]);
  const term = useTerminal({ ws, palette, projectPath: session.projectPath });
  const {
    attach, setWidthMode, setTextSize, handleTerminalOutput, handleTerminalGeometry, handleTerminalCleared,
    handleTerminalReady, handleTerminalClosed, reparent, containerRef, isFullscreen, sendKeys, lineAtClientY, revealLine,
  } = term;
  const wsConnected = useWsStore((s) => s.connected);
  const baton = useControlBaton(controlSessionId);
  const locked = baton.mode === 'spectator';
  const keyboardOpen = useSoftKeyboardOpen();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [closed, setClosed] = useState(false);
  const [geometry, setGeometry] = useState<{ cols: number; rows: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ctrl, setCtrl] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [moreOpen, setMoreOpen] = useState(false);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const [line, setLine] = useState('');
  const [sending, setSending] = useState(false);
  const fsRef = useRef<HTMLDivElement>(null);
  const lastNonWrap = useRef<TerminalWidthMode>(prefs.mode === 'wrap' ? 'fit' : prefs.mode);

  // This phone's width mode and reading size, before and after the terminal opens.
  useEffect(() => {
    setTextSize(prefs.size);
    setWidthMode(prefs.mode);
  }, [prefs, setTextSize, setWidthMode]);

  useEffect(() => {
    attach(terminalId);
  }, [terminalId, attach]);

  useEffect(() => {
    if (!ws) return undefined;
    const handler = (event: MessageEvent) => {
      let msg: { type?: string; terminalId?: string; data?: string; cols?: number; rows?: number; reason?: string; error?: unknown };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg.terminalId) return;
      if (msg.type === 'terminal_output' && typeof msg.data === 'string') handleTerminalOutput(msg.terminalId, msg.data);
      else if (msg.type === 'terminal_geometry' && typeof msg.cols === 'number') {
        handleTerminalGeometry(msg.terminalId, msg.cols);
        if (msg.terminalId === terminalId) setGeometry({ cols: msg.cols, rows: typeof msg.rows === 'number' ? msg.rows : 0 });
      } else if (msg.type === 'terminal_cleared') handleTerminalCleared(msg.terminalId);
      else if (msg.type === 'terminal_ready') handleTerminalReady(msg.terminalId);
      else if (msg.type === 'terminal_closed') {
        handleTerminalClosed(msg.terminalId, msg.reason);
        if (msg.terminalId === terminalId) setClosed(true);
      } else if (msg.type === 'terminal_error' && msg.terminalId === terminalId && typeof msg.error === 'string') {
        setNotice(msg.error);
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, terminalId, handleTerminalOutput, handleTerminalGeometry, handleTerminalCleared, handleTerminalReady, handleTerminalClosed]);

  // Full screen moves the xterm element into the overlay and back.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target = isFullscreen ? fsRef.current : containerRef.current;
      if (target) reparent(target);
    });
    return () => cancelAnimationFrame(frame);
  }, [isFullscreen, reparent, containerRef]);

  // ---- Bookmarks: hold a line ----
  const { bookmarks, add: addBookmark, remove: removeBookmark } = useTerminalBookmarks(terminalId);
  const bookmarkAt = useCallback(({ clientY }: LongPressPoint) => {
    const hit = lineAtClientY(clientY);
    if (!hit || !addBookmark(hit.line, hit.text)) {
      showToast('Hold a line with text on it to bookmark it', 'info', 2500);
      return;
    }
    navigator.vibrate?.(10);
    showToast(`Bookmarked: ${bookmarkLabel(hit.text, 48)}`, 'success', 2500);
  }, [lineAtClientY, addBookmark]);
  useLongPress({ enabled: true, targets: [containerRef, fsRef], selector: '.xterm-screen', onLongPress: bookmarkAt });
  const jumpTo = useCallback((b: TerminalBookmark) => {
    if (!revealLine(b)) showToast('That line is no longer in the terminal’s scrollback', 'info', 3000);
  }, [revealLine]);

  // ---- Width and text size ----
  const choose = (next: Partial<Prefs>) => {
    const merged = { ...prefs, ...next };
    if (merged.mode !== 'wrap') lastNonWrap.current = merged.mode;
    setPrefs(merged);
    savePrefs(merged);
  };
  const rendered = prefs.mode === 'fit' && term.fitState ? term.fitState.fontSize : prefs.size;
  // A size of your own means reading at it: from Fit that is panning.
  const resize = (direction: 1 | -1) => choose({ size: stepTextSize(rendered, direction), mode: prefs.mode === 'fit' ? 'pan' : prefs.mode });
  const fellBack = prefs.mode === 'fit' && term.fitState?.fitted === false && !!geometry;

  // ---- Typing ----
  const typingOff = locked || closed;
  const onKey = (key: KeyBarKey) => {
    const result = pressKey({ ctrl }, key);
    setCtrl(result.ctrl);
    if (result.send) sendKeys(result.send);
  };
  const sendLine = async () => {
    const text = line.replace(/\s+$/, '');
    if (!text || typingOff || sending) return;
    setSending(true);
    setNotice(null);
    const result = await submitComposed(terminalId, text, () => setLine((cur) => (cur.replace(/\s+$/, '') === text ? '' : cur)));
    setSending(false);
    if (!result.ok) setNotice(result.message);
  };
  const copyScreen = async () => {
    const { text } = term.readRecentText({ lines: geometry?.rows || 40 });
    if (!text) {
      showToast('Nothing on the screen to copy', 'info', 2500);
      return;
    }
    const copied = await copyText(text);
    showToast(copied ? 'Copied the screen' : 'Couldn’t copy on this phone', copied ? 'success' : 'error', 2500);
  };

  const live = closed ? 'Disconnected' : !wsConnected ? 'Reconnecting…' : term.isAttached ? 'Live' : 'Connecting…';
  const liveTone = closed ? 'error' : live === 'Live' ? 'live' : 'wait';
  const placeholder = closed ? 'The terminal is disconnected' : locked ? 'Take control to type here' : 'Type into the terminal…';

  const inputs = (
    <div className={styles.inputs} data-keyboard={keyboardOpen || isFullscreen ? '' : undefined}>
      {controlSessionId && <DrivingBanner sessionId={controlSessionId} />}
      {notice && (
        <p className={styles.notice} role="alert">
          <span>{notice}</span>
          <button type="button" className={styles.noticeClose} onClick={() => setNotice(null)} aria-label="Dismiss">
            <CloseIcon />
          </button>
        </p>
      )}
      <RawInputLine
        value={line}
        onChange={setLine}
        ctrl={ctrl}
        onCtrlCode={(code) => {
          setCtrl(false);
          sendKeys(code);
        }}
        onCtrlRelease={() => setCtrl(false)}
        disabled={typingOff}
        placeholder={placeholder}
        sending={sending}
        onSubmit={() => void sendLine()}
      />
      <PhoneKeyBar ctrl={ctrl} disabled={typingOff} onKey={onKey} />
    </div>
  );

  const viewer = (ref: typeof containerRef | typeof fsRef, testId: string) => (
    <div className={styles.viewerWrap}>
      <ZoomViewport zoom={zoom} onZoom={setZoom} testId={testId}>
        <div ref={ref} className={styles.xterm} data-pan={prefs.mode === 'wrap' ? undefined : ''} />
      </ZoomViewport>
      {zoom > 1 && (
        <button type="button" className={styles.zoomChip} onClick={() => setZoom(1)} aria-label={`Zoomed to ${zoomLabel(zoom)}: reset`}>
          {zoomLabel(zoom)} · Reset
        </button>
      )}
      {closed && (
        <div className={styles.closed}>
          <p>The terminal is disconnected</p>
          {onReconnect && <Button small variant="primary" onClick={onReconnect}>Reconnect</Button>}
        </div>
      )}
    </div>
  );

  return (
    <div className={styles.segment} data-testid="phone-session-terminal">
      <div className={styles.statusRow}>
        <p className={styles.state}>
          <span className={styles.dot} data-tone={liveTone} aria-hidden="true" />
          <span className={styles.stateText}>
            <span>{live}</span>
            {geometry && geometry.cols > 0 && <span className={styles.size}>{geometry.cols}×{geometry.rows || '?'}</span>}
          </span>
        </p>
        <div className={styles.modeGroup} role="group" aria-label="Terminal width">
          {(['fit', 'pan'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={styles.modeButton}
              aria-pressed={prefs.mode === mode}
              onClick={() => choose({ mode })}
            >
              {mode === 'fit' ? 'Fit' : 'Pan'}
            </button>
          ))}
        </div>
        <button type="button" className={styles.iconButton} onClick={() => resize(-1)} aria-label="Smaller text">A−</button>
        <button type="button" className={styles.iconButton} onClick={() => resize(1)} aria-label="Larger text">A+</button>
        <button type="button" className={styles.iconButton} onClick={() => setMoreOpen(true)} aria-label="More terminal actions" aria-haspopup="dialog">
          <EllipsisIcon />
        </button>
      </div>
      {fellBack && <p className={styles.fitNote}>Too wide to fit at a readable size, so it pans. Turn the phone sideways to fit it.</p>}
      {prefs.mode === 'wrap' && <p className={styles.fitNote}>Wrapping long lines. Tables and boxes may break up.</p>}

      {viewer(containerRef, 'phone-terminal-viewport')}
      {!isFullscreen && inputs}

      <TerminalMoreSheet
        open={moreOpen}
        onClose={closeMore}
        wrap={prefs.mode === 'wrap'}
        onToggleWrap={() => choose({ mode: prefs.mode === 'wrap' ? lastNonWrap.current : 'wrap' })}
        follow={term.autoScrollEnabled}
        onToggleFollow={term.toggleAutoScroll}
        onScrollToBottom={term.scrollToBottom}
        isFullscreen={isFullscreen}
        onToggleFullscreen={term.toggleFullscreen}
        onCopy={() => void copyScreen()}
        onRefresh={term.refreshOutput}
        onClear={term.clearOutput}
        onReconnect={closed ? onReconnect : undefined}
        bookmarks={{ list: bookmarks, onJump: jumpTo, onRemove: removeBookmark }}
        commands={commands}
      />

      {createPortal(
        <div className={styles.fullscreen} data-open={isFullscreen ? '' : undefined} aria-hidden={isFullscreen ? undefined : true}>
          <div className={styles.fsBar}>
            <span className={styles.fsTitle}>Terminal{geometry ? ` · ${geometry.cols}×${geometry.rows || '?'}` : ''}</span>
            <button type="button" className={styles.iconButton} onClick={term.toggleFullscreen} aria-label="Leave full screen">
              <ExitFullscreenIcon />
            </button>
          </div>
          {viewer(fsRef, 'phone-terminal-fullscreen')}
          {isFullscreen && inputs}
        </div>,
        document.body,
      )}
    </div>
  );
}

export default function SessionTerminal({ session }: { session: Session }) {
  // Re-read on every store change: the client is stable but swaps its socket on a
  // reconnect, so a cached socket would freeze the terminal.
  const ws = useWsStore((s) => s.client?.getRawSocket() ?? null);
  const [showing, setShowing] = useState<'agent' | 'shell'>('agent');
  const { sessionId } = session;
  const native = isNativeMobileApp();
  const opsId = session.opsTerminalId ?? null;
  const onShell = showing === 'shell' && !!opsId && !native;
  const terminalId = onShell ? opsId : session.terminalId ?? null;
  const canReconnect = session.source === 'ssh' || !!session.startupCommand;

  const reconnect = useCallback(() => {
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/reconnect-terminal`, { method: 'POST' }).catch(() => {});
  }, [sessionId]);

  // The COMMANDS tab: a plain shell on the Mac, which the phone app is never given (AASC-28).
  const commands: CommandsRow | null = native
    ? { kind: 'unavailable' }
    : opsId
      ? { kind: 'switch', showing: onShell ? 'shell' : 'agent', onClick: () => setShowing(onShell ? 'agent' : 'shell') }
      : null;

  if (!terminalId) {
    return (
      <div className={styles.segment} data-testid="phone-session-terminal">
        <EmptyState
          title="No terminal"
          message={session.status === 'ended' ? 'This session has ended.' : 'This session has no terminal attached yet.'}
          action={canReconnect && session.status === 'ended' ? <Button variant="primary" onClick={reconnect}>Reconnect</Button> : undefined}
        />
      </div>
    );
  }

  return (
    <PhoneTerminalView
      key={terminalId}
      ws={ws}
      session={session}
      terminalId={terminalId}
      controlSessionId={onShell ? null : sessionId}
      commands={commands}
      onReconnect={canReconnect && !onShell ? reconnect : undefined}
    />
  );
}
