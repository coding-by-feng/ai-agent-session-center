/**
 * Settings types for AI Agent Session Center.
 * Covers both server-side config and browser-side settings.
 */

import type { SessionStatus } from './session.js';

// ---------------------------------------------------------------------------
// Server Configuration (data/server-config.json)
// ---------------------------------------------------------------------------

/** Server configuration (data/server-config.json merged with defaults) */
export interface ServerConfig {
  port: number;
  hookDensity: 'high' | 'medium' | 'low';
  debug: boolean;
  processCheckInterval: number;
  sessionHistoryHours: number;
  enabledClis: string[];
  passwordHash: string | null;
}

// ---------------------------------------------------------------------------
// Tool Category Configuration
// ---------------------------------------------------------------------------

/** Tool category names for approval detection */
export type ToolCategory = 'fast' | 'userInput' | 'medium' | 'slow';

/** Tool timeout configuration (ms per category) */
export type ToolTimeoutConfig = Record<ToolCategory, number>;

/** Waiting reason per tool category */
export type WaitingReasonConfig = Record<ToolCategory, SessionStatus>;

// ---------------------------------------------------------------------------
// Auto-Idle Configuration
// ---------------------------------------------------------------------------

/** Auto-idle timeout configuration (ms per status) */
export interface AutoIdleConfig {
  prompting: number;
  waiting: number;
  working: number;
  approval: number;
  input: number;
}

// ---------------------------------------------------------------------------
// Animation Mapping
// ---------------------------------------------------------------------------

/** Animation state mapping for a status */
export interface StatusAnimation {
  animationState: string;
  emote: string | null;
}

/** Full status-to-animation mapping */
export type StatusAnimationConfig = Record<string, StatusAnimation>;

// ---------------------------------------------------------------------------
// Browser-Side Settings (persisted in IndexedDB / localStorage)
// ---------------------------------------------------------------------------

/** Per-CLI sound configuration */
export interface CliSoundConfig {
  enabled: boolean;
  volume: number;
  actions: Partial<Record<string, string>>;
}

/** Sound settings (Web Audio synthesis) */
export interface SoundSettings {
  enabled: boolean;
  volume: number;
  muteApproval: boolean;
  muteInput: boolean;
  perCli: {
    claude: CliSoundConfig;
    gemini: CliSoundConfig;
    codex: CliSoundConfig;
    openclaw: CliSoundConfig;
  };
}

/** Ambient / white noise preset names */
export type AmbientPreset = 'off' | 'rain' | 'lofi' | 'serverRoom' | 'deepSpace' | 'coffeeShop';

/** Ambient & white noise settings */
export interface AmbientSettings {
  enabled: boolean;
  volume: number;
  preset: AmbientPreset;
  roomSounds: boolean;
  roomVolume: number;
}

/** Label alarm settings */
export interface LabelAlarmSettings {
  labels: string[];
  soundEnabled: boolean;
}

/** Browser-side settings (persisted in localStorage/IndexedDB) */
export interface BrowserSettings {
  soundSettings: SoundSettings;
  ambientSettings: AmbientSettings;
  labelAlarms: LabelAlarmSettings;
  theme: 'dark' | 'light';
  compactMode: boolean;
  showArchived: boolean;
  groupBy: 'none' | 'project' | 'status' | 'source';
  sortBy: 'activity' | 'name' | 'status' | 'created';
}
