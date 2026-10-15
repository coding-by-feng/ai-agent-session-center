/**
 * Sheet — the phone kit's bottom sheet (AASC-38): actions, pickers, short forms.
 *
 *   detents  'fit' (as tall as its content), 'medium' (half the screen),
 *            'large' (all but the status bar). Drag the grabber or header up to
 *            grow to the next detent, down to shrink or close; a fast flick
 *            down closes. The close button, Escape and a tap on the backdrop
 *            close it too: the drag is never the only way.
 *
 * Portaled to <body> in the 10000+ band (no scroller or transformed ancestor can
 * clip it); <body> carries `phoneApp` while the frame is up, so the sheet wears
 * the phone tokens. Focus moves in on open, is trapped while open (only the
 * topmost sheet answers Escape and Tab), and returns to the opener on close.
 * Give it a stable `onClose`: its focus handling re-runs when that changes.
 */
import { useCallback, useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from './kitIcons';
import { nextDetent, type SheetDetent } from './sheetDetents';
import styles from '@/styles/modules/mobile/Sheet.module.css';

export type { SheetDetent } from './sheetDetents';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** The detents it may rest at, smallest first. Default: medium and large. */
  detents?: readonly SheetDetent[];
  /** Where it opens. Default: the first detent. */
  initialDetent?: SheetDetent;
  /** Pinned under the content (the sheet's main action). */
  footer?: ReactNode;
  /** Keep the title for screen readers only. */
  hideTitle?: boolean;
  testId?: string;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open sheets, oldest first: only the topmost answers Escape and traps Tab. */
const openSheets: HTMLElement[] = [];

export default function Sheet({
  open,
  onClose,
  title,
  children,
  detents = ['medium', 'large'],
  initialDetent,
  footer,
  hideTitle,
  testId,
}: SheetProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [detent, setDetent] = useState<SheetDetent>(initialDetent ?? detents[0]);
  // Each opening starts at the initial detent (state adjusted during render, not in an effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDetent(initialDetent ?? detents[0]);
  }
  const drag = useRef<{ startY: number; lastY: number; lastT: number; velocity: number; pointer: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () => Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    // The content's first control (a confirm's Cancel, a list's first row), else the close button.
    const firstInBody = panel?.querySelector<HTMLElement>(`[data-sheet-body] :is(${FOCUSABLE})`);
    (firstInBody ?? focusables()[0] ?? panel)?.focus();
    if (panel) openSheets.push(panel);

    function onKey(e: KeyboardEvent) {
      if (panel && openSheets[openSheets.length - 1] !== panel) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const at = panel ? openSheets.indexOf(panel) : -1;
      if (at !== -1) openSheets.splice(at, 1);
      opener?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if ((e.target as HTMLElement).closest('button')) return; // the close button is a tap, not a drag
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, velocity: 0, pointer: e.pointerId };
  }, []);

  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const dt = Math.max(1, e.timeStamp - d.lastT);
    d.velocity = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    const dy = e.clientY - d.startY;
    // Down follows the finger; up resists (it grows by detent, not by pixel).
    // Written to the DOM, not state: no re-render per move.
    const panel = panelRef.current;
    if (!panel) return;
    panel.dataset.dragging = '';
    panel.style.setProperty('--sheet-drag', `${Math.round(dy > 0 ? dy : dy / 3)}px`);
  }, []);

  const onPointerEnd = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    const panel = panelRef.current;
    if (panel) {
      delete panel.dataset.dragging;
      panel.style.removeProperty('--sheet-drag');
    }
    // A cancelled pointer (the system took the gesture) springs back; it never closes.
    if (e.type === 'pointercancel') return;
    const next = nextDetent(detents, detent, e.clientY - d.startY, d.velocity);
    if (next === 'close') onClose();
    else if (next !== detent) setDetent(next);
  }, [detents, detent, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className={styles.backdrop}
      data-testid={testId ? `${testId}-backdrop` : 'kit-sheet-backdrop'}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={styles.sheet}
        data-detent={detent}
        data-testid={testId}
      >
        <div
          className={styles.handle}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <span className={styles.grabber} aria-hidden="true" />
          <div className={styles.header}>
            <h2 id={titleId} className={`${styles.title}${hideTitle ? ` ${styles.srOnly}` : ''}`}>{title}</h2>
            <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className={styles.body} data-sheet-body="">{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
