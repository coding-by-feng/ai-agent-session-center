/**
 * @module constants
 * Frontend constants: session statuses, hook event names, tool-to-sound mappings,
 * label definitions, and localStorage keys. Mirrors server/constants.js where applicable.
 */

export const SESSION_STATUS = {
  IDLE: 'idle',
  PROMPTING: 'prompting',
  WORKING: 'working',
  APPROVAL: 'approval',
  INPUT: 'input',
  WAITING: 'waiting',
  ENDED: 'ended',
};

export const WS_TYPES = {
  SNAPSHOT: 'snapshot',
  SESSION_UPDATE: 'session_update',
  SESSION_REMOVED: 'session_removed',
  TEAM_UPDATE: 'team_update',
  HOOK_STATS: 'hook_stats',
  DURATION_ALERT: 'duration_alert',
  CLEAR_BROWSER_DB: 'clear_browser_db',
  TERMINAL_OUTPUT: 'terminal_output',
  TERMINAL_READY: 'terminal_ready',
  TERMINAL_CLOSED: 'terminal_closed',
  UPDATE_QUEUE_COUNT: 'update_queue_count',
  TERMINAL_INPUT: 'terminal_input',
};

export const LABELS = {
  ONEOFF: 'ONEOFF',
  HEAVY: 'HEAVY',
  IMPORTANT: 'IMPORTANT',
};

export const STORAGE_KEYS = {
  MUTED_SESSIONS: 'muted-sessions',
  PINNED_SESSIONS: 'pinned-sessions',
  SESSION_GROUPS: 'session-groups',
  SESSION_LABELS: 'sessionLabels',
  LAST_SESSION: 'lastSession',
  DETAIL_PANEL_WIDTH: 'detail-panel-width',
  DASHBOARD_LAYOUT: 'dashboard-layout',
  GROUPS_SEEDED: 'groups-seeded',
  WORKDIR_HISTORY: 'workdir-history',
  DEBUG: 'debug',
};

export const HOOK_EVENTS = {
  SESSION_START: 'SessionStart',
  USER_PROMPT_SUBMIT: 'UserPromptSubmit',
  PRE_TOOL_USE: 'PreToolUse',
  POST_TOOL_USE: 'PostToolUse',
  STOP: 'Stop',
  SESSION_END: 'SessionEnd',
};

export const AGENDA_PRIORITY = {
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
};

export const AGENDA_STATUS = {
  TODO: 'todo',
  IN_PROGRESS: 'in-progress',
  DONE: 'done',
  BLOCKED: 'blocked',
};

export const AGENDA_TAGS = ['feature', 'bug', 'refactor', 'research', 'docs', 'test'];

export const TOOL_SOUND_MAP = {
  Read: 'toolRead',
  Write: 'toolWrite',
  Edit: 'toolEdit',
  Bash: 'toolBash',
  Grep: 'toolGrep',
  Glob: 'toolGlob',
  WebFetch: 'toolWebFetch',
  Task: 'toolTask',
};
