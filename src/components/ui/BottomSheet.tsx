/**
 * BottomSheet — the phone's dialog (AASC-18): a panel that rises from the
 * bottom edge, within thumb reach, above the home indicator.
 *
 * Controlled (`open` / `onClose`), unlike `Modal`, which is keyed to
 * `uiStore.activeModal`: a sheet is usually local to the control that opened it
 * (a kill button, a row's menu), and must not close an unrelated modal.
 *
 * Portaled to `<body>` in the 10000+ band, so a scroller or a transformed
 * ancestor (the detail panel, the terminal) can never clip it. Escape, a tap on
 * the backdrop and the close button all call `onClose`; focus moves in on open,
 * stays in while open, and returns to the opener on close.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Button from '@/components/ui/Button';
import { useBackLayer } from '@/lib/backLayers';
import styles from '@/styles/modules/BottomSheet.module.css';

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Hide the visible title (it still names the dialog for screen readers). */
  hideTitle?: boolean;
  /** Fill the screen height (a full-screen form) instead of fitting the content. */
  fullHeight?: boolean;
  /** A control beside the close button (a full-height sheet's main action, e.g. "End"). */
  headerAction?: ReactNode;
  /** The body runs edge to edge (a terminal's key bar needs the full width); the header keeps its gutter. */
  flush?: boolean;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The open sheets, oldest first. A sheet can open over another (a confirm over
 * the session drawer): only the top one answers Escape and traps Tab, or one
 * Escape would close both.
 */
const openSheets: HTMLElement[] = [];

export default function BottomSheet({ open, onClose, title, children, hideTitle, fullHeight, headerAction, flush }: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // In the phone app, Android's back closes the sheet, not the screen under it (AASC-48).
  useBackLayer(open, onClose);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () => Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter((el) => !(el as HTMLButtonElement).disabled);
    (focusables()[0] ?? panel)?.focus();
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
      opener?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className={styles.backdrop}
      data-testid="bottom-sheet-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`${styles.sheet}${fullHeight ? ` ${styles.full}` : ''}${flush ? ` ${styles.flush}` : ''}`}
      >
        <div className={styles.grabber} aria-hidden="true" />
        <div className={`${styles.header}${hideTitle ? ` ${styles.srOnly}` : ''}`}>
          <h2 id={titleId} className={styles.title}>{title}</h2>
          {!hideTitle && headerAction && <div className={styles.headerAction}>{headerAction}</div>}
          {!hideTitle && (
            <button type="button" className={styles.close} onClick={onClose} aria-label="Close">×</button>
          )}
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmSheetProps {
  open: boolean;
  title: string;
  /** What will happen, in the user's words. */
  message: ReactNode;
  confirmLabel: string;
  /** A destructive action (kill, delete, clear): the confirm button is red. */
  danger?: boolean;
  /** The action is running: the confirm button is disabled and says so. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirm a destructive action from a phone: the cancel button comes first, so a stray tap is safe. */
export function ConfirmSheet({ open, title, message, confirmLabel, danger, busy, onConfirm, onCancel }: ConfirmSheetProps) {
  return (
    <BottomSheet open={open} onClose={onCancel} title={title}>
      <div className={styles.message}>{message}</div>
      <div className={styles.actions}>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </div>
    </BottomSheet>
  );
}
