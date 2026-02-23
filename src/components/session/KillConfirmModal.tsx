/**
 * KillConfirmModal confirms killing a session process (SIGTERM -> SIGKILL).
 * Ported from the kill modal logic in public/js/sessionControls.js.
 */
import { useState, useCallback } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { showToast } from '@/components/ui/ToastContainer';
import type { KillSessionResponse, ApiResponse } from '@/types';
import styles from '@/styles/modules/Modal.module.css';

export const KILL_MODAL_ID = 'kill-confirm';

export default function KillConfirmModal() {
  const activeModal = useUiStore((s) => s.activeModal);
  const closeModal = useUiStore((s) => s.closeModal);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const deselectSession = useSessionStore((s) => s.deselectSession);
  const [killing, setKilling] = useState(false);

  const isOpen = activeModal === KILL_MODAL_ID;
  if (!isOpen || !selectedSessionId) return null;

  const session = sessions.get(selectedSessionId);
  const projectName = session?.projectName || selectedSessionId.slice(0, 8);

  const handleCancel = () => {
    closeModal();
  };

  const handleConfirm = async () => {
    if (killing) return;
    setKilling(true);

    try {
      const resp = await fetch(`/api/sessions/${selectedSessionId}/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      const data: KillSessionResponse & ApiResponse = await resp.json();
      if (data.ok) {
        if (session?.terminalId) {
          try {
            await fetch(`/api/terminals/${session.terminalId}`, { method: 'DELETE' });
          } catch {
            showToast('Failed to close terminal', 'error');
          }
        }
        showToast(`PID ${data.pid || 'N/A'} terminated`, 'success');
        deselectSession();
      } else {
        showToast(data.error || 'Kill failed', 'error');
      }
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setKilling(false);
      closeModal();
    }
  };

  return (
    <div className={styles.overlay} onClick={handleCancel}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <h3>Kill Session</h3>
        <p>
          Kill session for &quot;{projectName}&quot;? This will terminate the
          Claude process (SIGTERM then SIGKILL).
        </p>
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
            disabled={killing}
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
              cursor: killing ? 'not-allowed' : 'pointer',
            }}
          >
            {killing ? 'KILLING...' : 'KILL'}
          </button>
        </div>
      </div>
    </div>
  );
}
