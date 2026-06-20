import { describe, it, expect, beforeEach } from 'vitest';
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
});
