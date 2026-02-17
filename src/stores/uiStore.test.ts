import { describe, it, expect, beforeEach } from 'vitest';
import { useUiStore } from './uiStore';

describe('uiStore', () => {
  beforeEach(() => {
    useUiStore.setState({
      activeModal: null,
      detailPanelOpen: false,
      activityFeedOpen: false,
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

  describe('setActivityFeedOpen', () => {
    it('opens the activity feed', () => {
      useUiStore.getState().setActivityFeedOpen(true);
      expect(useUiStore.getState().activityFeedOpen).toBe(true);
    });

    it('closes the activity feed', () => {
      useUiStore.getState().setActivityFeedOpen(true);
      useUiStore.getState().setActivityFeedOpen(false);
      expect(useUiStore.getState().activityFeedOpen).toBe(false);
    });
  });
});
