/**
 * KillConfirmModal confirms killing a session process (SIGTERM -> SIGKILL).
 * Ported from the kill modal logic in public/js/sessionControls.js.
 */
import { useState } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { showToast } from '@/components/ui/ToastContainer';
import Button from '@/components/ui/Button';
import styles from '@/styles/modules/Modal.module.css';
import { requestSessionKill } from '@/lib/sessionActions';

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
      const result = await requestSessionKill(selectedSessionId, session?.terminalId);
      if (result.warning) showToast(result.warning, 'error');
      showToast(result.message, result.ok ? 'success' : 'error');
      if (result.ok) deselectSession();
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
