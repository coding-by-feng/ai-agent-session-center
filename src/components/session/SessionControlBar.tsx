/**
 * SessionControlBar renders action buttons for the selected session:
 * Resume, Kill, Archive, Delete, Summarize, Alert.
 * Displayed in the detail panel below the header.
 * Ported from public/js/sessionControls.js.
 */
import { useState, useCallback } from 'react';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useGroupStore } from '@/stores/groupStore';
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
  const groups = useGroupStore((s) => s.groups);
  const addSession = useGroupStore((s) => s.addSession);
  const removeSessionFromGroup = useGroupStore((s) => s.removeSession);

  const [resuming, setResuming] = useState(false);
  const [summarizeState, setSummarizeState] = useState<'idle' | 'loading' | 'done'>('idle');

  const isDisconnected = session.status === 'ended';

  // ---- Resume ----
  const handleResume = useCallback(async () => {
    if (resuming || !isDisconnected) return;
    setResuming(true);
    try {
      const resp = await fetch(`/api/sessions/${session.sessionId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await resp.json();
      if (data.ok) {
        showToast('Resuming Claude session in terminal', 'success');
      } else {
        showToast(data.error || 'Resume failed', 'error');
      }
    } catch (err) {
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
      // Delete from server
      await fetch(`/api/sessions/${session.sessionId}`, { method: 'DELETE' }).catch(() => {});
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

  // ---- Group select ----
  const handleGroupChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const groupId = e.target.value;
      if (groupId === '__new__') {
        const name = window.prompt('New group name:');
        if (name?.trim()) {
          const newGroupId = useGroupStore.getState().createGroup(name.trim());
          useGroupStore.getState().addSession(newGroupId, session.sessionId);
          showToast(`Created and assigned to "${name.trim()}"`, 'success');
        }
        return;
      }

      // Remove from all groups first
      for (const g of groups) {
        if (g.sessionIds.includes(session.sessionId)) {
          removeSessionFromGroup(g.id, session.sessionId);
        }
      }

      // Add to selected group
      if (groupId) {
        addSession(groupId, session.sessionId);
        showToast('Moved to group', 'info');
      } else {
        showToast('Removed from group', 'info');
      }
    },
    [session.sessionId, groups, addSession, removeSessionFromGroup],
  );

  // Find current group
  const currentGroupId = groups.find((g) =>
    g.sessionIds.includes(session.sessionId),
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

        {/* Group select */}
        <select
          className={styles.ctrlSelect}
          value={currentGroupId}
          onChange={handleGroupChange}
        >
          <option value="">No group</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
          <option value="__new__">+ New Group</option>
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
