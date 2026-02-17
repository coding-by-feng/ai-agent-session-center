/**
 * QuickSessionModal - Quick-launch a session with label selection.
 * Reuses last working directory from history, allows label + workdir override.
 */
import { useState, useMemo } from 'react';
import Modal from '@/components/ui/Modal';
import { showToast } from '@/components/ui/ToastContainer';
import { useUiStore } from '@/stores/uiStore';
import styles from '@/styles/modules/Modal.module.css';

// ---------------------------------------------------------------------------
// Custom labels persistence
// ---------------------------------------------------------------------------

const CUSTOM_LABELS_KEY = 'custom-labels';

function loadCustomLabels(): string[] {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_LABELS_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveCustomLabels(labels: string[]): void {
  localStorage.setItem(CUSTOM_LABELS_KEY, JSON.stringify(labels));
}

const WORKDIR_HISTORY_KEY = 'workdir-history';

function loadWorkdirHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(WORKDIR_HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Built-in labels
// ---------------------------------------------------------------------------

const BUILT_IN_LABELS = ['ONEOFF', 'HEAVY', 'IMPORTANT'];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function QuickSessionModal() {
  const closeModal = useUiStore((s) => s.closeModal);

  const [selectedLabel, setSelectedLabel] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [customLabels, setCustomLabels] = useState(loadCustomLabels);
  const [workingDir, setWorkingDir] = useState(() => {
    const history = loadWorkdirHistory();
    return history[0] || '~';
  });
  const [submitting, setSubmitting] = useState(false);

  const allLabels = useMemo(
    () => [...BUILT_IN_LABELS, ...customLabels.filter((l) => !BUILT_IN_LABELS.includes(l))],
    [customLabels],
  );

  function handleAddLabel() {
    const trimmed = newLabel.trim().toUpperCase();
    if (!trimmed || allLabels.includes(trimmed)) return;
    const updated = [...customLabels, trimmed];
    setCustomLabels(updated);
    saveCustomLabels(updated);
    setNewLabel('');
    setSelectedLabel(trimmed);
  }

  function handleDeleteLabel(label: string) {
    if (BUILT_IN_LABELS.includes(label)) return;
    const updated = customLabels.filter((l) => l !== label);
    setCustomLabels(updated);
    saveCustomLabels(updated);
    if (selectedLabel === label) setSelectedLabel('');
  }

  async function handleLaunch() {
    if (submitting) return;
    setSubmitting(true);

    try {
      const res = await fetch('/api/terminals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: 'localhost',
          workingDir: workingDir || '~',
          command: 'claude',
          label: selectedLabel || undefined,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(`Quick session launched${selectedLabel ? ` [${selectedLabel}]` : ''}`, 'success');
        closeModal();
      } else {
        showToast(data.error || 'Failed to launch session', 'error');
      }
    } catch {
      showToast('Network error launching session', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal modalId="quick-session">
      <div className={styles.quickSessionPanel}>
        <div className={styles.quickSessionHeader}>
          <h3>QUICK LAUNCH</h3>
        </div>

        <div className={styles.quickSessionBody}>
          <p className={styles.quickSessionHint}>
            Launch a local Claude session with optional label
          </p>

          {/* Label chips */}
          <div className={styles.quickLabelChips}>
            {allLabels.length === 0 && (
              <span className={styles.quickLabelEmpty}>No labels configured</span>
            )}
            {allLabels.map((label) => (
              <button
                key={label}
                type="button"
                className={`${styles.quickLabelChip} ${selectedLabel === label ? styles.active : ''}`}
                onClick={() => setSelectedLabel(selectedLabel === label ? '' : label)}
              >
                <span className={styles.labelText}>{label}</span>
                {!BUILT_IN_LABELS.includes(label) && (
                  <span
                    className={styles.labelDelete}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteLabel(label);
                    }}
                  >
                    x
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Add custom label */}
          <div className={styles.quickLabelInputRow}>
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddLabel()}
              placeholder="Add custom label..."
            />
          </div>

          {/* Working directory override */}
          <div className={styles.quickWorkdirRow}>
            <label>Working Directory</label>
            <input
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              placeholder="~"
            />
          </div>
        </div>

        <div className={styles.quickSessionFooter}>
          <button
            type="button"
            onClick={() => closeModal()}
            style={{
              padding: '6px 14px',
              background: 'transparent',
              border: '1px solid var(--border-subtle)',
              borderRadius: '4px',
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              letterSpacing: '1px',
              cursor: 'pointer',
            }}
          >
            CANCEL
          </button>
          <button
            type="button"
            onClick={handleLaunch}
            disabled={submitting}
            style={{
              padding: '6px 16px',
              background: 'rgba(0, 229, 255, 0.15)',
              border: '1px solid var(--accent-cyan)',
              borderRadius: '4px',
              color: 'var(--accent-cyan)',
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '1px',
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.5 : 1,
            }}
          >
            {submitting ? 'LAUNCHING...' : 'LAUNCH'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
