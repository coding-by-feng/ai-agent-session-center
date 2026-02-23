/**
 * SessionControlBar renders action buttons for the selected session:
 * Resume, Kill, Archive, Delete, Summarize, Alert.
 * Displayed in the detail panel below the header.
 * Ported from public/js/sessionControls.js.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useRoomStore } from '@/stores/roomStore';
import { db } from '@/lib/db';
import { deleteSession as deleteSessionDb } from '@/lib/db';
import { showToast } from '@/components/ui/ToastContainer';
import { KILL_MODAL_ID } from './KillConfirmModal';
import { ALERT_MODAL_ID } from './AlertModal';
import { SUMMARIZE_MODAL_ID } from './SummarizeModal';
import LabelChips from './LabelChips';
import styles from '@/styles/modules/DetailPanel.module.css';

interface SessionControlBarProps {
  session: Session;
}

export default function SessionControlBar({ session }: SessionControlBarProps) {
  const deselectSession = useSessionStore((s) => s.deselectSession);
  const removeSession = useSessionStore((s) => s.removeSession);
  const updateSession = useSessionStore((s) => s.updateSession);
  const selectSession = useSessionStore((s) => s.selectSession);
  const openModal = useUiStore((s) => s.openModal);
  const rooms = useRoomStore((s) => s.rooms);
  const addSession = useRoomStore((s) => s.addSession);
  const removeSessionFromRoom = useRoomStore((s) => s.removeSession);

  const [resuming, setResuming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const isDisconnected = session.status === 'ended';

  // #4: Abort inflight resume fetch on unmount or session change
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, [session.sessionId]);

  // ---- Resume ----
  const handleResume = useCallback(async () => {
    if (resuming || !isDisconnected) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setResuming(true);
    try {
      const resp = await fetch(`/api/sessions/${session.sessionId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      const data = await resp.json();
      if (data.ok) {
        showToast('Resuming Claude session in terminal', 'success');
      } else {
        showToast(data.error || 'Resume failed', 'error');
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      showToast((err as Error).message, 'error');
    } finally {
      setResuming(false);
    }
  }, [session.sessionId, resuming, isDisconnected]);

  // ---- Kill ----
  const handleKill = useCallback(() => {
    openModal(KILL_MODAL_ID);
  }, [openModal]);

  // ---- Archive ----
  const handleArchive = useCallback(async () => {
    try {
      // Mark as archived in local DB
      const s = await db.sessions.get(session.sessionId);
      if (s) {
        await db.sessions.update(session.sessionId, {
          status: 'ended',
          archived: 1,
          endedAt: s.endedAt || Date.now(),
        });
      }
      // #12: Delete from server — show error on failure
      const delResp = await fetch(`/api/sessions/${session.sessionId}`, { method: 'DELETE' });
      if (!delResp.ok) showToast('Server archive failed, archived locally', 'warning');
      deselectSession();
      removeSession(session.sessionId);
      showToast('Session archived to history', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }, [session.sessionId, deselectSession, removeSession]);

  // ---- Permanent Delete ----
  const handleDelete = useCallback(async () => {
    const label = session.title || session.projectName || session.sessionId.slice(0, 8);
    if (!window.confirm(`Permanently delete session "${label}"?\nThis cannot be undone.`)) return;
    try {
      await fetch(`/api/sessions/${session.sessionId}`, { method: 'DELETE' });
      await deleteSessionDb(session.sessionId);
      deselectSession();
      removeSession(session.sessionId);
      showToast(`Session "${label}" permanently removed`, 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }, [session.sessionId, session.title, session.projectName, deselectSession, removeSession]);

  // ---- Summarize ----
  const handleSummarize = useCallback(() => {
    openModal(SUMMARIZE_MODAL_ID);
  }, [openModal]);

  // ---- Alert ----
  const handleAlert = useCallback(() => {
    openModal(ALERT_MODAL_ID);
  }, [openModal]);

  // ---- Room select ----
  const handleRoomChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const roomId = e.target.value;
      if (roomId === '__new__') {
        const name = window.prompt('New room name:');
        if (name?.trim()) {
          const newRoomId = useRoomStore.getState().createRoom(name.trim());
          useRoomStore.getState().addSession(newRoomId, session.sessionId);
          showToast(`Created and assigned to "${name.trim()}"`, 'success');
        }
        return;
      }

      // Remove from all rooms first
      for (const r of rooms) {
        if (r.sessionIds.includes(session.sessionId)) {
          removeSessionFromRoom(r.id, session.sessionId);
        }
      }

      // Add to selected room
      if (roomId) {
        addSession(roomId, session.sessionId);
        showToast('Moved to room', 'info');
      } else {
        showToast('Removed from room', 'info');
      }
    },
    [session.sessionId, rooms, addSession, removeSessionFromRoom],
  );

  // Find current room
  const currentRoomId = rooms.find((r) =>
    r.sessionIds.includes(session.sessionId),
  )?.id || '';

  return (
    <div>
      {/* Control buttons */}
      <div className={styles.ctrlBar}>
        {isDisconnected && (
          <button
            className={`${styles.ctrlBtn} ${styles.resume}`}
            onClick={handleResume}
            disabled={resuming}
          >
            {resuming ? 'RESUMING...' : 'RESUME'}
          </button>
        )}
        <button
          className={`${styles.ctrlBtn} ${styles.kill}`}
          onClick={handleKill}
        >
          KILL
        </button>
        <button
          className={`${styles.ctrlBtn} ${styles.archive}`}
          onClick={handleArchive}
        >
          ARCHIVE
        </button>
        <button
          className={`${styles.ctrlBtn} ${styles.delete}`}
          onClick={handleDelete}
        >
          DELETE
        </button>
        <button
          className={`${styles.ctrlBtn} ${styles.summarize}`}
          onClick={handleSummarize}
        >
          SUMMARIZE
        </button>
        <button
          className={`${styles.ctrlBtn} ${styles.alert}`}
          onClick={handleAlert}
        >
          ALERT
        </button>

        {/* Room select */}
        <select
          className={styles.ctrlSelect}
          value={currentRoomId}
          onChange={handleRoomChange}
        >
          <option value="">No room</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
          <option value="__new__">+ New Room</option>
        </select>
      </div>

      {/* Label chips */}
      <div style={{ padding: '8px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
        <LabelChips
          sessionId={session.sessionId}
          currentLabel={session.label || ''}
        />
      </div>
    </div>
  );
}
