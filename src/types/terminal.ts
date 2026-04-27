/**
 * Terminal / SSH types for AI Agent Session Center.
 */

import type { SshConfig } from './session.js';

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
  /** Pre-allocated output ring buffer (128 KB). Use ring* helpers — never mutate directly. */
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
  /** Effort level to auto-apply after Claude Code starts (min/low/medium/high/max) */
  effortLevel?: string;
  /** Model to auto-apply after Claude Code starts (opus/sonnet/haiku) */
  model?: string;
  /** Session metadata — set during workspace import so the first WS broadcast includes them */
  pinned?: boolean;
  muted?: boolean;
  alerted?: boolean;
  accentColor?: string;
  characterModel?: string;
  /**
   * When true, `command` is intentionally empty because the caller will write the
   * real launch command (e.g. `claude --resume 'X' || claude --continue`) later
   * via `writeWhenReady`.  Distinguishes workspace-resume terminals from ops
   * terminals (also command='' but truly never run Claude).  Resume terminals
   * still need a pendingLink registered so session matching can bind the Claude
   * SessionStart hook to the correct terminal card.
   */
  deferredLaunch?: boolean;
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
