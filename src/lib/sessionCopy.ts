/**
 * @module sessionCopy
 * Fork or clone a session (POST /sessions/:id/fork | clone): the new session is
 * selected and joins the original's room, as the terminal toolbar's buttons do
 * (DetailPanel's TerminalContent). Used by the phone's session actions sheet
 * (AASC-18). Neither asks for confirmation: both create, nothing is lost.
 *
 *  - fork: a new Claude session that branches from this conversation;
 *  - clone: a new session with the same command, folder and config.
 */
import { showToast } from '@/components/ui/ToastContainer';
import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';

export type CopyKind = 'fork' | 'clone';

interface CopyReply {
  ok?: boolean;
  terminalId?: string;
  error?: string;
}

/** Resolves to the new session's id, or null (after a toast saying why). Never throws. */
export async function copySession(sessionId: string, kind: CopyKind): Promise<string | null> {
  const verb = kind === 'fork' ? 'fork' : 'clone';
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/${kind}`, { method: 'POST' });
    const data = (await res.json().catch(() => ({}))) as CopyReply;
    if (!data.ok || !data.terminalId) {
      showToast(data.error || `Couldn't ${verb} the session`, 'error');
      return null;
    }
    useSessionStore.getState().selectSession(data.terminalId);
    const room = useRoomStore.getState().getRoomForSession(sessionId);
    if (room) useRoomStore.getState().addSession(room.id, data.terminalId);
    return data.terminalId;
  } catch {
    showToast(`Network error: couldn't ${verb} the session`, 'error');
    return null;
  }
}
