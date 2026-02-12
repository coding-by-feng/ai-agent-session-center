/**
 * API request/response types for AI Agent Session Center
 */

import type { Session, SessionSource } from './session';
import type { HookStats } from './websocket';

// ---- Generic API response wrapper ----

export interface ApiResponse<T = unknown> {
  success?: boolean;
  ok?: boolean;
  error?: string;
  data?: T;
}

// ---- Hook Stats ----

export type HookStatsResponse = HookStats;

// ---- Hook Density ----

export type HookDensity = 'high' | 'medium' | 'low';

export interface HooksStatusResponse {
  installed: boolean;
  density: HookDensity | 'off' | 'custom';
  events: string[];
}

export interface HooksInstallRequest {
  density: HookDensity;
}

export interface HooksInstallResponse {
  ok: boolean;
  density: HookDensity;
  events: string[];
  output: string;
}

// ---- Session Control ----

export interface KillSessionRequest {
  confirm: boolean;
}

export interface KillSessionResponse {
  ok: boolean;
  pid: number | null;
  source: SessionSource | string;
}

export interface UpdateTitleRequest {
  title: string;
}

export interface UpdateLabelRequest {
  label: string;
}

export interface SummarizeRequest {
  context: string;
  promptTemplate?: string;
  custom_prompt?: string;
}

export interface SummarizeResponse {
  ok: boolean;
  summary: string;
}

export interface ResumeSessionResponse {
  ok: boolean;
  terminalId: string;
}

export interface DeleteSessionResponse {
  ok: boolean;
  removed: boolean;
}

export interface SessionSourceResponse {
  source: SessionSource | string;
}

// ---- SSH / Terminals ----

export interface SshConnectionConfig {
  host?: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  authMethod?: 'key' | 'password';
  passphrase?: string;
}

export interface CreateTerminalRequest extends SshConnectionConfig {
  workingDir?: string;
  command?: string;
  apiKey?: string;
  tmuxSession?: string;
  useTmux?: boolean;
  sessionTitle?: string;
  label?: string;
}

export interface CreateTerminalResponse {
  ok: boolean;
  terminalId: string;
}

export interface TerminalInfo {
  id: string;
  host: string;
  connected: boolean;
}

export interface ListTerminalsResponse {
  terminals: TerminalInfo[];
}

export interface ListSshKeysResponse {
  keys: string[];
}

export interface TmuxSessionsRequest extends SshConnectionConfig {
  // inherits all SSH config fields
}

export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
}

export interface TmuxSessionsResponse {
  sessions: TmuxSession[];
}

// ---- MQ Stats ----

export interface MqStatsResponse {
  enabled: boolean;
  messagesProcessed?: number;
  errors?: number;
}

// ---- Reset ----

export interface ResetResponse {
  ok: boolean;
  message: string;
}
