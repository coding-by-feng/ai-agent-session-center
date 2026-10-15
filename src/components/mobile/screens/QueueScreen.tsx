/**
 * QueueScreen — the Queue tab's root (AASC-39 placeholder; AASC-47 rebuilds it
 * with the kit). Today's phone queue view (`QueueView` on a phone: one column,
 * confirm before remove, move in a sheet) inside the new screen chrome.
 */
import { lazy } from 'react';
import { Screen } from '../kit';
import styles from '@/styles/modules/mobile/Screens.module.css';

const QueueView = lazy(() => import('@/routes/QueueView'));

export default function QueueScreen() {
  return (
    <Screen title="Queue" large scroll={false} testId="phone-queue">
      <p className={styles.note}>Your Mac sends queued prompts while AASC is open there.</p>
      <div className={styles.embedded}>
        <QueueView />
      </div>
    </Screen>
  );
}
