import { create } from 'zustand';
import { LIVE_HINT_STORAGE_KEY } from '@/lib/liveHint';

/** Modal id for the room "kill all sessions" confirm dialog. Defined here (not
 *  in the modal component) so `openRoomKill` can reference it without a store↔
 *  component import cycle; the modal and DetailPanel import it from the store. */
export const ROOM_KILL_MODAL_ID = 'room-kill-confirm';

interface PendingFileOpen {
  filePath: string;
  projectPath: string;
}

export interface PendingFileChooser {
  filePath: string;
  projectPath: string;
  /** Viewport coordinates the chooser popover anchors to (click position). */
  anchor: { x: number; y: number };
}

export type CardDisplayMode = 'detailed' | 'compact';

/** Prompt Queue (QueueTab) layout: 'list' (default — the original row layout,
 *  drag-to-reorder) or 'card' (a wrapping grid; reorder via the row's existing
 *  ▲/▼ buttons instead of drag — a 2D grid has no unambiguous drop target). */
export type QueueViewMode = 'list' | 'card';

/** Where the DetailPanel session-navigation bar sits: a horizontal strip on top
 *  (default) or a vertical rail down the left side (reclaims vertical space). */
export type NavPosition = 'top' | 'left';

/** How the session strip is grouped and ordered:
 *  - 'room'     (default) — room-coloured frames, sessions ordered by status.
 *  - 'activity'           — no room frames at all; one flat list, most recently
 *                           active first. Answers "what did I touch last?".
 *  - 'project'            — one frame per project directory instead of per room,
 *                           each with buttons to start a new Claude / Codex
 *                           session there. Answers "what is running in X?". */
export type SessionSortMode = 'room' | 'activity' | 'project';

export interface WorkspaceLoadState {
  active: boolean;
  total: number;
  done: number;
  currentTitle: string;
}

interface UiState {
  activeModal: string | null;
  /** Room whose sessions the room-kill confirm modal targets. Set alongside
   *  activeModal by openRoomKill; cleared by closeModal. `openModal` carries no
   *  payload, so the target rides here rather than in activeModal. */
  roomKillTargetId: string | null;
  detailPanelOpen: boolean;
  detailPanelMinimized: boolean;
  pendingFileOpen: PendingFileOpen | null;
  pendingFileChooser: PendingFileChooser | null;
  cardDisplayMode: CardDisplayMode;
  /** Prompt Queue layout. Persisted to localStorage['queue-view-mode']. */
  queueViewMode: QueueViewMode;
  /** DetailPanel nav-bar position: 'top' (default) or 'left' rail. Persisted. */
  navPosition: NavPosition;
  /** Maximize mode: hide the detail panel's own session-chip strip for more
   *  terminal space (the global Header + NavBar are already hidden whenever a
   *  detail panel is in view — see AppLayout `hideTopBars`). Ephemeral (not
   *  persisted) so a reload returns to the normal panel layout. */
  maximized: boolean;
  /** Collapse the left-docked session rail to a thin strip (showing only an
   *  expand affordance + active-session count), reclaiming horizontal space for
   *  the content. Only takes effect when navPosition === 'left' && !maximized.
   *  Persisted to localStorage['nav-rail-collapsed']. */
  navRailCollapsed: boolean;
  /** Is the rail's built-in RECENT frame folded? That frame is not a Room, so
   *  this cannot live on room.collapsed. Persisted to
   *  localStorage['recent-room-collapsed']. */
  recentRoomCollapsed: boolean;
  /** The "go to session #" box (SessionJumpOverlay) is open. Not persisted. */
  sessionJumpOpen: boolean;
  /** Session strip grouping/ordering. Persisted to localStorage['session-sort-mode'].
   *  'activity' flattens the room frames away, 'project' swaps them for project
   *  frames — see SessionSortMode. */
  sessionSortMode: SessionSortMode;
  /** Project frames the user has folded, by `projectKey` (host|path). Project
   *  frames are not Rooms, so there is no room.collapsed to keep this on.
   *  Persisted to localStorage['collapsed-projects'] as a JSON array. */
  collapsedProjects: Set<string>;
  workspaceLoad: WorkspaceLoadState;
  /** Room filter: persisted across session switches */
  selectedRoomIds: Set<string>;
  /** The LIVE board's one-time tip has been retired on this device (lib/liveHint.ts).
   *  Persisted to localStorage['live-hint-dismissed']. */
  liveHintDismissed: boolean;
  /** The top bar's DIRS dropdown (WorkdirLauncher) is open. Shared, not local, so
   *  the LIVE page's "no sessions yet" card can open it. Not persisted. */
  workdirLauncherOpen: boolean;
  /** The workspace auto-load has not decided yet whether to restore. Mirrors
   *  workspaceSnapshot's module flag (`setRestorePending`) for React: true from
   *  boot until useWorkspaceAutoLoad resolves, so the LIVE page does not say
   *  "No agent sessions yet" just before a restore re-creates them. */
  workspaceRestorePending: boolean;

  openModal: (modalId: string) => void;
  /** Open the room-kill confirm modal targeting a specific room. */
  openRoomKill: (roomId: string) => void;
  closeModal: () => void;
  setDetailPanelOpen: (open: boolean) => void;
  minimizeDetailPanel: () => void;
  restoreDetailPanel: () => void;
  openFileInProject: (filePath: string, projectPath: string) => void;
  clearPendingFileOpen: () => void;
  openFileChooser: (
    filePath: string,
    projectPath: string,
    anchor: { x: number; y: number },
  ) => void;
  clearFileChooser: () => void;
  toggleCardDisplayMode: () => void;
  toggleQueueViewMode: () => void;
  setNavPosition: (pos: NavPosition) => void;
  toggleNavPosition: () => void;
  setMaximized: (on: boolean) => void;
  toggleMaximized: () => void;
  setNavRailCollapsed: (on: boolean) => void;
  toggleNavRailCollapsed: () => void;
  toggleRecentRoomCollapsed: () => void;
  openSessionJump: () => void;
  closeSessionJump: () => void;
  setSessionSortMode: (mode: SessionSortMode) => void;
  toggleProjectCollapsed: (projectKey: string) => void;
  startWorkspaceLoad: (total: number) => void;
  advanceWorkspaceLoad: (done: number, currentTitle: string) => void;
  finishWorkspaceLoad: () => void;
  toggleRoomFilter: (roomId: string) => void;
  clearRoomFilter: () => void;
  dismissLiveHint: () => void;
  setWorkdirLauncherOpen: (open: boolean) => void;
}

function loadCardDisplayMode(): CardDisplayMode {
  try {
    const v = localStorage.getItem('card-display-mode');
    return v === 'compact' ? 'compact' : 'detailed';
  } catch {
    return 'detailed';
  }
}

/**
 * Prompt Queue layout, defaulting to CARD (changed Aug 2026 — was 'list').
 *
 * Written as "explicitly 'list' wins, everything else is card" rather than
 * "'card' wins, else list", so the three cases stay distinct:
 *
 *   absent      → card   (the new default: never toggled, or a fresh install)
 *   'card'      → card
 *   'list'      → list   (an explicit choice, preserved — NOT overridden)
 *
 * `toggleQueueViewMode` persists both values, so a stored 'list' really does
 * mean the user picked it. Defaulting by flipping the comparison keeps that
 * distinction; special-casing only 'card' would have silently forced everyone
 * who deliberately chose list back onto the new default.
 */
function loadQueueViewMode(): QueueViewMode {
  try {
    return localStorage.getItem('queue-view-mode') === 'list' ? 'list' : 'card';
  } catch {
    // localStorage unavailable (private mode / disabled site data) — fall back
    // to the same default an unset key gets, not the old one.
    return 'card';
  }
}

function loadNavPosition(): NavPosition {
  try {
    return localStorage.getItem('nav-position') === 'left' ? 'left' : 'top';
  } catch {
    return 'top';
  }
}

function loadNavRailCollapsed(): boolean {
  try {
    return localStorage.getItem('nav-rail-collapsed') === '1';
  } catch {
    return false;
  }
}

function loadRecentRoomCollapsed(): boolean {
  try {
    return localStorage.getItem('recent-room-collapsed') === '1';
  } catch {
    return false;
  }
}

function loadSessionSortMode(): SessionSortMode {
  try {
    const stored = localStorage.getItem('session-sort-mode');
    return stored === 'activity' || stored === 'project' ? stored : 'room';
  } catch {
    return 'room';
  }
}

function loadCollapsedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem('collapsed-projects');
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((key): key is string => typeof key === 'string'));
      }
    }
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveCollapsedProjects(keys: Set<string>): void {
  try {
    if (keys.size === 0) {
      localStorage.removeItem('collapsed-projects');
    } else {
      localStorage.setItem('collapsed-projects', JSON.stringify([...keys]));
    }
  } catch {
    /* ignore */
  }
}

function loadRoomFilter(): Set<string> {
  try {
    const raw = localStorage.getItem('room-filter');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveRoomFilter(ids: Set<string>): void {
  try {
    if (ids.size === 0) {
      localStorage.removeItem('room-filter');
    } else {
      localStorage.setItem('room-filter', JSON.stringify([...ids]));
    }
  } catch {
    /* ignore */
  }
}

function loadLiveHintDismissed(): boolean {
  try {
    return localStorage.getItem(LIVE_HINT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export const useUiStore = create<UiState>((set) => ({
  activeModal: null,
  roomKillTargetId: null,
  detailPanelOpen: false,
  detailPanelMinimized: false,
  pendingFileOpen: null,
  pendingFileChooser: null,
  cardDisplayMode: loadCardDisplayMode(),
  queueViewMode: loadQueueViewMode(),
  navPosition: loadNavPosition(),
  maximized: false,
  navRailCollapsed: loadNavRailCollapsed(),
  recentRoomCollapsed: loadRecentRoomCollapsed(),
  sessionJumpOpen: false,
  sessionSortMode: loadSessionSortMode(),
  collapsedProjects: loadCollapsedProjects(),
  workspaceLoad: { active: false, total: 0, done: 0, currentTitle: '' },
  selectedRoomIds: loadRoomFilter(),
  liveHintDismissed: loadLiveHintDismissed(),
  workdirLauncherOpen: false,
  workspaceRestorePending: true,

  openModal: (modalId) => set({ activeModal: modalId }),
  openRoomKill: (roomId) => set({ activeModal: ROOM_KILL_MODAL_ID, roomKillTargetId: roomId }),
  // Clear the room-kill target too, so a stale id can't leak into the next open.
  closeModal: () => set({ activeModal: null, roomKillTargetId: null }),
  setDetailPanelOpen: (open) => set({ detailPanelOpen: open }),
  minimizeDetailPanel: () => set({ detailPanelMinimized: true }),
  restoreDetailPanel: () => set({ detailPanelMinimized: false }),
  openFileInProject: (filePath, projectPath) => set({ pendingFileOpen: { filePath, projectPath } }),
  clearPendingFileOpen: () => set({ pendingFileOpen: null }),
  openFileChooser: (filePath, projectPath, anchor) =>
    set({ pendingFileChooser: { filePath, projectPath, anchor } }),
  clearFileChooser: () => set({ pendingFileChooser: null }),
  toggleCardDisplayMode: () =>
    set((s) => {
      const next: CardDisplayMode = s.cardDisplayMode === 'detailed' ? 'compact' : 'detailed';
      try {
        localStorage.setItem('card-display-mode', next);
      } catch {
        /* ignore */
      }
      return { cardDisplayMode: next };
    }),
  toggleQueueViewMode: () =>
    set((s) => {
      const next: QueueViewMode = s.queueViewMode === 'list' ? 'card' : 'list';
      try {
        localStorage.setItem('queue-view-mode', next);
      } catch {
        /* ignore */
      }
      return { queueViewMode: next };
    }),
  setNavPosition: (pos) =>
    set(() => {
      try {
        localStorage.setItem('nav-position', pos);
      } catch {
        /* ignore */
      }
      return { navPosition: pos };
    }),
  toggleNavPosition: () =>
    set((s) => {
      const next: NavPosition = s.navPosition === 'left' ? 'top' : 'left';
      try {
        localStorage.setItem('nav-position', next);
      } catch {
        /* ignore */
      }
      return { navPosition: next };
    }),
  setMaximized: (on) => set({ maximized: on }),
  toggleMaximized: () => set((s) => ({ maximized: !s.maximized })),
  setNavRailCollapsed: (on) =>
    set(() => {
      try {
        localStorage.setItem('nav-rail-collapsed', on ? '1' : '0');
      } catch {
        /* ignore */
      }
      return { navRailCollapsed: on };
    }),
  toggleNavRailCollapsed: () =>
    set((s) => {
      const next = !s.navRailCollapsed;
      try {
        localStorage.setItem('nav-rail-collapsed', next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return { navRailCollapsed: next };
    }),
  toggleRecentRoomCollapsed: () =>
    set((s) => {
      const next = !s.recentRoomCollapsed;
      try {
        localStorage.setItem('recent-room-collapsed', next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return { recentRoomCollapsed: next };
    }),
  openSessionJump: () => set({ sessionJumpOpen: true }),
  closeSessionJump: () => set({ sessionJumpOpen: false }),
  setSessionSortMode: (mode) =>
    set(() => {
      try {
        localStorage.setItem('session-sort-mode', mode);
      } catch {
        /* ignore */
      }
      return { sessionSortMode: mode };
    }),
  toggleProjectCollapsed: (projectKey) =>
    set((s) => {
      const next = new Set(s.collapsedProjects);
      if (next.has(projectKey)) next.delete(projectKey);
      else next.add(projectKey);
      saveCollapsedProjects(next);
      return { collapsedProjects: next };
    }),
  startWorkspaceLoad: (total) =>
    set({ workspaceLoad: { active: true, total, done: 0, currentTitle: '' } }),
  advanceWorkspaceLoad: (done, currentTitle) =>
    set((s) => ({ workspaceLoad: { ...s.workspaceLoad, done, currentTitle } })),
  finishWorkspaceLoad: () =>
    set({ workspaceLoad: { active: false, total: 0, done: 0, currentTitle: '' } }),
  toggleRoomFilter: (roomId) =>
    set((s) => {
      const next = new Set(s.selectedRoomIds);
      if (next.has(roomId)) next.delete(roomId);
      else next.add(roomId);
      saveRoomFilter(next);
      return { selectedRoomIds: next };
    }),
  clearRoomFilter: () => {
    saveRoomFilter(new Set());
    set({ selectedRoomIds: new Set() });
  },
  dismissLiveHint: () => {
    try {
      localStorage.setItem(LIVE_HINT_STORAGE_KEY, '1');
    } catch {
      /* ignore — still retired for this visit */
    }
    set({ liveHintDismissed: true });
  },
  setWorkdirLauncherOpen: (open) => set({ workdirLauncherOpen: open }),
}));
