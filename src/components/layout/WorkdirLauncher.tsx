/**
 * WorkdirLauncher - Dropdown popover in the NavBar that lists recent working
 * directories. Clicking a directory instantly launches a terminal session
 * in that directory using saved connection config from localStorage.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useClickOutside } from '@/hooks/useClickOutside';
import { showToast } from '@/components/ui/ToastContainer';
import { useSessionStore } from '@/stores/sessionStore';
import { useKnownProjects } from '@/hooks/useKnownProjects';
import styles from '@/styles/modules/WorkdirLauncher.module.css';

const WORKDIR_HISTORY_KEY = 'workdir-history';
const LAST_SESSION_KEY = 'lastSession';

interface LastSessionConfig {
  host?: string;
  port?: number;
  username?: string;
  authMethod?: 'key' | 'password';
  privateKeyPath?: string;
  command?: string;
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

function loadLastSession(): LastSessionConfig {
  try {
    return JSON.parse(localStorage.getItem(LAST_SESSION_KEY) || '{}');
  } catch {
    return {};
  }
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

  async function handleLaunch(workingDir: string) {
    close();

    const saved = loadLastSession();

    try {
      const res = await fetch('/api/terminals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: saved.host || window.location.hostname || 'localhost',
          port: saved.port || undefined,
          username: saved.username || undefined,
          authMethod: saved.authMethod || undefined,
          privateKeyPath: saved.privateKeyPath || undefined,
          workingDir,
          command: saved.command || 'claude',
        }),
      });
      const data = await res.json();
      if (data.ok) {
        // Auto-select the new session so the detail panel stays open
        if (data.terminalId) {
          useSessionStore.getState().selectSession(data.terminalId);
        }
        showToast(`Session launched in ${shortenPath(workingDir)}`, 'success');
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
              <div
                key={dir}
                className={styles.dirItem}
                onClick={() => handleLaunch(dir)}
                title={`Launch session in ${dir}`}
              >
                <div className={styles.dirInfo}>
                  <span className={styles.dirName}>{shortenPath(dir)}</span>
                  <span className={styles.dirPath}>{dir}</span>
                </div>
                <button
                  className={styles.dirRemove}
                  onClick={(e) => handleRemove(dir, e)}
                  title="Remove from history"
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
