/**
 * useControlBaton — one session's control baton as seen from this device, and
 * the actions on it. Shared by the desktop lock (`SessionControlLock`) and the
 * phone's control banner (AASC-18), so the two can never disagree about who is
 * driving or when "Take control" opens.
 *
 * Modes:
 *  - `solo`       one device connected: the baton means nothing, show nothing
 *  - `free`       nobody holds it (the next write claims it), or the holder went offline
 *  - `spectator`  another online device drives it: our keystrokes are dropped
 *  - `asked`      we drive it and another device has asked for it
 *  - `driver`     we drive it and someone else is connected
 *
 * The idle countdown is derived from the holder's `lastActivityAt` and a local
 * clock that ticks only while we are a spectator: the server re-checks the
 * window on the actual claim, so a click a second early is refused, never
 * wrongly granted.
 */
import { useCallback, useEffect, useState } from 'react';
import { usePresenceStore, type PendingControlRequest } from '@/stores/presenceStore';
import { useSessionStore } from '@/stores/sessionStore';
import { getClientId } from '@/lib/deviceIdentity';
import { claimControl, grantControl, releaseControl, requestControl } from '@/lib/presenceClient';
import { showToast } from '@/components/ui/ToastContainer';
import type { ControlHolderView } from '@/types';

/** Mirrors `IDLE_TAKEOVER_MS` in server/presenceManager.ts. */
export const IDLE_TAKEOVER_MS = 60_000;
/** The "can't see it — Share?" toast carries a button: long enough to read and press. */
const SHARE_OFFER_MS = 8000;

export type ControlBatonMode = 'solo' | 'free' | 'spectator' | 'asked' | 'driver';

export interface ControlBaton {
  mode: ControlBatonMode;
  holder: ControlHolderView | undefined;
  request: PendingControlRequest | undefined;
  /** The holder has been idle long enough for "Take control". */
  canTake: boolean;
  /** Seconds until "Take control" opens (meaningful while `!canTake`). */
  waitSecs: number;
  ask: () => Promise<void>;
  take: () => Promise<void>;
  grant: () => Promise<void>;
  dismiss: () => void;
  release: () => Promise<void>;
}

/** Pure: which mode this device is in for one session. Exported for tests. */
export function controlBatonMode(
  deviceCount: number,
  holder: ControlHolderView | undefined,
  request: PendingControlRequest | undefined,
  myId: string,
): ControlBatonMode {
  // No Ask / Take control / Release any more (Oct 2026, by request): every device drives
  // directly, so nobody is a spectator. No button asks for control now, so `asked` (a pending
  // request) only comes from an old client.
  if (deviceCount <= 1) return 'solo';
  if (holder?.clientId === myId) return request ? 'asked' : 'driver';
  return 'free';
}

/**
 * `sessionId` null: a terminal with no session (an ops shell) has no baton to
 * arbitrate, so it reads as `solo` and every action is a no-op.
 */
export function useControlBaton(sessionId: string | null | undefined): ControlBaton {
  const holder = usePresenceStore((s) => (sessionId ? s.controllers.get(sessionId) : undefined));
  const deviceCount = usePresenceStore((s) => (sessionId ? s.devices.length : 0));
  const request = usePresenceStore((s) => (sessionId ? s.pendingRequests.get(sessionId) : undefined));
  const clearRequest = usePresenceStore((s) => s.clearRequest);
  const myId = getClientId();
  const mode = controlBatonMode(deviceCount, holder, request, myId);

  // "Now" lives in state, advanced by timer callbacks only (never a synchronous
  // setState in the effect body). 0 means "not sampled yet": treated as "just
  // claimed", so Take starts disabled rather than flashing enabled for a frame.
  const [now, setNow] = useState(0);
  const spectating = mode === 'spectator';
  useEffect(() => {
    if (!spectating) return;
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [spectating]);

  const idleMs = now && holder ? now - holder.lastActivityAt : 0;
  const canTake = spectating && idleMs >= IDLE_TAKEOVER_MS;
  const waitSecs = Math.max(1, Math.ceil((IDLE_TAKEOVER_MS - idleMs) / 1000));
  const holderLabel = holder?.label ?? 'the other device';

  const ask = useCallback(async () => {
    if (!sessionId) return;
    const res = await requestControl(sessionId);
    showToast(res.ok ? `Asked ${holderLabel} to hand over` : 'This session is already free', 'info', 3000);
  }, [sessionId, holderLabel]);

  const take = useCallback(async () => {
    if (!sessionId) return;
    const res = await claimControl(sessionId, true);
    showToast(
      res.ok ? 'You now control this session' : `Still held by ${res.controller?.label ?? 'another device'}`,
      res.ok ? 'info' : 'error',
      3000,
    );
  }, [sessionId]);

  const grant = useCallback(async () => {
    if (!sessionId || !request) return;
    const res = await grantControl(sessionId, request.fromClientId);
    clearRequest(sessionId);
    showToast(
      res.ok ? `Handed control to ${request.fromLabel}` : 'Could not hand over control',
      res.ok ? 'info' : 'error',
      3000,
    );
  }, [sessionId, request, clearRequest]);

  const dismiss = useCallback(() => {
    if (sessionId) clearRequest(sessionId);
  }, [sessionId, clearRequest]);

  const release = useCallback(async () => {
    if (!sessionId) return;
    await releaseControl(sessionId);
    // Only a device that is NOT this machine can be kept from a session: this
    // Mac's other windows see host-only sessions too.
    const devices = usePresenceStore.getState().devices;
    const remote = devices.filter((d) => d.clientId !== myId && !d.isLocal);
    const shared = !!useSessionStore.getState().sessions.get(sessionId)?.remoteVisible;
    if (shared || remote.length === 0) {
      showToast('Released — any device can take this session now', 'info', 3000);
      return;
    }
    const who = remote.length === 1 ? remote[0].label : 'your other devices';
    showToast(
      `Released — but this session is HOST ONLY, so ${who} can't see it.`,
      'info',
      SHARE_OFFER_MS,
      {
        label: 'Share',
        onClick: () => {
          // Read again: it may have been shared another way meanwhile, and the
          // store only offers a toggle.
          const store = useSessionStore.getState();
          if (!store.sessions.get(sessionId)?.remoteVisible) store.toggleRemoteVisible(sessionId);
          showToast(`Shared — ${who} can open it now`, 'info', 3000);
        },
      },
    );
  }, [sessionId, myId]);

  return { mode, holder, request, canTake, waitSecs, ask, take, grant, dismiss, release };
}
