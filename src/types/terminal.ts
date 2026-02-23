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
  outputBuffer: Buffer;
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
