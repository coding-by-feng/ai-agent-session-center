/**
 * QuickSessionModal - Quick-launch a session with label selection.
 * Reuses last working directory from history, allows label + workdir override.
 */
import { useState, useMemo, useCallback } from 'react';
import Modal from '@/components/ui/Modal';
import Combobox from '@/components/ui/Combobox';
import { showToast } from '@/components/ui/ToastContainer';
import { useUiStore } from '@/stores/uiStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { useKnownProjects } from '@/hooks/useKnownProjects';
import styles from '@/styles/modules/Modal.module.css';

// Default CLI command suggestions for the Command field
const DEFAULT_COMMANDS: string[] = [
  'claude',
  'claude --resume',
  'claude --continue',
  'claude --model sonnet',
  'claude --model opus',
  'gemini',
  'gemini --yolo',
  'codex',
  'aider',
];

const COMMAND_USAGE_KEY = 'command-usage-counts';

function loadCommandUsageCounts(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(COMMAND_USAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function getCommandSuggestions(): string[] {
  const counts = loadCommandUsageCounts();
  const usedSorted = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([cmd]) => cmd);
  const seen = new Set(usedSorted);
  const result = [...usedSorted];
  for (const cmd of DEFAULT_COMMANDS) {
    if (!seen.has(cmd)) result.push(cmd);
  }
  return result;
}

function saveCommand(cmd: string): void {
  if (!cmd) return;
  const counts = loadCommandUsageCounts();
  counts[cmd] = (counts[cmd] || 0) + 1;
  localStorage.setItem(COMMAND_USAGE_KEY, JSON.stringify(counts));
}

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
  const [sessionTitle, setSessionTitle] = useState('');
  const [workingDir, setWorkingDir] = useState(() => {
    const history = loadWorkdirHistory();
    return history[0] || '~';
  });
  const [command, setCommand] = useState('claude');
  const [roomId, setRoomId] = useState('');
  const [enableOpsTerminal, setEnableOpsTerminal] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Rooms
  const rooms = useRoomStore((s) => s.rooms);
  const roomOptions = useMemo(() => rooms.map((r) => r.name), [rooms]);

  // Working directory suggestions (history + known Claude Code projects)
  const workdirSuggestions = useKnownProjects();
  const commandSuggestions = useMemo(() => getCommandSuggestions(), []);

  // Validation
  const workingDirValid = workingDir.trim().length > 0;
  const commandValid = command.trim().length > 0;
  const formValid = workingDirValid && commandValid;

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
    if (submitting || !formValid) return;
    setSubmitting(true);
    saveCommand(command || 'claude');

    try {
      const res = await fetch('/api/terminals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: window.location.hostname || 'localhost',
          workingDir: workingDir || '~',
          command: command || 'claude',
          label: selectedLabel || undefined,
          sessionTitle: sessionTitle.trim() || undefined,
          enableOpsTerminal: enableOpsTerminal || undefined,
          forceNew: true,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(`Quick session launched${selectedLabel ? ` [${selectedLabel}]` : ''}`, 'success');
        // Auto-select the new session so the detail panel stays open
        if (data.terminalId) {
          useSessionStore.getState().selectSession(data.terminalId);
          if (roomId) {
            useRoomStore.getState().addSession(roomId, data.terminalId);
          }
        }
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

          {/* Session title */}
          <div className={styles.quickWorkdirRow}>
            <label>Session Title <span style={{ opacity: 0.4, fontWeight: 400 }}>(optional)</span></label>
            <input
              value={sessionTitle}
              onChange={(e) => setSessionTitle(e.target.value)}
              placeholder="Auto-generated if empty"
            />
          </div>

          {/* Working directory override */}
          <div className={styles.quickWorkdirRow}>
            <label>Working Directory <span style={{ color: 'var(--accent-cyan)', fontWeight: 700 }}>*</span></label>
            <Combobox
              value={workingDir}
              onChange={setWorkingDir}
              items={workdirSuggestions}
              placeholder="~"
            />
          </div>

          {/* Command */}
          <div className={styles.quickWorkdirRow}>
            <label>Command <span style={{ color: 'var(--accent-cyan)', fontWeight: 700 }}>*</span></label>
            <Combobox
              value={command}
              onChange={setCommand}
              items={commandSuggestions}
              placeholder="e.g. claude"
            />
          </div>

          {/* Room */}
          {roomOptions.length > 0 && (
            <div className={styles.quickWorkdirRow}>
              <label>Room</label>
              <Combobox
                value={roomId ? (rooms.find((r) => r.id === roomId)?.name ?? '') : ''}
                onChange={(v) => {
                  const match = rooms.find((r) => r.name === v);
                  setRoomId(match ? match.id : '');
                }}
                items={roomOptions}
                placeholder="None (corridor)"
              />
            </div>
          )}

          {/* Ops terminal checkbox */}
          <label className={styles.opsCheckboxRow}>
            <input
              type="checkbox"
              checked={enableOpsTerminal}
              onChange={(e) => setEnableOpsTerminal(e.target.checked)}
            />
            <div className={styles.opsCheckboxText}>
              <span className={styles.opsCheckboxLabel}>Commands Terminal</span>
              <span className={styles.opsCheckboxHint}>Extra shell tab for manual commands</span>
            </div>
          </label>
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
            disabled={submitting || !formValid}
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
              cursor: submitting || !formValid ? 'not-allowed' : 'pointer',
              opacity: submitting || !formValid ? 0.5 : 1,
            }}
          >
            {submitting ? 'LAUNCHING...' : 'LAUNCH'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
