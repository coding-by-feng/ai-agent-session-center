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
 *     window.
 *
 * The idle countdown is derived from the holder's `lastActivityAt` and a local
 * ticking clock rather than a server push: the server has no reason to
 * broadcast once per second, and being a second or two off only affects when
 * the button becomes enabled — the server re-checks the window on the actual
 * claim, so an early click is refused rather than wrongly granted.
 */
import { useEffect, useState } from 'react';
import { usePresenceStore } from '@/stores/presenceStore';
import { getClientId } from '@/lib/deviceIdentity';
import { claimControl, releaseControl, requestControl, grantControl } from '@/lib/presenceClient';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/DevicePresence.module.css';

/** Mirrors `IDLE_TAKEOVER_MS` in server/presenceManager.ts. */
const IDLE_TAKEOVER_MS = 60_000;

interface Props {
  sessionId: string;
}

export default function SessionControlLock({ sessionId }: Props) {
  const holder = usePresenceStore((s) => s.controllers.get(sessionId));
  const devices = usePresenceStore((s) => s.devices);
  const request = usePresenceStore((s) => s.pendingRequests.get(sessionId));
  const clearRequest = usePresenceStore((s) => s.clearRequest);
  const myId = getClientId();

  // The countdown needs a clock, but reading `Date.now()` during render is
  // impure (an incidental re-render would jump the number). Keep "now" in
  // state, advanced by an interval that only runs while a lock is on screen.
  // 0 means "not sampled yet" — the first tick lands a frame later.
  const [now, setNow] = useState(0);
  const heldByOther = !!holder && holder.online && holder.clientId !== myId;
  useEffect(() => {
    if (!heldByOther) return;
    // Both samples are timer callbacks, never a synchronous setState in the
    // effect body — that would cascade an extra render on every mount.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [heldByOther]);

  // Solo device → the baton is meaningless; render nothing.
  if (devices.length <= 1) return null;

  // (2) Someone is asking us to hand this session over.
  if (request && holder?.clientId === myId) {
    const onGrant = async () => {
      const res = await grantControl(sessionId, request.fromClientId);
      clearRequest(sessionId);
      showToast(
        res.ok ? `Handed control to ${request.fromLabel}` : 'Could not hand over control',
        res.ok ? 'info' : 'error',
        3000,
      );
    };
    return (
      <span className={styles.request}>
        <span aria-hidden="true">🙋</span>
        <span>{request.fromLabel} wants control</span>
        <button className={styles.grantBtn} onClick={onGrant}>Grant</button>
        <button
          className={styles.dismissBtn}
          onClick={() => clearRequest(sessionId)}
          aria-label="Dismiss control request"
          title="Keep control"
        >
          ×
        </button>
      </span>
    );
  }

  // (1) Another device drives this session — we are a spectator.
  if (heldByOther) {
    // `now === 0` on the very first render, before the effect samples the
    // clock — treat that as "just claimed" so the button starts disabled
    // rather than flashing enabled for one frame.
    const idleMs = now ? now - holder.lastActivityAt : 0;
    const canTake = idleMs >= IDLE_TAKEOVER_MS;
    const waitSecs = Math.max(1, Math.ceil((IDLE_TAKEOVER_MS - idleMs) / 1000));

    const onAsk = async () => {
      const res = await requestControl(sessionId);
      showToast(
        res.ok ? `Asked ${holder.label} to hand over` : 'This session is already free',
        'info',
        3000,
      );
    };
    const onTake = async () => {
      const res = await claimControl(sessionId, true);
      showToast(
        res.ok
          ? 'You now control this session'
          : `Still held by ${res.controller?.label ?? 'another device'}`,
        res.ok ? 'info' : 'error',
        3000,
      );
    };

    return (
      <span className={styles.lock}>
        <span aria-hidden="true">🔒</span>
        <span className={styles.lockHolder}>Driven by {holder.label}</span>
        <button className={styles.lockBtn} onClick={onAsk}>Ask</button>
        <button
          className={styles.lockBtn}
          onClick={onTake}
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
  if (holder?.clientId === myId) {
    return (
      <span className={styles.lock}>
        <span aria-hidden="true">🎮</span>
        <span className={styles.lockHolder}>You control this</span>
        <button
          className={styles.lockBtn}
          onClick={async () => {
            await releaseControl(sessionId);
            showToast('Released — any device can take this session now', 'info', 3000);
          }}
        >
          Release
        </button>
      </span>
    );
  }

  return null;
}
