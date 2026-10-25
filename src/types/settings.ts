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
  /**
   * The off switch for central sessions (server/mcp). `{ "enabled": false }` unmounts `/mcp` and
   * stops launches from carrying MCP flags or a token. Absent, or `enabled` absent, means on.
   * `router`, `autoRouting` and `idleWorkerMinutes` tune P4's automatic routing (server/mcp/routerConfig.ts);
   * all are read once at start, so a change needs a restart.
   */
  mcp?: {
    enabled?: boolean;
    router?: McpRouterConfig;
    /** `task_delegate(to: "auto")` and `task_route`. Off unless `true` (P4-10: the replay check scored 41.9 %). */
    autoRouting?: boolean;
    /** Minutes an idle worker a central opened is left before AASC closes it; 0 turns clean-up off (default 30). */
    idleWorkerMinutes?: number;
    /**
     * P5's typed notices (server/mcp/notices.ts): one `[AASC · notice]` line typed into an idle central about its
     * ended tasks and late-answered confirmations. Off unless `true` (Ruling P5-19): each notice starts a model turn.
     */
    notices?: boolean;
  };
}

/**
 * How the router scores a session it might reuse (every field optional; each number is clamped to its range, a
 * value that is not a number is ignored). Defaults: same folder 3, task words 2, idle or waiting 2, context
 * headroom 1, active within the hour 1; reuse at 4 or more; context ceiling 80 %; 5 runners-up.
 */
export interface McpRouterConfig {
  /** 0-10: the session sits in the project's own folder. */
  weightSameFolder?: number;
  /** 0-10: the task's words appear in the session's title, summary, remark, recent prompts or edited files. */
  weightTaskWords?: number;
  /** 0-10: the session is idle or waiting. */
  weightIdleOrWaiting?: number;
  /** 0-10: the session's context window is at most half full. */
  weightHeadroom?: number;
  /** 0-10: the session was active within the last hour. */
  weightRecentActivity?: number;
  /** 1-20: the lowest score at which a session is reused instead of opening a new one. */
  reuseThreshold?: number;
  /** 50-95: a session whose context window is this full (%) or more is never reused. */
  contextCeilingPct?: number;
  /** 1-10: how many other candidates `task_route` lists. */
  runnersUp?: number;
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
