import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from './settingsStore';

describe('settingsStore', () => {
  beforeEach(() => {
    // Reset to defaults
    useSettingsStore.setState({
      soundSettings: {
        enabled: true,
        volume: 0.5,
        muteApproval: false,
        muteInput: false,
      },
      labelAlarms: {
        labels: [],
        soundEnabled: true,
      },
      theme: 'dark',
      compactMode: false,
      showArchived: false,
      groupBy: 'none',
      sortBy: 'activity',
      fontSize: 13,
      characterModel: 'Xbot',
      animationIntensity: 1,
      hookDensity: 'medium',
    });
  });

  describe('default values', () => {
    it('has correct defaults', () => {
      const state = useSettingsStore.getState();
      expect(state.theme).toBe('dark');
      expect(state.fontSize).toBe(13);
      expect(state.characterModel).toBe('Xbot');
      expect(state.animationIntensity).toBe(1);
      expect(state.hookDensity).toBe('medium');
      expect(state.compactMode).toBe(false);
      expect(state.showArchived).toBe(false);
      expect(state.groupBy).toBe('none');
      expect(state.sortBy).toBe('activity');
    });

    it('has correct sound defaults', () => {
      const { soundSettings } = useSettingsStore.getState();
      expect(soundSettings.enabled).toBe(true);
      expect(soundSettings.volume).toBe(0.5);
      expect(soundSettings.muteApproval).toBe(false);
      expect(soundSettings.muteInput).toBe(false);
    });

    it('has correct label alarm defaults', () => {
      const { labelAlarms } = useSettingsStore.getState();
      expect(labelAlarms.labels).toEqual([]);
      expect(labelAlarms.soundEnabled).toBe(true);
    });
  });

  describe('setTheme', () => {
    it('changes theme to light', () => {
      useSettingsStore.getState().setTheme('light');
      expect(useSettingsStore.getState().theme).toBe('light');
    });

    it('changes theme back to dark', () => {
      useSettingsStore.getState().setTheme('light');
      useSettingsStore.getState().setTheme('dark');
      expect(useSettingsStore.getState().theme).toBe('dark');
    });
  });

  describe('setFontSize', () => {
    it('updates font size', () => {
      useSettingsStore.getState().setFontSize(16);
      expect(useSettingsStore.getState().fontSize).toBe(16);
    });
  });

  describe('setCharacterModel', () => {
    it('updates character model', () => {
      useSettingsStore.getState().setCharacterModel('CustomBot');
      expect(useSettingsStore.getState().characterModel).toBe('CustomBot');
    });
  });

  describe('setAnimationIntensity', () => {
    it('updates animation intensity', () => {
      useSettingsStore.getState().setAnimationIntensity(0.5);
      expect(useSettingsStore.getState().animationIntensity).toBe(0.5);
    });
  });

  describe('setHookDensity', () => {
    it('updates hook density', () => {
      useSettingsStore.getState().setHookDensity('high');
      expect(useSettingsStore.getState().hookDensity).toBe('high');
    });

    it('supports all density levels', () => {
      for (const level of ['high', 'medium', 'low'] as const) {
        useSettingsStore.getState().setHookDensity(level);
        expect(useSettingsStore.getState().hookDensity).toBe(level);
      }
    });
  });

  describe('setCompactMode', () => {
    it('enables compact mode', () => {
      useSettingsStore.getState().setCompactMode(true);
      expect(useSettingsStore.getState().compactMode).toBe(true);
    });
  });

  describe('setShowArchived', () => {
    it('enables show archived', () => {
      useSettingsStore.getState().setShowArchived(true);
      expect(useSettingsStore.getState().showArchived).toBe(true);
    });
  });

  describe('setGroupBy', () => {
    it('changes groupBy setting', () => {
      useSettingsStore.getState().setGroupBy('project');
      expect(useSettingsStore.getState().groupBy).toBe('project');
    });

    it('supports all groupBy options', () => {
      for (const opt of ['none', 'project', 'status', 'source'] as const) {
        useSettingsStore.getState().setGroupBy(opt);
        expect(useSettingsStore.getState().groupBy).toBe(opt);
      }
    });
  });

  describe('setSortBy', () => {
    it('changes sortBy setting', () => {
      useSettingsStore.getState().setSortBy('name');
      expect(useSettingsStore.getState().sortBy).toBe('name');
    });

    it('supports all sortBy options', () => {
      for (const opt of ['activity', 'name', 'status', 'created'] as const) {
        useSettingsStore.getState().setSortBy(opt);
        expect(useSettingsStore.getState().sortBy).toBe(opt);
      }
    });
  });

  describe('updateSoundSettings', () => {
    it('updates partial sound settings immutably', () => {
      useSettingsStore.getState().updateSoundSettings({ volume: 0.8 });
      const { soundSettings } = useSettingsStore.getState();
      expect(soundSettings.volume).toBe(0.8);
      expect(soundSettings.enabled).toBe(true); // unchanged
    });

    it('can disable sound', () => {
      useSettingsStore.getState().updateSoundSettings({ enabled: false });
      expect(useSettingsStore.getState().soundSettings.enabled).toBe(false);
    });

    it('can mute approval sounds', () => {
      useSettingsStore.getState().updateSoundSettings({ muteApproval: true });
      expect(useSettingsStore.getState().soundSettings.muteApproval).toBe(true);
    });
  });

  describe('updateLabelAlarms', () => {
    it('updates label list', () => {
      useSettingsStore.getState().updateLabelAlarms({ labels: ['reviewer', 'builder'] });
      expect(useSettingsStore.getState().labelAlarms.labels).toEqual(['reviewer', 'builder']);
    });

    it('disables alarm sound', () => {
      useSettingsStore.getState().updateLabelAlarms({ soundEnabled: false });
      expect(useSettingsStore.getState().labelAlarms.soundEnabled).toBe(false);
    });

    it('preserves unmodified fields', () => {
      useSettingsStore.getState().updateLabelAlarms({ labels: ['test'] });
      expect(useSettingsStore.getState().labelAlarms.soundEnabled).toBe(true);
    });
  });

  describe('loadFromDb', () => {
    it('merges partial state from DB', () => {
      useSettingsStore.getState().loadFromDb({ theme: 'light', fontSize: 16 });
      const state = useSettingsStore.getState();
      expect(state.theme).toBe('light');
      expect(state.fontSize).toBe(16);
      expect(state.characterModel).toBe('Xbot'); // unchanged
    });
  });

  describe('saveToDb', () => {
    it('returns a snapshot of current state', () => {
      useSettingsStore.getState().setTheme('light');
      const snapshot = useSettingsStore.getState().saveToDb();
      expect(snapshot.theme).toBe('light');
      expect(typeof snapshot.setTheme).toBe('function');
    });
  });
});
