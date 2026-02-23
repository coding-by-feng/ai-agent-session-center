/**
 * AlertModal lets the user set a timer alert for the selected session.
 * Ported from the alert modal logic in public/js/sessionControls.js.
 */
import { useState, useCallback } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { db } from '@/lib/db';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/Modal.module.css';

export const ALERT_MODAL_ID = 'alert-modal';

export default function AlertModal() {
  const activeModal = useUiStore((s) => s.activeModal);
  const closeModal = useUiStore((s) => s.closeModal);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const [minutes, setMinutes] = useState(5);

  const isOpen = activeModal === ALERT_MODAL_ID;
  if (!isOpen || !selectedSessionId) return null;

  const handleCancel = () => {
    closeModal();
  };

  // #16: Validate input range
  const isValid = Number.isFinite(minutes) && minutes >= 1 && minutes <= 999;

  const handleConfirm = async () => {
    if (!isValid) return;
    closeModal();

    try {
      const now = Date.now();
      await db.alerts.add({
        sessionId: selectedSessionId,
        type: 'timer',
        message: `Alert after ${minutes} minutes`,
        createdAt: now,
      });
      showToast(`Alert set for ${minutes} minutes`, 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  };

  return (
    <div className={styles.overlay} onClick={handleCancel}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <h3>Set Alert</h3>
        <p>Get notified after a duration of inactivity.</p>
        <div className={styles.alertInputRow}>
          <input
            type="number"
            className={styles.alertInput}
            value={minutes}
            onChange={(e) => setMinutes(parseInt(e.target.value, 10) || 0)}
            min={1}
            max={999}
          />
          <span>minutes</span>
        </div>
        {/* #16: Show validation message when input is invalid */}
        {!isValid && minutes !== 0 && (
          <p style={{ color: '#ff5555', fontSize: 11, margin: '0 0 12px' }}>
            Enter a value between 1 and 999
          </p>
        )}
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
            disabled={!isValid}
            style={{
              background: 'rgba(255, 145, 0, 0.15)',
              border: '1px solid rgba(255, 145, 0, 0.3)',
              color: 'var(--accent-orange, #ff9100)',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              fontWeight: 700,
              letterSpacing: '1px',
              padding: '6px 14px',
              borderRadius: '4px',
              cursor: minutes < 1 ? 'not-allowed' : 'pointer',
            }}
          >
            SET ALERT
          </button>
        </div>
      </div>
    </div>
  );
}
