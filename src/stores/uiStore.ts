import { create } from 'zustand';

interface PendingFileOpen {
  filePath: string;
  projectPath: string;
}

export type CardDisplayMode = 'detailed' | 'compact';

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
  detailHeaderCollapsed: boolean;
  pendingFileOpen: PendingFileOpen | null;
  cardDisplayMode: CardDisplayMode;
  workspaceLoad: WorkspaceLoadState;
  /** Room filter: persisted across session switches */
  selectedRoomIds: Set<string>;

  openModal: (modalId: string) => void;
  closeModal: () => void;
  setDetailPanelOpen: (open: boolean) => void;
  minimizeDetailPanel: () => void;
  restoreDetailPanel: () => void;
  setActivityFeedOpen: (open: boolean) => void;
  toggleDetailHeader: () => void;
  openFileInProject: (filePath: string, projectPath: string) => void;
  clearPendingFileOpen: () => void;
  toggleCardDisplayMode: () => void;
  startWorkspaceLoad: (total: number) => void;
  advanceWorkspaceLoad: (done: number, currentTitle: string) => void;
  finishWorkspaceLoad: () => void;
  toggleRoomFilter: (roomId: string) => void;
  clearRoomFilter: () => void;
}

function loadHeaderCollapsed(): boolean {
  try {
    return localStorage.getItem('detail-header-collapsed') !== '0';
  } catch { return true; }
}

function loadCardDisplayMode(): CardDisplayMode {
  try {
    const v = localStorage.getItem('card-display-mode');
    return v === 'compact' ? 'compact' : 'detailed';
  } catch { return 'detailed'; }
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
  detailHeaderCollapsed: loadHeaderCollapsed(),
  pendingFileOpen: null,
  cardDisplayMode: loadCardDisplayMode(),
  workspaceLoad: { active: false, total: 0, done: 0, currentTitle: '' },
  selectedRoomIds: loadRoomFilter(),

  openModal: (modalId) => set({ activeModal: modalId }),
  closeModal: () => set({ activeModal: null }),
  setDetailPanelOpen: (open) => set({ detailPanelOpen: open }),
  minimizeDetailPanel: () => set({ detailPanelMinimized: true }),
  restoreDetailPanel: () => set({ detailPanelMinimized: false }),
  setActivityFeedOpen: (open) => set({ activityFeedOpen: open }),
  toggleDetailHeader: () => set((s) => {
    const next = !s.detailHeaderCollapsed;
    try { localStorage.setItem('detail-header-collapsed', next ? '1' : '0'); } catch { /* ignore */ }
    return { detailHeaderCollapsed: next };
  }),
  openFileInProject: (filePath, projectPath) => set({ pendingFileOpen: { filePath, projectPath } }),
  clearPendingFileOpen: () => set({ pendingFileOpen: null }),
  toggleCardDisplayMode: () => set((s) => {
    const next: CardDisplayMode = s.cardDisplayMode === 'detailed' ? 'compact' : 'detailed';
    try { localStorage.setItem('card-display-mode', next); } catch { /* ignore */ }
    return { cardDisplayMode: next };
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
