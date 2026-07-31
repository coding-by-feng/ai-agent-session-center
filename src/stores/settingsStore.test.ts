import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore, CLI_SOUND_PROFILES, DEFAULT_AMBIENT_SETTINGS, fullCliActions } from './settingsStore';

const defaultPerCli = {
  claude: { ...CLI_SOUND_PROFILES.claude },
  codex: { ...CLI_SOUND_PROFILES.codex },
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
      expect(soundSettings.perCli.codex.enabled).toBe(true);
    });

    it('has distinct CLI volume defaults', () => {
      const { soundSettings } = useSettingsStore.getState();
      expect(soundSettings.perCli.claude.volume).toBe(0.7);
      expect(soundSettings.perCli.codex.volume).toBe(0.5);
    });

    it('is quiet by default — only high-signal events make a sound', () => {
      const { soundSettings } = useSettingsStore.getState();
      // High-signal, low-frequency events keep a sound out of the box…
      expect(soundSettings.perCli.claude.actions.approvalNeeded).toBe('alarm');
      expect(soundSettings.perCli.claude.actions.inputNeeded).toBe('chime');
      expect(soundSettings.perCli.claude.actions.alert).toBe('alarm');
      // taskComplete fires every turn, so 'quiet' uses a subtle blip (not fanfare).
      expect(soundSettings.perCli.claude.actions.taskComplete).toBe('blip');
      expect(soundSettings.perCli.codex.actions.taskComplete).toBe('blip');
      // …while per-tool chatter and session/subagent noise is silenced.
      expect(soundSettings.perCli.claude.actions.sessionStart).toBe('none');
      expect(soundSettings.perCli.claude.actions.toolRead).toBe('none');
      expect(soundSettings.perCli.codex.actions.subagentStart).toBe('none');
    });

    it('updateCliSoundConfig updates CLI volume immutably', () => {
      useSettingsStore.getState().updateCliSoundConfig('claude', { volume: 0.3 });
      const { soundSettings } = useSettingsStore.getState();
      expect(soundSettings.perCli.claude.volume).toBe(0.3);
      expect(soundSettings.perCli.claude.enabled).toBe(true); // unchanged
      expect(soundSettings.perCli.codex.volume).toBe(0.5); // other CLI unchanged
    });

    it('updateCliSoundConfig can disable a CLI', () => {
      useSettingsStore.getState().updateCliSoundConfig('codex', { enabled: false });
      expect(useSettingsStore.getState().soundSettings.perCli.codex.enabled).toBe(false);
    });

    it('setCliActionSound changes a single action sound', () => {
      useSettingsStore.getState().setCliActionSound('claude', 'sessionStart', 'buzz');
      const { soundSettings } = useSettingsStore.getState();
      expect(soundSettings.perCli.claude.actions.sessionStart).toBe('buzz');
      expect(soundSettings.perCli.claude.actions.approvalNeeded).toBe('alarm'); // other action unchanged
    });

    it('applyCliSoundPreset toggles between full and quiet profiles', () => {
      useSettingsStore.getState().applyCliSoundPreset('claude', 'full');
      let actions = useSettingsStore.getState().soundSettings.perCli.claude.actions;
      expect(actions.toolRead).toBe('click'); // per-tool sounds restored
      expect(actions.sessionStart).toBe('chime');

      useSettingsStore.getState().applyCliSoundPreset('claude', 'quiet');
      actions = useSettingsStore.getState().soundSettings.perCli.claude.actions;
      expect(actions.toolRead).toBe('none'); // chatter silenced again
      expect(actions.subagentStart).toBe('none');
      expect(actions.approvalNeeded).toBe('alarm'); // high-signal kept
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

  describe('quiet-by-default migration', () => {
    function loudPerCli() {
      return {
        claude: { enabled: true, volume: 0.7, actions: fullCliActions('claude') },
        codex: { enabled: true, volume: 0.5, actions: fullCliActions('codex') },
      };
    }

    it('quiets untouched loud profiles and stamps the schema version', () => {
      useSettingsStore.getState().loadFromDb({
        soundSettings: { enabled: true, volume: 0.5, muteApproval: false, muteInput: false, perCli: loudPerCli() },
      });
      const perCli = useSettingsStore.getState().soundSettings.perCli;
      expect(perCli.claude.actions.toolRead).toBe('none'); // per-tool chatter silenced
      expect(perCli.claude.actions.taskComplete).toBe('blip'); // subtle done cue
      expect(perCli.claude.actions.approvalNeeded).toBe('alarm'); // high-signal kept
      expect(useSettingsStore.getState().settingsSchemaVersion).toBe(1);
    });

    it('preserves a customized profile — only untouched ones are quieted', () => {
      const perCliIn = loudPerCli();
      perCliIn.claude.actions = { ...fullCliActions('claude'), toolRead: 'warble' };
      useSettingsStore.getState().loadFromDb({
        soundSettings: { enabled: true, volume: 0.5, muteApproval: false, muteInput: false, perCli: perCliIn },
      });
      const perCli = useSettingsStore.getState().soundSettings.perCli;
      expect(perCli.claude.actions.toolRead).toBe('warble'); // user customization respected
    });

    it('does not re-quiet a user already on the current schema version', () => {
      useSettingsStore.getState().loadFromDb({
        settingsSchemaVersion: 1,
        soundSettings: { enabled: true, volume: 0.5, muteApproval: false, muteInput: false, perCli: loudPerCli() },
      });
      // Already migrated → a deliberate loud choice is respected, not re-quieted.
      expect(useSettingsStore.getState().soundSettings.perCli.claude.actions.toolRead).toBe('click');
    });
  });
});
