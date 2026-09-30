import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUiStore } from './uiStore';

describe('uiStore', () => {
  beforeEach(() => {
    useUiStore.setState({
      activeModal: null,
      detailPanelOpen: false,
    });
  });

  describe('openModal / closeModal', () => {
    it('opens a modal by id', () => {
      useUiStore.getState().openModal('kill-session');
      expect(useUiStore.getState().activeModal).toBe('kill-session');
    });

    it('closes the active modal', () => {
      useUiStore.getState().openModal('kill-session');
      useUiStore.getState().closeModal();
      expect(useUiStore.getState().activeModal).toBe(null);
    });

    it('replaces the active modal when opening a different one', () => {
      useUiStore.getState().openModal('kill-session');
      useUiStore.getState().openModal('summarize');
      expect(useUiStore.getState().activeModal).toBe('summarize');
    });
  });

  describe('setDetailPanelOpen', () => {
    it('opens the detail panel', () => {
      useUiStore.getState().setDetailPanelOpen(true);
      expect(useUiStore.getState().detailPanelOpen).toBe(true);
    });

    it('closes the detail panel', () => {
      useUiStore.getState().setDetailPanelOpen(true);
      useUiStore.getState().setDetailPanelOpen(false);
      expect(useUiStore.getState().detailPanelOpen).toBe(false);
    });
  });

  describe('openFileChooser / clearFileChooser', () => {
    beforeEach(() => {
      useUiStore.setState({ pendingFileChooser: null, pendingFileOpen: null });
    });

    it('sets pendingFileChooser with path, project, and anchor', () => {
      useUiStore.getState().openFileChooser('docs/report.pdf', '/Users/me/proj', { x: 120, y: 240 });
      expect(useUiStore.getState().pendingFileChooser).toEqual({
        filePath: 'docs/report.pdf',
        projectPath: '/Users/me/proj',
        anchor: { x: 120, y: 240 },
      });
    });

    it('does not touch pendingFileOpen when the chooser opens', () => {
      useUiStore.getState().openFileChooser('a.md', '/p', { x: 0, y: 0 });
      expect(useUiStore.getState().pendingFileOpen).toBe(null);
    });

    it('clears pendingFileChooser', () => {
      useUiStore.getState().openFileChooser('a.md', '/p', { x: 0, y: 0 });
      useUiStore.getState().clearFileChooser();
      expect(useUiStore.getState().pendingFileChooser).toBe(null);
    });

    it('replaces a previous chooser when opened again', () => {
      useUiStore.getState().openFileChooser('a.md', '/p', { x: 0, y: 0 });
      useUiStore.getState().openFileChooser('b.md', '/q', { x: 5, y: 6 });
      expect(useUiStore.getState().pendingFileChooser?.filePath).toBe('b.md');
      expect(useUiStore.getState().pendingFileChooser?.projectPath).toBe('/q');
    });
  });

  // The initial mode is resolved by loadQueueViewMode() when the store MODULE
  // is first evaluated, so it can only be tested by re-importing the module
  // with localStorage already set. The previous "defaults to list" test set
  // `queueViewMode: 'list'` in its own beforeEach and then asserted it — it
  // never reached the loader, so it passed regardless of what the default
  // actually was, and would have kept passing through this very change.
  describe('queueViewMode default (loaded at module init)', () => {
    async function freshStore(stored: string | null) {
      localStorage.removeItem('queue-view-mode');
      if (stored !== null) localStorage.setItem('queue-view-mode', stored);
      vi.resetModules();
      const mod = await import('./uiStore');
      return mod.useUiStore.getState().queueViewMode;
    }

    it('defaults to CARD when nothing is stored', async () => {
      expect(await freshStore(null)).toBe('card');
    });

    it('honours an explicitly stored list choice', async () => {
      // The case that matters most: a user who deliberately picked list must
      // not be flipped onto the new default.
      expect(await freshStore('list')).toBe('list');
    });

    it('honours an explicitly stored card choice', async () => {
      expect(await freshStore('card')).toBe('card');
    });

    it('falls back to card on an unrecognised stored value', async () => {
      expect(await freshStore('nonsense')).toBe('card');
    });
  });

  describe('toggleQueueViewMode', () => {
    beforeEach(() => {
      localStorage.removeItem('queue-view-mode');
      useUiStore.setState({ queueViewMode: 'list' });
    });

    it('toggles from list to card', () => {
      useUiStore.getState().toggleQueueViewMode();
      expect(useUiStore.getState().queueViewMode).toBe('card');
    });

    it('toggles back from card to list on a second call', () => {
      useUiStore.getState().toggleQueueViewMode();
      useUiStore.getState().toggleQueueViewMode();
      expect(useUiStore.getState().queueViewMode).toBe('list');
    });

    it('persists the mode to localStorage', () => {
      useUiStore.getState().toggleQueueViewMode();
      expect(localStorage.getItem('queue-view-mode')).toBe('card');
      useUiStore.getState().toggleQueueViewMode();
      expect(localStorage.getItem('queue-view-mode')).toBe('list');
    });
  });

  // The rail's built-in RECENT frame is not a Room, so it cannot keep its
  // collapsed flag on room.collapsed like the user's rooms do.
  describe('recentRoomCollapsed', () => {
    async function freshStore(stored: string | null) {
      localStorage.removeItem('recent-room-collapsed');
      if (stored !== null) localStorage.setItem('recent-room-collapsed', stored);
      vi.resetModules();
      const mod = await import('./uiStore');
      return mod.useUiStore;
    }

    it('starts expanded when nothing is stored', async () => {
      expect((await freshStore(null)).getState().recentRoomCollapsed).toBe(false);
    });

    it('restores a stored collapse', async () => {
      expect((await freshStore('1')).getState().recentRoomCollapsed).toBe(true);
    });

    it('toggles and persists both ways', async () => {
      const store = await freshStore(null);
      store.getState().toggleRecentRoomCollapsed();
      expect(store.getState().recentRoomCollapsed).toBe(true);
      expect(localStorage.getItem('recent-room-collapsed')).toBe('1');
      store.getState().toggleRecentRoomCollapsed();
      expect(store.getState().recentRoomCollapsed).toBe(false);
      expect(localStorage.getItem('recent-room-collapsed')).toBe('0');
    });
  });
});
