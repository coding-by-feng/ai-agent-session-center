/**
 * FloatingTerminalPanel — picture-in-picture window hosting a single
 * TerminalContainer for "fork-and-explain" / "fork-and-translate" sessions.
 *
 * A draggable PiP window (drag, minimize-to-pill, maximize/restore,
 * click-outside-safe). Position + size are persisted per terminalId so the
 * window remembers where it was last placed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import TerminalContainer from '@/components/terminal/TerminalContainer';
import { useWsStore } from '@/stores/wsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { useShortcutStore } from '@/stores/shortcutStore';
import { keyComboToString } from '@/lib/shortcutKeys';
import type { ShortcutActionId } from '@/types/shortcut';
import { PALETTE } from '@/lib/robot3DGeometry';
import Tooltip from '@/components/ui/Tooltip';
import { tooltips } from '@/lib/tooltips';
import styles from '@/styles/modules/FloatingTerminalPanel.module.css';

const POS_KEY = 'float-terminal-pos';
const SIZE_KEY = 'float-terminal-size';
const COLLAPSED_KEY = 'float-terminal-collapsed';

const DEFAULT_SIZE = { w: 540, h: 360 };
const DEFAULT_OFFSET = { x: 80, y: 100 };
const COLLAPSED_W = 184;
const COLLAPSED_H = 36;
const MIN_W = 360;
const MIN_H = 220;
const VIEWPORT_MARGIN = 12;

interface Pos {
  x: number;
  y: number;
}
interface Size {
  w: number;
  h: number;
}
interface PanelRect {
  pos: Pos;
  size: Size;
}

interface FloatingTerminalPanelProps {
  terminalId: string;
  label: string;
  /** Stack offset — each open float is bumped down/right so they don't overlap. */
  stackIndex: number;
  originSessionId?: string;
  onClose: () => void;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function constrainFloatingPanelRect(
  pos: Pos,
  size: Size,
  viewport: Size,
  minimumSize: Size = { w: MIN_W, h: MIN_H },
): PanelRect {
  const maxW = Math.max(1, viewport.w - VIEWPORT_MARGIN * 2);
  const maxH = Math.max(1, viewport.h - VIEWPORT_MARGIN * 2);
  const minW = Math.min(minimumSize.w, maxW);
  const minH = Math.min(minimumSize.h, maxH);
  const requestedW = Number.isFinite(size.w) ? size.w : minW;
  const requestedH = Number.isFinite(size.h) ? size.h : minH;
  const fittedSize = {
    w: Math.min(maxW, Math.max(minW, requestedW)),
    h: Math.min(maxH, Math.max(minH, requestedH)),
  };
  const maxX = Math.max(VIEWPORT_MARGIN, viewport.w - fittedSize.w - VIEWPORT_MARGIN);
  const maxY = Math.max(VIEWPORT_MARGIN, viewport.h - fittedSize.h - VIEWPORT_MARGIN);
  const requestedX = Number.isFinite(pos.x) ? pos.x : VIEWPORT_MARGIN;
  const requestedY = Number.isFinite(pos.y) ? pos.y : VIEWPORT_MARGIN;
  return {
    size: fittedSize,
    pos: {
      x: Math.max(VIEWPORT_MARGIN, Math.min(maxX, requestedX)),
      y: Math.max(VIEWPORT_MARGIN, Math.min(maxY, requestedY)),
    },
  };
}

function constrainToViewport(pos: Pos, size: Size, minimumSize?: Size): PanelRect {
  if (typeof window === 'undefined') return { pos, size };
  return constrainFloatingPanelRect(
    pos,
    size,
    { w: window.innerWidth, h: window.innerHeight },
    minimumSize,
  );
}

export default function FloatingTerminalPanel({
  terminalId,
  label,
  stackIndex,
  originSessionId,
  onClose,
}: FloatingTerminalPanelProps) {
  const posKey = `${POS_KEY}:${terminalId}`;
  const sizeKey = `${SIZE_KEY}:${terminalId}`;
  const collapsedKey = `${COLLAPSED_KEY}:${terminalId}`;

  const [collapsed, setCollapsed] = useState<boolean>(() => readJson<boolean>(collapsedKey, false));
  const [size, setSize] = useState<Size>(
    () => constrainToViewport(DEFAULT_OFFSET, readJson<Size>(sizeKey, DEFAULT_SIZE)).size,
  );
  const [pos, setPos] = useState<Pos>(() => {
    const stored = readJson<Pos | null>(posKey, null);
    const initialPos = stored ?? {
      x: DEFAULT_OFFSET.x + stackIndex * 28,
      y: DEFAULT_OFFSET.y + stackIndex * 28,
    };
    const visibleSize = collapsed ? { w: COLLAPSED_W, h: COLLAPSED_H } : size;
    const minimumSize = collapsed ? { w: 1, h: 1 } : undefined;
    return constrainToViewport(initialPos, visibleSize, minimumSize).pos;
  });
  const [maximized, setMaximized] = useState<boolean>(false);
  const restoreRef = useRef<{ pos: Pos; size: Size } | null>(null);

  const client = useWsStore((s) => s.client);
  // Re-derive on reconnect: the stable WsClient swaps its socket in place, so
  // [client] alone freezes the floating terminal on the dead pre-reconnect
  // socket after a server restart.
  const connected = useWsStore((s) => s.connected);
  const ws = useMemo(() => client?.getRawSocket() ?? null, [client, connected]);

  const originSession = useSessionStore((s) =>
    originSessionId ? s.sessions.get(originSessionId) : undefined,
  );
  const pillAccent = originSession
    ? originSession.accentColor || PALETTE[(originSession.colorIndex ?? 0) % PALETTE.length]
    : undefined;

  // Pop out into a native window (Electron only) — draggable to another monitor.
  // Hide the in-app panel on success so only the popout window subscribes to the
  // PTY; FloatingTerminalRoot re-docks it when that window closes.
  const setPoppedOut = useFloatingSessionsStore((s) => s.setPoppedOut);
  const shortcutBindings = useShortcutStore((s) => s.bindings);
  const comboFor = (id: ShortcutActionId): string =>
    keyComboToString(shortcutBindings.find((b) => b.actionId === id)?.combo ?? null);
  const canPopOut = typeof window !== 'undefined' && !!window.electronAPI?.openTerminalWindow;
  const handlePopOut = useCallback(() => {
    window.electronAPI
      ?.openTerminalWindow?.({ terminalId, originSessionId, label })
      .then((r) => {
        if (r?.ok) setPoppedOut(terminalId, true);
      })
      .catch(() => {
        /* ignore — panel stays in-app */
      });
  }, [terminalId, originSessionId, label, setPoppedOut]);

  const rootRef = useRef<HTMLElement | null>(null);

  // Keep the whole panel inside the renderer viewport, including when a saved
  // desktop-sized rectangle is restored into a narrower Electron window.
  useEffect(() => {
    if (maximized) return undefined;
    const onResize = (): void => {
      const visibleSize = collapsed ? { w: COLLAPSED_W, h: COLLAPSED_H } : size;
      const minimumSize = collapsed ? { w: 1, h: 1 } : undefined;
      const next = constrainToViewport(pos, visibleSize, minimumSize);
      setPos((current) =>
        current.x === next.pos.x && current.y === next.pos.y ? current : next.pos,
      );
      if (!collapsed) {
        setSize((current) =>
          current.w === next.size.w && current.h === next.size.h ? current : next.size,
        );
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [collapsed, maximized, pos, size]);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const root = e.currentTarget as HTMLElement;
      const closestBtn = target.closest('button');
      if (closestBtn && closestBtn !== root) return;
      if (maximized) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startPos = pos;
      const requestedSize = collapsed ? { w: COLLAPSED_W, h: COLLAPSED_H } : size;
      const minimumSize = collapsed ? { w: 1, h: 1 } : undefined;
      const currentSize = constrainToViewport(startPos, requestedSize, minimumSize).size;
      if (collapsed) root.dataset.moved = '0';

      const onMove = (ev: MouseEvent): void => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (collapsed && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
          root.dataset.moved = '1';
        }
        const next = constrainToViewport(
          { x: startPos.x + dx, y: startPos.y + dy },
          currentSize,
          minimumSize,
        );
        setPos(next.pos);
      };
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        setPos((p) => {
          writeJson(posKey, p);
          return p;
        });
      };
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [pos, size, collapsed, posKey, maximized],
  );

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      if (maximized) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const startSize = size;
      const onMove = (ev: MouseEvent): void => {
        const maxW = Math.max(1, window.innerWidth - pos.x - VIEWPORT_MARGIN);
        const maxH = Math.max(1, window.innerHeight - pos.y - VIEWPORT_MARGIN);
        const minW = Math.min(MIN_W, maxW);
        const minH = Math.min(MIN_H, maxH);
        const w = Math.min(maxW, Math.max(minW, startSize.w + (ev.clientX - startX)));
        const h = Math.min(maxH, Math.max(minH, startSize.h + (ev.clientY - startY)));
        setSize({ w, h });
      };
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        setSize((s) => {
          writeJson(sizeKey, s);
          return s;
        });
      };
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'nwse-resize';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [pos, size, sizeKey, maximized],
  );

  const handleMinimize = useCallback(() => {
    const next = constrainToViewport(pos, { w: COLLAPSED_W, h: COLLAPSED_H }, { w: 1, h: 1 });
    setPos(next.pos);
    setCollapsed(true);
    writeJson(collapsedKey, true);
  }, [collapsedKey, pos]);

  const handleExpand = useCallback(() => {
    const next = constrainToViewport(pos, size);
    setPos(next.pos);
    setSize(next.size);
    setCollapsed(false);
    writeJson(collapsedKey, false);
  }, [collapsedKey, pos, size]);

  const handleToggleMaximize = useCallback(() => {
    setMaximized((m) => {
      if (!m) {
        restoreRef.current = { pos, size };
        return true;
      }
      const prev = restoreRef.current;
      if (prev) {
        const next = constrainToViewport(prev.pos, prev.size);
        setPos(next.pos);
        setSize(next.size);
      }
      restoreRef.current = null;
      return false;
    });
  }, [pos, size]);

  // Floating-window hotkeys (⌥⌘↓ / ⌥⌘↑ / ⌥⌘W by default, rebindable in Settings)
  // — only the float that currently holds focus reacts.
  useEffect(() => {
    const handler = (e: Event) => {
      if (!rootRef.current?.contains(document.activeElement)) return;
      const action = (e as CustomEvent<{ action?: string }>).detail?.action;
      if (action === 'minimize') handleMinimize();
      else if (action === 'maximize') handleToggleMaximize();
      else if (action === 'close') onClose();
    };
    document.addEventListener('floatTerminal:hotkey', handler);
    return () => document.removeEventListener('floatTerminal:hotkey', handler);
  }, [handleMinimize, handleToggleMaximize, onClose]);

  if (typeof document === 'undefined') return null;

  if (collapsed) {
    return createPortal(
      <Tooltip label={label} description="Open this floating session" placement="left">
        <button
          ref={(el) => {
            rootRef.current = el;
          }}
          type="button"
          className={styles.collapsed}
          style={{
            left: pos.x,
            top: pos.y,
            width: COLLAPSED_W,
            height: COLLAPSED_H,
            ...(pillAccent ? ({ '--pill-accent': pillAccent } as React.CSSProperties) : {}),
          }}
          onMouseDown={handleDragStart}
          onClick={(e) => {
            const moved = e.currentTarget.dataset.moved === '1';
            e.currentTarget.dataset.moved = '0';
            if (!moved) handleExpand();
          }}
          aria-label={`Open ${label}`}
        >
          <span className={styles.collapsedIcon}>⤴</span>
          <span className={styles.collapsedLabel}>{label}</span>
        </button>
      </Tooltip>,
      document.body,
    );
  }

  const panelStyle: React.CSSProperties = maximized
    ? {
        left: VIEWPORT_MARGIN,
        top: VIEWPORT_MARGIN,
        right: VIEWPORT_MARGIN,
        bottom: VIEWPORT_MARGIN,
        width: 'auto',
        height: 'auto',
      }
    : { left: pos.x, top: pos.y, width: size.w, height: size.h };

  return createPortal(
    <div
      ref={(el) => {
        rootRef.current = el;
      }}
      className={`${styles.panel}${maximized ? ` ${styles.maximized}` : ''}`}
      style={panelStyle}
    >
      <div className={styles.header} onMouseDown={handleDragStart}>
        <span className={styles.titleIcon} aria-hidden>
          ⤴
        </span>
        <span className={styles.title}>{label}</span>
        <div className={styles.headerBtns}>
          {canPopOut && (
            <Tooltip label="Pop out to a window (drag to another monitor)" placement="bottom">
              <button
                type="button"
                className={styles.headerBtn}
                onClick={handlePopOut}
                aria-label="Pop out to a window"
              >
                ⧉
              </button>
            </Tooltip>
          )}
          <Tooltip label={`Minimize to icon (${comboFor('floatMinimize')})`} placement="bottom">
            <button
              type="button"
              className={styles.headerBtn}
              onClick={handleMinimize}
              aria-label="Minimize"
            >
              ▁
            </button>
          </Tooltip>
          <Tooltip
            label={`${maximized ? 'Restore size' : 'Maximize'} (${comboFor('floatMaximize')})`}
            placement="bottom"
          >
            <button
              type="button"
              className={styles.headerBtn}
              onClick={handleToggleMaximize}
              aria-label={maximized ? 'Restore' : 'Maximize'}
            >
              {maximized ? '❐' : '☐'}
            </button>
          </Tooltip>
          <Tooltip
            label={`Close (${comboFor('floatClose')})`}
            description={tooltips.floatTerminalClose.description}
            placement="bottom"
          >
            <button
              type="button"
              className={styles.headerBtn}
              onClick={onClose}
              aria-label="Close floating terminal"
            >
              ✕
            </button>
          </Tooltip>
        </div>
      </div>
      <div className={styles.body}>
        <TerminalContainer
          terminalId={terminalId}
          ws={ws}
          showReconnect={false}
          // originSessionId stays the ROOT session: it drives the float's
          // translate/explain lookups AND float-visibility scoping (nested floats
          // must remain visible under the selected root session, never orphaned).
          // Recursive fork is handled server-side: TerminalContainer sends this
          // float's `terminalId` as spawnTerminalId, and the server resolves its
          // session as the fork parent (see floatingSessionSpawner).
          originSessionId={originSessionId}
        />
      </div>
      {!maximized && (
        <div className={styles.resize} onMouseDown={handleResizeStart} aria-hidden>
          <span className={styles.resizeGrip} aria-hidden />
        </div>
      )}
    </div>,
    document.body,
  );
}
