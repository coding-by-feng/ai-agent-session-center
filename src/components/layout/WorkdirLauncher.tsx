/**
 * WorkdirLauncher - Dropdown popover that lists recent working directories.
 * Each directory row carries a Claude / Codex launch button; clicking one
 * starts a local terminal session in that directory running the chosen CLI.
 *
 * Two copies: the NavBar's DIRS button, and a folder-and-clock icon in the
 * session panel's strip (App.tsx unmounts the NavBar while a panel is open).
 * See `variant` for how they differ.
 */
import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo, useId } from 'react';
import { createPortal } from 'react-dom';
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

interface WorkdirLauncherProps {
  /**
   * 'topbar' (default): the NavBar's DIRS button. Its open state lives in
   * uiStore so the LIVE page's "no sessions yet" card can open it.
   *
   * 'panel': an icon in the session panel's strip. It keeps its own open
   * state: DetailPanel leaves the strip mounted (hidden) after the panel closes,
   * just as the top bar comes back, and on the shared flag the top bar's DIRS
   * would open this hidden copy too, whose click-outside then shuts the visible
   * menu on the mousedown meant to launch. Its menu is portaled to <body>,
   * because the panel's `will-change: transform` would otherwise become the
   * containing block of the menu's `position: fixed`.
   */
  variant?: 'topbar' | 'panel';
  /** The trigger's class for an open state, so it matches its host's row. */
  triggerClassName?: (open: boolean) => string;
}

/** A folder with a clock in its corner: RECENT directories, the panel copy's
 *  trigger (the top bar's reads DIRS). Not a plain folder: in the Projects view
 *  the view menu beside it already shows one, meaning "this view". */
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

export default function WorkdirLauncher({ variant = 'topbar', triggerClassName }: WorkdirLauncherProps) {
  const inPanel = variant === 'panel';
  // The top bar's open state lives in uiStore, not here, so the LIVE page's
  // "no sessions yet" card can open this dropdown under the top bar's DIRS.
  const sharedOpen = useUiStore((s) => s.workdirLauncherOpen);
  const setSharedOpen = useUiStore((s) => s.setWorkdirLauncherOpen);
  const [ownOpen, setOwnOpen] = useState(false);
  const open = inPanel ? ownOpen : sharedOpen;
  const setOpen = inPanel ? setOwnOpen : setSharedOpen;
  const [dirs, setDirs] = useState<string[]>([]);
  const knownProjects = useKnownProjects();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Where focus was when the dropdown was opened from elsewhere (the LIVE
   *  page's "no sessions yet" card), or the panel copy's own icon when it was
   *  opened from the keyboard; Escape hands it back there. */
  const openerRef = useRef<HTMLElement | null>(null);
  const focusIntoMenu = useRef(false);
  const menuId = useId();

  const close = useCallback(() => setOpen(false), [setOpen]);

  // The shared open state outlives the top bar (it lives in uiStore), and the
  // top bar unmounts whenever a session panel opens. Close on unmount, or the
  // dropdown reappears by itself when the panel closes again. The panel copy's
  // state dies with it, and it must never shut the top bar's menu.
  useEffect(() => {
    if (inPanel) return;
    return () => setSharedOpen(false);
  }, [inPanel, setSharedOpen]);

  // Placed with fixed coordinates from the trigger's viewport rect. Below 640px
  // the top bar is a sideways scroller (overflow-x: auto), which clips an
  // absolutely positioned child to the bar's own height — the dropdown opened
  // and could not be seen. `position: fixed` escapes that clip while the top
  // bar's menu stays inside this component's DOM, so its stacking order is
  // unchanged (the panel copy's is portaled instead — see `variant`). Written
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

  // The panel copy's menu is portaled out of this subtree, so a click on it
  // must count as inside too.
  const insideRefs = useMemo(() => [wrapperRef, menuRef], []);
  useClickOutside(insideRefs, close, open);

  // The panel can stop being visible while this stays mounted, and the portaled
  // menu does not go with it. A deselect hides the strip (display: none: the
  // icon leaves layout, which a ResizeObserver sees); the terminal's fullscreen
  // hides the whole panel with visibility: hidden (body.term-fullscreen, which
  // keeps the icon's box, so only the class change shows it). Close on either.
  useEffect(() => {
    const trigger = triggerRef.current;
    if (!inPanel || !open || !trigger) return;
    const resize = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (trigger.getClientRects().length === 0) setOwnOpen(false);
        });
    resize?.observe(trigger);
    const fullscreen = new MutationObserver(() => {
      if (document.body.classList.contains('term-fullscreen')) setOwnOpen(false);
    });
    fullscreen.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => {
      resize?.disconnect();
      fullscreen.disconnect();
    };
  }, [inPanel, open]);

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

  const menu = open && (
    <div
      id={menuId}
      className={inPanel ? `${styles.dropdown} ${styles.dropdownPortaled}` : styles.dropdown}
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
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        ref={triggerRef}
        className={triggerClassName ? triggerClassName(open) : `${styles.triggerBtn} ${open ? styles.open : ''}`}
        onClick={(e) => {
          // Opened from the keyboard (Enter / Space: a click with detail 0), the
          // panel copy takes focus into its menu — portaled to the end of <body>,
          // the menu is not the next Tab stop after its icon. Escape hands it back.
          if (inPanel && !open && e.detail === 0) {
            openerRef.current = triggerRef.current;
            focusIntoMenu.current = true;
          }
          setOpen(!open);
        }}
        title={inPanel ? 'Recent directories' : 'Recent working directories'}
        aria-label={inPanel ? 'Recent directories' : undefined}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        {inPanel ? <RecentDirsIcon /> : 'DIRS'}
      </button>

      {menu && (inPanel ? createPortal(menu, document.body) : menu)}
    </div>
  );
}
