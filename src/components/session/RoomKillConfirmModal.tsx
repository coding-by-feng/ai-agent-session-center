/**
 * RoomKillConfirmModal — confirms killing EVERY live session in a room, then
 * terminates them one by one through the same hardened path as the single-session
 * KillConfirmModal (lib/roomKill.ts, shared with the phone's session drawer).
 * Reports a summary toast.
 */
import { useState } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore, ROOM_KILL_MODAL_ID } from '@/stores/uiStore';
import { useRoomStore } from '@/stores/roomStore';
import type { Session } from '@/types';
import Button from '@/components/ui/Button';
import styles from '@/styles/modules/Modal.module.css';
import { killRoomSessions, liveRoomSessions } from '@/lib/roomKill';

/** How many session names to list before collapsing the rest into "+N more". */
const NAME_LIST_CAP = 8;

const sessionLabel = (s: Session): string =>
  s.title || s.projectName || s.sessionId.slice(0, 8);

export default function RoomKillConfirmModal() {
  const activeModal = useUiStore((s) => s.activeModal);
  const roomKillTargetId = useUiStore((s) => s.roomKillTargetId);
  const closeModal = useUiStore((s) => s.closeModal);
  const rooms = useRoomStore((s) => s.rooms);
  const sessions = useSessionStore((s) => s.sessions);
  const [killing, setKilling] = useState(false);

  const isOpen = activeModal === ROOM_KILL_MODAL_ID;
  if (!isOpen || !roomKillTargetId) return null;

  const room = rooms.find((r) => r.id === roomKillTargetId);
  if (!room) return null;

  // Only live sessions are killable: skip ids no longer in the store and any
  // already-ended card. The modal — not the icon — is the source of truth for
  // what gets killed, independent of the room filter.
  const liveSessions = liveRoomSessions(room, sessions);

  const count = liveSessions.length;

  const handleCancel = () => closeModal();

  const handleConfirm = async () => {
    if (killing || count === 0) return;
    setKilling(true);

    // A snapshot before any store churn. lib/roomKill.ts toasts the outcome and
    // drops the selection only if the open session actually died.
    await killRoomSessions(room.name, liveSessions);

    setKilling(false);
    closeModal();
  };

  const shown = liveSessions.slice(0, NAME_LIST_CAP);
  const overflow = count - shown.length;

  return (
    <div className={styles.overlay} onClick={handleCancel}>
      <div
        className={styles.panel}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="room-kill-title"
      >
        <h3 id="room-kill-title">Kill all sessions in &quot;{room.name}&quot;</h3>
        {count === 0 ? (
          <p>This room has no live sessions to kill.</p>
        ) : (
          <>
            <p>
              This will terminate {count} live session{count === 1 ? '' : 's'} (SIGTERM
              then SIGKILL). Ended sessions are skipped.
            </p>
            <ul style={{ margin: '0 0 4px', paddingLeft: 18, fontSize: '12px', lineHeight: 1.6 }}>
              {shown.map((s) => (
                <li key={s.sessionId}>{sessionLabel(s)}</li>
              ))}
              {overflow > 0 && <li style={{ opacity: 0.7 }}>+{overflow} more</li>}
            </ul>
          </>
        )}
        <div className={styles.actions}>
          {/* The shared kit (AASC-11), as in KillConfirmModal. */}
          <Button onClick={handleCancel}>CANCEL</Button>
          <Button
            variant="danger"
            onClick={handleConfirm}
            disabled={killing || count === 0}
            aria-busy={killing || undefined}
          >
            {killing ? 'KILLING...' : count === 0 ? 'KILL' : `KILL ${count}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
