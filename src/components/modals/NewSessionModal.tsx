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
import { useSessionStore } from '@/stores/sessionStore';
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
// Command history (localStorage)
// ---------------------------------------------------------------------------

const COMMAND_HISTORY_KEY = 'command-history';
const MAX_COMMAND_HISTORY = 20;

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
  'codex',
  'aider',
];

function loadCommandHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(COMMAND_HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

/** Merge user history (on top) with defaults, deduplicated. */
function getCommandSuggestions(): string[] {
  const history = loadCommandHistory();
  const seen = new Set(history);
  const merged = [...history];
  for (const cmd of DEFAULT_COMMANDS) {
    if (!seen.has(cmd)) merged.push(cmd);
  }
  return merged;
}

function saveCommand(cmd: string): void {
  if (!cmd) return;
  const history = loadCommandHistory().filter((c) => c !== cmd);
  history.unshift(cmd);
  localStorage.setItem(COMMAND_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_COMMAND_HISTORY)));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function NewSessionModal() {
  const [saved] = useState(() => loadLastSession());
  const [host, setHost] = useState(window.location.hostname || saved.host || 'localhost');
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
  const [submitting, setSubmitting] = useState(false);

  // SSH keys from server
  const [sshKeys, setSshKeys] = useState<SshKeyInfo[]>([]);

  // Working directory history (merged with known Claude Code projects)
  const workdirHistory = useKnownProjects();

  // Command history
  const commandSuggestions = useMemo(() => getCommandSuggestions(), []);

  // Fetch SSH keys on mount
  useEffect(() => {
    fetch('/api/ssh-keys')
      .then((r) => r.json())
      .then((data: { keys: SshKeyInfo[] }) => setSshKeys(data.keys ?? []))
      .catch(() => {});
  }, []);

  // #33: Client-side form validation
  const portNum = Number(port);
  const portValid = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const formValid = portValid;

  async function handleSubmit() {
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
        }
        showToast('Terminal session created', 'success');
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
            <label>Host</label>
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="localhost" />
          </div>
          <div className={`${styles.sshField} ${styles.sshFieldSmall}`}>
            <label>Port</label>
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="22"
              style={port && !portValid ? { borderColor: '#ff5555' } : undefined}
            />
            {port && !portValid && (
              <span style={{ color: '#ff5555', fontSize: 10 }}>1-65535</span>
            )}
          </div>
        </div>

        {/* Username */}
        <div className={styles.sshField}>
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Optional" />
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
          <label>Working Directory</label>
          <Combobox
            value={workingDir}
            onChange={setWorkingDir}
            items={workdirHistory}
            placeholder="~"
          />
        </div>

        {/* Command */}
        <div className={styles.sshField}>
          <label>
            Command <span className={styles.sshFieldHint}>(runs after connect)</span>
          </label>
          <Combobox
            value={command}
            onChange={setCommand}
            items={commandSuggestions}
            placeholder="e.g. claude"
          />
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
      </div>

      <div className={styles.newSessionFooter}>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={() => {/* closed via Modal overlay */}}
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
