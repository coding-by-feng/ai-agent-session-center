/**
 * SessionControlBar renders action buttons for the selected session:
 * Resume, Kill, Mute/Unmute, Alert toggle, Room select.
 * Displayed in the detail panel below the header.
 */
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { muteSession, unmuteSession, alertSession, unalertSession } from '@/lib/alarmEngine';
import { useUiStore } from '@/stores/uiStore';
import { showToast } from '@/components/ui/ToastContainer';
import Select from '@/components/ui/Select';
import type { SelectOption } from '@/components/ui/Select';
import { KILL_MODAL_ID } from './KillConfirmModal';
import styles from '@/styles/modules/DetailPanel.module.css';

interface SessionControlBarProps {
  session: Session;
  labelChips?: React.ReactNode;
}

export default function SessionControlBar({ session, labelChips }: SessionControlBarProps) {
  const toggleMute = useSessionStore((s) => s.toggleMute);
  const toggleAlert = useSessionStore((s) => s.toggleAlert);
  const openModal = useUiStore((s) => s.openModal);
  const rooms = useRoomStore((s) => s.rooms);
  const addSession = useRoomStore((s) => s.addSession);
  const removeSessionFromRoom = useRoomStore((s) => s.removeSession);

  const [resuming, setResuming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const isDisconnected = session.status === 'ended';

  // Abort inflight resume fetch on unmount or session change
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

  // ---- Mute / Unmute ----
  const handleToggleMute = useCallback(() => {
    const muted = !session.muted;
    toggleMute(session.sessionId);
    if (muted) {
      muteSession(session.sessionId);
      showToast('Session muted', 'info');
    } else {
      unmuteSession(session.sessionId);
      showToast('Session unmuted', 'info');
    }
  }, [session.sessionId, session.muted, toggleMute]);

  // ---- Alert toggle ----
  const handleToggleAlert = useCallback(() => {
    const alerted = !session.alerted;
    toggleAlert(session.sessionId);
    if (alerted) {
      alertSession(session.sessionId);
      showToast('Alert ON — loud sounds for approval & completion', 'success');
    } else {
      unalertSession(session.sessionId);
      showToast('Alert OFF', 'info');
    }
  }, [session.sessionId, session.alerted, toggleAlert]);

  // ---- Room select ----
  const handleRoomChange = useCallback(
    (roomId: string) => {
      for (const r of rooms) {
        if (r.sessionIds.includes(session.sessionId)) {
          removeSessionFromRoom(r.id, session.sessionId);
        }
      }
      if (roomId) {
        addSession(roomId, session.sessionId);
        showToast('Moved to room', 'info');
      } else {
        showToast('Removed from room', 'info');
      }
    },
    [session.sessionId, rooms, addSession, removeSessionFromRoom],
  );

  const currentRoomId = rooms.find((r) =>
    r.sessionIds.includes(session.sessionId),
  )?.id || '';

  const roomOptions = useMemo<SelectOption[]>(() => [
    { value: '', label: 'No room' },
    ...rooms.map((r) => ({ value: r.id, label: r.name })),
  ], [rooms]);

  return (
    <div className={styles.ctrlBar}>
      {labelChips}
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
        className={`${styles.ctrlBtn} ${session.muted ? styles.muted : styles.mute}`}
        onClick={handleToggleMute}
      >
        {session.muted ? 'UNMUTE' : 'MUTE'}
      </button>
      <button
        className={`${styles.ctrlBtn} ${session.alerted ? styles.alertActive : styles.alert}`}
        onClick={handleToggleAlert}
      >
        {session.alerted ? 'ALERT ON' : 'ALERT'}
      </button>

      {/* Room select */}
      <Select
        value={currentRoomId}
        onChange={handleRoomChange}
        options={roomOptions}
      />
    </div>
  );
}
