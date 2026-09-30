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
import Tooltip from '@/components/ui/Tooltip';
import { faultLabel } from '@/lib/resumeWatchdog';
import { tooltips } from '@/lib/tooltips';
import { KILL_MODAL_ID } from './KillConfirmModal';
import SessionControlLock from './SessionControlLock';
import styles from '@/styles/modules/DetailPanel.module.css';

interface SessionControlBarProps {
  session: Session;
}

export default function SessionControlBar({ session }: SessionControlBarProps) {
  const toggleMute = useSessionStore((s) => s.toggleMute);
  const toggleAlert = useSessionStore((s) => s.toggleAlert);
  const toggleRemoteVisible = useSessionStore((s) => s.toggleRemoteVisible);
  const toggleRcDaemon = useSessionStore((s) => s.toggleRemoteControlDaemon);
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

  // ---- Remote visibility ----
  // Optimistic, same shape as handleToggleMute below: flip the LOCAL store
  // first so the button changes on click, then let toggleRemoteVisible's
  // fire-and-forget fetch persist it. The previous version awaited the fetch
  // and only ever showed a toast — no local state changed either way, so the
  // button never visually flipped; only a full reload picked up the write the
  // server had already made. The authoritative gate stays server-side in
  // sessionVisibility.ts regardless of what this optimistic flip shows.
  const handleToggleRemoteVisible = useCallback(() => {
    const next = !session.remoteVisible;
    toggleRemoteVisible(session.sessionId);
    showToast(
      next
        ? 'Session is now visible to your other devices'
        : 'Session is now hidden from other devices',
      'info',
    );
  }, [session.sessionId, session.remoteVisible, toggleRemoteVisible]);

  // ---- Remote Control auto-relink ----
  // Off by default and opt-in per session: this types slash commands into a
  // live CLI, so it must never be something the user gets by accident.
  const handleToggleRcDaemon = useCallback(() => {
    const next = !session.remoteControlDaemon;
    toggleRcDaemon(session.sessionId);
    showToast(
      next
        ? 'Auto-relink ON — Remote Control refreshes when this session goes idle'
        : 'Auto-relink OFF',
      'info',
      2400,
    );
  }, [session.sessionId, session.remoteControlDaemon, toggleRcDaemon]);

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
      {/* Who is driving this session, when more than one device is connected.
          Renders nothing on a solo workspace. Without it, a spectator types
          into the terminal and nothing happens — which reads as a broken app
          rather than as another device holding the session. */}
      <SessionControlLock sessionId={session.sessionId} />
      {session.interruption && (
        <span
          className={styles.ctrlInterrupted}
          title={`Turn ended on a transient failure, not a finished task:\n${session.interruption.line}`}
        >
          ⚠ {faultLabel(session.interruption.kind)}
        </span>
      )}
      {isDisconnected && (
        <Tooltip {...tooltips.ctrlResume}>
          <button
            className={`${styles.ctrlBtn} ${styles.resume}`}
            onClick={handleResume}
            disabled={resuming}
          >
            {resuming ? 'RESUMING...' : 'RESUME'}
          </button>
        </Tooltip>
      )}
      <Tooltip {...tooltips.ctrlKill}>
        <button
          className={`${styles.ctrlBtn} ${styles.kill}`}
          onClick={handleKill}
        >
          KILL
        </button>
      </Tooltip>
      <Tooltip {...(session.muted ? tooltips.ctrlUnmute : tooltips.ctrlMute)}>
        <button
          className={`${styles.ctrlBtn} ${session.muted ? styles.muted : styles.mute}`}
          onClick={handleToggleMute}
        >
          {session.muted ? 'UNMUTE' : 'MUTE'}
        </button>
      </Tooltip>
      <Tooltip {...(session.remoteVisible ? tooltips.ctrlRemoteVisibleOn : tooltips.ctrlRemoteVisibleOff)}>
        <button
          className={`${styles.ctrlBtn} ${session.remoteVisible ? styles.remoteShared : ''}`}
          onClick={handleToggleRemoteVisible}
          aria-pressed={!!session.remoteVisible}
        >
          {session.remoteVisible ? 'SHARED' : 'HOST ONLY'}
        </button>
      </Tooltip>
      <Tooltip {...(session.remoteControlDaemon ? tooltips.ctrlRcDaemonOn : tooltips.ctrlRcDaemonOff)}>
        <button
          className={`${styles.ctrlBtn} ${session.remoteControlDaemon ? styles.rcDaemonOn : ''}`}
          onClick={handleToggleRcDaemon}
          aria-pressed={!!session.remoteControlDaemon}
        >
          {session.remoteControlDaemon ? '🛰 AUTO-RELINK' : '🛰 RELINK OFF'}
        </button>
      </Tooltip>
      <Tooltip {...(session.alerted ? tooltips.ctrlAlertOn : tooltips.ctrlAlertOff)}>
        <button
          className={`${styles.ctrlBtn} ${session.alerted ? styles.alertActive : styles.alert}`}
          onClick={handleToggleAlert}
        >
          {session.alerted ? 'ALERT ON' : 'ALERT'}
        </button>
      </Tooltip>

      {/* Room select */}
      <Select
        value={currentRoomId}
        onChange={handleRoomChange}
        options={roomOptions}
        className={styles.roomSelect}
      />
    </div>
  );
}
