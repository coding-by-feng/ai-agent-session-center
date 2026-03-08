import { create } from 'zustand';

interface PendingFileOpen {
  filePath: string;
  projectPath: string;
}

interface UiState {
  activeModal: string | null;
  detailPanelOpen: boolean;
  activityFeedOpen: boolean;
  detailHeaderCollapsed: boolean;
  pendingFileOpen: PendingFileOpen | null;

  openModal: (modalId: string) => void;
  closeModal: () => void;
  setDetailPanelOpen: (open: boolean) => void;
  setActivityFeedOpen: (open: boolean) => void;
  toggleDetailHeader: () => void;
  openFileInProject: (filePath: string, projectPath: string) => void;
  clearPendingFileOpen: () => void;
}

function loadHeaderCollapsed(): boolean {
  try {
    return localStorage.getItem('detail-header-collapsed') !== '0';
  } catch { return true; }
}

export const useUiStore = create<UiState>((set) => ({
  activeModal: null,
  detailPanelOpen: false,
  activityFeedOpen: false,
  detailHeaderCollapsed: loadHeaderCollapsed(),
  pendingFileOpen: null,

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
}));
