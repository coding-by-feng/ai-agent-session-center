/**
 * Session types for AI Agent Session Center
 */

/** Session status values */
export type SessionStatus =
  | 'idle'
  | 'prompting'
  | 'working'
  | 'approval'
  | 'input'
  | 'waiting'
  | 'ended'
  | 'connecting';

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

/** Hook event type names (Claude Code lifecycle events) */
export type EventType =
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
  // Gemini events
  | 'BeforeAgent'
  | 'BeforeTool'
  | 'AfterTool'
  | 'AfterAgent'
  // Codex events
  | 'agent-turn-complete';

/** Session source (where Claude was launched from) */
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
export interface ResponseLogEntry {
  text: string;
  timestamp: number;
}

/** A session event log entry */
export interface SessionEvent {
  type: string;
  timestamp: number;
  detail: string;
}

/** Archived previous session data (used for SSH resume chains) */
export interface PreviousSessionData {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  promptHistory: PromptEntry[];
  toolLog: ToolLogEntry[];
  responseLog: ResponseLogEntry[];
  events: SessionEvent[];
  toolUsage: Record<string, number>;
  totalToolCalls: number;
}

/** Core session object stored in the sessions Map */
export interface Session {
  sessionId: string;
  projectPath: string;
  projectName: string;
  title: string;
  label?: string;
  status: SessionStatus;
  animationState: AnimationState;
  emote: Emote;
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number | null;
  currentPrompt: string;
  promptHistory: PromptEntry[];
  toolUsage: Record<string, number>;
  totalToolCalls: number;
  model: string;
  subagentCount: number;
  toolLog: ToolLogEntry[];
  responseLog: ResponseLogEntry[];
  events: SessionEvent[];
  archived: number;
  source: SessionSource | string;
  pendingTool: string | null;
  pendingToolDetail?: string | null;
  waitingDetail: string | null;
  cachedPid: number | null;
  queueCount: number;
  terminalId?: string | null;
  lastTerminalId?: string | null;
  sshHost?: string;
  sshCommand?: string;
  accentColor?: string;
  characterModel?: string;
  summary?: string;
  transcriptPath?: string;
  permissionMode?: string | null;
  isHistorical?: boolean;
  previousSessions?: PreviousSessionData[];
  /** Set when a session is re-keyed (resumed or matched); old session ID */
  replacesId?: string;
}

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
  team?: import('./websocket').TeamInfo;
}
