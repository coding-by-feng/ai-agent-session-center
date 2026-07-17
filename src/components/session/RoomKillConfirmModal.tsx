/**
 * RoomKillConfirmModal — confirms killing EVERY live session in a room, then
 * terminates them one by one through the same hardened path as the single-session
 * KillConfirmModal (POST /sessions/:id/kill → group SIGTERM/SIGKILL, then
 * DELETE /terminals/:id to reap the PTY child tree). Reports a summary toast.
 */
import { useState } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore, ROOM_KILL_MODAL_ID } from '@/stores/uiStore';
import { useRoomStore } from '@/stores/roomStore';
import { showToast } from '@/components/ui/ToastContainer';
import type { Session, KillSessionResponse, ApiResponse } from '@/types';
import styles from '@/styles/modules/Modal.module.css';

type KillResponse = KillSessionResponse & ApiResponse & {
  killedPid?: number | null;
  stillAlivePid?: number;
};

/** How many session names to list before collapsing the rest into "+N more". */
const NAME_LIST_CAP = 8;

const sessionLabel = (s: Session): string =>
  s.title || s.projectName || s.sessionId.slice(0, 8);

/** Kill one session, mirroring KillConfirmModal. Resolves to whether it died. */
async function killOne(session: Session): Promise<boolean> {
  try {
    const resp = await fetch(`/api/sessions/${session.sessionId}/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const data: KillResponse = await resp.json();
    if (!data.ok) return false;
    if (session.terminalId) {
      // Close the terminal too — this is what reaps the PTY's child agent tree.
      // A terminal-close failure doesn't make the process kill a failure.
      try {
        await fetch(`/api/terminals/${session.terminalId}`, { method: 'DELETE' });
      } catch {
        /* best-effort */
      }
    }
    return true;
  } catch {
    return false;
  }
}

export default function RoomKillConfirmModal() {
  const activeModal = useUiStore((s) => s.activeModal);
  const roomKillTargetId = useUiStore((s) => s.roomKillTargetId);
  const closeModal = useUiStore((s) => s.closeModal);
  const rooms = useRoomStore((s) => s.rooms);
  const sessions = useSessionStore((s) => s.sessions);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const deselectSession = useSessionStore((s) => s.deselectSession);
  const [killing, setKilling] = useState(false);

  const isOpen = activeModal === ROOM_KILL_MODAL_ID;
  if (!isOpen || !roomKillTargetId) return null;

  const room = rooms.find((r) => r.id === roomKillTargetId);
  if (!room) return null;

  // Only live sessions are killable: skip ids no longer in the store and any
  // already-ended card. The modal — not the icon — is the source of truth for
  // what gets killed, independent of the room filter.
  const liveSessions = room.sessionIds
    .map((id) => sessions.get(id))
    .filter((s): s is Session => !!s && s.status !== 'ended');

  const count = liveSessions.length;

  const handleCancel = () => closeModal();

  const handleConfirm = async () => {
    if (killing || count === 0) return;
    setKilling(true);

    const targets = liveSessions; // snapshot before any store churn
    const results = await Promise.all(targets.map(killOne)); // index-aligned with targets
    const killed = results.filter(Boolean).length;
    const failed = count - killed;

    if (failed === 0) {
      showToast(`Terminated ${killed} session${killed === 1 ? '' : 's'} in ${room.name}`, 'success');
    } else if (killed === 0) {
      showToast(`Failed to kill ${failed} session${failed === 1 ? '' : 's'} in ${room.name}`, 'error');
    } else {
      showToast(`Terminated ${killed} of ${count} in ${room.name} — ${failed} survived`, 'error');
    }

    // Drop the selection only if the OPEN session was ACTUALLY killed — not merely
    // targeted. A survivor (network error, or a process that outlived SIGKILL →
    // ok:false) stays selected, matching the single-session KillConfirmModal which
    // deselects only inside its data.ok branch.
    const openSessionKilled = !!selectedSessionId
      && targets.some((s, i) => results[i] && s.sessionId === selectedSessionId);
    if (openSessionKilled) deselectSession();

    setKilling(false);
    closeModal();
  };

  const shown = liveSessions.slice(0, NAME_LIST_CAP);
  const overflow = count - shown.length;

  return (
    <div className={styles.overlay} onClick={handleCancel}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <h3>Kill all sessions in &quot;{room.name}&quot;</h3>
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
          <button
            className={styles.closeBtn}
            onClick={handleCancel}
            style={{ fontSize: '12px', padding: '6px 14px' }}
          >
            CANCEL
          </button>
          <button
            onClick={handleConfirm}
            disabled={killing || count === 0}
            style={{
              background: 'rgba(255, 51, 85, 0.15)',
              border: '1px solid rgba(255, 51, 85, 0.3)',
              color: 'var(--accent-red, #ff3355)',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              fontWeight: 700,
              letterSpacing: '1px',
              padding: '6px 14px',
              borderRadius: '4px',
              cursor: killing || count === 0 ? 'not-allowed' : 'pointer',
              opacity: count === 0 ? 0.5 : 1,
            }}
          >
            {killing ? 'KILLING...' : count === 0 ? 'KILL' : `KILL ${count}`}
          </button>
        </div>
      </div>
    </div>
  );
}
