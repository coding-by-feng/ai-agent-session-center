/**
 * WorkdirLauncher - Dropdown popover that lists recent working directories.
 * Each directory row carries a Claude / Codex launch button; clicking one
 * starts a local terminal session in that directory running the chosen CLI.
 *
 * Two hosts: a folder-and-clock icon in the session panel's strip, and the DIRS
 * button on the LIVE page's "no sessions yet" card (with no session there is no
 * panel). The top bar's DIRS was removed in Oct 2026.
 *
 * Every copy keeps its own open state and portals its menu to <body>.
 * DetailPanel leaves the strip mounted (hidden) after the panel closes, so two
 * copies can be mounted at once; a shared flag would open the hidden copy too,
 * whose click-outside then shuts the visible menu on the mousedown meant to
 * launch. The portal is because the panel's `will-change: transform` would
 * otherwise become the containing block of the menu's `position: fixed`.
 */
import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo, useId } from 'react';
import { createPortal } from 'react-dom';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useKnownProjects } from '@/hooks/useKnownProjects';
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

interface WorkdirLauncherProps {
  /** Text for the trigger in place of the folder-and-clock icon: the LIVE
   *  card's "DIRS", which then also names the button. */
  label?: string;
  /** The trigger's class for an open state. Each host styles its own trigger,
   *  so it matches the row it sits in. */
  triggerClassName: (open: boolean) => string;
}

/** A folder with a clock in its corner: RECENT directories, the strip copy's
 *  trigger. Not a plain folder: in the Projects view the view menu beside it
 *  already shows one, meaning "this view". */
function RecentDirsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M6.8 11.5H2.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3.1l1.4 1.5h4.5a1 1 0 0 1 1 1v1.7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10.4" cy="10.4" r="2.85" stroke="currentColor" strokeWidth="1.1" />
      <path d="M10.4 9v1.5l1 .7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function WorkdirLauncher({ label, triggerClassName }: WorkdirLauncherProps) {
  const hasLabel = Boolean(label);
  const [open, setOpen] = useState(false);
  const [dirs, setDirs] = useState<string[]>([]);
  const knownProjects = useKnownProjects();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** The trigger, when the menu was opened from the keyboard: Escape hands
   *  focus back to it. */
  const openerRef = useRef<HTMLElement | null>(null);
  const focusIntoMenu = useRef(false);
  const menuId = useId();

  const close = useCallback(() => setOpen(false), []);

  // Placed with fixed coordinates from the trigger's viewport rect, so no
  // ancestor's overflow crops it (the rail and the card both scroll). Written
  // straight to two CSS variables (no render); re-placed when the list loads,
  // on resize and on any scroll.
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

  // The menu is portaled out of this subtree, so a click on it must count as
  // inside too.
  const insideRefs = useMemo(() => [wrapperRef, menuRef], []);
  useClickOutside(insideRefs, close, open);

  // The host can stop being visible while this stays mounted, and the portaled
  // menu does not go with it. A deselect hides the strip (display: none: the
  // trigger leaves layout, which a ResizeObserver sees); the terminal's
  // fullscreen hides the whole panel with visibility: hidden (body.term-fullscreen,
  // which keeps the trigger's box, so only the class change shows it). Close on either.
  useEffect(() => {
    const trigger = triggerRef.current;
    if (!open || !trigger) return;
    const resize = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (trigger.getClientRects().length === 0) setOpen(false);
        });
    resize?.observe(trigger);
    const fullscreen = new MutationObserver(() => {
      if (document.body.classList.contains('term-fullscreen')) setOpen(false);
    });
    fullscreen.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => {
      resize?.disconnect();
      fullscreen.disconnect();
    };
  }, [open]);

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

  useLayoutEffect(() => {
    if (open) return;
    openerRef.current = null;
    focusIntoMenu.current = false;
  }, [open]);

  // Opened from the keyboard: move focus into the menu once its list has
  // rendered. Portaled to the end of <body>, the menu is not the next Tab stop
  // after its trigger (and in the panel the terminal swallows Tab).
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

  const menu = open && (
    <div
      id={menuId}
      className={styles.dropdown}
      ref={menuRef}
      tabIndex={-1}
    >
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
  );

  return (
    <div ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName(open)}
        onClick={(e) => {
          // Opened from the keyboard (Enter / Space: a click with detail 0), focus
          // goes into the menu (see above). Escape hands it back.
          if (!open && e.detail === 0) {
            openerRef.current = triggerRef.current;
            focusIntoMenu.current = true;
          }
          setOpen(!open);
        }}
        title="Recent directories"
        // A label names the button itself; the icon needs one. A disclosure
        // (aria-expanded + aria-controls), not aria-haspopup: the panel is a
        // list of buttons, not an ARIA menu with menuitems and arrow keys.
        aria-label={hasLabel ? undefined : 'Recent directories'}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        {hasLabel ? label : <RecentDirsIcon />}
      </button>

      {menu && createPortal(menu, document.body)}
    </div>
  );
}
