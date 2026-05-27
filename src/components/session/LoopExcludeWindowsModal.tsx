/**
 * LoopExcludeWindowsModal — edit the session-level "quiet hours" for loops.
 *
 * Lives next to the Pause / Idle-guard toggles in the queue status row.
 * Whatever windows are saved here apply to EVERY loop in the session, OR'd
 * with each loop's own per-item windows in the scheduler.
 *
 * Visually it reuses the same chainModal* shell as QueueItemEditModal so the
 * two editors feel like siblings.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExcludeWindow } from '@/stores/queueStore';
import TimePicker12 from '@/components/ui/TimePicker12';
import styles from '@/styles/modules/Terminal.module.css';

interface LoopExcludeWindowsModalProps {
  windows: ExcludeWindow[];
  onClose: () => void;
  onSave: (windows: ExcludeWindow[]) => void;
}

let _nextLocalId = Date.now();
function nextId(): number {
  return _nextLocalId++;
}

export default function LoopExcludeWindowsModal({
  windows,
  onClose,
  onSave,
}: LoopExcludeWindowsModalProps) {
  const [draft, setDraft] = useState<ExcludeWindow[]>(
    windows.map((w) => ({ ...w })),
  );
  const overlayRef = useRef<HTMLDivElement>(null);

  // ESC closes the sheet.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose],
  );

  const addWindow = () =>
    setDraft((p) => [...p, { id: nextId(), startHHMM: '00:00', endHHMM: '09:00' }]);
  const updateField = (id: number, field: 'startHHMM' | 'endHHMM', value: string) =>
    setDraft((p) => p.map((w) => (w.id === id ? { ...w, [field]: value } : w)));
  const removeWindow = (id: number) =>
    setDraft((p) => p.filter((w) => w.id !== id));

  const handleSave = () => {
    // Strip empty/invalid rows so the saved list never persistently no-ops.
    const cleaned = draft.filter(
      (w) => w.startHHMM && w.endHHMM && w.startHHMM !== w.endHHMM,
    );
    onSave(cleaned);
    onClose();
  };

  return (
    <div ref={overlayRef} className={styles.chainModalOverlay} onClick={handleOverlayClick}>
      <div className={styles.chainModalPanel} role="dialog" aria-modal="true">
        <div className={styles.chainModalHeader}>
          <h3>Session quiet hours</h3>
          <button className={styles.chainCloseBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className={styles.chainModalBody}>
          <div className={styles.chainSectionHint} style={{ paddingBottom: 6 }}>
            Loops in this session won&apos;t fire during these time ranges. Each
            loop can also add its own windows on top (in its edit modal).
          </div>

          {draft.length === 0 ? (
            <div className={styles.chainEmpty}>
              No quiet hours yet — loops run 24/7 unless individual items add their own.
            </div>
          ) : (
            draft.map((w) => {
              const wraps = w.startHHMM && w.endHHMM && w.startHHMM > w.endHHMM;
              const invalid = w.startHHMM === w.endHHMM;
              return (
                <div key={w.id} className={styles.excludeWindowRow}>
                  <TimePicker12
                    value={w.startHHMM || '00:00'}
                    onChange={(next) => updateField(w.id, 'startHHMM', next ?? '00:00')}
                    ariaLabel="Window start"
                  />
                  <span className={styles.excludeWindowArrow}>→</span>
                  <TimePicker12
                    value={w.endHHMM || '00:00'}
                    onChange={(next) => updateField(w.id, 'endHHMM', next ?? '00:00')}
                    ariaLabel="Window end"
                  />
                  {wraps && (
                    <span className={styles.excludeWindowHint} title="Wraps past midnight">
                      ↺ overnight
                    </span>
                  )}
                  {invalid && (
                    <span
                      className={styles.excludeWindowInvalid}
                      title="Start and end are equal — this window will be ignored"
                    >
                      ⚠ invalid
                    </span>
                  )}
                  <button
                    className={`${styles.chainStepBtn} ${styles.chainStepDel}`}
                    onClick={() => removeWindow(w.id)}
                    title="Delete window"
                  >
                    ✕
                  </button>
                </div>
              );
            })
          )}

          <button className={styles.chainAddBtn} onClick={addWindow}>
            + Add quiet-hours window
          </button>
        </div>

        <div className={styles.chainModalFooter}>
          <div />
          <div className={styles.chainModalFooterRight}>
            <button className={styles.chainBtn} onClick={onClose}>Cancel</button>
            <button
              className={`${styles.chainBtn} ${styles.chainBtnPrimary}`}
              onClick={handleSave}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
