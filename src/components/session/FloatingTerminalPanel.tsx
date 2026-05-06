/**
 * FloatingTerminalPanel — picture-in-picture window hosting a single
 * TerminalContainer for "fork-and-explain" / "fork-and-translate" sessions.
 *
 * Mirrors the FloatingProjectPanel UX (drag, minimize-to-pill, maximize/restore,
 * click-outside-safe). Position + size are persisted per terminalId so the
 * window remembers where it was last placed.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import TerminalContainer from '@/components/terminal/TerminalContainer';
import { useWsStore } from '@/stores/wsStore';
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

interface Pos { x: number; y: number }
interface Size { w: number; h: number }

interface FloatingTerminalPanelProps {
  terminalId: string;
  label: string;
  /** Stack offset — each open float is bumped down/right so they don't overlap. */
  stackIndex: number;
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
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function clampToViewport(pos: Pos, size: Size): Pos {
  if (typeof window === 'undefined') return pos;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxX = Math.max(VIEWPORT_MARGIN, vw - size.w - VIEWPORT_MARGIN);
  const maxY = Math.max(VIEWPORT_MARGIN, vh - size.h - VIEWPORT_MARGIN);
  return {
    x: Math.max(VIEWPORT_MARGIN, Math.min(maxX, pos.x)),
    y: Math.max(VIEWPORT_MARGIN, Math.min(maxY, pos.y)),
  };
}

export default function FloatingTerminalPanel({
  terminalId,
  label,
  stackIndex,
  onClose,
}: FloatingTerminalPanelProps) {
  const posKey = `${POS_KEY}:${terminalId}`;
  const sizeKey = `${SIZE_KEY}:${terminalId}`;
  const collapsedKey = `${COLLAPSED_KEY}:${terminalId}`;

  const [collapsed, setCollapsed] = useState<boolean>(() =>
    readJson<boolean>(collapsedKey, false));
  const posStoredRef = useRef<boolean>(false);
  const [pos, setPos] = useState<Pos>(() => {
    const stored = readJson<Pos | null>(posKey, null);
    posStoredRef.current = stored !== null;
    return stored ?? {
      x: DEFAULT_OFFSET.x + stackIndex * 28,
      y: DEFAULT_OFFSET.y + stackIndex * 28,
    };
  });
  const [size, setSize] = useState<Size>(() => readJson<Size>(sizeKey, DEFAULT_SIZE));
  const [maximized, setMaximized] = useState<boolean>(false);
  const restoreRef = useRef<{ pos: Pos; size: Size } | null>(null);

  const client = useWsStore((s) => s.client);
  const ws = useMemo(() => client?.getRawSocket() ?? null, [client]);

  const rootRef = useRef<HTMLElement | null>(null);

  // Anchor on first paint
  useLayoutEffect(() => {
    if (posStoredRef.current) return;
    setPos((p) => clampToViewport(p, collapsed ? { w: COLLAPSED_W, h: COLLAPSED_H } : size));
    posStoredRef.current = true;
  }, [collapsed, size]);

  // Re-clamp on viewport resize
  useEffect(() => {
    const onResize = (): void => {
      setPos((p) => clampToViewport(p, collapsed ? { w: COLLAPSED_W, h: COLLAPSED_H } : size));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [collapsed, size]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const root = e.currentTarget as HTMLElement;
    const closestBtn = target.closest('button');
    if (closestBtn && closestBtn !== root) return;
    if (maximized) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startPos = pos;
    const currentSize = collapsed ? { w: COLLAPSED_W, h: COLLAPSED_H } : size;
    if (collapsed) root.dataset.moved = '0';

    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (collapsed && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        root.dataset.moved = '1';
      }
      const next = clampToViewport({ x: startPos.x + dx, y: startPos.y + dy }, currentSize);
      setPos(next);
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      setPos((p) => { writeJson(posKey, p); return p; });
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [pos, size, collapsed, posKey, maximized]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    if (maximized) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = size;
    const onMove = (ev: MouseEvent): void => {
      const vw = window.innerWidth - pos.x - VIEWPORT_MARGIN;
      const vh = window.innerHeight - pos.y - VIEWPORT_MARGIN;
      const w = Math.max(MIN_W, Math.min(vw, startSize.w + (ev.clientX - startX)));
      const h = Math.max(MIN_H, Math.min(vh, startSize.h + (ev.clientY - startY)));
      setSize({ w, h });
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      setSize((s) => { writeJson(sizeKey, s); return s; });
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'nwse-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [pos, size, sizeKey, maximized]);

  const handleMinimize = useCallback(() => {
    setCollapsed(true);
    writeJson(collapsedKey, true);
  }, [collapsedKey]);

  const handleExpand = useCallback(() => {
    setCollapsed(false);
    writeJson(collapsedKey, false);
  }, [collapsedKey]);

  const handleToggleMaximize = useCallback(() => {
    setMaximized((m) => {
      if (!m) {
        restoreRef.current = { pos, size };
        return true;
      }
      const prev = restoreRef.current;
      if (prev) {
        setPos(prev.pos);
        setSize(prev.size);
      }
      restoreRef.current = null;
      return false;
    });
  }, [pos, size]);

  if (typeof document === 'undefined') return null;

  if (collapsed) {
    return createPortal(
      <Tooltip label={label} description="Open this floating session" placement="left">
        <button
          ref={(el) => { rootRef.current = el; }}
          type="button"
          className={styles.collapsed}
          style={{ left: pos.x, top: pos.y, width: COLLAPSED_W, height: COLLAPSED_H }}
          onMouseDown={handleDragStart}
          onClick={(e) => {
            const moved = (e.currentTarget.dataset.moved === '1');
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
    ? { left: VIEWPORT_MARGIN, top: VIEWPORT_MARGIN, right: VIEWPORT_MARGIN, bottom: VIEWPORT_MARGIN, width: 'auto', height: 'auto' }
    : { left: pos.x, top: pos.y, width: size.w, height: size.h };

  return createPortal(
    <div
      ref={(el) => { rootRef.current = el; }}
      className={`${styles.panel}${maximized ? ` ${styles.maximized}` : ''}`}
      style={panelStyle}
    >
      <div className={styles.header} onMouseDown={handleDragStart}>
        <span className={styles.titleIcon} aria-hidden>⤴</span>
        <span className={styles.title}>{label}</span>
        <div className={styles.headerBtns}>
          <Tooltip label="Minimize to icon" placement="bottom">
            <button type="button" className={styles.headerBtn} onClick={handleMinimize} aria-label="Minimize">▁</button>
          </Tooltip>
          <Tooltip label={maximized ? 'Restore size' : 'Maximize'} placement="bottom">
            <button type="button" className={styles.headerBtn} onClick={handleToggleMaximize} aria-label={maximized ? 'Restore' : 'Maximize'}>
              {maximized ? '❐' : '☐'}
            </button>
          </Tooltip>
          <Tooltip {...tooltips.floatTerminalClose} placement="bottom">
            <button type="button" className={styles.headerBtn} onClick={onClose} aria-label="Close floating terminal">✕</button>
          </Tooltip>
        </div>
      </div>
      <div className={styles.body}>
        <TerminalContainer
          terminalId={terminalId}
          ws={ws}
          showReconnect={false}
        />
      </div>
      {!maximized && (
        <div
          className={styles.resize}
          onMouseDown={handleResizeStart}
          aria-hidden
        >
          <span className={styles.resizeGrip} aria-hidden />
        </div>
      )}
    </div>,
    document.body,
  );
}
