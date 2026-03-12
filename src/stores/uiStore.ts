import { create } from 'zustand';

interface PendingFileOpen {
  filePath: string;
  projectPath: string;
}

export type CardDisplayMode = 'detailed' | 'compact';

interface UiState {
  activeModal: string | null;
  detailPanelOpen: boolean;
  activityFeedOpen: boolean;
  detailHeaderCollapsed: boolean;
  pendingFileOpen: PendingFileOpen | null;
  cardDisplayMode: CardDisplayMode;

  openModal: (modalId: string) => void;
  closeModal: () => void;
  setDetailPanelOpen: (open: boolean) => void;
  setActivityFeedOpen: (open: boolean) => void;
  toggleDetailHeader: () => void;
  openFileInProject: (filePath: string, projectPath: string) => void;
  clearPendingFileOpen: () => void;
  toggleCardDisplayMode: () => void;
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

export const useUiStore = create<UiState>((set) => ({
  activeModal: null,
  detailPanelOpen: false,
  activityFeedOpen: false,
  detailHeaderCollapsed: loadHeaderCollapsed(),
  pendingFileOpen: null,
  cardDisplayMode: loadCardDisplayMode(),

  openModal: (modalId) => set({ activeModal: modalId }),
  closeModal: () => set({ activeModal: null }),
  setDetailPanelOpen: (open) => set({ detailPanelOpen: open }),
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
}));
