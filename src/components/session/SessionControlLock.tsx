/**
 * SessionControlLock — the per-session control baton, surfaced in the session
 * control bar.
 *
 * Renders in exactly three situations and is invisible otherwise, so a
 * single-device workspace never sees it:
 *
 *  1. **Another device drives this session** → a lock with the holder's name, a
 *     "Ask for control" button, and — once the holder has been idle long enough
 *     — "Take control". This is the piece that keeps the UI honest: without it,
 *     a spectator types into the terminal and nothing happens, which reads as a
 *     broken app rather than as someone else holding the session.
 *
 *  2. **Another device has asked US for this session** → Grant / Dismiss.
 *
 *  3. **We drive it while other devices are connected** → a quiet "Release"
 *     so handing over does not require the other device to wait out the idle
 *     window. Release frees the baton, not the session's visibility: a device
 *     that is not this machine (an iPad on the LAN) sees only SHARED sessions
 *     (server/sessionVisibility.ts), so for a HOST ONLY session the toast says
 *     so and offers Share. Sharing stays an explicit click, never a side effect.
 *
 * The state, the idle countdown and the actions live in `useControlBaton`,
 * which the phone's control banner (`PhoneControlBanner`, AASC-18) shares.
 * The countdown is derived from the holder's `lastActivityAt` and a local
 * ticking clock rather than a server push: the server has no reason to
 * broadcast once per second, and being a second or two off only affects when
 * the button becomes enabled — the server re-checks the window on the actual
 * claim, so an early click is refused rather than wrongly granted.
 */
import { useControlBaton } from '@/hooks/useControlBaton';
import styles from '@/styles/modules/DevicePresence.module.css';

interface Props {
  sessionId: string;
}

export default function SessionControlLock({ sessionId }: Props) {
  // The baton's state and actions are shared with the phone's control banner
  // (useControlBaton), so the two can never disagree about who drives.
  const { mode, holder, request, canTake, waitSecs, ask, take, grant, dismiss, release } = useControlBaton(sessionId);

  // (2) Someone is asking us to hand this session over. A full-row card, not a
  // chip: a bare "Grant" never said what it gave away, and the no-wrap chip
  // pushed its × dismiss past the right edge of a docked panel.
  if (mode === 'asked' && request) {
    return (
      <div className={styles.request} role="group" aria-label="Control request">
        <div className={styles.requestBody}>
          <span className={styles.requestTitle}>
            <span aria-hidden="true">🙋 </span>
            <strong className={styles.requestFrom}>{request.fromLabel}</strong> wants control of this session
          </span>
          <span className={styles.requestHint}>
            It will type here; you watch. Ask to take it back any time.
          </span>
          <span className={styles.requestActions}>
            <button
              className={styles.grantBtn}
              onClick={grant}
              title={`Hand typing in this session to ${request.fromLabel}`}
            >
              Grant control
            </button>
            <button
              className={styles.dismissBtn}
              onClick={dismiss}
              title="Decline — this device keeps typing"
            >
              Keep control
            </button>
          </span>
        </div>
      </div>
    );
  }

  // (1) Another device drives this session — we are a spectator.
  if (mode === 'spectator' && holder) {
    return (
      <span className={styles.lock}>
        <span aria-hidden="true">🔒</span>
        <span className={styles.lockHolder}>Driven by {holder.label}</span>
        <button className={styles.lockBtn} onClick={ask}>Ask</button>
        <button
          className={styles.lockBtn}
          onClick={take}
          disabled={!canTake}
          title={
            canTake
              ? 'The other device has been idle — take over'
              : `Available in ${waitSecs}s if the other device stays idle`
          }
        >
          {canTake ? 'Take control' : `Take in ${waitSecs}s`}
        </button>
      </span>
    );
  }

  // (3) We drive it, and someone else is around to hand it to.
  if (mode === 'driver') {
    return (
      <span className={styles.lock}>
        <span aria-hidden="true">🎮</span>
        <span className={styles.lockHolder}>You control this</span>
        <button className={styles.lockBtn} onClick={release}>
          Release
        </button>
      </span>
    );
  }

  // Solo device, or nobody holds it: the baton is meaningless here.
  return null;
}
