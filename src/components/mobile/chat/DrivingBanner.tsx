/**
 * DrivingBanner — "Your Mac is driving · Take control" (AASC-42/45), over the
 * composer and over the terminal's input when another device holds the
 * session's control baton (the server drops this phone's typing until then).
 * When this phone drives and another device asks for it, it offers the hand-over.
 *
 * The state and actions are `useControlBaton`'s, the hook behind the desktop's
 * lock and the classic phone banner (PhoneControlBanner), so they can't
 * disagree about who drives or when Take control opens. Plain words: the holder
 * is "Your Mac" when it is a window on the Mac itself.
 */
import { useControlBaton } from '@/hooks/useControlBaton';
import { useDriverName } from './useDriverName';
import styles from '@/styles/modules/mobile/DrivingBanner.module.css';

export interface DrivingBannerProps {
  sessionId: string;
  /** One line (a waiting card already takes the room): who drives and Take control, no Ask. */
  compact?: boolean;
}

export default function DrivingBanner({ sessionId, compact = false }: DrivingBannerProps) {
  const baton = useControlBaton(sessionId);
  const { mode, holder, request, canTake, waitSecs } = baton;
  const who = useDriverName(holder?.clientId, holder?.label);

  if (mode === 'spectator' && holder) {
    return (
      <section className={`${styles.banner}${compact ? ` ${styles.compact}` : ''}`} aria-label="Who is driving" aria-live="polite" data-testid="driving-banner">
        <p className={styles.text}>
          <span className={styles.title}>{who} is driving</span>
          {!compact && (
            <span className={styles.note}>
              {canTake ? 'Take control to type here.' : `Take control opens after ${waitSecs} s of quiet there.`}
            </span>
          )}
        </p>
        <div className={styles.actions}>
          {!compact && <button type="button" className={styles.button} onClick={() => void baton.ask()}>Ask</button>}
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            aria-disabled={canTake ? undefined : true}
            onClick={() => { if (canTake) void baton.take(); }}
          >
            {canTake ? 'Take control' : `Take in ${waitSecs} s`}
          </button>
        </div>
      </section>
    );
  }

  if (mode === 'asked' && request) {
    return (
      <section className={`${styles.banner} ${styles.asked}`} aria-label="Who is driving" aria-live="polite">
        <p className={styles.text}>
          <span className={styles.title}>{request.fromLabel} wants control</span>
          <span className={styles.note}>You are driving this session.</span>
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={baton.dismiss}>Keep</button>
          <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => void baton.grant()}>Hand over</button>
        </div>
      </section>
    );
  }

  return null;
}
