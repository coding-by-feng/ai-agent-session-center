/**
 * Tooltip — themed hover/focus tooltip with optional description + shortcut.
 *
 * Usage:
 *   <Tooltip label="Refresh" description="Re-scan the file tree." shortcut="⌘R">
 *     <button onClick={refresh}>↻</button>
 *   </Tooltip>
 *
 * The wrapper renders a span with hover/focus listeners. The tooltip itself
 * is rendered into document.body via portal so it never gets clipped by
 * scroll containers, overflow:hidden parents, or stacking contexts.
 *
 * Positioning: prefers `placement` (default 'top'), but flips to the opposite
 * side if the preferred side would clip the viewport.
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
  /** Preferred side; flips automatically when clipped. */
  placement?: TooltipPlacement;
  /** Hover delay in ms before showing. Default 350. */
  delay?: number;
  /** Wrapped trigger element (button / icon / span). */
  children: ReactNode;
  /** Disable the tooltip without removing the wrapper. */
  disabled?: boolean;
}

const VIEWPORT_PAD = 8;
const GAP = 8;

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
  placement = 'top',
  delay = 350,
  children,
  disabled = false,
}: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos>({ left: -9999, top: -9999, placement });

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const show = useCallback(() => {
    if (disabled) return;
    clearTimer();
    timerRef.current = window.setTimeout(() => setOpen(true), delay);
  }, [disabled, delay, clearTimer]);

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  // Recompute position whenever the tooltip becomes visible or its content changes.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current?.getBoundingClientRect();
    const tooltip = tooltipRef.current?.getBoundingClientRect();
    if (!trigger || !tooltip) return;
    setPos(computePosition(trigger, tooltip, placement));
  }, [open, label, description, shortcut, placement]);

  // Hide on scroll, resize, or Escape.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => hide();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, hide]);

  // Cleanup pending timer on unmount.
  useEffect(() => () => clearTimer(), [clearTimer]);

  return (
    <>
      <span
        ref={triggerRef}
        className={styles.trigger}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-describedby={open ? id : undefined}
      >
        {children}
      </span>
      {open && createPortal(
        <div
          ref={tooltipRef}
          id={id}
          role="tooltip"
          className={`${styles.tooltip} ${styles[`placement_${pos.placement}`]}`}
          style={{ left: pos.left, top: pos.top }}
        >
          <div className={styles.label}>{label}</div>
          {description && <div className={styles.description}>{description}</div>}
          {shortcut && <div className={styles.shortcut}><kbd>{shortcut}</kbd></div>}
          <span className={styles.arrow} aria-hidden />
        </div>,
        document.body,
      )}
    </>
  );
}
