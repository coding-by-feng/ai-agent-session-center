import { create } from 'zustand';

interface PendingFileOpen {
  filePath: string;
  projectPath: string;
}

interface UiState {
  activeModal: string | null;
  detailPanelOpen: boolean;
  activityFeedOpen: boolean;
  pendingFileOpen: PendingFileOpen | null;

  openModal: (modalId: string) => void;
  closeModal: () => void;
  setDetailPanelOpen: (open: boolean) => void;
  setActivityFeedOpen: (open: boolean) => void;
  openFileInProject: (filePath: string, projectPath: string) => void;
  clearPendingFileOpen: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeModal: null,
  detailPanelOpen: false,
  activityFeedOpen: false,
  pendingFileOpen: null,

  openModal: (modalId) => set({ activeModal: modalId }),
  closeModal: () => set({ activeModal: null }),
  setDetailPanelOpen: (open) => set({ detailPanelOpen: open }),
  setActivityFeedOpen: (open) => set({ activityFeedOpen: open }),
  openFileInProject: (filePath, projectPath) => set({ pendingFileOpen: { filePath, projectPath } }),
  clearPendingFileOpen: () => set({ pendingFileOpen: null }),
}));
