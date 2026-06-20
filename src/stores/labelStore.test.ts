import { describe, it, expect, beforeEach } from 'vitest';
import {
  useLabelStore,
  BUILTIN_LABELS,
  DEFAULT_LABEL_COLOR,
  MAX_CUSTOM_LABELS,
} from './labelStore';
import { clearLocalStorage } from '../__tests__/setup';

describe('labelStore', () => {
  beforeEach(() => {
    clearLocalStorage();
    useLabelStore.setState({ labels: {}, custom: [] });
  });

  describe('setLabel / getLabel', () => {
    it('sets a label for a session', () => {
      useLabelStore.getState().setLabel('s1', 'HEAVY');
      expect(useLabelStore.getState().getLabel('s1')).toBe('HEAVY');
    });

    it('overwrites with a single label (one at a time)', () => {
      useLabelStore.getState().setLabel('s1', 'HEAVY');
      useLabelStore.getState().setLabel('s1', 'IMPORTANT');
      expect(useLabelStore.getState().getLabel('s1')).toBe('IMPORTANT');
    });

    it('clears a label when given null', () => {
      useLabelStore.getState().setLabel('s1', 'HEAVY');
      useLabelStore.getState().setLabel('s1', null);
      expect(useLabelStore.getState().getLabel('s1')).toBeUndefined();
    });

    it('does not affect other sessions', () => {
      useLabelStore.getState().setLabel('s1', 'HEAVY');
      useLabelStore.getState().setLabel('s2', 'ONEOFF');
      useLabelStore.getState().setLabel('s1', null);
      expect(useLabelStore.getState().getLabel('s2')).toBe('ONEOFF');
    });

    it('persists the label map to localStorage', () => {
      useLabelStore.getState().setLabel('s1', 'HEAVY');
      const stored = JSON.parse(localStorage.getItem('session-label-map') ?? '{}');
      expect(stored).toEqual({ s1: 'HEAVY' });
    });

    it('persists removal to localStorage', () => {
      useLabelStore.getState().setLabel('s1', 'HEAVY');
      useLabelStore.getState().setLabel('s1', null);
      const stored = JSON.parse(localStorage.getItem('session-label-map') ?? '{}');
      expect(stored).toEqual({});
    });
  });

  describe('addCustom / removeCustom', () => {
    it('adds a custom label', () => {
      useLabelStore.getState().addCustom('REVIEW', '#00ff88');
      expect(useLabelStore.getState().custom).toEqual([{ name: 'REVIEW', color: '#00ff88' }]);
    });

    it('trims whitespace and ignores empty names', () => {
      useLabelStore.getState().addCustom('  ', '#fff');
      expect(useLabelStore.getState().custom).toHaveLength(0);
      useLabelStore.getState().addCustom('  PADDED  ', '#fff');
      expect(useLabelStore.getState().custom[0].name).toBe('PADDED');
    });

    it('dedupes by name (case-insensitive) and updates color', () => {
      useLabelStore.getState().addCustom('Review', '#111111');
      useLabelStore.getState().addCustom('review', '#222222');
      const { custom } = useLabelStore.getState();
      expect(custom).toHaveLength(1);
      expect(custom[0].color).toBe('#222222');
    });

    it('does not shadow a built-in label name', () => {
      useLabelStore.getState().addCustom('HEAVY', '#000000');
      expect(useLabelStore.getState().custom).toHaveLength(0);
    });

    it('caps the number of custom labels', () => {
      for (let i = 0; i < MAX_CUSTOM_LABELS + 5; i++) {
        useLabelStore.getState().addCustom(`L${i}`, '#abcdef');
      }
      expect(useLabelStore.getState().custom).toHaveLength(MAX_CUSTOM_LABELS);
    });

    it('removes a custom label by name (case-insensitive)', () => {
      useLabelStore.getState().addCustom('REVIEW', '#00ff88');
      useLabelStore.getState().removeCustom('review');
      expect(useLabelStore.getState().custom).toHaveLength(0);
    });

    it('persists custom labels to localStorage', () => {
      useLabelStore.getState().addCustom('REVIEW', '#00ff88');
      const stored = JSON.parse(localStorage.getItem('custom-label-defs') ?? '[]');
      expect(stored).toEqual([{ name: 'REVIEW', color: '#00ff88' }]);
    });
  });

  describe('labelColor', () => {
    it('resolves built-in label colors', () => {
      const heavy = BUILTIN_LABELS.find((l) => l.name === 'HEAVY')!;
      expect(useLabelStore.getState().labelColor('HEAVY')).toBe(heavy.color);
    });

    it('resolves built-in colors case-insensitively', () => {
      const oneoff = BUILTIN_LABELS.find((l) => l.name === 'ONEOFF')!;
      expect(useLabelStore.getState().labelColor('oneoff')).toBe(oneoff.color);
    });

    it('resolves custom label colors', () => {
      useLabelStore.getState().addCustom('REVIEW', '#00ff88');
      expect(useLabelStore.getState().labelColor('REVIEW')).toBe('#00ff88');
    });

    it('falls back to the default color for unknown names', () => {
      expect(useLabelStore.getState().labelColor('UNKNOWN')).toBe(DEFAULT_LABEL_COLOR);
    });
  });

  describe('loadFromStorage', () => {
    it('round-trips both maps via localStorage', () => {
      localStorage.setItem('session-label-map', JSON.stringify({ s9: 'IMPORTANT' }));
      localStorage.setItem('custom-label-defs', JSON.stringify([{ name: 'WIP', color: '#123456' }]));
      useLabelStore.getState().loadFromStorage();
      const state = useLabelStore.getState();
      expect(state.getLabel('s9')).toBe('IMPORTANT');
      expect(state.custom).toEqual([{ name: 'WIP', color: '#123456' }]);
      expect(state.labelColor('WIP')).toBe('#123456');
    });

    it('handles empty/missing storage gracefully', () => {
      useLabelStore.getState().loadFromStorage();
      expect(useLabelStore.getState().labels).toEqual({});
      expect(useLabelStore.getState().custom).toEqual([]);
    });
  });
});
