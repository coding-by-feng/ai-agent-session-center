/**
 * QueueMoveSheet — "Move to another session" on a phone (AASC-18).
 *
 * The desktop picker (`QueueMovePicker`) is a 200px dropdown hung off the MOVE
 * button, its rows ~26px tall. On a phone the same choice is a bottom sheet of
 * full-width rows at a finger's 44px, within thumb reach. Same targets, same
 * `onSelect`, so the queue's move logic is untouched.
 */
import BottomSheet from '@/components/ui/BottomSheet';
import type { QueueMoveTarget } from './QueueMovePicker';
import styles from '@/styles/modules/QueuePhone.module.css';

interface QueueMoveSheetProps {
  open: boolean;
  targets: QueueMoveTarget[];
  onSelect: (sessionId: string) => void;
  onClose: () => void;
}

export default function QueueMoveSheet({ open, targets, onSelect, onClose }: QueueMoveSheetProps) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Move to another session">
      {targets.length === 0 ? (
        <p className={styles.sheetNote}>There is no other session to move it to.</p>
      ) : (
        <ul className={styles.sheetList} aria-label="Sessions">
          {targets.map((t) => (
            <li key={t.id}>
              <button type="button" className={styles.sheetItem} onClick={() => onSelect(t.id)}>
                <span className={styles.sheetItemTitle}>{t.projectName || t.id.slice(0, 8)}</span>
                {t.title && <span className={styles.sheetItemSub}>{t.title}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </BottomSheet>
  );
}
