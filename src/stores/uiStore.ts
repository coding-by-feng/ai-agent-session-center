import { create } from 'zustand';

interface PendingFileOpen {
  filePath: string;
  projectPath: string;
}

export type SidebarFilterMode = 'all' | 'ssh' | 'others';

interface UiState {
  activeModal: string | null;
  detailPanelOpen: boolean;
  activityFeedOpen: boolean;
  pendingFileOpen: PendingFileOpen | null;
  sidebarFilterMode: SidebarFilterMode;

  openModal: (modalId: string) => void;
  closeModal: () => void;
  setDetailPanelOpen: (open: boolean) => void;
  setActivityFeedOpen: (open: boolean) => void;
  openFileInProject: (filePath: string, projectPath: string) => void;
  clearPendingFileOpen: () => void;
  setSidebarFilterMode: (mode: SidebarFilterMode) => void;
}

function loadFilterMode(): SidebarFilterMode {
  try {
    const val = localStorage.getItem('sidebar-filter-mode');
    if (val === 'all' || val === 'ssh' || val === 'others') return val;
  } catch { /* ignore */ }
  return 'all';
}

export const useUiStore = create<UiState>((set) => ({
  activeModal: null,
  detailPanelOpen: false,
  activityFeedOpen: false,
  pendingFileOpen: null,
  sidebarFilterMode: loadFilterMode(),

  openModal: (modalId) => set({ activeModal: modalId }),
  closeModal: () => set({ activeModal: null }),
  setDetailPanelOpen: (open) => set({ detailPanelOpen: open }),
  setActivityFeedOpen: (open) => set({ activityFeedOpen: open }),
  openFileInProject: (filePath, projectPath) => set({ pendingFileOpen: { filePath, projectPath } }),
  clearPendingFileOpen: () => set({ pendingFileOpen: null }),
  setSidebarFilterMode: (mode) => {
    try { localStorage.setItem('sidebar-filter-mode', mode); } catch { /* ignore */ }
    set({ sidebarFilterMode: mode });
  },
}));
