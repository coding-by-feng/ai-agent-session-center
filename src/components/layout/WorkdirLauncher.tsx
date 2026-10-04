/**
 * WorkdirLauncher - Dropdown popover in the NavBar that lists recent working
 * directories. Each directory row carries a Claude / Codex launch
 * button; clicking one starts a local terminal session in that directory
 * running the chosen CLI.
 */
import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useKnownProjects } from '@/hooks/useKnownProjects';
import { useUiStore } from '@/stores/uiStore';
import { launchSession, shortenPath } from '@/lib/launchSession';
import { computeMovePickerPosition } from '@/lib/queueMovePlacement';
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
  // Open state lives in uiStore, not here, so the LIVE page's "no sessions
  // yet" card can open this dropdown under the top bar's DIRS.
  const open = useUiStore((s) => s.workdirLauncherOpen);
  const setOpen = useUiStore((s) => s.setWorkdirLauncherOpen);
  const [dirs, setDirs] = useState<string[]>([]);
  const knownProjects = useKnownProjects();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Where focus was when the dropdown was opened from elsewhere (the LIVE
   *  page's "no sessions yet" card); Escape hands it back there. */
  const openerRef = useRef<HTMLElement | null>(null);
  const focusIntoMenu = useRef(false);

  const close = useCallback(() => setOpen(false), [setOpen]);

  // The open state outlives this component (it lives in uiStore), and the top
  // bar unmounts whenever a session panel opens. Close on unmount, or the
  // dropdown reappears by itself when the panel closes again.
  useEffect(() => () => setOpen(false), [setOpen]);

  // Placed with fixed coordinates from the DIRS button's viewport rect. Below
  // 640px the top bar is a sideways scroller (overflow-x: auto), which clips an
  // absolutely positioned child to the bar's own height — the dropdown opened
  // and could not be seen. `position: fixed` escapes that clip while the menu
  // stays inside this component's DOM, so click-outside and the top bar's
  // stacking order are unchanged. Written straight to two CSS variables
  // (no render); re-placed when the list loads, on resize and on any scroll.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const r = trigger.getBoundingClientRect();
      const { top, left } = computeMovePickerPosition(
        { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
        { width: menu.offsetWidth, height: menu.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        'left',
      );
      menu.style.setProperty('--dd-top', `${top}px`);
      menu.style.setProperty('--dd-left', `${left}px`);
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open, dirs]);

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

  // Opened from elsewhere — focus is outside this component, typically on the
  // LIVE page's card: the menu sits in the top bar, far back in tab order, and
  // below 640px the bar may be scrolled sideways. Bring the button into view
  // and move focus into the menu once its list has rendered (below).
  useLayoutEffect(() => {
    if (!open) {
      openerRef.current = null;
      focusIntoMenu.current = false;
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body || wrapperRef.current?.contains(active)) return;
    openerRef.current = active;
    focusIntoMenu.current = true;
    triggerRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [open]);

  useEffect(() => {
    if (!open || !focusIntoMenu.current) return;
    // The list loads in an effect after opening, so the first pass can still be
    // empty: hold focus on the menu itself and move on once a button exists.
    const first = menuRef.current?.querySelector<HTMLElement>('button');
    if (first) {
      first.focus();
      focusIntoMenu.current = false;
    } else {
      menuRef.current?.focus();
    }
  }, [open, dirs]);

  // Escape key closes dropdown (and hands focus back if it was taken from elsewhere)
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        const opener = openerRef.current;
        close();
        if (opener?.isConnected) opener.focus();
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
        ref={triggerRef}
        className={`${styles.triggerBtn} ${open ? styles.open : ''}`}
        onClick={() => setOpen(!open)}
        title="Recent working directories"
        aria-haspopup="true"
        aria-expanded={open}
      >
        DIRS
      </button>

      {open && (
        <div className={styles.dropdown} ref={menuRef} tabIndex={-1}>
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
