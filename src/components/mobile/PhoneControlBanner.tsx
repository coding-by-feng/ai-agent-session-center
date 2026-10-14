/**
 * PhoneControlBanner — the control baton above the phone's compose box (AASC-18).
 *
 * While another device drives the session, the phone's keystrokes are dropped by
 * the server (wsManager `holdsControl`, `/terminals/:id/write` 409 CONTROL_HELD),
 * so the compose box and keys are disabled and this says why, with the two ways
 * out: ask the driver to hand over, or take it once they have been idle a minute.
 * When this phone drives and another device asks for it, it offers the hand-over.
 *
 * Presentational: the state and actions come from `useControlBaton`, the same
 * hook behind the desktop's `SessionControlLock`.
 */
import type { ControlBaton } from '@/hooks/useControlBaton';
import styles from '@/styles/modules/PhoneSession.module.css';

export default function PhoneControlBanner({ baton }: { baton: ControlBaton }) {
  const { mode, holder, request, canTake, waitSecs } = baton;

  if (mode === 'spectator' && holder) {
    return (
      <section className={styles.banner} aria-label="Session control" aria-live="polite">
        <p className={styles.bannerText}>
          <span aria-hidden="true">🔒 </span>
          {holder.label} is driving this session
        </p>
        <p className={styles.bannerNote}>
          Typing is off on this phone until you have control.
          {!canTake && ` Take control opens after ${waitSecs}s of quiet on ${holder.label}.`}
        </p>
        <div className={styles.bannerActions}>
          <button type="button" className={styles.bannerBtn} onClick={() => void baton.ask()}>
            Ask for control
          </button>
          <button
            type="button"
            className={`${styles.bannerBtn} ${styles.bannerPrimary}`}
            onClick={() => void baton.take()}
            disabled={!canTake}
          >
            {canTake ? 'Take control' : `Take in ${waitSecs}s`}
          </button>
        </div>
      </section>
    );
  }

  if (mode === 'asked' && request) {
    return (
      <section className={`${styles.banner} ${styles.bannerAsked}`} aria-label="Session control" aria-live="polite">
        <p className={styles.bannerText}>
          <span aria-hidden="true">🙋 </span>
          {request.fromLabel} wants control of this session
        </p>
        <div className={styles.bannerActions}>
          <button type="button" className={styles.bannerBtn} onClick={baton.dismiss}>
            Keep control
          </button>
          <button
            type="button"
            className={`${styles.bannerBtn} ${styles.bannerPrimary}`}
            onClick={() => void baton.grant()}
          >
            Hand over
          </button>
        </div>
      </section>
    );
  }

  return null;
}
