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

  // How the session strip is grouped: by room (the default), flat by recent
  // activity, or by project.
  describe('sessionSortMode', () => {
    async function freshStore(stored: string | null) {
      localStorage.removeItem('session-sort-mode');
      if (stored !== null) localStorage.setItem('session-sort-mode', stored);
      vi.resetModules();
      const mod = await import('./uiStore');
      return mod.useUiStore;
    }

    it('starts grouped by room when nothing is stored', async () => {
      expect((await freshStore(null)).getState().sessionSortMode).toBe('room');
    });

    it.each(['room', 'activity', 'project'] as const)('restores a stored %s', async (mode) => {
      expect((await freshStore(mode)).getState().sessionSortMode).toBe(mode);
    });

    it('falls back to room on a value it does not know', async () => {
      expect((await freshStore('by-colour')).getState().sessionSortMode).toBe('room');
    });

    it('switches to any mode and remembers it', async () => {
      const store = await freshStore(null);
      store.getState().setSessionSortMode('project');
      expect(store.getState().sessionSortMode).toBe('project');
      expect(localStorage.getItem('session-sort-mode')).toBe('project');
      store.getState().setSessionSortMode('activity');
      expect(store.getState().sessionSortMode).toBe('activity');
      expect(localStorage.getItem('session-sort-mode')).toBe('activity');
      store.getState().setSessionSortMode('room');
      expect(store.getState().sessionSortMode).toBe('room');
      expect(localStorage.getItem('session-sort-mode')).toBe('room');
    });

    it('still switches when the browser will not store it', async () => {
      const store = await freshStore(null);
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
      try {
        store.getState().setSessionSortMode('project');
        expect(store.getState().sessionSortMode).toBe('project');
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Project frames in the session strip are not Rooms either, so their folded
  // state is kept here, by project key.
  describe('collapsedProjects', () => {
    async function freshStore(stored: string | null) {
      localStorage.removeItem('collapsed-projects');
      if (stored !== null) localStorage.setItem('collapsed-projects', stored);
      vi.resetModules();
      const mod = await import('./uiStore');
      return mod.useUiStore;
    }

    it('starts with every project expanded', async () => {
      expect((await freshStore(null)).getState().collapsedProjects.size).toBe(0);
    });

    it('restores the projects that were folded', async () => {
      const store = await freshStore(JSON.stringify(['localhost|/w/app', 'localhost|/w/kts']));
      expect([...store.getState().collapsedProjects].sort()).toEqual(['localhost|/w/app', 'localhost|/w/kts']);
    });

    it.each(['not json', '"just a string"', '{"a":1}', '42'])('starts empty on a stored %s', async (junk) => {
      expect((await freshStore(junk)).getState().collapsedProjects.size).toBe(0);
    });

    it('keeps only the strings from a mixed list', async () => {
      const store = await freshStore(JSON.stringify(['localhost|/w/app', 7, null, { a: 1 }]));
      expect([...store.getState().collapsedProjects]).toEqual(['localhost|/w/app']);
    });

    it('folds and unfolds a project, remembering each change', async () => {
      const store = await freshStore(null);
      store.getState().toggleProjectCollapsed('localhost|/w/app');
      expect(store.getState().collapsedProjects.has('localhost|/w/app')).toBe(true);
      expect(JSON.parse(localStorage.getItem('collapsed-projects') ?? '[]')).toEqual(['localhost|/w/app']);

      store.getState().toggleProjectCollapsed('localhost|/w/kts');
      expect(JSON.parse(localStorage.getItem('collapsed-projects') ?? '[]').sort()).toEqual([
        'localhost|/w/app',
        'localhost|/w/kts',
      ]);

      store.getState().toggleProjectCollapsed('localhost|/w/app');
      expect(store.getState().collapsedProjects.has('localhost|/w/app')).toBe(false);
      expect(JSON.parse(localStorage.getItem('collapsed-projects') ?? '[]')).toEqual(['localhost|/w/kts']);
    });

    it('clears the stored entry once the last project is unfolded', async () => {
      const store = await freshStore(null);
      store.getState().toggleProjectCollapsed('localhost|/w/app');
      store.getState().toggleProjectCollapsed('localhost|/w/app');
      expect(localStorage.getItem('collapsed-projects')).toBeNull();
    });

    it('replaces the set instead of changing it, so subscribers see the change', async () => {
      const store = await freshStore(null);
      const before = store.getState().collapsedProjects;
      store.getState().toggleProjectCollapsed('localhost|/w/app');
      const after = store.getState().collapsedProjects;
      expect(after).not.toBe(before);
      expect(before.size).toBe(0);
    });

    it('still folds when the browser will not store it', async () => {
      const store = await freshStore(null);
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
      try {
        store.getState().toggleProjectCollapsed('localhost|/w/app');
        expect(store.getState().collapsedProjects.has('localhost|/w/app')).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // The LIVE page's one-time tip ("Open a session: click a card, or LIVE").
  // Retired for good on this device by its ✕, a card click or a LIVE click.
  describe('liveHintDismissed', () => {
    async function freshStore(stored: string | null) {
      localStorage.removeItem('live-hint-dismissed');
      if (stored !== null) localStorage.setItem('live-hint-dismissed', stored);
      vi.resetModules();
      const mod = await import('./uiStore');
      return mod.useUiStore;
    }

    it('starts not dismissed on a fresh profile', async () => {
      expect((await freshStore(null)).getState().liveHintDismissed).toBe(false);
    });

    it('stays dismissed across reloads', async () => {
      expect((await freshStore('1')).getState().liveHintDismissed).toBe(true);
    });

    it('dismissLiveHint retires it and remembers that', async () => {
      const store = await freshStore(null);
      store.getState().dismissLiveHint();
      expect(store.getState().liveHintDismissed).toBe(true);
      expect(localStorage.getItem('live-hint-dismissed')).toBe('1');
    });

    it('still retires it for this visit when the browser will not store it', async () => {
      const store = await freshStore(null);
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
      try {
        store.getState().dismissLiveHint();
        expect(store.getState().liveHintDismissed).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('reads a blocked storage as not dismissed instead of throwing', async () => {
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
      try {
        vi.resetModules();
        const mod = await import('./uiStore');
        expect(mod.useUiStore.getState().liveHintDismissed).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // The docked queue (the strip under the terminal, and the QUEUE tab) folds to
  // its header. One flag, because TerminalContent sizes the strip's row from it
  // and both QueueTab mounts show it; the float window ignores it.
  describe('queuePanelCollapsed', () => {
    async function freshStore(stored: string | null) {
      localStorage.removeItem('queue-panel-collapsed');
      if (stored !== null) localStorage.setItem('queue-panel-collapsed', stored);
      vi.resetModules();
      const mod = await import('./uiStore');
      return mod.useUiStore;
    }

    it('starts collapsed on a fresh profile, as the strip always has', async () => {
      expect((await freshStore(null)).getState().queuePanelCollapsed).toBe(true);
    });

    it('restores a stored choice either way', async () => {
      expect((await freshStore('0')).getState().queuePanelCollapsed).toBe(false);
      expect((await freshStore('1')).getState().queuePanelCollapsed).toBe(true);
    });

    it('persists both ways under the key QueueTab has always used', async () => {
      const store = await freshStore('0');
      store.getState().setQueuePanelCollapsed(true);
      expect(store.getState().queuePanelCollapsed).toBe(true);
      expect(localStorage.getItem('queue-panel-collapsed')).toBe('1');
      store.getState().setQueuePanelCollapsed(false);
      expect(store.getState().queuePanelCollapsed).toBe(false);
      expect(localStorage.getItem('queue-panel-collapsed')).toBe('0');
    });

    it('still collapses for this visit when the browser will not store it', async () => {
      const store = await freshStore('0');
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
      try {
        store.getState().setQueuePanelCollapsed(true);
        expect(store.getState().queuePanelCollapsed).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('reads a blocked storage as collapsed, the default', async () => {
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
      try {
        vi.resetModules();
        const mod = await import('./uiStore');
        expect(mod.useUiStore.getState().queuePanelCollapsed).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
