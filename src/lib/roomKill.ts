/**
 * @module roomKill
 * Kill every live session in a room: the desktop's RoomKillConfirmModal and the
 * phone's session drawer (AASC-18) confirm differently and then both run this,
 * so a room is killed the same way wherever it was asked for.
 *
 * Each session goes through the same hardened path as the single-session kill
 * (POST /sessions/:id/kill → group SIGTERM/SIGKILL, then DELETE /terminals/:id to
 * reap the PTY child tree); a summary toast reports the outcome.
 */
import { useSessionStore } from '@/stores/sessionStore';
import type { Room } from '@/stores/roomStore';
import { showToast } from '@/components/ui/ToastContainer';
import { closeManagedTerminal } from '@/lib/terminalTransport';
import type { ApiResponse, KillSessionResponse, Session } from '@/types';

type KillResponse = KillSessionResponse & ApiResponse & {
  killedPid?: number | null;
  stillAlivePid?: number;
};

/**
 * The room's sessions that can be killed: ids still in the store, not ended.
 * Independent of the room filter: the confirm, not the icon, decides.
 */
export function liveRoomSessions(room: Pick<Room, 'sessionIds'>, sessions: ReadonlyMap<string, Session>): Session[] {
  return room.sessionIds
    .map((id) => sessions.get(id))
    .filter((s): s is Session => !!s && s.status !== 'ended');
}

/** Kill one session, mirroring KillConfirmModal. Resolves to whether it died. */
export async function killOneSession(session: Session): Promise<boolean> {
  try {
    const resp = await fetch(`/api/sessions/${session.sessionId}/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const data: KillResponse = await resp.json();
    if (!data.ok) return false;
    const terminalId = data.terminalId === undefined ? session.terminalId : data.terminalId;
    if (terminalId) {
      // Close the terminal too — this is what reaps the PTY's child agent tree.
      // A terminal-close failure doesn't make the process kill a failure.
      try {
        await closeManagedTerminal(terminalId);
      } catch {
        /* best-effort */
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill `targets` (a snapshot taken before any store churn), toast the summary,
 * and drop the selection if the OPEN session was actually killed — not merely
 * targeted: a survivor (network error, or a process that outlived SIGKILL)
 * stays selected, as with the single-session kill.
 */
export async function killRoomSessions(roomName: string, targets: readonly Session[]): Promise<{ killed: number; failed: number }> {
  const count = targets.length;
  const { selectedSessionId } = useSessionStore.getState();
  const results = await Promise.all(targets.map(killOneSession)); // index-aligned with targets
  const killed = results.filter(Boolean).length;
  const failed = count - killed;

  if (failed === 0) {
    showToast(`Terminated ${killed} session${killed === 1 ? '' : 's'} in ${roomName}`, 'success');
  } else if (killed === 0) {
    showToast(`Failed to kill ${failed} session${failed === 1 ? '' : 's'} in ${roomName}`, 'error');
  } else {
    showToast(`Terminated ${killed} of ${count} in ${roomName} — ${failed} survived`, 'error');
  }

  const openSessionKilled = !!selectedSessionId
    && targets.some((s, i) => results[i] && s.sessionId === selectedSessionId);
  if (openSessionKilled) useSessionStore.getState().deselectSession();

  return { killed, failed };
}
