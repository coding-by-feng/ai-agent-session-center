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
  /**
   * Optional remote-only listener (127.0.0.1) where every request counts as a
   * remote device. Point tunnels and relays here, never at `port`. Absent or
   * null = off. `AASC_REMOTE_LISTENER_PORT` overrides it.
   */
  remoteListenerPort?: number | null;
  /**
   * Offer "Pair a phone" on the desktop (AASC-30). Off until the phone app can
   * be installed and aasc.work/pair is live. `AASC_PHONE_PAIRING=1` / `0`
   * overrides it. Phones paired before are listed and revocable either way.
   */
  phonePairing?: boolean;
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
    codex: CliSoundConfig;
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
  /** Terminal scrollback replay buffer size, in bytes. How much history is
   *  restored when a terminal reconnects / the app reloads / a session resumes.
   *  Default 2 MB; clamped to [0.25 MB, 32 MB] on the backend. */
  terminalReplayBufferBytes: number;
  /** How many lines a live xterm instance keeps in its own scrollback. Distinct
   *  from the replay buffer: this is renderer memory, roughly cols × 12 bytes
   *  per retained line. Default 20 000; clamped to [1 000, 200 000]. */
  terminalScrollbackLines: number;
  /** Desktop app only: stop the Mac idling into sleep while an agent is working,
   *  prompting or waiting on an approval or answer, so a phone can still reach
   *  it (AASC-16). Off by default; never keeps the display on. */
  keepAwakeWhileWorking: boolean;
}
