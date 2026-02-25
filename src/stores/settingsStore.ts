import { create } from 'zustand';
import { db } from '@/lib/db';
import type { BrowserSettings, SoundSettings, LabelAlarmSettings, AmbientSettings, CliSoundConfig, AmbientPreset } from '@/types';

// ---------------------------------------------------------------------------
// Theme definitions (matching original 9 themes)
// ---------------------------------------------------------------------------

export type ThemeName =
  | 'command-center'
  | 'cyberpunk'
  | 'warm'
  | 'dracula'
  | 'solarized'
  | 'nord'
  | 'monokai'
  | 'light'
  | 'blonde';

export interface ThemeDefinition {
  name: ThemeName;
  label: string;
  colors: [string, string, string];
}

export const THEMES: ThemeDefinition[] = [
  { name: 'command-center', label: 'Command Center', colors: ['#0a0a1a', '#00e5ff', '#ff9100'] },
  { name: 'cyberpunk', label: 'Cyberpunk', colors: ['#0d0221', '#ff00ff', '#00ffff'] },
  { name: 'warm', label: 'Warm', colors: ['#faf6f1', '#d97706', '#b87333'] },
  { name: 'dracula', label: 'Dracula', colors: ['#282a36', '#bd93f9', '#50fa7b'] },
  { name: 'solarized', label: 'Solarized', colors: ['#002b36', '#2aa198', '#cb4b16'] },
  { name: 'nord', label: 'Nord', colors: ['#2e3440', '#88c0d0', '#d08770'] },
  { name: 'monokai', label: 'Monokai', colors: ['#272822', '#66d9ef', '#f92672'] },
  { name: 'light', label: 'Light', colors: ['#f0f2f5', '#0ea5e9', '#3b82f6'] },
  { name: 'blonde', label: 'Blonde', colors: ['#fdf8ef', '#ca8a04', '#a16207'] },
];

// ---------------------------------------------------------------------------
// Per-CLI default sound profiles
// ---------------------------------------------------------------------------

export const CLI_SOUND_PROFILES: Record<string, CliSoundConfig> = {
  claude: {
    enabled: true,
    volume: 0.7,
    actions: {
      sessionStart: 'chime',
      sessionEnd: 'cascade',
      promptSubmit: 'ping',
      taskComplete: 'fanfare',
      toolRead: 'click',
      toolWrite: 'blip',
      toolEdit: 'blip',
      toolBash: 'click',
      toolGrep: 'click',
      toolGlob: 'click',
      toolWebFetch: 'ping',
      toolTask: 'chime',
      toolOther: 'click',
      approvalNeeded: 'alarm',
      inputNeeded: 'chime',
      alert: 'alarm',
      kill: 'thud',
      archive: 'ping',
      subagentStart: 'chirp',
      subagentStop: 'ping',
    },
  },
  gemini: {
    enabled: true,
    volume: 0.7,
    actions: {
      sessionStart: 'ding',
      sessionEnd: 'cascade',
      promptSubmit: 'chirp',
      taskComplete: 'fanfare',
      toolRead: 'click',
      toolWrite: 'swoosh',
      toolEdit: 'swoosh',
      toolBash: 'ding',
      toolGrep: 'click',
      toolGlob: 'click',
      toolWebFetch: 'swoosh',
      toolTask: 'ding',
      toolOther: 'chirp',
      approvalNeeded: 'alarm',
      inputNeeded: 'ding',
      alert: 'alarm',
      kill: 'thud',
      archive: 'swoosh',
      subagentStart: 'chirp',
      subagentStop: 'ding',
    },
  },
  codex: {
    enabled: true,
    volume: 0.5,
    actions: {
      sessionStart: 'blip',
      sessionEnd: 'beep',
      promptSubmit: 'click',
      taskComplete: 'blip',
      toolRead: 'click',
      toolWrite: 'blip',
      toolEdit: 'blip',
      toolBash: 'beep',
      toolGrep: 'click',
      toolGlob: 'click',
      toolWebFetch: 'click',
      toolTask: 'beep',
      toolOther: 'click',
      approvalNeeded: 'alarm',
      inputNeeded: 'beep',
      alert: 'alarm',
      kill: 'thud',
      archive: 'click',
      subagentStart: 'blip',
      subagentStop: 'beep',
    },
  },
  openclaw: {
    enabled: true,
    volume: 0.7,
    actions: {
      sessionStart: 'fanfare',
      sessionEnd: 'cascade',
      promptSubmit: 'buzz',
      taskComplete: 'fanfare',
      toolRead: 'click',
      toolWrite: 'buzz',
      toolEdit: 'buzz',
      toolBash: 'buzz',
      toolGrep: 'click',
      toolGlob: 'click',
      toolWebFetch: 'swoosh',
      toolTask: 'buzz',
      toolOther: 'buzz',
      approvalNeeded: 'urgentAlarm',
      inputNeeded: 'fanfare',
      alert: 'urgentAlarm',
      kill: 'thud',
      archive: 'cascade',
      subagentStart: 'fanfare',
      subagentStop: 'cascade',
    },
  },
};

export const DEFAULT_AMBIENT_SETTINGS: AmbientSettings = {
  enabled: false,
  volume: 0.3,
  preset: 'off',
  roomSounds: false,
  roomVolume: 0.2,
};

// ---------------------------------------------------------------------------
// Sound action mapping
// ---------------------------------------------------------------------------

export interface SoundActionMap {
  [action: string]: string;
}

// ---------------------------------------------------------------------------
// Movement action mapping
// ---------------------------------------------------------------------------

export interface MovementActionMap {
  [action: string]: string;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

interface SettingsState extends BrowserSettings {
  // Appearance
  themeName: ThemeName;
  fontSize: number;
  scanlineEnabled: boolean;
  animationIntensity: number;
  animationSpeed: number;
  characterModel: string;

  // Sound
  soundActions: SoundActionMap;
  movementActions: MovementActionMap;

  // Hooks
  hookDensity: 'high' | 'medium' | 'low' | 'off';

  // UI
  scene3dEnabled: boolean;
  activityFeedVisible: boolean;
  toastEnabled: boolean;
  autoSendQueue: boolean;
  defaultTerminalTheme: string;

  // API Keys (stored in localStorage for privacy)
  anthropicApiKey: string;
  openaiApiKey: string;
  geminiApiKey: string;

  // Autosave flash
  autosaveVisible: boolean;

  // Actions
  loadFromDb: (settings: Partial<SettingsState>) => void;
  saveToDb: () => SettingsState;
  updateSoundSettings: (settings: Partial<SoundSettings>) => void;
  updateCliSoundConfig: (cli: string, config: Partial<CliSoundConfig>) => void;
  setCliActionSound: (cli: string, action: string, sound: string) => void;
  updateAmbientSettings: (settings: Partial<AmbientSettings>) => void;
  updateLabelAlarms: (settings: Partial<LabelAlarmSettings>) => void;
  setThemeName: (theme: ThemeName) => void;
  setTheme: (theme: 'dark' | 'light') => void;
  setFontSize: (size: number) => void;
  setScanlineEnabled: (enabled: boolean) => void;
  setAnimationIntensity: (intensity: number) => void;
  setAnimationSpeed: (speed: number) => void;
  setCharacterModel: (model: string) => void;
  setHookDensity: (density: 'high' | 'medium' | 'low' | 'off') => void;
  setCompactMode: (compact: boolean) => void;
  setShowArchived: (show: boolean) => void;
  setGroupBy: (groupBy: BrowserSettings['groupBy']) => void;
  setSortBy: (sortBy: BrowserSettings['sortBy']) => void;
  setScene3dEnabled: (enabled: boolean) => void;
  setActivityFeedVisible: (visible: boolean) => void;
  setToastEnabled: (enabled: boolean) => void;
  setAutoSendQueue: (enabled: boolean) => void;
  setDefaultTerminalTheme: (theme: string) => void;
  setSoundAction: (action: string, sound: string) => void;
  setMovementAction: (action: string, effect: string) => void;
  setApiKey: (provider: 'anthropic' | 'openai' | 'gemini', key: string) => void;
  persistSetting: (key: string, value: unknown) => Promise<void>;
  flashAutosave: () => void;
  resetDefaults: () => void;
}

// Helper to extract just data keys (no functions)
type FunctionKeys<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T];

type SettingsData = Omit<SettingsState, FunctionKeys<SettingsState>>;

const defaultSettings: SettingsData = {
  soundSettings: {
    enabled: true,
    volume: 0.5,
    muteApproval: false,
    muteInput: false,
    perCli: {
      claude: { ...CLI_SOUND_PROFILES.claude },
      gemini: { ...CLI_SOUND_PROFILES.gemini },
      codex: { ...CLI_SOUND_PROFILES.codex },
      openclaw: { ...CLI_SOUND_PROFILES.openclaw },
    },
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
  themeName: 'command-center',
  fontSize: 13,
  scanlineEnabled: true,
  animationIntensity: 100,
  animationSpeed: 100,
  characterModel: 'robot',
  soundActions: {},
  movementActions: {},
  hookDensity: 'medium',
  scene3dEnabled: true,
  activityFeedVisible: true,
  toastEnabled: true,
  autoSendQueue: false,
  defaultTerminalTheme: 'auto',
  anthropicApiKey: '',
  openaiApiKey: '',
  geminiApiKey: '',
  autosaveVisible: false,
};

// ---------------------------------------------------------------------------
// Theme side-effects
// ---------------------------------------------------------------------------

function applyTheme(themeName: ThemeName): void {
  if (themeName === 'command-center') {
    document.body.removeAttribute('data-theme');
  } else {
    document.body.setAttribute('data-theme', themeName);
  }
}

function applyFontSize(size: number): void {
  document.documentElement.style.fontSize = size + 'px';
}

function applyScanline(enabled: boolean): void {
  document.body.classList.toggle('no-scanlines', !enabled);
}

function applyAnimationIntensity(value: number): void {
  document.documentElement.style.setProperty('--anim-intensity', String(value / 100));
}

function applyAnimationSpeed(value: number): void {
  document.documentElement.style.setProperty('--anim-speed', String(value / 100));
}

// ---------------------------------------------------------------------------
// Zustand store
// ---------------------------------------------------------------------------

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...defaultSettings,

  loadFromDb: (settings) => {
    set({ ...settings });
    // Apply visual side effects
    const state = get();
    applyTheme(state.themeName);
    applyFontSize(state.fontSize);
    applyScanline(state.scanlineEnabled);
    applyAnimationIntensity(state.animationIntensity);
    applyAnimationSpeed(state.animationSpeed);
  },

  saveToDb: () => {
    const state = get();
    return { ...state };
  },

  updateSoundSettings: (updates) => {
    set((state) => ({
      soundSettings: { ...state.soundSettings, ...updates },
    }));
    get().persistSetting('soundSettings', JSON.stringify(get().soundSettings));
  },

  updateCliSoundConfig: (cli, config) => {
    set((state) => {
      const perCli = state.soundSettings.perCli;
      const current = perCli[cli as keyof typeof perCli];
      if (!current) return {};
      return {
        soundSettings: {
          ...state.soundSettings,
          perCli: {
            ...perCli,
            [cli]: { ...current, ...config },
          },
        },
      };
    });
    get().persistSetting('soundSettings', JSON.stringify(get().soundSettings));
  },

  setCliActionSound: (cli, action, sound) => {
    set((state) => {
      const perCli = state.soundSettings.perCli;
      const current = perCli[cli as keyof typeof perCli];
      if (!current) return {};
      return {
        soundSettings: {
          ...state.soundSettings,
          perCli: {
            ...perCli,
            [cli]: {
              ...current,
              actions: { ...current.actions, [action]: sound },
            },
          },
        },
      };
    });
    get().persistSetting('soundSettings', JSON.stringify(get().soundSettings));
  },

  updateAmbientSettings: (updates) => {
    set((state) => ({
      ambientSettings: { ...state.ambientSettings, ...updates },
    }));
    get().persistSetting('ambientSettings', JSON.stringify(get().ambientSettings));
  },

  updateLabelAlarms: (updates) => {
    set((state) => ({
      labelAlarms: { ...state.labelAlarms, ...updates },
    }));
    get().persistSetting('labelAlarms', JSON.stringify(get().labelAlarms));
  },

  setThemeName: (themeName) => {
    applyTheme(themeName);
    set({ themeName });
    get().persistSetting('themeName', themeName);
  },

  setTheme: (theme) => set({ theme }),

  setFontSize: (fontSize) => {
    applyFontSize(fontSize);
    set({ fontSize });
    get().persistSetting('fontSize', fontSize);
  },

  setScanlineEnabled: (scanlineEnabled) => {
    applyScanline(scanlineEnabled);
    set({ scanlineEnabled });
    get().persistSetting('scanlineEnabled', scanlineEnabled);
  },

  setAnimationIntensity: (animationIntensity) => {
    applyAnimationIntensity(animationIntensity);
    set({ animationIntensity });
    get().persistSetting('animationIntensity', animationIntensity);
  },

  setAnimationSpeed: (animationSpeed) => {
    applyAnimationSpeed(animationSpeed);
    set({ animationSpeed });
    get().persistSetting('animationSpeed', animationSpeed);
  },

  setCharacterModel: (characterModel) => {
    set({ characterModel });
    get().persistSetting('characterModel', characterModel);
  },

  setHookDensity: (hookDensity) => {
    set({ hookDensity });
    get().persistSetting('hookDensity', hookDensity);
  },

  setCompactMode: (compactMode) => set({ compactMode }),
  setShowArchived: (showArchived) => set({ showArchived }),
  setGroupBy: (groupBy) => set({ groupBy }),
  setSortBy: (sortBy) => set({ sortBy }),

  setScene3dEnabled: (scene3dEnabled) => {
    set({ scene3dEnabled });
    get().persistSetting('scene3dEnabled', scene3dEnabled);
  },

  setActivityFeedVisible: (activityFeedVisible) => {
    set({ activityFeedVisible });
    get().persistSetting('activityFeedVisible', activityFeedVisible);
  },

  setToastEnabled: (toastEnabled) => {
    set({ toastEnabled });
    get().persistSetting('toastEnabled', toastEnabled);
  },

  setAutoSendQueue: (autoSendQueue) => {
    set({ autoSendQueue });
    get().persistSetting('autoSendQueue', autoSendQueue);
  },

  setDefaultTerminalTheme: (defaultTerminalTheme) => {
    set({ defaultTerminalTheme });
    get().persistSetting('defaultTerminalTheme', defaultTerminalTheme);
  },

  setSoundAction: (action, sound) => {
    set((state) => ({
      soundActions: { ...state.soundActions, [action]: sound },
    }));
    const actions = get().soundActions;
    get().persistSetting('soundActions', JSON.stringify(actions));
  },

  setMovementAction: (action, effect) => {
    set((state) => ({
      movementActions: { ...state.movementActions, [action]: effect },
    }));
    const actions = get().movementActions;
    get().persistSetting('movementActions', JSON.stringify(actions));
  },

  setApiKey: (provider, key) => {
    const fieldMap = {
      anthropic: 'anthropicApiKey',
      openai: 'openaiApiKey',
      gemini: 'geminiApiKey',
    } as const;
    set({ [fieldMap[provider]]: key });
    get().persistSetting(fieldMap[provider], key);
  },

  // #46: Safe serializer to prevent circular reference crashes
  persistSetting: async (key, value) => {
    try {
      // Validate serialization before persisting
      if (typeof value === 'object' && value !== null) {
        try { JSON.stringify(value); } catch { return; }
      }
      await db.settings.put({ key, value, updatedAt: Date.now() });
      get().flashAutosave();
    } catch {
      // Silently fail - settings are still in memory
    }
  },

  flashAutosave: () => {
    set({ autosaveVisible: true });
    setTimeout(() => set({ autosaveVisible: false }), 2000);
  },

  resetDefaults: () => {
    set({ ...defaultSettings });
    applyTheme(defaultSettings.themeName);
    applyFontSize(defaultSettings.fontSize);
    applyScanline(defaultSettings.scanlineEnabled);
    applyAnimationIntensity(defaultSettings.animationIntensity);
    applyAnimationSpeed(defaultSettings.animationSpeed);
    // Persist all defaults
    const state = get();
    for (const [key, value] of Object.entries(defaultSettings)) {
      if (typeof value !== 'function') {
        state.persistSetting(key, typeof value === 'object' ? JSON.stringify(value) : value);
      }
    }
  },
}));
