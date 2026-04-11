/**
 * NewSessionModal - Full SSH terminal creation form.
 * Fields: host, port, username, auth method, key path, working dir,
 * tmux mode, tmux session, command, API key, session title, label.
 */
import { useState, useEffect, useMemo } from 'react';
import type { SshKeyInfo } from '@/types';
import type { CreateTerminalRequest } from '@/types/api';
import Modal from '@/components/ui/Modal';
import Combobox from '@/components/ui/Combobox';
import { showToast } from '@/components/ui/ToastContainer';
import { useUiStore } from '@/stores/uiStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { useKnownProjects } from '@/hooks/useKnownProjects';
import styles from '@/styles/modules/Modal.module.css';

// ---------------------------------------------------------------------------
// Working directory history (localStorage)
// ---------------------------------------------------------------------------

const WORKDIR_HISTORY_KEY = 'workdir-history';
const MAX_WORKDIR_HISTORY = 20;
const LAST_SESSION_KEY = 'lastSession';

interface LastSessionConfig {
  host?: string;
  port?: number;
  username?: string;
  authMethod?: 'key' | 'password';
  privateKeyPath?: string;
  workingDir?: string;
  command?: string;
  terminalTheme?: string;
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
// Host & username history (localStorage)
// ---------------------------------------------------------------------------

const HOST_HISTORY_KEY = 'host-history';
const USERNAME_HISTORY_KEY = 'username-history';
const MAX_HISTORY = 20;

function loadHistory(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    return [];
  }
}

function saveHistory(key: string, value: string, max = MAX_HISTORY): void {
  if (!value) return;
  const history = loadHistory(key).filter((v) => v !== value);
  history.unshift(value);
  localStorage.setItem(key, JSON.stringify(history.slice(0, max)));
}

function getHostSuggestions(): string[] {
  const history = loadHistory(HOST_HISTORY_KEY);
  const defaults = ['localhost'];
  const seen = new Set(history);
  const merged = [...history];
  for (const d of defaults) {
    if (!seen.has(d)) merged.push(d);
  }
  return merged;
}

function getUsernameSuggestions(): string[] {
  return loadHistory(USERNAME_HISTORY_KEY);
}

// ---------------------------------------------------------------------------
// Command history (localStorage)
// ---------------------------------------------------------------------------

const COMMAND_USAGE_KEY = 'command-usage-counts';

// Common CLI commands shown by default in the Command dropdown
const DEFAULT_COMMANDS: string[] = [
  'claude',
  'claude --resume',
  'claude --continue',
  'claude --model sonnet',
  'claude --model opus',
  'claude --dangerously-skip-permissions',
  'claude --verbose',
  'gemini',
  'gemini --yolo',
  'codex',
  'aider',
];

function loadCommandUsageCounts(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(COMMAND_USAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

/** Sort by usage frequency (most used first), then append unused defaults. */
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
// Component
// ---------------------------------------------------------------------------

export default function NewSessionModal() {
  const closeModal = useUiStore((s) => s.closeModal);
  const [saved] = useState(() => loadLastSession());
  const [host, setHost] = useState(saved.host || window.location.hostname || '');
  const [port, setPort] = useState(String(saved.port || 22));
  const [username, setUsername] = useState(saved.username || '');
  const [authMethod, setAuthMethod] = useState<'key' | 'password'>(saved.authMethod || 'key');
  const [privateKeyPath, setPrivateKeyPath] = useState(saved.privateKeyPath || '');
  const [password, setPassword] = useState('');
  const [workingDir, setWorkingDir] = useState(saved.workingDir || '~');
  const [command, setCommand] = useState(saved.command || '');
  const [apiKey, setApiKey] = useState('');
  const [sessionTitle, setSessionTitle] = useState('');
  const [label, setLabel] = useState('');
  const [roomId, setRoomId] = useState('');
  const [effortLevel, setEffortLevel] = useState('high');
  const [model, setModel] = useState('');
  const [enableOpsTerminal, setEnableOpsTerminal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // SSH keys from server
  const [sshKeys, setSshKeys] = useState<SshKeyInfo[]>([]);

  // Working directory history (merged with known Claude Code projects)
  const workdirHistory = useKnownProjects();

  // Host, username, and command history
  const hostSuggestions = useMemo(() => getHostSuggestions(), []);
  const usernameSuggestions = useMemo(() => getUsernameSuggestions(), []);
  const commandSuggestions = useMemo(() => getCommandSuggestions(), []);

  // Rooms
  const rooms = useRoomStore((s) => s.rooms);
  const roomOptions = useMemo(() => rooms.map((r) => r.name), [rooms]);

  // Fetch SSH keys on mount
  useEffect(() => {
    fetch('/api/ssh-keys')
      .then((r) => r.json())
      .then((data: { keys: SshKeyInfo[] }) => setSshKeys(data.keys ?? []))
      .catch(() => {});
  }, []);

  // Mark field as touched on blur
  const markTouched = (field: string) => () => setTouched((prev) => ({ ...prev, [field]: true }));

  // #33: Client-side form validation — required fields
  const portNum = Number(port);
  const portValid = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const hostValid = host.trim().length > 0;
  const usernameValid = username.trim().length > 0;
  const workingDirValid = workingDir.trim().length > 0;
  const commandValid = command.trim().length > 0;
  const formValid = portValid && hostValid && usernameValid && workingDirValid && commandValid;

  async function handleSubmit() {
    // Mark all required fields as touched so validation errors show
    setTouched({ host: true, port: true, username: true, workingDir: true, command: true });
    if (submitting || !formValid) return;
    setSubmitting(true);

    const body: CreateTerminalRequest = {
      host: host || window.location.hostname || 'localhost',
      port: portNum || 22,
      username: username || '',
      authMethod,
      privateKeyPath: authMethod === 'key' && privateKeyPath ? privateKeyPath : undefined,
      password: authMethod === 'password' && password ? password : undefined,
      workingDir: workingDir || '~',
      command: command || undefined,
      apiKey: apiKey || undefined,
      sessionTitle: sessionTitle || undefined,
      label: label || undefined,
      effortLevel: effortLevel || undefined,
      model: model || undefined,
      enableOpsTerminal: enableOpsTerminal || undefined,
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
        if (body.host) saveHistory(HOST_HISTORY_KEY, body.host);
        if (body.username) saveHistory(USERNAME_HISTORY_KEY, body.username);
        saveLastSession({
          host: body.host,
          port: body.port,
          username: body.username,
          authMethod,
          privateKeyPath: authMethod === 'key' ? privateKeyPath : undefined,
          workingDir: workingDir || '~',
          command: command || undefined,
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
        {/* Host + Port */}
        <div className={styles.sshFieldRow}>
          <div className={`${styles.sshField} ${styles.sshFieldGrow}`}>
            <label>Host <span className={styles.sshFieldRequired}>*</span></label>
            <Combobox
              value={host}
              onChange={(v) => { setHost(v); setTouched((t) => ({ ...t, host: true })); }}
              items={hostSuggestions}
              placeholder="hostname / IP / domain"
            />
            {touched.host && !hostValid && (
              <span className={styles.sshFieldError}>Required</span>
            )}
          </div>
          <div className={`${styles.sshField} ${styles.sshFieldSmall}`}>
            <label>Port <span className={styles.sshFieldRequired}>*</span></label>
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              onBlur={markTouched('port')}
              placeholder="22"
              style={port && !portValid ? { borderColor: '#ff5555' } : undefined}
            />
            {port && !portValid && (
              <span className={styles.sshFieldError}>1-65535</span>
            )}
          </div>
        </div>

        {/* Username */}
        <div className={styles.sshField}>
          <label>Username <span className={styles.sshFieldRequired}>*</span></label>
          <Combobox
            value={username}
            onChange={(v) => { setUsername(v); setTouched((t) => ({ ...t, username: true })); }}
            items={usernameSuggestions}
            placeholder="e.g. root"
          />
          {touched.username && !usernameValid && (
            <span className={styles.sshFieldError}>Required</span>
          )}
        </div>

        {/* Auth method */}
        <div className={styles.sshField}>
          <label>Auth Method</label>
          <Combobox
            value={authMethod === 'key' ? 'SSH Key' : 'Password'}
            onChange={(v) => setAuthMethod(v === 'Password' ? 'password' : 'key')}
            items={['SSH Key', 'Password']}
            placeholder="SSH Key"
          />
        </div>

        {/* Key path or password */}
        {authMethod === 'key' ? (
          <div className={styles.sshField}>
            <label>
              Private Key Path <span className={styles.sshFieldHint}>(optional)</span>
            </label>
            <Combobox
              value={privateKeyPath}
              onChange={setPrivateKeyPath}
              items={sshKeys.map((k) => k.path)}
              placeholder="Default (~/.ssh/id_*)"
            />
          </div>
        ) : (
          <div className={styles.sshField}>
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="SSH password"
            />
          </div>
        )}

        {/* Working directory */}
        <div className={styles.sshField}>
          <label>Working Directory <span className={styles.sshFieldRequired}>*</span></label>
          <Combobox
            value={workingDir}
            onChange={setWorkingDir}
            items={workdirHistory}
            placeholder="~"
          />
          {touched.workingDir && !workingDirValid && (
            <span className={styles.sshFieldError}>Required</span>
          )}
        </div>

        {/* Command */}
        <div className={styles.sshField}>
          <label>
            Command <span className={styles.sshFieldRequired}>*</span> <span className={styles.sshFieldHint}>(runs after connect)</span>
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

        {/* Session title + label */}
        <div className={styles.sshFieldRow}>
          <div className={`${styles.sshField} ${styles.sshFieldGrow}`}>
            <label>Session Title</label>
            <input value={sessionTitle} onChange={(e) => setSessionTitle(e.target.value)} placeholder="Optional" />
          </div>
          <div className={`${styles.sshField} ${styles.sshFieldGrow}`}>
            <label>Label</label>
            <Combobox
              value={label}
              onChange={setLabel}
              items={['ONEOFF', 'HEAVY', 'IMPORTANT']}
              placeholder="None"
            />
          </div>
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

        {/* Model + Effort level (Claude only) */}
        {command.trim().toLowerCase().startsWith('claude') && (
        <div className={styles.sshFieldRow}>
          <div className={`${styles.sshField} ${styles.sshFieldGrow}`}>
            <label>Model</label>
            <Combobox
              value={model}
              onChange={setModel}
              items={['opus', 'sonnet', 'haiku']}
              placeholder="Default"
            />
          </div>
          <div className={`${styles.sshField} ${styles.sshFieldGrow}`}>
            <label>Effort Level</label>
            <Combobox
              value={effortLevel}
              onChange={setEffortLevel}
              items={['min', 'low', 'medium', 'high', 'max']}
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
