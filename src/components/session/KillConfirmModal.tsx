/**
 * KillConfirmModal confirms killing a session process (SIGTERM -> SIGKILL).
 * Ported from the kill modal logic in public/js/sessionControls.js.
 */
import { useState } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { showToast } from '@/components/ui/ToastContainer';
import type { KillSessionResponse, ApiResponse } from '@/types';
import Button from '@/components/ui/Button';
import styles from '@/styles/modules/Modal.module.css';
import { closeManagedTerminal } from '@/lib/terminalTransport';

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
      const data: KillSessionResponse & ApiResponse & { killedPid?: number | null; stillAlivePid?: number } = await resp.json();
      if (data.ok) {
        const terminalId = data.terminalId === undefined ? session?.terminalId : data.terminalId;
        if (terminalId) {
          try {
            await closeManagedTerminal(terminalId);
          } catch {
            showToast('Failed to close terminal', 'error');
          }
        }
        // Distinguish "terminated a real process" from "no live process found" so
        // we never claim a phantom kill ("PID N/A terminated").
        const killedPid = data.killedPid ?? data.pid ?? null;
        showToast(
          data.processShared
            ? 'Session terminal closed — shared Codex host left running'
            : killedPid
              ? `PID ${killedPid} terminated`
              : 'Session closed — no running process found',
          'success',
        );
        deselectSession();
      } else {
        // Server verified the process outlived SIGKILL — surface the survivor.
        showToast(
          data.stillAlivePid
            ? `Failed to kill process ${data.stillAlivePid} — it survived SIGKILL`
            : data.error || 'Kill failed',
          'error',
        );
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
      <div
        className={styles.panel}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kill-confirm-title"
      >
        <h3 id="kill-confirm-title">Kill Session</h3>
        <p>
          Kill session for &quot;{projectName}&quot;? This will close its managed
          terminal or terminate its isolated agent process.
        </p>
        <div className={styles.actions}>
          {/* The shared kit (AASC-11): one font and one height for both, the danger
              look on the destructive one only. */}
          <Button onClick={handleCancel}>CANCEL</Button>
          <Button variant="danger" onClick={handleConfirm} disabled={killing} aria-busy={killing || undefined}>
            {killing ? 'KILLING...' : 'KILL'}
          </Button>
        </div>
      </div>
    </div>
  );
}
