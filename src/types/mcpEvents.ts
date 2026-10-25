/**
 * Central-session (server/mcp) events the server tells this Mac's own windows about, and the rows they carry.
 * Shared by the server and the client, so the two cannot drift.
 *
 * Both are local-only broadcasts (never to a phone or another device) and carry no token:
 *   - `mcp_activity`     a new row of the activity log: every write a central made, every refusal
 *   - `mcp_task_update`  a task a central handed a session changed (server/mcp/ledger.ts)
 */

/** The WebSocket type of a new activity row. */
export const MCP_ACTIVITY = 'mcp_activity' as const;

/** The WebSocket type of a task's change. */
export const MCP_TASK_UPDATE = 'mcp_task_update' as const;

/** What a tool can do (server/mcp/types.ts `Risk`, which must stay equal to this). */
export type McpRisk = 'read' | 'write' | 'steers' | 'ask' | 'destructive' | 'outward';

/**
 * Where a task stands:
 * - queued     recorded; AASC is about to send its prompt (to a session it just opened: once that session has started)
 * - sent       the prompt route took it; AASC is typing and confirming it (it can wait behind a running turn)
 * - running    the session took the prompt (its UserPromptSubmit)
 * - blocked    the session waits on a dialog (a permission, a question, a plan) during the task
 * - stalled    its turn ended on an API fault (529, rate limit, network); it runs again when the turn is continued
 * - done       the turn ended cleanly, with no background shell left: the answer is in
 * - failed     the prompt was never taken, or the session or its terminal went away
 * - cancelled  the person stopped the turn (Esc), or the central cancelled the task
 */
export type McpTaskState = 'queued' | 'sent' | 'running' | 'blocked' | 'stalled' | 'done' | 'failed' | 'cancelled';

/** How an activity row ended: a call went through, was refused or failed; or the state a task moved to. */
export type McpActivityOutcome = 'ok' | 'refused' | 'failed' | McpTaskState;

/** A flat detail of a row: short values only, never a token or text a session wrote. */
export type McpActivityDetail = Record<string, string | number | boolean | null>;

/** One row of the activity log (`mcp_activity`), as GET /api/mcp/activity and the `mcp_activity` message give it. */
export interface McpActivityRow {
  id: number;
  /** Epoch ms. */
  at: number;
  centralId: string;
  /** The central's own card when the row was written; null when it had none. */
  centralSessionId: string | null;
  /** The tool called, or `task` for a task's change of state. */
  tool: string;
  risk: McpRisk;
  /** The session the write was for or refused for; null when there was none (or it was not known). */
  targetSessionId: string | null;
  taskId: string | null;
  /** One line in AASC's own words. */
  summary: string;
  outcome: McpActivityOutcome;
  detail: McpActivityDetail | null;
}

/** How AASC routed a task itself (`task_delegate` to "auto"): its decision, and its reasons in its own words. */
export interface McpTaskRoute {
  by: 'auto';
  decision: 'reuse' | 'create' | 'handoff';
  reasons: readonly string[];
}

/** A task as the `mcp_task_update` message gives it: what a badge needs, nothing the session wrote. */
export interface McpTaskView {
  /** `T<n>`, never reused: a new server run counts on from the highest id its activity log holds. */
  taskId: string;
  centralId: string;
  /** The worker's id now (it follows a re-key). */
  sessionId: string;
  state: McpTaskState;
  /** The task's first line, cut short (the central's own words). */
  title: string;
  createdAt: number;
  sentAt: number | null;
  updatedAt: number;
  /** Why it failed, in AASC's words; null otherwise. */
  error: string | null;
  /** How long the answer is, in characters; null until there is one. */
  answerChars: number | null;
  /** The answer was longer than the ledger keeps (20 000 characters) and is cut there. The server always sends it. */
  answerTruncated?: boolean;
  /** How AASC routed it; null when the central named the session. The server always sends it. */
  route?: McpTaskRoute | null;
  /** The session it was re-routed from, once its first session's terminal closed; null otherwise. The server always sends it. */
  retargetedFrom?: string | null;
}

export interface McpActivityMessage {
  type: typeof MCP_ACTIVITY;
  row: McpActivityRow;
}

export interface McpTaskUpdateMessage {
  type: typeof MCP_TASK_UPDATE;
  task: McpTaskView;
}
