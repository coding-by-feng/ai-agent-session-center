/**
 * KillConfirmModal confirms killing a session process (SIGTERM -> SIGKILL).
 * Ported from the kill modal logic in public/js/sessionControls.js.
 *
 * Two ways in: the panel's skull (`KILL_MODAL_ID`, the selected session) and a
 * LIVE board card's (`SESSION_KILL_MODAL_ID`, the session in
 * `sessionKillTargetId`). It names the session by its title, since the board
 * shows several sessions of one project side by side.
 *
 * Killed from its panel, the panel steps back to the session opened before it
 * (`leaveSession`) rather than closing; from a board card, it closes the
 * (minimized) panel only if that was the panel's session.
 */
import { useState } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore, SESSION_KILL_MODAL_ID } from '@/stores/uiStore';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { showToast } from '@/components/ui/ToastContainer';
import Button from '@/components/ui/Button';
import styles from '@/styles/modules/Modal.module.css';
import { requestSessionKill } from '@/lib/sessionActions';

export const KILL_MODAL_ID = 'kill-confirm';

export default function KillConfirmModal() {
  const activeModal = useUiStore((s) => s.activeModal);
  const sessionKillTargetId = useUiStore((s) => s.sessionKillTargetId);
  const closeModal = useUiStore((s) => s.closeModal);
  const restoreDetailPanel = useUiStore((s) => s.restoreDetailPanel);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const deselectSession = useSessionStore((s) => s.deselectSession);
  const leaveSession = useSessionStore((s) => s.leaveSession);
  const [killing, setKilling] = useState(false);

  const fromPanel = activeModal === KILL_MODAL_ID;
  const targetId =
    activeModal === SESSION_KILL_MODAL_ID ? sessionKillTargetId
      : fromPanel ? selectedSessionId
        : null;
  if (!targetId) return null;

  const session = sessions.get(targetId);
  const title = session ? sessionDisplayTitle(session) : targetId.slice(0, 8);
  const where = session?.projectName && session.projectName !== title ? ` in ${session.projectName}` : '';

  const handleCancel = () => {
    closeModal();
  };

  const handleConfirm = async () => {
    if (killing) return;
    setKilling(true);
    try {
      const result = await requestSessionKill(targetId, session?.terminalId);
      if (result.warning) showToast(result.warning, 'error');
      showToast(result.message, result.ok ? 'success' : 'error');
      // A board card can kill a session other than the panel's: leave that one
      // open. Read now, not from the render: the selection may have moved.
      if (result.ok && useSessionStore.getState().selectedSessionId === targetId) {
        if (fromPanel) {
          const nextId = leaveSession(targetId);
          const next = nextId ? useSessionStore.getState().sessions.get(nextId) : undefined;
          if (next) showToast(`Switched to ${sessionDisplayTitle(next)}`, 'info', 1500);
        } else {
          // The board is only reachable with the panel minimized: un-minimize
          // too, or its "Restore" chip stays up for a session that is gone.
          deselectSession();
          restoreDetailPanel();
        }
      }
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
          Kill session &quot;{title}&quot;{where}? This will close its managed
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
