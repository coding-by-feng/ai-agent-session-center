/**
 * FloatingProjectPanel — picture-in-picture style overlay for the PROJECT tab.
 *
 * Two states:
 *  - expanded: full draggable window with title bar (minimize / close buttons)
 *  - collapsed: small draggable pill button, click to re-expand
 *
 * Position, size, and collapsed state are persisted per-session in localStorage.
 * The panel is positioned absolutely inside its containing element (must be
 * position: relative). Drag is bounded to the parent's client rect.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import styles from '@/styles/modules/DetailPanel.module.css';
import Tooltip from '@/components/ui/Tooltip';
import { tooltips } from '@/lib/tooltips';

const FLOAT_POS_KEY = 'float-project-pos';
const FLOAT_SIZE_KEY = 'float-project-size';
const FLOAT_COLLAPSED_KEY = 'float-project-collapsed';

const DEFAULT_SIZE = { w: 520, h: 420 };
const DEFAULT_POS = { x: 24, y: 24 };
const COLLAPSED_W = 132;
const COLLAPSED_H = 36;
const MIN_W = 320;
const MIN_H = 220;

interface Pos { x: number; y: number }
interface Size { w: number; h: number }

interface FloatingProjectPanelProps {
  /** Receives the body container element so the parent can portal content into it. */
  bodyRef: (el: HTMLDivElement | null) => void;
  sessionId?: string;
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

function clampPos(pos: Pos, size: Size, parent: HTMLElement | null): Pos {
  if (!parent) return pos;
  const rect = parent.getBoundingClientRect();
  const maxX = Math.max(0, rect.width - size.w);
  const maxY = Math.max(0, rect.height - size.h);
  return {
    x: Math.max(0, Math.min(maxX, pos.x)),
    y: Math.max(0, Math.min(maxY, pos.y)),
  };
}

export default function FloatingProjectPanel({
  bodyRef,
  sessionId,
  onClose,
}: FloatingProjectPanelProps) {
  const posKey = sessionId ? `${FLOAT_POS_KEY}:${sessionId}` : FLOAT_POS_KEY;
  const sizeKey = sessionId ? `${FLOAT_SIZE_KEY}:${sessionId}` : FLOAT_SIZE_KEY;
  const collapsedKey = sessionId ? `${FLOAT_COLLAPSED_KEY}:${sessionId}` : FLOAT_COLLAPSED_KEY;

  const [collapsed, setCollapsed] = useState<boolean>(() =>
    readJson<boolean>(collapsedKey, false));
  const [pos, setPos] = useState<Pos>(() => readJson<Pos>(posKey, DEFAULT_POS));
  const [size, setSize] = useState<Size>(() => readJson<Size>(sizeKey, DEFAULT_SIZE));
  const [maximized, setMaximized] = useState<boolean>(false);
  const restoreRef = useRef<{ pos: Pos; size: Size } | null>(null);

  // Restore per-session state when sessionId changes.
  useEffect(() => {
    setCollapsed(readJson<boolean>(collapsedKey, false));
    setPos(readJson<Pos>(posKey, DEFAULT_POS));
    setSize(readJson<Size>(sizeKey, DEFAULT_SIZE));
    setMaximized(false);
    restoreRef.current = null;
  }, [collapsedKey, posKey, sizeKey]);

  const rootRef = useRef<HTMLElement | null>(null);
  const parentRef = useRef<HTMLElement | null>(null);

  // Capture the offsetParent once mounted (the .tabContent container).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    parentRef.current = el.offsetParent as HTMLElement | null;
  }, [collapsed]);

  // Re-clamp position when the parent resizes (window resize, panel resize).
  useEffect(() => {
    const parent = parentRef.current;
    if (!parent || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const currentSize = collapsed ? { w: COLLAPSED_W, h: COLLAPSED_H } : size;
      setPos((p) => clampPos(p, currentSize, parent));
    });
    ro.observe(parent);
    return () => ro.disconnect();
  }, [collapsed, size]);

  // ---- Drag (header / collapsed icon) ----
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    // Ignore drags initiated on buttons *inside* the header (close/min/max),
    // but not on the root button itself when collapsed.
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

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (collapsed && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        root.dataset.moved = '1';
      }
      const next = clampPos(
        { x: startPos.x + dx, y: startPos.y + dy },
        currentSize,
        parentRef.current,
      );
      setPos(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      // Persist final position
      setPos((p) => { writeJson(posKey, p); return p; });
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [pos, size, collapsed, posKey, maximized]);

  // ---- Resize (bottom-right corner) ----
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    if (maximized) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = size;
    const parent = parentRef.current;
    const parentRect = parent?.getBoundingClientRect();

    const onMove = (ev: MouseEvent) => {
      const maxW = parentRect ? parentRect.width - pos.x : Infinity;
      const maxH = parentRect ? parentRect.height - pos.y : Infinity;
      const w = Math.max(MIN_W, Math.min(maxW, startSize.w + (ev.clientX - startX)));
      const h = Math.max(MIN_H, Math.min(maxH, startSize.h + (ev.clientY - startY)));
      setSize({ w, h });
    };
    const onUp = () => {
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

  // ---- Render ----
  if (collapsed) {
    return (
      <Tooltip {...tooltips.floatExpand} placement="left">
        <button
          ref={(el) => { rootRef.current = el; }}
          type="button"
          className={styles.floatCollapsed}
          style={{ left: pos.x, top: pos.y, width: COLLAPSED_W, height: COLLAPSED_H }}
          onMouseDown={handleDragStart}
          onClick={(e) => {
            // Avoid expand-on-click after a drag — only expand if no movement
            // happened. We use a simple distance check via dataset.
            const moved = (e.currentTarget.dataset.moved === '1');
            e.currentTarget.dataset.moved = '0';
            if (!moved) handleExpand();
          }}
          aria-label={tooltips.floatExpand.label}
        >
          <span className={styles.floatCollapsedIcon}>▣</span>
          <span className={styles.floatCollapsedLabel}>PROJECT</span>
          <span className={styles.floatCollapsedExpand} aria-hidden>⤢</span>
        </button>
      </Tooltip>
    );
  }

  const panelStyle: React.CSSProperties = maximized
    ? { left: 0, top: 0, right: 0, bottom: 0, width: 'auto', height: 'auto' }
    : { left: pos.x, top: pos.y, width: size.w, height: size.h };
  const maxTip = maximized ? tooltips.floatRestore : tooltips.floatMaximize;

  return (
    <div
      ref={(el) => { rootRef.current = el; }}
      className={`${styles.floatPanel}${maximized ? ` ${styles.floatPanelMaximized}` : ''}`}
      style={panelStyle}
    >
      <div className={styles.floatHeader} onMouseDown={handleDragStart}>
        <span className={styles.floatTitle}>PROJECT</span>
        <div className={styles.floatHeaderBtns}>
          <Tooltip {...tooltips.floatMinimize} placement="bottom">
            <button
              type="button"
              className={styles.floatHeaderBtn}
              onClick={handleMinimize}
              aria-label={tooltips.floatMinimize.label}
            >
              ▁
            </button>
          </Tooltip>
          <Tooltip {...maxTip} placement="bottom">
            <button
              type="button"
              className={styles.floatHeaderBtn}
              onClick={handleToggleMaximize}
              aria-label={maxTip.label}
            >
              {maximized ? '❐' : '☐'}
            </button>
          </Tooltip>
          <Tooltip {...tooltips.floatClose} placement="bottom">
            <button
              type="button"
              className={styles.floatHeaderBtn}
              onClick={onClose}
              aria-label={tooltips.floatClose.label}
            >
              ✕
            </button>
          </Tooltip>
        </div>
      </div>
      <div className={styles.floatBody} ref={bodyRef} />
      {!maximized && (
        <div
          className={styles.floatResize}
          onMouseDown={handleResizeStart}
          title="Drag to resize"
          aria-hidden
        >
          <span className={styles.floatResizeGrip} aria-hidden />
        </div>
      )}
    </div>
  );
}
