import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore, CLI_SOUND_PROFILES, DEFAULT_AMBIENT_SETTINGS } from './settingsStore';

const defaultPerCli = {
  claude: { ...CLI_SOUND_PROFILES.claude },
  gemini: { ...CLI_SOUND_PROFILES.gemini },
  codex: { ...CLI_SOUND_PROFILES.codex },
  openclaw: { ...CLI_SOUND_PROFILES.openclaw },
};

describe('settingsStore', () => {
  beforeEach(() => {
    // Reset to defaults
    useSettingsStore.setState({
      soundSettings: {
        enabled: true,
        volume: 0.5,
        muteApproval: false,
        muteInput: false,
        perCli: { ...defaultPerCli },
      },
      ambientSettings: { ...DEFAULT_AMBIENT_SETTINGS },
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

  describe('per-CLI sound config', () => {
    it('has default per-CLI profiles', () => {
      const { soundSettings } = useSettingsStore.getState();
      expect(soundSettings.perCli.claude.enabled).toBe(true);
      expect(soundSettings.perCli.gemini.enabled).toBe(true);
      expect(soundSettings.perCli.codex.enabled).toBe(true);
      expect(soundSettings.perCli.openclaw.enabled).toBe(true);
    });

    it('has distinct CLI volume defaults', () => {
      const { soundSettings } = useSettingsStore.getState();
      expect(soundSettings.perCli.claude.volume).toBe(0.7);
      expect(soundSettings.perCli.codex.volume).toBe(0.5);
    });

    it('has per-CLI action sounds', () => {
      const { soundSettings } = useSettingsStore.getState();
      expect(soundSettings.perCli.claude.actions.sessionStart).toBe('chime');
      expect(soundSettings.perCli.gemini.actions.sessionStart).toBe('ding');
      expect(soundSettings.perCli.codex.actions.sessionStart).toBe('blip');
      expect(soundSettings.perCli.openclaw.actions.sessionStart).toBe('fanfare');
    });

    it('updateCliSoundConfig updates CLI volume immutably', () => {
      useSettingsStore.getState().updateCliSoundConfig('claude', { volume: 0.3 });
      const { soundSettings } = useSettingsStore.getState();
      expect(soundSettings.perCli.claude.volume).toBe(0.3);
      expect(soundSettings.perCli.claude.enabled).toBe(true); // unchanged
      expect(soundSettings.perCli.gemini.volume).toBe(0.7); // other CLI unchanged
    });

    it('updateCliSoundConfig can disable a CLI', () => {
      useSettingsStore.getState().updateCliSoundConfig('gemini', { enabled: false });
      expect(useSettingsStore.getState().soundSettings.perCli.gemini.enabled).toBe(false);
    });

    it('setCliActionSound changes a single action sound', () => {
      useSettingsStore.getState().setCliActionSound('claude', 'sessionStart', 'buzz');
      const { soundSettings } = useSettingsStore.getState();
      expect(soundSettings.perCli.claude.actions.sessionStart).toBe('buzz');
      expect(soundSettings.perCli.claude.actions.sessionEnd).toBe('cascade'); // unchanged
    });
  });

  describe('ambient settings', () => {
    it('has correct ambient defaults', () => {
      const { ambientSettings } = useSettingsStore.getState();
      expect(ambientSettings.enabled).toBe(false);
      expect(ambientSettings.volume).toBe(0.3);
      expect(ambientSettings.preset).toBe('off');
      expect(ambientSettings.roomSounds).toBe(false);
      expect(ambientSettings.roomVolume).toBe(0.2);
    });

    it('updateAmbientSettings updates preset immutably', () => {
      useSettingsStore.getState().updateAmbientSettings({ preset: 'rain' });
      const { ambientSettings } = useSettingsStore.getState();
      expect(ambientSettings.preset).toBe('rain');
      expect(ambientSettings.enabled).toBe(false); // unchanged
    });

    it('updateAmbientSettings can enable and set volume', () => {
      useSettingsStore.getState().updateAmbientSettings({ enabled: true, volume: 0.6 });
      const { ambientSettings } = useSettingsStore.getState();
      expect(ambientSettings.enabled).toBe(true);
      expect(ambientSettings.volume).toBe(0.6);
    });

    it('updateAmbientSettings can toggle room sounds', () => {
      useSettingsStore.getState().updateAmbientSettings({ roomSounds: true, roomVolume: 0.5 });
      const { ambientSettings } = useSettingsStore.getState();
      expect(ambientSettings.roomSounds).toBe(true);
      expect(ambientSettings.roomVolume).toBe(0.5);
    });
  });
});
