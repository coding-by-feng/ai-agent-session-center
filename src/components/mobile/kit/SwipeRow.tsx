/**
 * SwipeRow — swipe a row left to reveal its actions (AASC-38): Mute, More,
 * Delete.
 *
 * The gesture decides its axis after 8px: sideways drags the row, up/down is
 * left to the list's scroll (`touch-action: pan-y`). Released past half the
 * actions' width it stays open; a tap on the row then closes it instead of
 * opening the row. The offset is written to a CSS variable, not state, so a drag
 * doesn't re-render the row.
 *
 * A swipe is never the only way: the same actions must also be on the row's
 * ContextMenu (long press), which is what a screen reader or keyboard uses. The
 * revealed buttons are out of the Tab order and hidden from assistive tech
 * while the row is closed.
 */
import { useCallback, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import styles from '@/styles/modules/mobile/SwipeRow.module.css';

export interface SwipeAction {
  id: string;
  label: string;
  icon?: ReactNode;
  tone?: 'neutral' | 'accent' | 'destructive';
  onAction: () => void;
}

export interface SwipeRowProps {
  actions: ReadonlyArray<SwipeAction>;
  children: ReactNode;
}

export const SWIPE_ACTION_WIDTH = 80;
const AXIS_LOCK_PX = 8;

export default function SwipeRow({ actions, children }: SwipeRowProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const width = actions.length * SWIPE_ACTION_WIDTH;
  const drag = useRef<{ x: number; y: number; base: number; axis: 'x' | 'y' | null; offset: number; pointer: number } | null>(null);
  const swallowClick = useRef(false);

  const writeOffset = (px: number | null) => {
    const el = contentRef.current;
    if (!el) return;
    if (px === null) {
      el.style.removeProperty('--swipe-x');
      delete el.dataset.dragging;
    } else {
      el.style.setProperty('--swipe-x', `${Math.round(px)}px`);
      el.dataset.dragging = '';
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    swallowClick.current = false;
    drag.current = { x: e.clientX, y: e.clientY, base: open ? -width : 0, axis: null, offset: open ? -width : 0, pointer: e.pointerId };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.axis) {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      d.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (d.axis === 'x') e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    if (d.axis !== 'x') return;
    // Past the actions it resists; it never moves right of closed.
    const raw = d.base + dx;
    d.offset = raw < -width ? -width + (raw + width) / 3 : Math.min(0, raw);
    writeOffset(d.offset);
  };

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    writeOffset(null);
    if (d.axis !== 'x' || e.type === 'pointercancel') return;
    swallowClick.current = true;
    setOpen(d.offset < -width / 2);
  };

  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (swallowClick.current || open) {
      e.preventDefault();
      e.stopPropagation();
      if (!swallowClick.current) setOpen(false);
    }
    swallowClick.current = false;
  };

  const run = useCallback((action: SwipeAction) => {
    setOpen(false);
    action.onAction();
  }, []);

  return (
    <div className={styles.swipeRow} data-open={open ? '' : undefined} data-count={Math.min(actions.length, 4)}>
      <div className={styles.actions} aria-hidden={!open}>
        {actions.map((a) => (
          <button
            key={a.id}
            type="button"
            className={styles.action}
            data-tone={a.tone ?? 'neutral'}
            tabIndex={open ? 0 : -1}
            onClick={() => run(a)}
          >
            {a.icon}
            <span>{a.label}</span>
          </button>
        ))}
      </div>
      <div
        ref={contentRef}
        className={styles.content}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={onClickCapture}
      >
        {children}
      </div>
    </div>
  );
}
