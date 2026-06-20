/**
 * NewSessionModal - Local terminal creation form.
 * Fields: working dir, command, session title, room, API key,
 * remote control, model, effort level, commands terminal.
 */
import { useState, useMemo } from 'react';
import type { CreateTerminalRequest } from '@/types/api';
import Modal from '@/components/ui/Modal';
import Combobox from '@/components/ui/Combobox';
import BrowseDirButton from '@/components/ui/BrowseDirButton';
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
  MODEL_OPTIONS,
  normalizeEffortLevel,
} from '@/lib/remoteControlName';
import styles from '@/styles/modules/Modal.module.css';

// ---------------------------------------------------------------------------
// Working directory history (localStorage)
// ---------------------------------------------------------------------------

const WORKDIR_HISTORY_KEY = 'workdir-history';
const MAX_WORKDIR_HISTORY = 20;
const LAST_SESSION_KEY = 'lastSession';
const DIR_SESSION_CONFIGS_KEY = 'dir-session-configs';

interface LastSessionConfig {
  workingDir?: string;
  command?: string;
}

function loadLastSession(): LastSessionConfig {
  try {
    return JSON.parse(localStorage.getItem(LAST_SESSION_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveLastSession(config: LastSessionConfig): void {
  try {
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(config));
  } catch { /* ignore quota errors */ }
}

function saveDirSessionConfig(dir: string, config: LastSessionConfig): void {
  if (!dir) return;
  try {
    const all: Record<string, LastSessionConfig> = JSON.parse(
      localStorage.getItem(DIR_SESSION_CONFIGS_KEY) || '{}',
    );
    all[dir] = { ...config, workingDir: dir };
    localStorage.setItem(DIR_SESSION_CONFIGS_KEY, JSON.stringify(all));
  } catch { /* ignore quota errors */ }
}

function loadWorkdirHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(WORKDIR_HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveWorkdir(dir: string): void {
  if (!dir) return;
  const history = loadWorkdirHistory().filter((d) => d !== dir);
  history.unshift(dir);
  localStorage.setItem(WORKDIR_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_WORKDIR_HISTORY)));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function NewSessionModal() {
  const closeModal = useUiStore((s) => s.closeModal);
  const [saved] = useState(() => loadLastSession());
  const [workingDir, setWorkingDir] = useState(saved.workingDir || '~');
  const [command, setCommand] = useState(saved.command || '');
  const [apiKey, setApiKey] = useState('');
  const [sessionTitle, setSessionTitle] = useState('');
  const [roomId, setRoomId] = useState('');
  const [sessionPrefs] = useState(() => loadSessionPrefs());
  const [effortLevel, setEffortLevel] = useState(normalizeEffortLevel(sessionPrefs.effortLevel));
  const [model, setModel] = useState(sessionPrefs.model || '');
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
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Working directory history (merged with known Claude Code projects)
  const workdirHistory = useKnownProjects();

  // Command history
  const commandSuggestions = useMemo(() => getCommandSuggestions(), []);

  // Rooms
  const rooms = useRoomStore((s) => s.rooms);
  const roomOptions = useMemo(() => rooms.map((r) => r.name), [rooms]);

  const isClaudeCommand = command.trim().toLowerCase().startsWith('claude');
  const autoRemoteControlName = useMemo(
    () => deriveRemoteControlName(sessionTitle, workingDir, useSessionStore.getState().sessions.values()),
    [sessionTitle, workingDir],
  );
  const effectiveRemoteControlName = remoteControlNameTouched && remoteControlName
    ? sanitizeRemoteControlName(remoteControlName)
    : autoRemoteControlName;

  // #33: Client-side form validation — required fields
  const workingDirValid = workingDir.trim().length > 0;
  const commandValid = command.trim().length > 0;
  const formValid = workingDirValid && commandValid;

  async function handleSubmit() {
    // Mark all required fields as touched so validation errors show
    setTouched({ workingDir: true, command: true });
    if (submitting || !formValid) return;
    setSubmitting(true);

    // No host/username — the server resolves a host-less request to a local
    // PTY and falls back to the OS user.
    const body: CreateTerminalRequest = {
      workingDir: workingDir || '~',
      command: command || undefined,
      apiKey: apiKey || undefined,
      sessionTitle: sessionTitle || undefined,
      effortLevel: effortLevel || undefined,
      model: model || undefined,
      enableOpsTerminal: enableOpsTerminal || undefined,
      remoteControlName:
        isClaudeCommand && enableRemoteControl && effectiveRemoteControlName
          ? effectiveRemoteControlName
          : undefined,
      forceNew: true,
    };

    try {
      const res = await fetch('/api/terminals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        saveWorkdir(workingDir);
        if (command) saveCommand(command);
        const configToSave: LastSessionConfig = {
          workingDir: workingDir || '~',
          command: command || undefined,
        };
        saveLastSession(configToSave);
        saveDirSessionConfig(workingDir || '~', configToSave);
        saveSessionPrefs({ model: model || undefined, effortLevel: effortLevel || undefined });
        saveRemoteControlSettings({
          enabled: enableRemoteControl,
          autoEnable: autoEnableRemoteControl,
          lastName: remoteControlNameTouched ? remoteControlName : undefined,
        });
        // Auto-select the new session so the detail panel stays open
        if (data.terminalId) {
          useSessionStore.getState().selectSession(data.terminalId);
          // Assign to selected room
          if (roomId) {
            useRoomStore.getState().addSession(roomId, data.terminalId);
          }
        }
        showToast('Terminal session created', 'success');
        closeModal();
      } else {
        showToast(data.error || 'Failed to create terminal', 'error');
      }
    } catch (err) {
      showToast('Network error creating terminal', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal modalId="new-session" title="New Terminal Session" panelClassName={styles.newSessionPanel}>
      <div className={styles.newSessionBody}>
        {/* Working directory */}
        <div className={styles.sshField}>
          <label>Working Directory <span className={styles.sshFieldRequired}>*</span></label>
          <div className={styles.workdirInputRow}>
            <Combobox
              value={workingDir}
              onChange={setWorkingDir}
              items={workdirHistory}
              placeholder="~"
              className={styles.workdirCombo}
            />
            <BrowseDirButton onPick={setWorkingDir} defaultPath={workingDir} />
          </div>
          {touched.workingDir && !workingDirValid && (
            <span className={styles.sshFieldError}>Required</span>
          )}
        </div>

        {/* Command */}
        <div className={styles.sshField}>
          <label>
            Command <span className={styles.sshFieldRequired}>*</span> <span className={styles.sshFieldHint}>(runs in directory)</span>
          </label>
          <Combobox
            value={command}
            onChange={setCommand}
            items={commandSuggestions}
            placeholder="e.g. claude"
          />
          {touched.command && !commandValid && (
            <span className={styles.sshFieldError}>Required</span>
          )}
        </div>

        {/* Session title */}
        <div className={styles.sshField}>
          <label>Session Title</label>
          <input value={sessionTitle} onChange={(e) => setSessionTitle(e.target.value)} placeholder="Optional" />
        </div>

        {/* Room */}
        <div className={styles.sshField}>
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

        {/* API key */}
        <div className={styles.sshField}>
          <label>
            API Key <span className={styles.sshFieldHint}>(override ANTHROPIC_API_KEY)</span>
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Optional"
          />
        </div>

        {/* Remote control (Claude only) */}
        {isClaudeCommand && (
          <div className={styles.sshField}>
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

        {/* Model + Effort level (Claude only) */}
        {command.trim().toLowerCase().startsWith('claude') && (
        <div className={styles.sshFieldRow}>
          <div className={`${styles.sshField} ${styles.sshFieldGrow}`}>
            <label>Model</label>
            <Combobox
              value={model}
              onChange={setModel}
              items={[...MODEL_OPTIONS]}
              placeholder="Default"
            />
          </div>
          <div className={`${styles.sshField} ${styles.sshFieldGrow}`}>
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

      <div className={styles.newSessionFooter}>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={() => closeModal()}
          style={{ fontSize: '11px', letterSpacing: '1px' }}
        >
          CANCEL
        </button>
        <button
          type="button"
          onClick={handleSubmit}
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
            cursor: submitting ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.5 : 1,
          }}
        >
          {submitting ? 'CREATING...' : 'CREATE'}
        </button>
      </div>
    </Modal>
  );
}
