/**
 * NewSessionModal - Full SSH terminal creation form.
 * Fields: host, port, username, auth method, key path, working dir,
 * tmux mode, tmux session, command, API key, session title, label.
 */
import { useState, useEffect, useCallback } from 'react';
import type { TmuxSessionInfo, SshKeyInfo } from '@/types';
import type { CreateTerminalRequest } from '@/types/api';
import Modal from '@/components/ui/Modal';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/Modal.module.css';

// ---------------------------------------------------------------------------
// Working directory history (localStorage)
// ---------------------------------------------------------------------------

const WORKDIR_HISTORY_KEY = 'workdir-history';
const MAX_WORKDIR_HISTORY = 20;

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
  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [authMethod, setAuthMethod] = useState<'key' | 'password'>('key');
  const [privateKeyPath, setPrivateKeyPath] = useState('');
  const [password, setPassword] = useState('');
  const [workingDir, setWorkingDir] = useState('~');
  const [useTmux, setUseTmux] = useState(false);
  const [tmuxSession, setTmuxSession] = useState('');
  const [command, setCommand] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [sessionTitle, setSessionTitle] = useState('');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // SSH keys + tmux sessions from server
  const [sshKeys, setSshKeys] = useState<SshKeyInfo[]>([]);
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionInfo[]>([]);
  const [tmuxLoading, setTmuxLoading] = useState(false);

  // Working directory history
  const [workdirHistory] = useState(() => loadWorkdirHistory());

  // Fetch SSH keys on mount
  useEffect(() => {
    fetch('/api/ssh-keys')
      .then((r) => r.json())
      .then((data: { keys: SshKeyInfo[] }) => setSshKeys(data.keys ?? []))
      .catch(() => {});
  }, []);

  const fetchTmuxSessions = useCallback(async () => {
    if (!host || !username) return;
    setTmuxLoading(true);
    try {
      const res = await fetch('/api/tmux-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host,
          port: Number(port) || 22,
          username,
          authMethod,
          privateKeyPath: authMethod === 'key' ? privateKeyPath : undefined,
          password: authMethod === 'password' ? password : undefined,
        }),
      });
      const data = await res.json();
      setTmuxSessions(data.sessions ?? []);
    } catch {
      setTmuxSessions([]);
    } finally {
      setTmuxLoading(false);
    }
  }, [host, port, username, authMethod, privateKeyPath, password]);

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);

    const body: CreateTerminalRequest = {
      host: host || 'localhost',
      port: Number(port) || 22,
      username: username || '',
      authMethod,
      privateKeyPath: authMethod === 'key' && privateKeyPath ? privateKeyPath : undefined,
      password: authMethod === 'password' && password ? password : undefined,
      workingDir: workingDir || '~',
      command: command || undefined,
      apiKey: apiKey || undefined,
      useTmux: useTmux || undefined,
      tmuxSession: useTmux && tmuxSession ? tmuxSession : undefined,
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
    <Modal modalId="new-session" title="New Terminal Session">
      <div className={styles.newSessionBody}>
        {/* Mode toggle: Direct SSH / Tmux */}
        <div className={styles.sshModeToggle}>
          <button
            type="button"
            className={`${styles.sshModeBtn} ${!useTmux ? styles.active : ''}`}
            onClick={() => setUseTmux(false)}
          >
            DIRECT
          </button>
          <button
            type="button"
            className={`${styles.sshModeBtn} ${useTmux ? styles.active : ''}`}
            onClick={() => setUseTmux(true)}
          >
            TMUX
          </button>
        </div>

        {/* Host + Port */}
        <div className={styles.sshFieldRow}>
          <div className={`${styles.sshField} ${styles.sshFieldGrow}`}>
            <label>Host</label>
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="localhost" />
          </div>
          <div className={`${styles.sshField} ${styles.sshFieldSmall}`}>
            <label>Port</label>
            <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" />
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
          <select value={authMethod} onChange={(e) => setAuthMethod(e.target.value as 'key' | 'password')}>
            <option value="key">SSH Key</option>
            <option value="password">Password</option>
          </select>
        </div>

        {/* Key path or password */}
        {authMethod === 'key' ? (
          <div className={styles.sshField}>
            <label>
              Private Key Path <span className={styles.sshFieldHint}>(optional)</span>
            </label>
            <select
              value={privateKeyPath}
              onChange={(e) => setPrivateKeyPath(e.target.value)}
            >
              <option value="">Default (~/.ssh/id_*)</option>
              {sshKeys.map((k) => (
                <option key={k.path} value={k.path}>{k.name}</option>
              ))}
            </select>
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
          <input
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            placeholder="~"
            list="workdir-history"
          />
          {workdirHistory.length > 0 && (
            <datalist id="workdir-history">
              {workdirHistory.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          )}
        </div>

        {/* Tmux session list */}
        {useTmux && (
          <div className={styles.sshField}>
            <label>
              Tmux Session
              <button
                type="button"
                className={styles.sshTmuxRefresh}
                onClick={fetchTmuxSessions}
                title="Refresh tmux sessions"
              >
                &#x21bb;
              </button>
            </label>
            <div className={styles.sshTmuxList}>
              {tmuxLoading && <div className={styles.sshTmuxLoading}>Loading...</div>}
              {!tmuxLoading && tmuxSessions.length === 0 && (
                <div className={styles.sshTmuxEmpty}>No tmux sessions found</div>
              )}
              {tmuxSessions.map((s) => (
                <div
                  key={s.name}
                  className={`${styles.sshTmuxItem} ${tmuxSession === s.name ? styles.selected : ''}`}
                  onClick={() => setTmuxSession(s.name)}
                >
                  <span className={styles.sshTmuxName}>{s.name}</span>
                  <span className={styles.sshTmuxMeta}>
                    {s.windows} win{s.windows !== 1 ? 's' : ''} {s.attached ? '(attached)' : ''}
                  </span>
                </div>
              ))}
            </div>
            <input
              value={tmuxSession}
              onChange={(e) => setTmuxSession(e.target.value)}
              placeholder="Or type new session name"
              style={{ marginTop: '4px' }}
            />
          </div>
        )}

        {/* Command */}
        <div className={styles.sshField}>
          <label>
            Command <span className={styles.sshFieldHint}>(runs after connect)</span>
          </label>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
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
            <select value={label} onChange={(e) => setLabel(e.target.value)}>
              <option value="">None</option>
              <option value="ONEOFF">ONEOFF</option>
              <option value="HEAVY">HEAVY</option>
              <option value="IMPORTANT">IMPORTANT</option>
            </select>
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
          {submitting ? 'CREATING...' : 'CREATE'}
        </button>
      </div>
    </Modal>
  );
}
