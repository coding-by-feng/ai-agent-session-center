import { create } from 'zustand';

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

export interface WorkspaceLoadState {
  active: boolean;
  total: number;
  done: number;
  currentTitle: string;
}

interface UiState {
  activeModal: string | null;
  detailPanelOpen: boolean;
  detailPanelMinimized: boolean;
  activityFeedOpen: boolean;
  pendingFileOpen: PendingFileOpen | null;
  pendingFileChooser: PendingFileChooser | null;
  cardDisplayMode: CardDisplayMode;
  /** DetailPanel nav-bar position: 'top' (default) or 'left' rail. Persisted. */
  navPosition: NavPosition;
  /** Maximize mode: hide the detail panel's own session-chip strip for more
   *  terminal space. The global Header + NavBar stay pinned at all times.
   *  Ephemeral (not persisted) so a reload returns to the normal panel layout. */
  maximized: boolean;
  workspaceLoad: WorkspaceLoadState;
  /** Room filter: persisted across session switches */
  selectedRoomIds: Set<string>;

  openModal: (modalId: string) => void;
  closeModal: () => void;
  setDetailPanelOpen: (open: boolean) => void;
  minimizeDetailPanel: () => void;
  restoreDetailPanel: () => void;
  setActivityFeedOpen: (open: boolean) => void;
  openFileInProject: (filePath: string, projectPath: string) => void;
  clearPendingFileOpen: () => void;
  openFileChooser: (filePath: string, projectPath: string, anchor: { x: number; y: number }) => void;
  clearFileChooser: () => void;
  toggleCardDisplayMode: () => void;
  setNavPosition: (pos: NavPosition) => void;
  toggleNavPosition: () => void;
  setMaximized: (on: boolean) => void;
  toggleMaximized: () => void;
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
  detailPanelOpen: false,
  detailPanelMinimized: false,
  activityFeedOpen: false,
  pendingFileOpen: null,
  pendingFileChooser: null,
  cardDisplayMode: loadCardDisplayMode(),
  navPosition: loadNavPosition(),
  maximized: false,
  workspaceLoad: { active: false, total: 0, done: 0, currentTitle: '' },
  selectedRoomIds: loadRoomFilter(),

  openModal: (modalId) => set({ activeModal: modalId }),
  closeModal: () => set({ activeModal: null }),
  setDetailPanelOpen: (open) => set({ detailPanelOpen: open }),
  minimizeDetailPanel: () => set({ detailPanelMinimized: true }),
  restoreDetailPanel: () => set({ detailPanelMinimized: false }),
  setActivityFeedOpen: (open) => set({ activityFeedOpen: open }),
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
