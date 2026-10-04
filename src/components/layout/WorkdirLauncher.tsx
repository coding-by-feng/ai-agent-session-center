/**
 * WorkdirLauncher - Dropdown popover in the NavBar that lists recent working
 * directories. Each directory row carries a Claude / Codex launch
 * button; clicking one starts a local terminal session in that directory
 * running the chosen CLI.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useKnownProjects } from '@/hooks/useKnownProjects';
import { launchSession, shortenPath } from '@/lib/launchSession';
import { CLI_LAUNCHERS } from './cliLaunchers';
import styles from '@/styles/modules/WorkdirLauncher.module.css';

const WORKDIR_HISTORY_KEY = 'workdir-history';

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
    // The command is the CLI the user explicitly picked (claude/codex). No
    // forceNew: relaunching a directory that already runs that CLI reuses the
    // running session (the project frames in the session strip do force one).
    await launchSession({ workingDir, command });
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
                  {CLI_LAUNCHERS.map(({ command, label, Icon }) => (
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
