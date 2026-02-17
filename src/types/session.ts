/**
 * Session types for AI Agent Session Center.
 * Canonical source of truth — shared by server (NodeNext) and client (Vite).
 */

// ---------------------------------------------------------------------------
// Enums / Literal Unions
// ---------------------------------------------------------------------------

/** Session lifecycle status (maps to SESSION_STATUS constants) */
export type SessionStatus =
  | 'connecting'
  | 'idle'
  | 'prompting'
  | 'working'
  | 'approval'
  | 'input'
  | 'waiting'
  | 'ended';

/** 3D animation state names (matching RobotExpressive clips) */
export type AnimationState =
  | 'Idle'
  | 'Walking'
  | 'Running'
  | 'Waiting'
  | 'Death'
  | 'Dance';

/** Emote names (one-shot animations) */
export type Emote = 'Wave' | 'ThumbsUp' | 'Jump' | 'Yes' | null;

/** Hook event type names (Claude Code, Gemini, Codex lifecycle events) */
export type EventType =
  // Claude
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TeammateIdle'
  | 'TaskCompleted'
  | 'PreCompact'
  | 'Notification'
  // Gemini
  | 'BeforeAgent'
  | 'BeforeTool'
  | 'AfterTool'
  | 'AfterAgent'
  // Codex
  | 'agent-turn-complete';

/** Session source — where Claude was launched from */
export type SessionSource =
  | 'ssh'
  | 'vscode'
  | 'jetbrains'
  | 'iterm'
  | 'warp'
  | 'kitty'
  | 'ghostty'
  | 'alacritty'
  | 'wezterm'
  | 'hyper'
  | 'terminal'
  | 'tmux'
  | 'unknown';

// ---------------------------------------------------------------------------
// Sub-Records
// ---------------------------------------------------------------------------

/** A single prompt history entry */
export interface PromptEntry {
  text: string;
  timestamp: number;
}

/** A single tool log entry */
export interface ToolLogEntry {
  tool: string;
  input: string;
  timestamp: number;
  failed?: boolean;
  error?: string;
}

/** A single response log entry */
export interface ResponseEntry {
  text: string;
  timestamp: number;
}

/** A session event log entry */
export interface SessionEvent {
  type: string;
  timestamp: number;
  detail: string;
}

/** SSH connection configuration stored on a session */
export interface SshConfig {
  host: string;
  port: number;
  username?: string;
  authMethod?: 'key' | 'password';
  privateKeyPath?: string;
  workingDir?: string;
  command?: string;
}

/** Archived previous session data (used for SSH resume chains) */
export interface ArchivedSession {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  promptHistory: PromptEntry[];
  toolLog: ToolLogEntry[];
  responseLog: ResponseEntry[];
  events: SessionEvent[];
  toolUsage: Record<string, number>;
  totalToolCalls: number;
}

// ---------------------------------------------------------------------------
// Core Session
// ---------------------------------------------------------------------------

/** Core session object stored in the sessions Map */
export interface Session {
  sessionId: string;
  status: SessionStatus;
  animationState: AnimationState;
  emote: Emote;

  // Project
  projectName: string;
  projectPath: string;
  title: string;
  label?: string;
  summary?: string;
  accentColor?: string;
  characterModel?: string;

  // Source / origin
  source: SessionSource | string;
  model: string;
  transcriptPath?: string;
  permissionMode?: string | null;

  // Timing
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;

  // Prompt & tool tracking
  currentPrompt: string;
  promptHistory: PromptEntry[];
  toolUsage: Record<string, number>;
  totalToolCalls: number;
  toolLog: ToolLogEntry[];
  responseLog: ResponseEntry[];
  events: SessionEvent[];

  // Approval detection
  pendingTool: string | null;
  pendingToolDetail?: string | null;
  waitingDetail: string | null;

  // Subagents
  subagentCount: number;
  lastSubagentName?: string;

  // Team
  teamId?: string | null;
  teamRole?: 'leader' | 'member';
  parentSessionId?: string | null;
  isSubagent?: boolean;
  agentName?: string;
  agentType?: string;
  teamName?: string;
  agentColor?: string;
  tmuxPaneId?: string;
  backendType?: string;

  // Terminal / SSH linkage
  terminalId: string | null;
  lastTerminalId?: string | null;
  cachedPid: number | null;
  sshHost?: string;
  sshCommand?: string;
  sshConfig?: SshConfig;

  // Resume / re-key
  replacesId?: string;
  previousSessions?: ArchivedSession[];
  isHistorical?: boolean;

  // Misc
  archived: number;
  queueCount: number;
  colorIndex?: number;
  muted?: boolean;
  pinned?: boolean;
}

// ---------------------------------------------------------------------------
// Ring Buffer & Event Results
// ---------------------------------------------------------------------------

/** Event ring buffer entry for WebSocket reconnect replay */
export interface BufferedEvent {
  seq: number;
  type: string;
  data: unknown;
  timestamp: number;
}

/** Result returned from handleEvent() */
export interface HandleEventResult {
  session: Session;
  team?: import('./team.js').TeamSerialized;
}

// ---------------------------------------------------------------------------
// Pending Resume / Link helpers
// ---------------------------------------------------------------------------

/** Entry in the pendingResume Map (terminalId -> info) */
export interface PendingResume {
  oldSessionId: string;
  timestamp: number;
}

/** Entry in the sshManager pendingLinks Map (workDir -> info) */
export interface PendingLink {
  terminalId: string;
  host: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Snapshot (persistence across server restarts)
// ---------------------------------------------------------------------------

/** Structure of /tmp/claude-session-center/sessions-snapshot.json */
export interface SessionSnapshot {
  version: number;
  savedAt: number;
  eventSeq: number;
  mqOffset: number;
  sessions: Record<string, Session>;
  projectSessionCounters: Record<string, number>;
  pidToSession: Record<string, string>;
  pendingResume: Record<string, PendingResume>;
}
