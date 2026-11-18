/**
 * quickCreateStore — whether the "＋ New" menu is open (Nov 17 2026).
 *
 * Its own small store, not a uiStore flag: the menu is opened from three places that never mount together
 * (the session rail's ＋ New, the top bar's ＋ New, and the `newSession` shortcut) and is drawn once, in App.
 */
import { create } from 'zustand';

interface QuickCreateState {
  open: boolean;
  /** Open, or close when it is already open (the button is a toggle). */
  toggle: () => void;
  openMenu: () => void;
  close: () => void;
}

export const useQuickCreateStore = create<QuickCreateState>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  openMenu: () => set({ open: true }),
  close: () => set({ open: false }),
}));
