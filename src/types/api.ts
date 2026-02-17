/**
 * API request/response types for AI Agent Session Center.
 * Covers all REST endpoints in apiRouter.
 */

import type { Session, SessionSource } from './session.js';
import type { TeamSerialized, TeamConfig } from './team.js';
import type { HookStats } from './websocket.js';
import type { TerminalInfo, TmuxSessionInfo, SshKeyInfo } from './terminal.js';

// ---------------------------------------------------------------------------
// Generic
// ---------------------------------------------------------------------------

export interface ApiResponse<T = unknown> {
  success?: boolean;
  ok?: boolean;
  error?: string;
  data?: T;
}

// ---------------------------------------------------------------------------
// Hook Stats (GET /api/hook-stats)
// ---------------------------------------------------------------------------

export type HookStatsResponse = HookStats;

// ---------------------------------------------------------------------------
// Hook Density (GET/POST /api/hooks/status, /api/hooks/install)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// MQ Stats (GET /api/mq-stats)
// ---------------------------------------------------------------------------

export interface MqStatsResponse {
  enabled: boolean;
  messagesProcessed?: number;
  errors?: number;
  lastOffset?: number;
  fileSize?: number;
}

// ---------------------------------------------------------------------------
// Reset (POST /api/reset)
// ---------------------------------------------------------------------------

export interface ResetResponse {
  ok: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Session Control
// ---------------------------------------------------------------------------

// POST /api/sessions/:id/kill
export interface KillSessionRequest {
  confirm: boolean;
}

export interface KillSessionResponse {
  ok: boolean;
  pid: number | null;
  source: SessionSource | string;
}

// PUT /api/sessions/:id/title
export interface UpdateTitleRequest {
  title: string;
}

// PUT /api/sessions/:id/label
export interface UpdateLabelRequest {
  label: string;
}

// PUT /api/sessions/:id/accent-color
export interface UpdateAccentColorRequest {
  color: string;
}

// POST /api/sessions/:id/summarize
export interface SummarizeRequest {
  context: string;
  promptTemplate?: string;
  custom_prompt?: string;
}

export interface SummarizeResponse {
  ok: boolean;
  summary: string;
}

// POST /api/sessions/:id/resume
export interface ResumeSessionResponse {
  ok: boolean;
  terminalId: string;
  newTerminal?: boolean;
}

// DELETE /api/sessions/:id
export interface DeleteSessionResponse {
  ok: boolean;
  removed: boolean;
}

// GET /api/sessions/:id/source
export interface SessionSourceResponse {
  source: SessionSource | string;
}

// ---------------------------------------------------------------------------
// SSH / Terminals
// ---------------------------------------------------------------------------

/** SSH connection base config (shared between terminal and tmux requests) */
export interface SshConnectionConfig {
  host?: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  authMethod?: 'key' | 'password';
  passphrase?: string;
}

// POST /api/terminals
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

// GET /api/terminals
export interface ListTerminalsResponse {
  terminals: TerminalInfo[];
}

// GET /api/ssh-keys
export interface ListSshKeysResponse {
  keys: SshKeyInfo[];
}

// POST /api/tmux-sessions
export type TmuxSessionsRequest = SshConnectionConfig;

export interface TmuxSessionsResponse {
  sessions: TmuxSessionInfo[];
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

// GET /api/teams/:teamId/config
export interface TeamConfigResponse {
  teamName: string;
  config: TeamConfig | null;
}

// POST /api/teams/:teamId/members/:sessionId/terminal
export interface TeamMemberTerminalResponse {
  ok: boolean;
  terminalId: string;
  tmuxPaneId: string;
}

// ---------------------------------------------------------------------------
// DB / History
// ---------------------------------------------------------------------------

/** DB session row (from SQLite, different from in-memory Session) */
export interface DbSessionRow {
  id: string;
  project_path: string;
  project_name: string;
  title: string;
  model: string;
  status: string;
  source: string;
  label: string | null;
  summary: string | null;
  team_id: string | null;
  team_role: string | null;
  character_model: string | null;
  accent_color: string | null;
  started_at: number | null;
  ended_at: number | null;
  last_activity_at: number | null;
  total_prompts: number;
  total_tool_calls: number;
  archived: number;
}

export interface DbPromptRow {
  id: number;
  session_id: string;
  text: string;
  timestamp: number;
}

export interface DbResponseRow {
  id: number;
  session_id: string;
  text_excerpt: string;
  timestamp: number;
}

export interface DbToolCallRow {
  id: number;
  session_id: string;
  tool_name: string;
  tool_input_summary: string;
  timestamp: number;
}

export interface DbEventRow {
  id: number;
  session_id: string;
  event_type: string;
  detail: string;
  timestamp: number;
}

export interface DbNoteRow {
  id: number;
  session_id: string;
  text: string;
  created_at: number;
  updated_at: number;
}

/** GET /api/db/sessions/:id — full session detail */
export interface SessionDetailResponse {
  session: DbSessionRow;
  prompts: DbPromptRow[];
  responses: DbResponseRow[];
  tool_calls: DbToolCallRow[];
  events: DbEventRow[];
  notes: DbNoteRow[];
}

/** GET /api/db/sessions — paginated session list */
export interface SessionSearchResponse {
  sessions: DbSessionRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /api/db/sessions query parameters */
export interface SessionSearchParams {
  query?: string;
  project?: string;
  status?: string;
  dateFrom?: number;
  dateTo?: number;
  archived?: boolean | string | number;
  sortBy?: 'started_at' | 'last_activity_at' | 'project_name' | 'status';
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

/** GET /api/db/search — full-text search */
export interface FullTextSearchResult {
  session_id: string;
  project_name: string;
  type: 'prompt' | 'response';
  text: string;
  timestamp: number;
}

export interface FullTextSearchResponse {
  results: FullTextSearchResult[];
  total: number;
  page: number;
  pageSize: number;
}

/** POST /api/db/sessions/:id/notes */
export interface AddNoteRequest {
  text: string;
}
