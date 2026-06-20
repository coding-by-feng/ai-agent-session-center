/**
 * WorkdirLauncher - Dropdown popover in the NavBar that lists recent working
 * directories. Each directory row carries a Claude / Codex / Gemini launch
 * button; clicking one starts a local terminal session in that directory
 * running the chosen CLI.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useClickOutside } from '@/hooks/useClickOutside';
import { showToast } from '@/components/ui/ToastContainer';
import { useSessionStore } from '@/stores/sessionStore';
import { useKnownProjects } from '@/hooks/useKnownProjects';
import { ClaudeIcon, CodexIcon, GeminiIcon } from './CliBrandIcons';
import styles from '@/styles/modules/WorkdirLauncher.module.css';

const WORKDIR_HISTORY_KEY = 'workdir-history';
const DIR_SESSION_CONFIGS_KEY = 'dir-session-configs';

/** The CLIs the launcher can start, with their official-style brand icons. */
const CLI_OPTIONS = [
  { command: 'claude', label: 'Claude', Icon: ClaudeIcon },
  { command: 'codex', label: 'Codex', Icon: CodexIcon },
  { command: 'gemini', label: 'Gemini', Icon: GeminiIcon },
] as const;

interface DirSessionConfig {
  command?: string;
  workingDir?: string;
}

function loadWorkdirHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(WORKDIR_HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveWorkdirHistory(dirs: string[]): void {
  localStorage.setItem(WORKDIR_HISTORY_KEY, JSON.stringify(dirs));
}

/** Remember the last CLI launched in a directory (read by the session modals). */
function saveDirSessionConfig(dir: string, config: DirSessionConfig): void {
  if (!dir) return;
  try {
    const all: Record<string, DirSessionConfig> = JSON.parse(
      localStorage.getItem(DIR_SESSION_CONFIGS_KEY) || '{}',
    );
    all[dir] = { ...config, workingDir: dir };
    localStorage.setItem(DIR_SESSION_CONFIGS_KEY, JSON.stringify(all));
  } catch { /* ignore quota errors */ }
}

/** Extract the last meaningful segment from a path for display. */
function shortenPath(fullPath: string): string {
  const normalized = fullPath.replace(/\/+$/, '');
  if (normalized === '~' || normalized === '/') return normalized;
  const segments = normalized.split('/');
  return segments[segments.length - 1] || normalized;
}

export default function WorkdirLauncher() {
  const [open, setOpen] = useState(false);
  const [dirs, setDirs] = useState<string[]>([]);
  const knownProjects = useKnownProjects();
  const wrapperRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useClickOutside(wrapperRef, close, open);

  // Reload history merged with known projects each time the dropdown opens
  useEffect(() => {
    if (open) {
      const history = loadWorkdirHistory();
      const seen = new Set(history);
      const merged = [...history];
      for (const dir of knownProjects) {
        if (!seen.has(dir)) {
          seen.add(dir);
          merged.push(dir);
        }
      }
      setDirs(merged);
    }
  }, [open, knownProjects]);

  // Escape key closes dropdown
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, close]);

  async function handleLaunch(workingDir: string, command: string) {
    close();

    // The command is the CLI the user explicitly picked (claude/codex/gemini).
    // No host/username — the server spawns a local PTY for host-less requests.
    const body = { workingDir, command };

    try {
      const res = await fetch('/api/terminals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        // Auto-select the new session so the detail panel stays open
        if (data.terminalId) {
          useSessionStore.getState().selectSession(data.terminalId);
        }
        // Remember the last CLI used for this directory (consumed by the
        // session-creation modals when they prefill a command).
        saveDirSessionConfig(workingDir, { command, workingDir });
        showToast(`Launched ${command} in ${shortenPath(workingDir)}`, 'success');
      } else {
        showToast(data.error || 'Failed to launch session', 'error');
      }
    } catch {
      showToast('Network error launching session', 'error');
    }
  }

  function handleRemove(dir: string, e: React.MouseEvent) {
    e.stopPropagation();
    const updated = dirs.filter((d) => d !== dir);
    setDirs(updated);
    saveWorkdirHistory(updated);
  }

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        className={`${styles.triggerBtn} ${open ? styles.open : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        title="Recent working directories"
      >
        DIRS
      </button>

      {open && (
        <div className={styles.dropdown}>
          <div className={styles.dropdownHeader}>Recent Directories</div>
          {dirs.length === 0 ? (
            <div className={styles.empty}>
              No directory history yet. Launch a session to start recording.
            </div>
          ) : (
            dirs.map((dir) => (
              <div key={dir} className={styles.dirItem}>
                <div className={styles.dirInfo} title={dir}>
                  <span className={styles.dirName}>{shortenPath(dir)}</span>
                  <span className={styles.dirPath}>{dir}</span>
                </div>
                <div className={styles.dirLaunchers}>
                  {CLI_OPTIONS.map(({ command, label, Icon }) => (
                    <button
                      key={command}
                      type="button"
                      className={styles.dirLaunchBtn}
                      onClick={() => handleLaunch(dir, command)}
                      title={`Launch ${label} in ${shortenPath(dir)}`}
                      aria-label={`Launch ${label} in ${shortenPath(dir)}`}
                    >
                      <Icon />
                    </button>
                  ))}
                </div>
                <button
                  className={styles.dirRemove}
                  onClick={(e) => handleRemove(dir, e)}
                  title="Remove from history"
                  aria-label="Remove from history"
                >
                  x
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
