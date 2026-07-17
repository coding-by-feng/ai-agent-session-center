/**
 * Terminal / SSH types for AI Agent Session Center.
 */

// ---------------------------------------------------------------------------
// Terminal scrollback replay buffer (configurable)
//
// Each terminal pre-allocates a ring buffer that holds the most recent output.
// This is what gets replayed when a terminal reconnects, the app reloads, or a
// session resumes — i.e. how far back you can scroll after a rebuild. It is a
// user setting (Settings ▸ ADVANCED ▸ Terminal); these constants are the
// default and the safety clamp applied on every backend.
//
// NOTE: electron/ptyHost.ts keeps its own copy of these constants (it does not
// import this module at runtime) — keep the two in sync.
// ---------------------------------------------------------------------------

/** Default replay buffer size: 2 MB (~16× the old 128 KB). */
export const DEFAULT_TERMINAL_REPLAY_BUFFER_BYTES = 2 * 1024 * 1024;
/** Lower clamp: 0.25 MB — below this, even a couple of screens won't fit. */
export const MIN_TERMINAL_REPLAY_BUFFER_BYTES = 256 * 1024;
/** Upper clamp: 32 MB per terminal — guards against a poisoned/typo setting. */
export const MAX_TERMINAL_REPLAY_BUFFER_BYTES = 32 * 1024 * 1024;

/** Clamp an arbitrary number to the valid replay-buffer range; non-finite → default. */
export function clampReplayBufferBytes(bytes: number): number {
  if (!Number.isFinite(bytes)) return DEFAULT_TERMINAL_REPLAY_BUFFER_BYTES;
  return Math.min(
    MAX_TERMINAL_REPLAY_BUFFER_BYTES,
    Math.max(MIN_TERMINAL_REPLAY_BUFFER_BYTES, Math.round(bytes)),
  );
}

// ---------------------------------------------------------------------------
// Internal Terminal (server-side, stored in sshManager terminals Map)
// ---------------------------------------------------------------------------

/** Internal terminal object held by sshManager */
export interface Terminal {
  pty: import('node-pty').IPty;
  sessionId: string | null;
  config: TerminalConfig;
  wsClient: import('ws').WebSocket | null;
  createdAt: number;
  /** Pre-allocated output ring buffer (size = configurable replay buffer, default 2 MB). Use ring* helpers — never mutate directly. */
  outputRing: Buffer;
  /** Next write offset within outputRing. */
  outputOffset: number;
  /** True once outputRing has wrapped at least once (full buffer has data). */
  outputWrapped: boolean;
  shellReady?: Promise<boolean>;
  // #19: Store disposables for proper cleanup
  disposables?: import('node-pty').IDisposable[];
}

/** Resolved terminal config (after validation & defaults) */
export interface TerminalConfig {
  host: string;
  port?: number;
  username?: string;
  authMethod?: 'key' | 'password';
  privateKeyPath?: string;
  workingDir: string;
  command: string;
  password?: string;
  apiKey?: string;
  tmuxSession?: string;
  useTmux?: boolean;
  sessionTitle?: string;
  label?: string;
  /** Original startup command captured from hooks (preserves full CLI + params) */
  startupCommand?: string;
  /** Permission mode from snapshot — used to reconstruct CLI flags on resume */
  permissionMode?: string;
  /** Effort level to auto-apply after Claude Code starts (low/medium/high/xhigh/max/ultracode) */
  effortLevel?: string;
  /** Model to auto-apply after Claude Code starts (opus/sonnet/haiku) */
  model?: string;
  /** Run `/remote-control <name>` automatically after Claude Code starts. */
  remoteControlName?: string;
  /** Session metadata — set during workspace import so the first WS broadcast includes them */
  pinned?: boolean;
  muted?: boolean;
  alerted?: boolean;
  accentColor?: string;
  characterModel?: string;
  /** User's progress remark, carried through a workspace restore. */
  remark?: string;
  /**
   * When true, `command` is intentionally empty because the caller will write the
   * real launch command (e.g. `claude --resume 'X' || claude --continue`) later
   * via `writeWhenReady`.  Distinguishes workspace-resume terminals from ops
   * terminals (also command='' but truly never run Claude).  Resume terminals
   * still need a pendingLink registered so session matching can bind the Claude
   * SessionStart hook to the correct terminal card.
   */
  deferredLaunch?: boolean;
  /**
   * Process-isolation marker for any session spawned from another session
   * (clone/fork actions and floating popups). Forks share the origin's
   * projectPath, which would otherwise cause the kill-by-PID lookup to match
   * the origin's claude process and accidentally SIGTERM it. When true, the
   * kill flow skips the PID lookup entirely and relies on the per-PTY kill
   * (which only affects this fork's process group).
   */
  isFork?: boolean;
  /**
   * Marks a floating Explain/Translate PiP popup (set by floatingSessionSpawner
   * and workspace restore). Controls visibility only: floating sessions are
   * hidden from the session lists and rendered as PiP panels.
   */
  isFloating?: boolean;
  /** Origin session id this fork was spawned from (for traceability). */
  originSessionId?: string;
}

// ---------------------------------------------------------------------------
// API-facing Terminal Info
// ---------------------------------------------------------------------------

/** Terminal info returned from GET /api/terminals */
export interface TerminalInfo {
  terminalId: string;
  sessionId: string | null;
  host: string;
  workingDir: string;
  command: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Tmux
// ---------------------------------------------------------------------------

/** Tmux session info returned from listTmuxSessions() */
export interface TmuxSessionInfo {
  name: string;
  attached: boolean;
  created: number;
  windows: number;
}

// ---------------------------------------------------------------------------
// SSH Key
// ---------------------------------------------------------------------------

/** SSH key info returned from listSshKeys() */
export interface SshKeyInfo {
  name: string;
  path: string;
}
