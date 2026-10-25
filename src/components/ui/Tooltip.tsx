/**
 * Tooltip — themed hover/focus tooltip with optional description + shortcut.
 *
 * Usage:
 *   <Tooltip label="Refresh" description="Re-scan the file tree." shortcut="⌘R">
 *     <button onClick={refresh}>↻</button>
 *   </Tooltip>
 *
 * `content` takes a small React body (rows, a bar) for a tooltip that has more
 * to say than a sentence; the caller styles it. It is measured like the rest, so
 * the viewport flip / clamp below applies to it unchanged.
 *
 * The wrapper renders a span with hover/focus listeners. The tooltip itself
 * is rendered into document.body via portal so it never gets clipped by
 * scroll containers, overflow:hidden parents, or stacking contexts.
 *
 * Positioning: prefers `placement` (default 'top'), but flips to the opposite
 * side if the preferred side would clip the viewport.
 *
 * Touch (AASC-20): a finger has no hover, so a tap never opens the tooltip (the
 * mouse events and focus a tap emulates are ignored) and a long press does: 500
 * ms without moving more than 10 px, the same gesture as the phone's other long
 * presses. The click that may end that press is swallowed, so holding a button
 * to read its name does not also press it. The tooltip then closes on the next
 * touch anywhere, on scroll, or after a few seconds.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import styles from '@/styles/modules/Tooltip.module.css';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  /** Required short title — first line, bold. */
  label: string;
  /** Optional 1–2 sentence guideline shown under the label. */
  description?: string;
  /** Optional keyboard shortcut hint, e.g. "⌘K" or "Ctrl+B". */
  shortcut?: string;
  /** Optional rich body under the label / description. Styled by the caller. */
  content?: ReactNode;
  /** Preferred side; flips automatically when clipped. */
  placement?: TooltipPlacement;
  /** Hover delay in ms before showing. Default 350. */
  delay?: number;
  /** Wrapped trigger element (button / icon / span). */
  children: ReactNode;
  /** Disable the tooltip without removing the wrapper. */
  disabled?: boolean;
  /** Extra class on the wrapper span: a trigger that is a flex or grid item
   *  (a strip card) needs the wrapper to take its slot, not shrink to it. */
  triggerClassName?: string;
  /** 360px instead of 280px, for a `content` list (the strip's prompt peek). */
  wide?: boolean;
}

const VIEWPORT_PAD = 8;
const GAP = 8;

/** A long press: held this long, moving no further than this (the phone's other long presses agree). */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;
/** After a touch, the browser's emulated mouseenter and focus are ignored for this long. */
const TOUCH_GHOST_MS = 800;
/** A tooltip a long press opened closes by itself after this long. */
const TOUCH_SHOW_MS = 4000;

interface Pos { left: number; top: number; placement: TooltipPlacement }

function computePosition(
  trigger: DOMRect,
  tooltip: DOMRect,
  preferred: TooltipPlacement,
): Pos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const fits = (p: TooltipPlacement): boolean => {
    if (p === 'top')    return trigger.top - tooltip.height - GAP >= VIEWPORT_PAD;
    if (p === 'bottom') return trigger.bottom + tooltip.height + GAP <= vh - VIEWPORT_PAD;
    if (p === 'left')   return trigger.left - tooltip.width - GAP >= VIEWPORT_PAD;
    return trigger.right + tooltip.width + GAP <= vw - VIEWPORT_PAD;
  };

  // Pick first side that fits, in this order: preferred, opposite, then perpendicular.
  const opposite: Record<TooltipPlacement, TooltipPlacement> = {
    top: 'bottom', bottom: 'top', left: 'right', right: 'left',
  };
  const perpendicular: Record<TooltipPlacement, TooltipPlacement[]> = {
    top: ['right', 'left'],
    bottom: ['right', 'left'],
    left: ['top', 'bottom'],
    right: ['top', 'bottom'],
  };
  const order: TooltipPlacement[] = [preferred, opposite[preferred], ...perpendicular[preferred]];
  const placement = order.find(fits) ?? preferred;

  let left = 0;
  let top = 0;
  if (placement === 'top') {
    left = trigger.left + trigger.width / 2 - tooltip.width / 2;
    top = trigger.top - tooltip.height - GAP;
  } else if (placement === 'bottom') {
    left = trigger.left + trigger.width / 2 - tooltip.width / 2;
    top = trigger.bottom + GAP;
  } else if (placement === 'left') {
    left = trigger.left - tooltip.width - GAP;
    top = trigger.top + trigger.height / 2 - tooltip.height / 2;
  } else {
    left = trigger.right + GAP;
    top = trigger.top + trigger.height / 2 - tooltip.height / 2;
  }

  // Clamp into viewport.
  left = Math.max(VIEWPORT_PAD, Math.min(vw - tooltip.width - VIEWPORT_PAD, left));
  top = Math.max(VIEWPORT_PAD, Math.min(vh - tooltip.height - VIEWPORT_PAD, top));

  return { left, top, placement };
}

export default function Tooltip({
  label,
  description,
  shortcut,
  content,
  placement = 'top',
  delay = 350,
  children,
  disabled = false,
  triggerClassName,
  wide = false,
}: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos>({ left: -9999, top: -9999, placement });

  // Touch: the pending long press, where it started, when a finger last
  // touched, whether the next click ends a long press, and whether the open
  // tooltip came from one.
  const pressRef = useRef<{ timer: number; x: number; y: number } | null>(null);
  const lastTouchRef = useRef(0);
  const swallowClickRef = useRef(false);
  const touchOpenRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearPress = useCallback(() => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  }, []);

  const show = useCallback(() => {
    if (disabled) return;
    // The mouseenter and focus a tap emulates: a finger opens by long press only.
    if (Date.now() - lastTouchRef.current < TOUCH_GHOST_MS) return;
    clearTimer();
    timerRef.current = window.setTimeout(() => setOpen(true), delay);
  }, [disabled, delay, clearTimer]);

  const hide = useCallback(() => {
    clearTimer();
    touchOpenRef.current = false;
    setOpen(false);
  }, [clearTimer]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    lastTouchRef.current = Date.now();
    swallowClickRef.current = false;
    clearPress();
    if (disabled) return;
    const timer = window.setTimeout(() => {
      pressRef.current = null;
      swallowClickRef.current = true;
      touchOpenRef.current = true;
      clearTimer();
      setOpen(true);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        touchOpenRef.current = false;
        setOpen(false);
      }, TOUCH_SHOW_MS);
    }, LONG_PRESS_MS);
    pressRef.current = { timer, x: e.clientX, y: e.clientY };
  }, [disabled, clearPress, clearTimer]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const press = pressRef.current;
    if (!press || e.pointerType !== 'touch') return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_SLOP_PX) clearPress();
  }, [clearPress]);

  const onPointerEnd = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    lastTouchRef.current = Date.now();
    clearPress();
  }, [clearPress]);

  // The click that ends a long press is not a press of the button.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!swallowClickRef.current) return;
    swallowClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // Android opens its context menu on a long press.
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    if (pressRef.current || touchOpenRef.current) e.preventDefault();
  }, []);

  // Recompute position whenever the tooltip becomes visible or its content changes.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current?.getBoundingClientRect();
    const tooltip = tooltipRef.current?.getBoundingClientRect();
    if (!trigger || !tooltip) return;
    setPos(computePosition(trigger, tooltip, placement));
  }, [open, label, description, shortcut, content, placement]);

  // Hide on scroll, resize, or Escape — and a long-press tooltip on the next
  // touch anywhere (a finger has no mouseleave).
  useEffect(() => {
    if (!open) return;
    const onScroll = () => hide();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    const onTouchDown = (e: PointerEvent) => {
      if (touchOpenRef.current && e.pointerType === 'touch') hide();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onTouchDown, true);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onTouchDown, true);
    };
  }, [open, hide]);

  // Cleanup pending timers on unmount.
  useEffect(() => () => {
    clearTimer();
    clearPress();
  }, [clearTimer, clearPress]);

  return (
    <>
      <span
        ref={triggerRef}
        className={triggerClassName ? `${styles.trigger} ${triggerClassName}` : styles.trigger}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={onClickCapture}
        onContextMenu={onContextMenu}
        aria-describedby={open ? id : undefined}
      >
        {children}
      </span>
      {open && createPortal(
        <div
          ref={tooltipRef}
          id={id}
          role="tooltip"
          className={`${styles.tooltip}${wide ? ` ${styles.tooltipWide}` : ''} ${styles[`placement_${pos.placement}`]}`}
          style={{ left: pos.left, top: pos.top }}
        >
          <div className={styles.label}>{label}</div>
          {description && <div className={styles.description}>{description}</div>}
          {content}
          {shortcut && <div className={styles.shortcut}><kbd>{shortcut}</kbd></div>}
          <span className={styles.arrow} aria-hidden />
        </div>,
        document.body,
      )}
    </>
  );
}
