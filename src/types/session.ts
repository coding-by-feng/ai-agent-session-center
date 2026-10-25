/**
 * Session types for AI Agent Session Center.
 * Canonical source of truth — shared by server (NodeNext) and client (Vite).
 */

import type { SessionCentralMarker } from './central.js';

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

/** Hook event type names (Claude Code, Codex lifecycle events) */
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
  /**
   * The fuller text behind `input` (a Bash command or an unrecognised tool's JSON,
   * which `input` cuts to 100-120 characters), up to 1,000 characters. Only the
   * newest ~30 entries keep it, and only when it says more than `input` does.
   * Shown when a row of the AGENTS log is opened.
   */
  detail?: string;
  /**
   * The in-process subagent that made this call (its Claude `agent_id`).
   * Absent for the session's own calls. Set only when the id matches one of
   * the session's `subagents`, so a teammate's own identity never lands here.
   */
  agentId?: string;
}

/**
 * `working` until the subagent's SubagentStop; `done` after it; `ended` when it
 * was closed without one (the session restarted or ended, or the leader's Stop
 * no longer listed it as running), so its outcome is unknown.
 */
export type SubagentRunStatus = 'working' | 'done' | 'ended';

/**
 * One in-process subagent (Claude Code's Agent/Task tool) run by a session.
 * Built by `server/subagentTracker.ts`; drives the AGENTS tab.
 */
export interface SubagentRun {
  agentId: string;
  /** e.g. `Explore`, `code-reviewer`; `unknown` when the CLI didn't say. */
  agentType: string;
  /** The task the leader gave it (the Agent tool's `description`), when known. */
  description: string | null;
  /**
   * True once the description came from an id-keyed source (the leader's
   * Agent PostToolUse, or `background_tasks`). False while it is a FIFO guess,
   * which parallel spawns of one type can get wrong.
   */
  descriptionConfirmed: boolean;
  status: SubagentRunStatus;
  startedAt: number;
  endedAt: number | null;
  lastActivityAt: number;
  toolCount: number;
  /** The latest tool it called (kept while it thinks between calls); null once finished. */
  currentTool: string | null;
  /** Short summary of that tool's input (a path, a command, a pattern). */
  currentTarget: string | null;
}

/** An entry of Claude Code's `background_tasks` (on Stop and SubagentStop). */
export interface BackgroundTask {
  id?: string;
  type?: string;
  status?: string;
  description?: string;
  agent_type?: string;
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
  /** False: a phone's launch in a new folder (AASC-54). Kept so a restart, resume or fork
   *  of that session leaves Claude's folder-trust prompt to the person too. */
  autoConfirmTrust?: false;
}

/** Archived previous session data (used for SSH resume chains) */
/**
 * A prior run of a session, archived on resume / reconnect / re-key.
 *
 * Carries ONLY the fields something actually reads: ConversationView's
 * `PrevSessionSection` renders `startedAt`, `endedAt` and `promptHistory`;
 * `workspaceSnapshot` reads `sessionId` to build its alias map. It previously
 * also deep-copied `toolLog`, `responseLog`, `events`, `toolUsage` and
 * `totalToolCalls` — written at three call sites, read at none, and kept five
 * deep per session.
 *
 * Built exclusively by `archiveSession()` in `server/sessionTrim.ts`. Adding a
 * field without adding a consumer just reintroduces the bloat.
 */
export interface ArchivedSession {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  promptHistory: PromptEntry[];
}

// ---------------------------------------------------------------------------
// Interruption (transient-failure detection)
// ---------------------------------------------------------------------------

/** Class of transient failure recognised in a terminal's output. */
export type FaultKind = 'api_error' | 'rate_limit' | 'network';

/**
 * A transient failure banner observed in the session's PTY output. Produced by
 * `server/interruptionDetector.ts`, consumed by `src/lib/resumeWatchdog.ts`.
 */
export interface SessionInterruption {
  kind: FaultKind;
  /** The banner line as printed, for the UI badge. */
  line: string;
  detectedAt: number;
}

/**
 * A context compaction in progress: set by a PreCompact hook, cleared when it ends
 * (PostCompact, or Claude's SessionStart with source `compact`) or by the next turn
 * event. Live-only; the phone ignores one older than `COMPACTING_STALE_MS`.
 */
export interface SessionCompacting {
  since: number;
  /** 'auto' (the context filled up, or compacted while idle) or 'manual' (/compact), when the CLI says. */
  trigger: 'auto' | 'manual' | null;
}

// ---------------------------------------------------------------------------
// Waiting requests (AASC-43): what a waiting session is asking, structured
// ---------------------------------------------------------------------------

/** One choice of an AskUserQuestion, as the agent offered it. */
export interface PendingRequestOption {
  label: string;
  description?: string;
}

/**
 * What the CLI is waiting on, structured (`server/pendingRequests.ts`): set by the
 * PermissionRequest hook and by PreToolUse of AskUserQuestion / ExitPlanMode, cleared by
 * the call's PostToolUse(Failure), UserPromptSubmit, Stop, SessionStart/End, a newer
 * request, or an answer the server wrote. Answered by
 * `POST /api/sessions/:id/requests/:requestId/answer`. Live-only: never archived or
 * written to the restart snapshot.
 */
export interface PendingRequest {
  /** The hook's tool_use_id when it sent one, else a server uuid. An answer names it. */
  id: string;
  kind: 'permission' | 'question' | 'plan';
  cli: 'claude' | 'codex';
  /** For the answer key map, once the CLI reports one. */
  cliVersion?: string;
  /** Bash, Edit, WebFetch, AskUserQuestion, ExitPlanMode, an MCP tool, Codex's shell… */
  tool: string;
  /** The tool's input as the CLI sent it: capped at 8 KB, edits whole up to 64 KB. Absent on a guess. */
  input?: unknown;
  /** The input was cut to fit its cap (long strings end in a marker). */
  inputTruncated?: boolean;
  /** AskUserQuestion's choices, present only when the answer route can pick one:
   *  a single, single-select question with at most 9 choices. */
  options?: PendingRequestOption[];
  /** The dialog has an "always allow" line: its PermissionRequest suggested a rule to save.
   *  Without one, Claude's option 2 is "Yes, and switch to auto mode", so Always allow is
   *  neither offered nor answered. */
  canAlwaysAllow?: true;
  /** The hook's tool_use_id, when it sent one: matches the call's PostToolUse. */
  toolUseId?: string;
  /** Raised while another request was still open (parallel tools or subagents): the CLI
   *  may be showing either dialog, so no card can answer it. Lasts until it is cleared. */
  ambiguous?: boolean;
  raisedAt: number;
  /** `timer` and `notification` are guesses (no input): only "Open terminal" can answer them. */
  source: 'permission_request' | 'notification' | 'pre_tool_use' | 'timer';
}

// ---------------------------------------------------------------------------
// Plan usage (the CLI's subscription limits — what `/usage` and `/status` show)
// ---------------------------------------------------------------------------

/** The AI CLIs that report plan limits. */
export type PlanCli = 'claude' | 'codex';

/** One plan-limit bucket: a CLI's "5-hour" or "weekly" allowance. */
export interface PlanUsageWindow {
  /**
   * Length of the window in minutes (300 = 5 h, 10080 = a week). It identifies
   * the window — the UI derives the label from it — so two observations of the
   * same window can be compared and a window that has rolled over is told apart
   * from the one before it by `resetsAt`.
   */
  minutes: number;
  /** 0–100: how much of the limit is used. */
  usedPercent: number;
  /** Epoch ms at which the window resets; null when the CLI did not say. */
  resetsAt: number | null;
}

/**
 * Plan limits as last reported by a CLI. They belong to the ACCOUNT, not to a
 * session, so the server attaches the freshest observation to every live
 * session of that CLI (`server/planUsageService.ts`); the field rides the
 * ordinary session update and so inherits its visibility gate.
 */
export interface PlanUsage {
  cli: PlanCli;
  /** At least one window: an observation with none is never produced. */
  windows: PlanUsageWindow[];
  /** The login's plan as the CLI names it (Codex `plan_type`), when it says. */
  plan?: string;
  /** The CLI reported that a limit has been hit. */
  limitReached?: boolean;
  /** Epoch ms when a session last reported these numbers. */
  asOf: number;
}

// ---------------------------------------------------------------------------
// Core Session
// ---------------------------------------------------------------------------

/** Core session object stored in the sessions Map */
/**
 * Live model + effort of a Claude session, newest reading per field (`server/sessionRuntime.ts`).
 * `model` may be an ID or a display name — format with `formatModelLabel`. No `effort`
 * with an `effortAt` means it is unknown since that time (e.g. right after a model switch).
 */
export interface SessionRuntime {
  model?: string;
  modelAt?: number;
  /** The model the user CHOSE (`/model <name>`, the reply after a `/model` menu pick, a
   *  Codex turn) as a `--model` value — never just the model a reply came from. */
  launchModel?: string;
  launchModelAt?: number;
  effort?: string;
  effortAt?: number;
  /** The effort came from an explicit `/effort` (not a status-line report). */
  effortSet?: boolean;
  /** How full the context window is, from Claude Code's status line. Absent = not
   *  reported yet (no reply since launch or `/clear`), never "0%". */
  context?: SessionContextUsage;
  contextAt?: number;
}

export interface SessionContextUsage {
  /** Used share of the window, 0–100 (Claude Code's own `used_percentage`). */
  pct: number;
  /** The window, in tokens. */
  size?: number;
  /** Tokens in the window: input + cache creation + cache read of the last reply. */
  tokens?: number;
}

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
  /** AI CLI family (Claude, Codex). Distinct from terminal/source. */
  cliSource?: string;
  /** The model a resume launches with (`--model`): set at creation, then follows `/model`
   *  whenever the live value is a valid flag (`launchFlagsFromRuntime`). */
  model: string;
  /** Effort level (low/medium/high/xhigh/max/ultracode) a resume launches with: set at creation,
   *  then follows `/effort` (Codex: each turn's reasoning effort). Popups inherit it. */
  effortLevel?: string;
  /** The model and effort the CLI reports it is running with now (`server/sessionRuntime.ts`):
   *  Claude's transcript + status line, Codex's rollout `turn_context`. The chip shows it (Claude
   *  only); its flag-valid values are also written into `model` / `effortLevel`. */
  runtime?: SessionRuntime;
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

  /**
   * Set when the terminal printed a transient-failure banner (API 5xx, rate
   * limit, connection error) — see `server/interruptionDetector.ts`. Cleared
   * the moment the session goes back to work, which is what the renderer's
   * auto-resume watchdog reads as "recovered". Absent on a healthy session.
   */
  interruption?: SessionInterruption | null;
  /** A context compaction in progress (see `SessionCompacting`); absent or null otherwise. */
  compacting?: SessionCompacting | null;
  /**
   * How the session came to need approval (AASC-16 push): a PermissionRequest hook,
   * a permission_prompt Notification, or the approval timeout guess. Live-only;
   * never archived.
   */
  approvalSource?: 'permission_request' | 'notification' | 'timer' | null;
  /** What the session waits on, structured (AASC-43); null once answered or gone. Live-only. */
  pendingRequest?: PendingRequest | null;

  /**
   * The CLI's plan limits (5-hour / weekly usage and when they reset), as last
   * reported. Account-wide, so every live session of one CLI carries the same
   * value; absent until some session of that CLI has reported. Never read it as
   * "this session's usage" — it is not.
   */
  planUsage?: PlanUsage | null;

  /**
   * When the user stopped the current turn — Esc mid-turn, or declining a tool
   * and redirecting — detected from Claude Code's own "What should Claude do
   * instead?" line. Claude Code fires a real Stop for a cancel, so without this
   * the queue reads it as a finished turn and sends the next prompt. The queue
   * holds while set; cleared by the user's next prompt (UserPromptSubmit), a new
   * session (SessionStart), or the queue's Resume. Deliberately separate from
   * `interruption`: the auto-resume watchdog must never continue a turn the
   * user cancelled on purpose.
   */
  userCancelledAt?: number | null;

  // Subagents
  subagentCount: number;
  /** Running background work that is not a subagent (shells, monitors) as of the last Stop. */
  backgroundTaskCount?: number;
  lastSubagentName?: string;
  /** In-process subagent runs, oldest first, capped (see subagentTracker.ts). */
  subagents?: SubagentRun[];

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
  /**
   * May this session be seen by a device that is NOT the machine running the
   * server? Absent means NO — see server/sessionVisibility.ts for why the flag
   * is "may be seen" rather than "hidden": the absent state must be the safe
   * one, because that is the state of every row written before this existed.
   */
  remoteVisible?: boolean;
  /**
   * Does selecting terminal text open the AI popup (Explain / Translate) for
   * this session? Defaults to ON.
   *
   * Note the inversion relative to `remoteVisible` above, and that it is
   * deliberate rather than inconsistent: there, absent must mean "hidden",
   * because the safe state for a NEW capability is deny. Here the feature
   * already shipped enabled for everyone, so the safe state — the one that
   * changes nothing for an existing session — is ON. Both follow the same
   * rule ("absent = the safe state"); they differ because the safe state
   * differs. Always read through `isAiPopupEnabled()`, never the raw field,
   * so `undefined` can never be mistaken for `false`.
   */
  aiPopupEnabled?: boolean;
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
   * Set when this session is a central (server/mcp): an agent AASC launched with the `aasc` MCP server
   * and a token, so it can read and drive other sessions. Copied from the launch's config at creation and
   * kept through every re-key, merge and relaunch (each new PTY gets a new token under the same
   * `centralId`); a workspace snapshot saves it, never a token. Forks and clones never carry it.
   */
  central?: SessionCentralMarker;
  /**
   * The person marked this session hands-off: a central (server/mcp) may read it but never type into it,
   * hand it a task or queue work for it (server/mcp/policy.ts refuses with HANDS_OFF). Absent means
   * centrals may steer it, within their scope and the other rails. Only the person sets it.
   */
  handsOff?: boolean;
  /**
   * `false` when the connecting timeout turned this card idle before its CLI was heard from (no hook from its
   * terminal yet): the CLI may still be showing a question, such as its folder-trust prompt, so nothing may type
   * into it for a central (Rulings P4-35, P4-41). Absent or `true` means the CLI was heard. Cleared per terminal
   * by the first hook.
   */
  startHeard?: boolean;
  /**
   * Marks a session the dashboard did NOT launch: a real Claude/Codex CLI
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
