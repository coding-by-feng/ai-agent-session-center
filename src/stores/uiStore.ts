import { create } from 'zustand';

interface UiState {
  activeModal: string | null;
  detailPanelOpen: boolean;
  activityFeedOpen: boolean;

  openModal: (modalId: string) => void;
  closeModal: () => void;
  setDetailPanelOpen: (open: boolean) => void;
  setActivityFeedOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeModal: null,
  detailPanelOpen: false,
  activityFeedOpen: false,

  openModal: (modalId) => set({ activeModal: modalId }),
  closeModal: () => set({ activeModal: null }),
  setDetailPanelOpen: (open) => set({ detailPanelOpen: open }),
  setActivityFeedOpen: (open) => set({ activityFeedOpen: open }),
}));
