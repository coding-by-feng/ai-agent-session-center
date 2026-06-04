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
import { getCommandSuggestions, saveCommand } from '@/lib/commandSuggestions';
import {
  deriveRemoteControlName,
  loadRemoteControlSettings,
  saveRemoteControlSettings,
  sanitizeRemoteControlName,
  loadSessionPrefs,
  saveSessionPrefs,
  EFFORT_LEVELS,
  normalizeEffortLevel,
} from '@/lib/remoteControlName';
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
  const [sessionTitle, setSessionTitle] = useState('');
  const [workingDir, setWorkingDir] = useState(() => {
    const history = loadWorkdirHistory();
    return history[0] || '~';
  });
  const [command, setCommand] = useState('claude');
  const [sessionPrefs] = useState(() => loadSessionPrefs());
  const [effortLevel, setEffortLevel] = useState(normalizeEffortLevel(sessionPrefs.effortLevel));
  const [model, setModel] = useState(sessionPrefs.model || '');
  const [roomId, setRoomId] = useState('');
  const [enableOpsTerminal, setEnableOpsTerminal] = useState(false);
  const [remoteControlSettings] = useState(() => loadRemoteControlSettings());
  const [autoEnableRemoteControl, setAutoEnableRemoteControl] = useState(
    !!remoteControlSettings.autoEnable,
  );
  const [enableRemoteControl, setEnableRemoteControl] = useState(
    !!remoteControlSettings.autoEnable || remoteControlSettings.enabled,
  );
  const [remoteControlName, setRemoteControlName] = useState('');
  const [remoteControlNameTouched, setRemoteControlNameTouched] = useState(false);
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

  const isClaudeCommand = command.trim().toLowerCase().startsWith('claude');
  const autoRemoteControlName = useMemo(
    () => deriveRemoteControlName(sessionTitle, workingDir, useSessionStore.getState().sessions.values()),
    [sessionTitle, workingDir],
  );
  const effectiveRemoteControlName = remoteControlNameTouched && remoteControlName
    ? sanitizeRemoteControlName(remoteControlName)
    : autoRemoteControlName;

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
      let terminalId: string | undefined;

      const remoteControlPayload =
        isClaudeCommand && enableRemoteControl && effectiveRemoteControlName
          ? effectiveRemoteControlName
          : undefined;

      // Electron: use IPC to create PTY directly (VS Code-style)
      if (window.electronAPI?.createPty) {
        const result = await window.electronAPI.createPty({
          workingDir: workingDir || '~',
          command: command || 'claude',
          label: selectedLabel || undefined,
          sessionTitle: sessionTitle.trim() || undefined,
          effortLevel: effortLevel || undefined,
          model: model || undefined,
          enableOpsTerminal: enableOpsTerminal || undefined,
          remoteControlName: remoteControlPayload,
        });
        if (!result.ok) {
          showToast(result.error || 'Failed to create terminal', 'error');
          return;
        }
        terminalId = result.terminalId;
      } else {
        // Browser: use HTTP API (existing path)
        const res = await fetch('/api/terminals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host: window.location.hostname || 'localhost',
            workingDir: workingDir || '~',
            command: command || 'claude',
            label: selectedLabel || undefined,
            sessionTitle: sessionTitle.trim() || undefined,
            effortLevel: effortLevel || undefined,
            model: model || undefined,
            enableOpsTerminal: enableOpsTerminal || undefined,
            remoteControlName: remoteControlPayload,
            forceNew: true,
          }),
        });
        const data = await res.json();
        if (!data.ok) {
          showToast(data.error || 'Failed to launch session', 'error');
          return;
        }
        terminalId = data.terminalId;
      }

      saveSessionPrefs({ model: model || undefined, effortLevel: effortLevel || undefined });
      saveRemoteControlSettings({
        enabled: enableRemoteControl,
        autoEnable: autoEnableRemoteControl,
        lastName: remoteControlNameTouched ? remoteControlName : undefined,
      });
      showToast(`Quick session launched${selectedLabel ? ` [${selectedLabel}]` : ''}`, 'success');
      if (terminalId) {
        useSessionStore.getState().selectSession(terminalId);
        if (roomId) {
          useRoomStore.getState().addSession(roomId, terminalId);
        }
      }
      closeModal();
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

          {/* Model + Effort level (Claude only) */}
          {command.trim().toLowerCase().startsWith('claude') && (
          <div className={styles.quickWorkdirRow} style={{ display: 'flex', gap: '8px' }}>
            <div style={{ flex: 1 }}>
              <label>Model</label>
              <Combobox
                value={model}
                onChange={setModel}
                items={['opus', 'sonnet', 'haiku']}
                placeholder="Default"
              />
            </div>
            <div style={{ flex: 1 }}>
              <label>Effort Level</label>
              <Combobox
                value={effortLevel}
                onChange={setEffortLevel}
                items={[...EFFORT_LEVELS]}
                placeholder="high"
              />
            </div>
          </div>
          )}

          {/* Remote control (Claude only) */}
          {isClaudeCommand && (
            <div className={styles.quickWorkdirRow}>
              <label className={styles.opsCheckboxRow} style={{ marginBottom: 4 }}>
                <input
                  type="checkbox"
                  checked={enableRemoteControl}
                  onChange={(e) => setEnableRemoteControl(e.target.checked)}
                />
                <div className={styles.opsCheckboxText}>
                  <span className={styles.opsCheckboxLabel}>Enable Remote Control</span>
                  <span className={styles.opsCheckboxHint}>Auto-runs <code>/remote-control &lt;name&gt;</code> after Claude starts</span>
                </div>
              </label>
              {enableRemoteControl && (
                <input
                  value={remoteControlNameTouched ? remoteControlName : autoRemoteControlName}
                  onChange={(e) => {
                    setRemoteControlName(e.target.value);
                    setRemoteControlNameTouched(true);
                  }}
                  placeholder={autoRemoteControlName}
                  style={{ marginTop: 4 }}
                />
              )}
              <label className={styles.opsCheckboxRow} style={{ marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={autoEnableRemoteControl}
                  onChange={(e) => setAutoEnableRemoteControl(e.target.checked)}
                />
                <div className={styles.opsCheckboxText}>
                  <span className={styles.opsCheckboxLabel}>Auto-enable for future Claude sessions</span>
                  <span className={styles.opsCheckboxHint}>Pre-checks the box above whenever the command starts with <code>claude</code></span>
                </div>
              </label>
            </div>
          )}

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
