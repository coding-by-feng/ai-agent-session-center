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
  | 'PostCompact'
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
  summary?: string;
  /**
   * Short user-authored note on what this session is currently doing, shown
   * inline under the title in the detail rail so it is readable without opening
   * a tab. Distinct from the NOTES tab (long-form, multi-entry) and from
   * `summary` (AI-generated). User-owned: nothing but an explicit edit changes it.
   */
  remark?: string;
  accentColor?: string;
  characterModel?: string;

  // Source / origin
  source: SessionSource | string;
  /** AI CLI family (Claude, Codex, Gemini). Distinct from terminal/source. */
  cliSource?: string;
  model: string;
  /** Effort level (low/medium/high/xhigh/max/ultracode) — set at creation from config so popups can inherit it. */
  effortLevel?: string;
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
  opsTerminalId?: string | null;
  hadOpsTerminal?: boolean;
  lastTerminalId?: string | null;
  cachedPid: number | null;
  sshHost?: string;
  sshCommand?: string;
  sshConfig?: SshConfig;
  startupCommand?: string;

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
  /** When true, play loud alert sounds for approval, input, and task completion */
  alerted?: boolean;
  /**
   * Process-isolation marker for any session spawned from another session
   * (main-session clone/fork actions AND floating popups). Read by the kill
   * flow to skip the cwd-based PID lookup (which would otherwise collide with
   * the origin's claude process since they share projectPath) and by hook
   * fork-routing in sessionMatcher. Does NOT control visibility.
   */
  isFork?: boolean;
  /**
   * Marks a floating Explain/Translate PiP popup. Hidden from the agents
   * sidebar, header strip, and 3D scene; rendered as a floating panel over its
   * origin session instead. Distinct from isFork: clone/fork sessions set
   * isFork only and stay visible in the session lists.
   */
  isFloating?: boolean;
  /** Origin session id this fork was spawned from (for traceability). */
  originSessionId?: string;
  /**
   * Marks a session the dashboard did NOT launch: a real Claude/Gemini/Codex CLI
   * running in an external terminal (or started before hooks were installed), so
   * it never bound to a dashboard PTY. Two sources set this:
   *   - a hook event that matched no terminal (sessionMatcher "external" fallback,
   *     full data: real sessionId + transcript), or
   *   - the process-scan discovery pass (thin card: pid + cwd + name only).
   * Rendered with a distinct "external" badge; carries no dashboard terminal, so
   * terminal actions (open/reconnect/kill-via-PTY) don't apply.
   */
  isExternal?: boolean;
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
