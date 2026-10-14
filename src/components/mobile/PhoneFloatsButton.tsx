/**
 * PhoneFloatsButton — brings a hidden AI popup back on a phone (AASC-20). Sits
 * in the session header beside ⋯ while the session has popups running; tapping
 * it shows the newest in the full-height sheet (PhoneFloatingSheet), where the
 * others are one tap away. Absent when there are none.
 */
import { useShallow } from 'zustand/react/shallow';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { SparkIcon } from './phoneIcons';
import phone from '@/styles/modules/PhoneSession.module.css';
import styles from '@/styles/modules/PhoneExtras.module.css';

export default function PhoneFloatsButton({ sessionId }: { sessionId: string }) {
  const floats = useFloatingSessionsStore(useShallow((s) => s.floats.filter((f) => f.originSessionId === sessionId)));
  const setShown = useFloatingSessionsStore((s) => s.setPhoneShown);
  if (floats.length === 0) return null;
  const newest = floats[floats.length - 1];
  const count = floats.length;
  return (
    <button
      type="button"
      className={`${phone.iconBtn} ${styles.floatsBtn}`}
      onClick={() => setShown(newest.terminalId)}
      aria-label={`AI popups: ${count} running. Show`}
      aria-haspopup="dialog"
    >
      <SparkIcon />
      <span className={styles.floatsCount} aria-hidden="true">{count}</span>
    </button>
  );
}
