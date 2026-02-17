/**
 * @module constants
 * Centralized magic strings for event types, session statuses, animation states,
 * and WebSocket message types. Shared by all server modules to eliminate string duplication.
 */

// Hook event types (Claude Code lifecycle events)
export const EVENT_TYPES = {
  SESSION_START: 'SessionStart',
  SESSION_END: 'SessionEnd',
  USER_PROMPT_SUBMIT: 'UserPromptSubmit',
  PRE_TOOL_USE: 'PreToolUse',
  POST_TOOL_USE: 'PostToolUse',
  POST_TOOL_USE_FAILURE: 'PostToolUseFailure',
  PERMISSION_REQUEST: 'PermissionRequest',
  STOP: 'Stop',
  SUBAGENT_START: 'SubagentStart',
  SUBAGENT_STOP: 'SubagentStop',
  TEAMMATE_IDLE: 'TeammateIdle',
  TASK_COMPLETED: 'TaskCompleted',
  PRE_COMPACT: 'PreCompact',
  NOTIFICATION: 'Notification',
  // Gemini events
  BEFORE_AGENT: 'BeforeAgent',
  BEFORE_TOOL: 'BeforeTool',
  AFTER_TOOL: 'AfterTool',
  AFTER_AGENT: 'AfterAgent',
  // Codex events
  AGENT_TURN_COMPLETE: 'agent-turn-complete',
} as const;

// All Claude hook events (used for hook density configuration)
export const ALL_CLAUDE_HOOK_EVENTS: string[] = [
  EVENT_TYPES.SESSION_START,
  EVENT_TYPES.USER_PROMPT_SUBMIT,
  EVENT_TYPES.PRE_TOOL_USE,
  EVENT_TYPES.POST_TOOL_USE,
  EVENT_TYPES.POST_TOOL_USE_FAILURE,
  EVENT_TYPES.PERMISSION_REQUEST,
  EVENT_TYPES.STOP,
  EVENT_TYPES.NOTIFICATION,
  EVENT_TYPES.SUBAGENT_START,
  EVENT_TYPES.SUBAGENT_STOP,
  EVENT_TYPES.TEAMMATE_IDLE,
  EVENT_TYPES.TASK_COMPLETED,
  EVENT_TYPES.PRE_COMPACT,
  EVENT_TYPES.SESSION_END,
];

// Known event types set (all transports — Claude, Gemini, Codex)
export const KNOWN_EVENTS: Set<string> = new Set([
  ...ALL_CLAUDE_HOOK_EVENTS,
  EVENT_TYPES.BEFORE_AGENT,
  EVENT_TYPES.BEFORE_TOOL,
  EVENT_TYPES.AFTER_TOOL,
  EVENT_TYPES.AFTER_AGENT,
  EVENT_TYPES.AGENT_TURN_COMPLETE,
]);

// Hook density presets — which events to register at each density level
export const DENSITY_EVENTS: Record<string, string[]> = {
  high: ALL_CLAUDE_HOOK_EVENTS,
  medium: [
    EVENT_TYPES.SESSION_START,
    EVENT_TYPES.USER_PROMPT_SUBMIT,
    EVENT_TYPES.PRE_TOOL_USE,
    EVENT_TYPES.POST_TOOL_USE,
    EVENT_TYPES.POST_TOOL_USE_FAILURE,
    EVENT_TYPES.PERMISSION_REQUEST,
    EVENT_TYPES.STOP,
    EVENT_TYPES.NOTIFICATION,
    EVENT_TYPES.SUBAGENT_START,
    EVENT_TYPES.SUBAGENT_STOP,
    EVENT_TYPES.TASK_COMPLETED,
    EVENT_TYPES.SESSION_END,
  ],
  low: [
    EVENT_TYPES.SESSION_START,
    EVENT_TYPES.USER_PROMPT_SUBMIT,
    EVENT_TYPES.PERMISSION_REQUEST,
    EVENT_TYPES.STOP,
    EVENT_TYPES.SESSION_END,
  ],
};

// Session statuses
export const SESSION_STATUS = {
  IDLE: 'idle',
  PROMPTING: 'prompting',
  WORKING: 'working',
  APPROVAL: 'approval',
  INPUT: 'input',
  WAITING: 'waiting',
  ENDED: 'ended',
  CONNECTING: 'connecting',
} as const;

// Animation states
export const ANIMATION_STATE = {
  IDLE: 'Idle',
  WALKING: 'Walking',
  RUNNING: 'Running',
  WAITING: 'Waiting',
  DEATH: 'Death',
  DANCE: 'Dance',
} as const;

// Emote names
export const EMOTE = {
  WAVE: 'Wave',
  THUMBS_UP: 'ThumbsUp',
  JUMP: 'Jump',
  YES: 'Yes',
} as const;

// WebSocket message types
export const WS_TYPES = {
  SESSION_UPDATE: 'session_update',
  SESSION_REMOVED: 'session_removed',
  TEAM_UPDATE: 'team_update',
  HOOK_STATS: 'hook_stats',
  SNAPSHOT: 'snapshot',
  TERMINAL_OUTPUT: 'terminal_output',
  TERMINAL_READY: 'terminal_ready',
  TERMINAL_CLOSED: 'terminal_closed',
  TERMINAL_INPUT: 'terminal_input',
  TERMINAL_RESIZE: 'terminal_resize',
  TERMINAL_DISCONNECT: 'terminal_disconnect',
  TERMINAL_SUBSCRIBE: 'terminal_subscribe',
  UPDATE_QUEUE_COUNT: 'update_queue_count',
  REPLAY: 'replay',
  CLEAR_BROWSER_DB: 'clearBrowserDb',
} as const;

// Session sources
export const SESSION_SOURCE = {
  SSH: 'ssh',
  VSCODE: 'vscode',
  JETBRAINS: 'jetbrains',
  ITERM: 'iterm',
  WARP: 'warp',
  KITTY: 'kitty',
  GHOSTTY: 'ghostty',
  ALACRITTY: 'alacritty',
  WEZTERM: 'wezterm',
  HYPER: 'hyper',
  TERMINAL: 'terminal',
  TMUX: 'tmux',
  UNKNOWN: 'unknown',
} as const;
