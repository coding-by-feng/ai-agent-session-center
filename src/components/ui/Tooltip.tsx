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
 * side if the preferred side would clip the viewport. It is placed by its layout
 * size (the fade-in draws it at 96% at first), and its arrow stays on the trigger
 * when the viewport pushes it along.
 *
 * Touch (AASC-20): a finger has no hover, so a tap never opens the tooltip (the
 * mouse events and focus a tap emulates are ignored) and a long press does: 500
 * ms without moving more than 10 px, the same gesture as the phone's other long
 * presses. The click that may end that press is swallowed, so holding a button
 * to read its name does not also press it. The tooltip then closes on the next
 * touch anywhere, on scroll, or after a few seconds.
 *
 * Interactive (Oct 29 2026, the session prompt peek): the pointer may move into the
 * tooltip, so it never covers its trigger: it takes the first side with room enough,
 * capped to the room there, and its body scrolls the rest (never past the window).
 * Leaving the trigger waits `INTERACTIVE_GRACE_MS` so the pointer can cross the gap;
 * a scroll inside it, or in a scroller that does not hold the trigger (a terminal
 * printing), and a click into it do not close it. A portal still bubbles React events
 * to the trigger's ancestors (the header name renames on a double-click), so it keeps
 * its clicks to itself; a press still reaches the page's click-outside listeners.
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
  /** 480px instead of 280px, for a `content` list (the strip's prompt peek). */
  wide?: boolean;
  /** The pointer may move into the tooltip to scroll a body taller than the window. */
  interactive?: boolean;
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
/** An interactive tooltip closes this long after the pointer leaves the trigger or the tooltip. */
const INTERACTIVE_GRACE_MS = 150;

/** The arrow keeps this far from the tooltip's ends (its half width and the rounded corner). */
const ARROW_INSET = 10;
/** An interactive tooltip takes a side that leaves it at least this tall (top/bottom) or wide (left/right). */
const MIN_FIT_HEIGHT = 160;
const MIN_FIT_WIDTH = 280;

/** A portal bubbles React events to the trigger's ancestors: an interactive tooltip keeps its clicks. */
const keepToTooltip = (e: React.SyntheticEvent) => e.stopPropagation();

interface Size { width: number; height: number }

interface Pos {
  left: number;
  top: number;
  placement: TooltipPlacement;
  /** Where the arrow sits along its edge (px from the tooltip's left or top). */
  arrow?: number;
  /** The room an interactive tooltip is capped to on its side (px): a height above or
   *  below its trigger, a width (`--tooltip-room`) beside it. */
  maxHeight?: number;
  maxWidth?: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const isVertical = (p: TooltipPlacement) => p === 'top' || p === 'bottom';

/**
 * Where an interactive tooltip goes: never over its trigger, since the pointer may move into
 * it. The first side in `order` with room enough, else the roomiest, capped to the room there
 * (its body scrolls the rest); never taller than the window, as `.tooltipInteractive` says.
 */
function fitInteractive(trigger: DOMRect, tooltip: Size, order: TooltipPlacement[]) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const room = (p: TooltipPlacement) => {
    if (p === 'top') return trigger.top - GAP - VIEWPORT_PAD;
    if (p === 'bottom') return vh - VIEWPORT_PAD - trigger.bottom - GAP;
    if (p === 'left') return trigger.left - GAP - VIEWPORT_PAD;
    return vw - VIEWPORT_PAD - trigger.right - GAP;
  };
  const height = Math.min(tooltip.height, vh - 2 * VIEWPORT_PAD);
  const enough = (p: TooltipPlacement) =>
    room(p) >= (isVertical(p) ? Math.min(height, MIN_FIT_HEIGHT) : Math.min(tooltip.width, MIN_FIT_WIDTH));
  const placement = order.find(enough) ?? order.reduce((best, p) => (room(p) > room(best) ? p : best));
  const cap = Math.max(0, Math.floor(room(placement)));
  return isVertical(placement)
    ? { placement, size: { width: tooltip.width, height: Math.min(height, cap) }, maxHeight: cap }
    : { placement, size: { width: Math.min(tooltip.width, cap), height }, maxWidth: cap };
}

function computePosition(
  trigger: DOMRect,
  tooltip: Size,
  preferred: TooltipPlacement,
  interactive = false,
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
  const fit = interactive ? fitInteractive(trigger, tooltip, order) : undefined;
  const placement = fit?.placement ?? order.find(fits) ?? preferred;
  const size = fit?.size ?? tooltip;

  let left = 0;
  let top = 0;
  if (placement === 'top') {
    left = trigger.left + trigger.width / 2 - size.width / 2;
    top = trigger.top - size.height - GAP;
  } else if (placement === 'bottom') {
    left = trigger.left + trigger.width / 2 - size.width / 2;
    top = trigger.bottom + GAP;
  } else if (placement === 'left') {
    left = trigger.left - size.width - GAP;
    top = trigger.top + trigger.height / 2 - size.height / 2;
  } else {
    left = trigger.right + GAP;
    top = trigger.top + trigger.height / 2 - size.height / 2;
  }

  // Clamp into viewport.
  left = Math.max(VIEWPORT_PAD, Math.min(vw - size.width - VIEWPORT_PAD, left));
  top = Math.max(VIEWPORT_PAD, Math.min(vh - size.height - VIEWPORT_PAD, top));

  // The arrow on the trigger's centre, wherever the clamp left the tooltip.
  const arrow = isVertical(placement)
    ? clamp(trigger.left + trigger.width / 2 - left, ARROW_INSET, size.width - ARROW_INSET)
    : clamp(trigger.top + trigger.height / 2 - top, ARROW_INSET, size.height - ARROW_INSET);

  return { left, top, placement, arrow, maxHeight: fit?.maxHeight, maxWidth: fit?.maxWidth };
}

/** The arrow's offset along the edge it sits on; before the first measure, the CSS's 50%. */
function arrowStyle({ placement, arrow }: Pos): React.CSSProperties | undefined {
  if (arrow === undefined) return undefined;
  return isVertical(placement) ? { left: arrow } : { top: arrow };
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
  interactive = false,
}: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
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

  // Closing forgets the room an interactive tooltip was capped to, or the next open
  // would measure it under that old cap.
  const close = useCallback(() => {
    touchOpenRef.current = false;
    setOpen(false);
    setPos((p) =>
      p.maxHeight === undefined && p.maxWidth === undefined ? p : { ...p, maxHeight: undefined, maxWidth: undefined },
    );
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    close();
  }, [clearTimer, close]);

  // Interactive: close a moment after the pointer leaves the trigger or the tooltip,
  // so it can cross the gap between them; arriving at either cancels it.
  const scheduleHide = useCallback(() => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      close();
    }, INTERACTIVE_GRACE_MS);
  }, [clearTimer, close]);

  // A click into an interactive tooltip takes the focus from the trigger: that is reading, not leaving.
  const onTriggerBlur = useCallback((e: React.FocusEvent) => {
    if (interactive && e.relatedTarget instanceof Node && tooltipRef.current?.contains(e.relatedTarget)) return;
    hide();
  }, [interactive, hide]);

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
        close();
      }, TOUCH_SHOW_MS);
    }, LONG_PRESS_MS);
    pressRef.current = { timer, x: e.clientX, y: e.clientY };
  }, [disabled, clearPress, clearTimer, close]);

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
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;
    // Its layout size: its rect is the fade-in's, scaled to 96% (`tooltipFadeIn`). An
    // interactive one's height is what its body asks for, not what a cap left it, and once
    // narrowed (`pos.maxWidth`) it is measured again with its lines rewrapped.
    const body = bodyRef.current;
    const size = {
      width: tooltip.offsetWidth,
      height: tooltip.offsetHeight + (body ? body.scrollHeight - body.clientHeight : 0),
    };
    setPos(computePosition(trigger, size, placement, interactive));
  }, [open, label, description, shortcut, content, placement, interactive, pos.maxWidth]);

  // Hide on scroll, resize, or Escape — and a long-press tooltip on the next
  // touch anywhere (a finger has no mouseleave).
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      // An interactive one closes only when its trigger may have moved: a scroll inside it is
      // someone reading it, and a scroller that does not hold the trigger (a terminal printing)
      // moves nothing it points at. A page scroll or a resize still closes it.
      const target = e.target;
      if (
        interactive && target instanceof Node && target !== document
        && (tooltipRef.current?.contains(target) || !target.contains(triggerRef.current))
      ) return;
      hide();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    const onTouchDown = (e: PointerEvent) => {
      if (!touchOpenRef.current || e.pointerType !== 'touch') return;
      // A finger reading an interactive one (scrolling it) keeps it, until a touch lands elsewhere.
      if (interactive && e.target instanceof Node && tooltipRef.current?.contains(e.target)) {
        clearTimer();
        return;
      }
      hide();
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
  }, [open, hide, interactive, clearTimer]);

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
        onMouseLeave={interactive && open ? scheduleHide : hide}
        onFocus={show}
        onBlur={onTriggerBlur}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={onClickCapture}
        onContextMenu={onContextMenu}
        aria-describedby={open ? (interactive ? `${id}-label${description ? ` ${id}-description` : ''}` : id) : undefined}
      >
        {children}
      </span>
      {open && createPortal(
        <div
          ref={tooltipRef}
          id={id}
          role="tooltip"
          className={`${styles.tooltip}${wide ? ` ${styles.tooltipWide}` : ''}${interactive ? ` ${styles.tooltipInteractive}` : ''} ${styles[`placement_${pos.placement}`]}`}
          style={{
            left: pos.left,
            top: pos.top,
            maxHeight: pos.maxHeight,
            '--tooltip-room': pos.maxWidth === undefined ? undefined : `${pos.maxWidth}px`,
          } as React.CSSProperties}
          {...(interactive
            ? {
                tabIndex: -1,
                onMouseEnter: clearTimer,
                onMouseLeave: scheduleHide,
                onClick: keepToTooltip,
                onDoubleClick: keepToTooltip,
                onContextMenu: keepToTooltip,
              }
            : {})}
        >
          {/* An interactive one's body can run to thousands of words: its label and description describe the trigger. */}
          <div id={interactive ? `${id}-label` : undefined} className={styles.label}>{label}</div>
          {description && <div id={interactive ? `${id}-description` : undefined} className={styles.description}>{description}</div>}
          {interactive && content != null ? <div ref={bodyRef} className={styles.body}>{content}</div> : content}
          {shortcut && <div className={styles.shortcut}><kbd>{shortcut}</kbd></div>}
          <span className={styles.arrow} style={arrowStyle(pos)} aria-hidden />
        </div>,
        document.body,
      )}
    </>
  );
}
