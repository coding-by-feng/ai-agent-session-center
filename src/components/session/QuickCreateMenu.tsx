/**
 * QuickCreateMenu — the "＋ New" menu (Nov 17 2026): start a session in a project with one click, make a room,
 * or open the full form. Drawn once (App mounts it); opened by the session rail's ＋ New, the top bar's ＋ New
 * and the `newSession` shortcut through quickCreateStore.
 *
 * A row's agent button always starts a NEW session there (`launchInProjectGroup`: forceNew, an existing folder
 * only, and the room this project's sessions already use). Typing filters the rows; Enter starts the agent used
 * last in the highlighted folder and Alt+Enter the other one. Portaled to <body> and fixed, placed under the
 * visible ＋ New button and clamped inside the window; with no button on screen it sits near the top centre.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLaunchers } from '@/stores/enabledAgentsStore';
import type { LauncherCommand } from '@/components/layout/cliLaunchers';
import { useKnownProjects } from '@/hooks/useKnownProjects';
import { launchInProjectGroup } from '@/lib/projectLaunch';
import { normalizeProjectPath, projectKey } from '@/lib/projectGroups';
import { computeMovePickerPosition } from '@/lib/queueMovePlacement';
import {
  lastCliFor, otherCli, QUICK_CREATE_ANCHOR_ATTR, quickCreateRows, ROOM_MANAGER_MODAL_ID, type QuickCreateCli, type QuickCreateRow,
} from '@/lib/quickCreate';
import { showToast } from '@/components/ui/ToastContainer';
import { useQuickCreateStore } from '@/stores/quickCreateStore';
import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { Session } from '@/types';
import styles from '@/styles/modules/QuickCreateMenu.module.css';

const ROOM_NAME_MAX = 60;

function readJson<T>(key: string, fallback: T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || 'null');
    return (value ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function visibleAnchor(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(`[${QUICK_CREATE_ANCHOR_ATTR}]`);
  for (const el of all) if (el.getClientRects().length > 0) return el;
  return null;
}

/** The open session's folder, when it is one a local launch can start in. */
function localProjectDir(session: Session | undefined): string | null {
  if (!session?.projectPath || !projectKey(session)?.startsWith('localhost|')) return null;
  return normalizeProjectPath(session.projectPath);
}

export default function QuickCreateMenu() {
  const open = useQuickCreateStore((s) => s.open);
  // Mounted only while open: every opening starts from an empty search, the first row and no room form.
  return open ? <QuickCreateBody /> : null;
}

function QuickCreateBody() {
  const launchers = useLaunchers();
  const close = useQuickCreateStore((s) => s.close);
  const currentDir = useSessionStore((s) => localProjectDir(s.selectedSessionId ? s.sessions.get(s.selectedSessionId) : undefined));
  const knownProjects = useKnownProjects();

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [roomName, setRoomName] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const recentDirs = useMemo(() => {
    const history = readJson<unknown[]>('workdir-history', []).filter((d): d is string => typeof d === 'string');
    return [...history, ...knownProjects];
  }, [knownProjects]);
  const rows = useMemo(() => quickCreateRows(currentDir, recentDirs, query), [currentDir, recentDirs, query]);
  const activeIndex = Math.min(active, Math.max(rows.length - 1, 0));

  const dismiss = useCallback(() => {
    const opener = openerRef.current;
    close();
    if (opener?.isConnected) opener.focus();
  }, [close]);

  // The search box takes the keys; Escape hands focus back to whatever had it.
  useLayoutEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const place = () => {
      const menu = menuRef.current;
      if (!menu) return;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const size = { width: menu.offsetWidth, height: menu.offsetHeight };
      const anchor = visibleAnchor()?.getBoundingClientRect();
      const { top, left } = anchor
        ? computeMovePickerPosition({ top: anchor.top, bottom: anchor.bottom, left: anchor.left, right: anchor.right }, size, viewport, 'left')
        : { top: Math.min(72, Math.max(8, viewport.height - size.height - 8)), left: Math.max(8, (viewport.width - size.width) / 2) };
      menu.style.setProperty('--qc-top', `${top}px`);
      menu.style.setProperty('--qc-left', `${left}px`);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [rows.length, roomName]);

  // A press outside closes it. Not on a ＋ New button: that press is the button's own toggle, and closing here
  // first would make its click open the menu again.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (menuRef.current?.contains(target) || target?.closest?.(`[${QUICK_CREATE_ANCHOR_ATTR}]`)) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      dismiss();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [dismiss]);

  const launch = useCallback(async (row: QuickCreateRow, command: QuickCreateCli | LauncherCommand) => {
    close();
    const sessions = [...useSessionStore.getState().sessions.values()].filter(
      (s) => s.status !== 'ended' && localProjectDir(s) === row.dir,
    );
    await launchInProjectGroup({ launchPath: row.dir, sessions }, command);
  }, [close]);

  const launchActive = useCallback((alternate: boolean) => {
    const row = rows[activeIndex];
    if (!row) return;
    const usual = lastCliFor(row.dir, readJson<Record<string, { command?: unknown }> | null>('dir-session-configs', null));
    void launch(row, alternate ? otherCli(usual) : usual);
  }, [rows, activeIndex, launch]);

  const createRoom = useCallback(() => {
    const name = (roomName ?? '').trim().slice(0, ROOM_NAME_MAX);
    if (!name) return;
    useRoomStore.getState().createRoom(name);
    showToast(`Room “${name}” created`, 'success');
    close();
  }, [roomName, close]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIndex + step + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      launchActive(e.altKey);
    }
  };

  const heading = (row: QuickCreateRow, index: number) => {
    if (row.current) return 'This project';
    return index === 0 || rows[index - 1].current ? 'Recent' : null;
  };

  return createPortal(
    <div className={styles.menu} ref={menuRef} role="dialog" aria-label="New session or room">
      <input
        ref={searchRef}
        className={styles.search}
        type="search"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={onSearchKey}
        placeholder="Search projects…"
        aria-label="Search projects"
        aria-controls="quick-create-rows"
      />
      <div className={styles.rows} id="quick-create-rows">
        {rows.length === 0 && (
          <div className={styles.empty}>{query ? 'No project matches. Use More options to pick a folder.' : 'No projects yet. Use More options to pick a folder.'}</div>
        )}
        {rows.map((row, index) => {
          const title = heading(row, index);
          return (
            <div key={row.dir}>
              {title && <div className={styles.heading}>{title}</div>}
              <div
                className={`${styles.row} ${index === activeIndex ? styles.rowActive : ''}`}
                data-active={index === activeIndex ? '' : undefined}
                onMouseEnter={() => setActive(index)}
              >
                <div className={styles.info} title={row.dir}>
                  <span className={styles.name}>{row.name}</span>
                  <span className={styles.path}>{row.dir}</span>
                </div>
                <div className={styles.launchers}>
                  {launchers.map(({ command, label, Icon }) => (
                    <button
                      key={command}
                      type="button"
                      className={styles.launch}
                      onClick={() => void launch(row, command)}
                      title={`New ${label} session in ${row.name}`}
                      aria-label={`New ${label} session in ${row.name}`}
                    >
                      <Icon />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {roomName === null ? (
        <div className={styles.footer}>
          <button type="button" className={styles.footerBtn} onClick={() => setRoomName('')}>New room…</button>
          <button
            type="button"
            className={styles.footerBtn}
            onClick={() => { close(); useUiStore.getState().openModal(ROOM_MANAGER_MODAL_ID); }}
          >
            Manage rooms…
          </button>
          <button
            type="button"
            className={`${styles.footerBtn} ${styles.footerEnd}`}
            onClick={() => { const dir = rows[activeIndex]?.dir ?? currentDir; close(); useUiStore.getState().openNewSession(dir); }}
          >
            More options…
          </button>
        </div>
      ) : (
        <form className={styles.footer} onSubmit={(e) => { e.preventDefault(); createRoom(); }}>
          <input
            className={styles.roomInput}
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            maxLength={ROOM_NAME_MAX}
            placeholder="Room name"
            aria-label="Room name"
            autoFocus
          />
          <button type="submit" className={styles.footerBtn} disabled={!roomName.trim()}>Create room</button>
          <button type="button" className={styles.footerBtn} onClick={() => setRoomName(null)}>Cancel</button>
        </form>
      )}
    </div>,
    document.body,
  );
}
