/**
 * RoomAlertToggle — the room frame header's Alert (Nov 25 2026). One click sets the per-session Alert (loud sound,
 * glowing card, desktop notification) on every live session in the room: on for all when any is off, off for all
 * when every one is on (`roomAlert.ts`). It writes each session as the control bar's Alert does (the store's
 * optimistic update and `PUT /api/sessions/:id/alerted`, plus the alarm engine), for the room's sessions as they are
 * now: it is not a stored room setting.
 */
import { useCallback } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { alertSession, unalertSession } from '@/lib/alarmEngine';
import { liveRoomIds, roomAlertClick, roomAlertState } from '@/lib/roomAlert';
import { showToast } from '@/components/ui/ToastContainer';
import { AlertIcon } from '@/components/ui/icons';
import styles from '@/styles/modules/DetailPanel.module.css';

interface RoomAlertToggleProps {
  roomName: string;
  sessionIds: readonly string[];
  /** The sessions the switcher lists (its own `sessions`), so the bell and the skull count the same live cards. */
  sessions: ReadonlyMap<string, { status: string; alerted?: boolean }>;
}

const ARIA_PRESSED = { all: 'true', some: 'mixed', none: 'false' } as const;

export default function RoomAlertToggle({ roomName, sessionIds, sessions }: RoomAlertToggleProps) {
  const setAlertedMany = useSessionStore((s) => s.setAlertedMany);
  const live = liveRoomIds(sessionIds, sessions);
  const state = roomAlertState(live, sessions);
  const count = `${live.length} session${live.length === 1 ? '' : 's'}`;
  const label = state === 'all' ? `Stop alerts for all ${count} in ${roomName}` : `Alert all ${count} in ${roomName}`;

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const { next, changes } = roomAlertClick(liveRoomIds(sessionIds, sessions), sessions);
      if (changes.length === 0) return;
      setAlertedMany(changes, next);
      for (const id of changes) {
        if (next) alertSession(id);
        else unalertSession(id);
      }
      const n = `${changes.length} session${changes.length === 1 ? '' : 's'}`;
      showToast(next ? `Alert ON for ${n} in ${roomName}` : `Alert OFF for ${n} in ${roomName}`, next ? 'success' : 'info');
    },
    [roomName, sessionIds, sessions, setAlertedMany],
  );

  if (live.length === 0) return null;
  return (
    <button
      type="button"
      className={styles.roomAlertToggle}
      data-state={state}
      aria-pressed={ARIA_PRESSED[state]}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <AlertIcon />
    </button>
  );
}
