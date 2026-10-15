/**
 * ConfirmSheet — confirm a destructive action on the phone (AASC-38).
 *
 * The same props as today's `ConfirmSheet` (components/ui/BottomSheet.tsx), on
 * the kit's Sheet so it wears the phone palette: what will happen in the user's
 * words, then Cancel and the action, the red one last.
 */
import type { ReactNode } from 'react';
import Sheet from './Sheet';
import Button from './Button';
import styles from '@/styles/modules/mobile/ConfirmSheet.module.css';

export interface ConfirmSheetProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  /** Destructive (kill, delete, clear): the action is red. */
  danger?: boolean;
  /** The action is running: it shows a spinner and ignores taps. */
  busy?: boolean;
  onConfirm: () => void;
  /** Escape, the close button, the backdrop and Cancel all call it. */
  onCancel: () => void;
}

const FIT = ['fit'] as const;

export default function ConfirmSheet({ open, title, message, confirmLabel, danger, busy, onConfirm, onCancel }: ConfirmSheetProps) {
  return (
    <Sheet open={open} onClose={onCancel} title={title} detents={FIT} testId="confirm-sheet">
      <div className={styles.message}>{message}</div>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant={danger ? 'destructive' : 'primary'} onClick={onConfirm} loading={busy}>
          {confirmLabel}
        </Button>
      </div>
    </Sheet>
  );
}
