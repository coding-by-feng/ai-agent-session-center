import { create } from 'zustand';

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

/** Where the DetailPanel session-navigation bar sits: a horizontal strip on top
 *  (default) or a vertical rail down the left side (reclaims vertical space). */
export type NavPosition = 'top' | 'left';

/** How the session strip is ordered:
 *  - 'room'     (default) — room-coloured frames, sessions ordered by status.
 *  - 'activity'           — no room frames at all; one flat list, most recently
 *                           active first. Answers "what did I touch last?". */
export type SessionSortMode = 'room' | 'activity';

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
  /** Session strip ordering. Persisted to localStorage['session-sort-mode'].
   *  'activity' flattens the room frames away — see SessionSortMode. */
  sessionSortMode: SessionSortMode;
  workspaceLoad: WorkspaceLoadState;
  /** Room filter: persisted across session switches */
  selectedRoomIds: Set<string>;

  openModal: (modalId: string) => void;
  /** Open the room-kill confirm modal targeting a specific room. */
  openRoomKill: (roomId: string) => void;
  closeModal: () => void;
  setDetailPanelOpen: (open: boolean) => void;
  minimizeDetailPanel: () => void;
  restoreDetailPanel: () => void;
  openFileInProject: (filePath: string, projectPath: string) => void;
  clearPendingFileOpen: () => void;
  openFileChooser: (filePath: string, projectPath: string, anchor: { x: number; y: number }) => void;
  clearFileChooser: () => void;
  toggleCardDisplayMode: () => void;
  setNavPosition: (pos: NavPosition) => void;
  toggleNavPosition: () => void;
  setMaximized: (on: boolean) => void;
  toggleMaximized: () => void;
  setNavRailCollapsed: (on: boolean) => void;
  toggleNavRailCollapsed: () => void;
  toggleSessionSortMode: () => void;
  startWorkspaceLoad: (total: number) => void;
  advanceWorkspaceLoad: (done: number, currentTitle: string) => void;
  finishWorkspaceLoad: () => void;
  toggleRoomFilter: (roomId: string) => void;
  clearRoomFilter: () => void;
}

function loadCardDisplayMode(): CardDisplayMode {
  try {
    const v = localStorage.getItem('card-display-mode');
    return v === 'compact' ? 'compact' : 'detailed';
  } catch { return 'detailed'; }
}

function loadNavPosition(): NavPosition {
  try {
    return localStorage.getItem('nav-position') === 'left' ? 'left' : 'top';
  } catch { return 'top'; }
}

function loadNavRailCollapsed(): boolean {
  try {
    return localStorage.getItem('nav-rail-collapsed') === '1';
  } catch { return false; }
}

function loadSessionSortMode(): SessionSortMode {
  try {
    return localStorage.getItem('session-sort-mode') === 'activity' ? 'activity' : 'room';
  } catch { return 'room'; }
}

function loadRoomFilter(): Set<string> {
  try {
    const raw = localStorage.getItem('room-filter');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch { /* ignore */ }
  return new Set();
}

function saveRoomFilter(ids: Set<string>): void {
  try {
    if (ids.size === 0) {
      localStorage.removeItem('room-filter');
    } else {
      localStorage.setItem('room-filter', JSON.stringify([...ids]));
    }
  } catch { /* ignore */ }
}

export const useUiStore = create<UiState>((set) => ({
  activeModal: null,
  roomKillTargetId: null,
  detailPanelOpen: false,
  detailPanelMinimized: false,
  pendingFileOpen: null,
  pendingFileChooser: null,
  cardDisplayMode: loadCardDisplayMode(),
  navPosition: loadNavPosition(),
  maximized: false,
  navRailCollapsed: loadNavRailCollapsed(),
  sessionSortMode: loadSessionSortMode(),
  workspaceLoad: { active: false, total: 0, done: 0, currentTitle: '' },
  selectedRoomIds: loadRoomFilter(),

  openModal: (modalId) => set({ activeModal: modalId }),
  openRoomKill: (roomId) => set({ activeModal: ROOM_KILL_MODAL_ID, roomKillTargetId: roomId }),
  // Clear the room-kill target too, so a stale id can't leak into the next open.
  closeModal: () => set({ activeModal: null, roomKillTargetId: null }),
  setDetailPanelOpen: (open) => set({ detailPanelOpen: open }),
  minimizeDetailPanel: () => set({ detailPanelMinimized: true }),
  restoreDetailPanel: () => set({ detailPanelMinimized: false }),
  openFileInProject: (filePath, projectPath) => set({ pendingFileOpen: { filePath, projectPath } }),
  clearPendingFileOpen: () => set({ pendingFileOpen: null }),
  openFileChooser: (filePath, projectPath, anchor) => set({ pendingFileChooser: { filePath, projectPath, anchor } }),
  clearFileChooser: () => set({ pendingFileChooser: null }),
  toggleCardDisplayMode: () => set((s) => {
    const next: CardDisplayMode = s.cardDisplayMode === 'detailed' ? 'compact' : 'detailed';
    try { localStorage.setItem('card-display-mode', next); } catch { /* ignore */ }
    return { cardDisplayMode: next };
  }),
  setNavPosition: (pos) => set(() => {
    try { localStorage.setItem('nav-position', pos); } catch { /* ignore */ }
    return { navPosition: pos };
  }),
  toggleNavPosition: () => set((s) => {
    const next: NavPosition = s.navPosition === 'left' ? 'top' : 'left';
    try { localStorage.setItem('nav-position', next); } catch { /* ignore */ }
    return { navPosition: next };
  }),
  setMaximized: (on) => set({ maximized: on }),
  toggleMaximized: () => set((s) => ({ maximized: !s.maximized })),
  setNavRailCollapsed: (on) => set(() => {
    try { localStorage.setItem('nav-rail-collapsed', on ? '1' : '0'); } catch { /* ignore */ }
    return { navRailCollapsed: on };
  }),
  toggleNavRailCollapsed: () => set((s) => {
    const next = !s.navRailCollapsed;
    try { localStorage.setItem('nav-rail-collapsed', next ? '1' : '0'); } catch { /* ignore */ }
    return { navRailCollapsed: next };
  }),
  toggleSessionSortMode: () => set((s) => {
    const next: SessionSortMode = s.sessionSortMode === 'activity' ? 'room' : 'activity';
    try { localStorage.setItem('session-sort-mode', next); } catch { /* ignore */ }
    return { sessionSortMode: next };
  }),
  startWorkspaceLoad: (total) => set({ workspaceLoad: { active: true, total, done: 0, currentTitle: '' } }),
  advanceWorkspaceLoad: (done, currentTitle) => set((s) => ({ workspaceLoad: { ...s.workspaceLoad, done, currentTitle } })),
  finishWorkspaceLoad: () => set({ workspaceLoad: { active: false, total: 0, done: 0, currentTitle: '' } }),
  toggleRoomFilter: (roomId) => set((s) => {
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
}));
