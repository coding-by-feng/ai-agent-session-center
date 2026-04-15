# Session Data Model

## Session Statuses

| Status | Meaning | Animation | Emote |
|--------|---------|-----------|-------|
| `connecting` | Terminal created, waiting for Claude to start | Walking | Wave |
| `idle` | Claude started, waiting for user prompt | Idle | - |
| `prompting` | User submitted a prompt | Walking | Wave |
| `working` | Claude is using tools (PreToolUse/PostToolUse) | Running | - |
| `approval` | Waiting for user to approve a tool | Waiting | - |
| `input` | Waiting for user answer (AskUserQuestion) | Waiting | - |
| `waiting` | Claude finished responding (Stop event) | Waiting/Dance | ThumbsUp |
| `ended` | Session ended (SessionEnd or process died) | Death | - |

Defined in `server/constants.ts`:

```typescript
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
```

## Animation States

| Animation | Used When |
|-----------|-----------|
| `Idle` | Session idle, no activity |
| `Walking` | Connecting, prompting |
| `Running` | Tool execution (working) |
| `Waiting` | Approval, input, stop (light work) |
| `Death` | Session ended |
| `Dance` | Heavy work completed (Stop with >10 tool calls) |

```typescript
export const ANIMATION_STATE = {
  IDLE: 'Idle',
  WALKING: 'Walking',
  RUNNING: 'Running',
  WAITING: 'Waiting',
  DEATH: 'Death',
  DANCE: 'Dance',
} as const;
```

## Emotes

| Emote | Used When |
|-------|-----------|
| `Wave` | Session connecting, user prompt submitted |
| `ThumbsUp` | Light work completed (Stop event) or TaskCompleted |
| `Jump` | Subagent spawned (SubagentStart) |
| `Yes` | Positive acknowledgment |

```typescript
export const EMOTE = {
  WAVE: 'Wave',
  THUMBS_UP: 'ThumbsUp',
  JUMP: 'Jump',
  YES: 'Yes',
} as const;
```

## Session Object Schema

Defined in `src/types/session.ts`. Created by `createDefaultSession()` in `server/sessionMatcher.ts`.

```typescript
interface Session {
  // ── Core Identity ──────────────────────────────────────────────────
  sessionId: string;              // unique ID (from hook or terminal ID)

  // ── Status & Animation ─────────────────────────────────────────────
  status: SessionStatus;          // SESSION_STATUS value
  animationState: AnimationState; // ANIMATION_STATE value
  emote: Emote;                   // EMOTE value or null

  // ── Project Info ───────────────────────────────────────────────────
  projectPath: string;            // absolute working directory
  projectName: string;            // directory basename (e.g., "my-app")
  title: string;                  // auto-generated or user-set display title
  label?: string;                 // user label ("important", "heavy", etc.)
  summary?: string;               // AI-generated session summary
  accentColor?: string;           // custom card border color
  characterModel?: string;        // custom 3D character model override

  // ── Source / Origin ────────────────────────────────────────────────
  source: SessionSource | string; // 'ssh' | 'vscode' | 'jetbrains' | 'iterm' |
                                  // 'warp' | 'kitty' | 'ghostty' | 'alacritty' |
                                  // 'wezterm' | 'hyper' | 'terminal' | 'tmux' | 'unknown'
  model: string;                  // Claude model ID (e.g., "claude-sonnet-4-6")
  transcriptPath?: string;        // path to Claude transcript file
  permissionMode?: string | null; // permission mode from hook ("acceptEdits", etc.)
  startupCommand?: string;        // command used to start Claude (first hook, non-subagent)

  // ── Timestamps ─────────────────────────────────────────────────────
  startedAt: number;              // Date.now() when session created
  lastActivityAt: number;         // last hook event timestamp
  endedAt: number | null;         // when session ended (null if active)

  // ── Prompt & Tool Tracking ─────────────────────────────────────────
  currentPrompt: string;          // current/last user prompt text
  promptHistory: PromptEntry[];   // last 50 prompts [{text, timestamp}]
  toolUsage: Record<string, number>; // { toolName: count } aggregated map
  totalToolCalls: number;         // running total (resets on Stop)
  toolLog: ToolLogEntry[];        // last 200 tool call entries [{tool, input, timestamp, failed?, error?}]
  responseLog: ResponseEntry[];   // last 50 Claude response excerpts [{text, timestamp}]
  events: SessionEvent[];         // lifecycle events [{type, timestamp, detail}]

  // ── Approval Detection ─────────────────────────────────────────────
  pendingTool: string | null;     // tool name currently executing
  pendingToolDetail?: string | null; // input summary for pending tool
  waitingDetail: string | null;   // detail about what's being waited on

  // ── Subagents ──────────────────────────────────────────────────────
  subagentCount: number;          // active subagent count
  lastSubagentName?: string;      // name of last spawned subagent

  // ── Team ───────────────────────────────────────────────────────────
  teamId?: string | null;         // team this session belongs to
  teamRole?: 'leader' | 'member'; // role in team
  parentSessionId?: string | null;// parent session (if this is a subagent)
  isSubagent?: boolean;           // whether this is a subagent session
  agentName?: string;             // agent name from enriched hook
  agentType?: string;             // agent type (e.g., "general-purpose")
  teamName?: string;              // team name from enriched hook
  agentColor?: string;            // agent color for UI
  tmuxPaneId?: string;            // tmux pane ID (team tracking)
  backendType?: string;           // backend type (team tracking)

  // ── Terminal / SSH Linkage ─────────────────────────────────────────
  terminalId: string | null;      // linked PTY terminal ID
  opsTerminalId?: string | null;  // ops/secondary terminal ID
  hadOpsTerminal?: boolean;       // whether ops terminal was ever set
  lastTerminalId?: string | null; // previous terminal (after restart/disconnect)
  cachedPid: number | null;       // Claude process PID (from hook enrichment)
  sshHost?: string;               // hostname (e.g., "localhost", "prod-server")
  sshCommand?: string;            // command run in terminal (e.g., "claude")
  sshConfig?: SshConfig;          // full SSH config for reconnect

  // ── Resume / Re-key ────────────────────────────────────────────────
  replacesId?: string;            // old session ID this one replaces (re-keying)
  previousSessions?: ArchivedSession[]; // last 5 archived session data (resume chain)
  isHistorical?: boolean;         // ended SSH session kept for history view

  // ── Misc ───────────────────────────────────────────────────────────
  archived: number;               // archived flag (0 | 1)
  queueCount: number;             // number of queued prompts
  colorIndex?: number;            // color index for UI
  muted?: boolean;                // muted sound alerts
  pinned?: boolean;               // pinned to top
}
```

### Sub-record Types

```typescript
interface PromptEntry     { text: string; timestamp: number; }
interface ToolLogEntry    { tool: string; input: string; timestamp: number; failed?: boolean; error?: string; }
interface ResponseEntry   { text: string; timestamp: number; }
interface SessionEvent    { type: string; timestamp: number; detail: string; }

interface SshConfig {
  host: string;
  port: number;
  username?: string;
  authMethod?: 'key' | 'password';
  privateKeyPath?: string;
  workingDir?: string;
  command?: string;
}

interface ArchivedSession {
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
```

## State Machine

```
                   ┌────────────────────────────────────────────────┐
                   │              State Transitions                  │
                   └────────────────────────────────────────────────┘

  [create terminal] ────► connecting
                               │
                     SessionStart
                               │
                               ▼
                        ┌──► idle ◄──────────────────── [auto-idle timers]
                        │      │                              ▲
                        │ UserPromptSubmit                    │
                        │      │                              │
                        │      ▼                              │
                        │  prompting ─────────────────────────┤ [30s timeout]
                        │      │                              │
                        │  PreToolUse                         │
                        │      │                              │
                        │      ▼                              │
                        │  working ◄──── PostToolUse          │
                        │   │    │                            │
                        │   │    │   [timeout:                │
                        │   │    │    fast 3s /               │
                        │   │    │    slow 8s /               │
                        │   │    │    medium 15s]             │
                        │   │    │        │                   │
                        │   │    │        ▼                   │
                        │   │    │    approval ◄─── PermissionRequest
                        │   │    │                            │
                        │   │    │   [timeout 3s:             │
                        │   │    │    AskUserQuestion /       │
                        │   │    │    EnterPlanMode]          │
                        │   │    │        │                   │
                        │   │    │        ▼                   │
                        │   │    │     input                  │
                        │   │    │                            │
                        │   │    Stop                         │
                        │   │    │                            │
                        │   │    ▼                            │
                        │   │  waiting ───────────────────────┘ [2min timeout]
                        │   │
                        │ SessionEnd / process died / server restart
                        │   │
                        │   ▼
                        │  ended
                        │   │
                        │  [resume / reconnect]
                        │   │
                        └───┘
```

### Auto-Idle Timers (autoIdleManager.ts — checks every 10s)

| Current Status | Idle Timeout | Target Status | Animation | Notes |
|----------------|--------------|---------------|-----------|-------|
| `waiting` | 120s (2 min) | `idle` | Idle | Normal completion cooldown |
| `prompting` | 30s | `waiting` | Waiting | User likely cancelled |
| `working` | 180s (3 min) | `idle` | Idle | Long-running tool timeout |
| `approval` | 600s (10 min) | `idle` | Idle | Safety net for stuck approval |
| `input` | 600s (10 min) | `idle` | Idle | Safety net for stuck input |

## Hook Event to State Mapping

| Hook Event | Status Transition | Animation | Emote | Actions |
|------------|------------------|-----------|-------|---------|
| `SessionStart` | any → `idle` | Idle | - | Set model, transcript path, permission mode. Update SSH projectPath from hook cwd. Team linking via `parent_session_id` or path-based matching. |
| `UserPromptSubmit` | idle/waiting → `prompting` | Walking | Wave | Store prompt in history (last 50). Auto-generate title from project name + prompt. |
| `PreToolUse` | prompting/working → `working` | Running | - | Increment tool usage counter. Push to tool log (last 200). Start approval detection timer. |
| `PostToolUse` | working → `working` | - | - | Cancel approval timer. Mark tool completed. Stay working. |
| `PostToolUseFailure` | working → `working` | - | - | Cancel approval timer. Mark last tool log entry as failed with error message. |
| `PermissionRequest` | working → `approval` | Waiting | - | Cancel approval timer (reliable signal). Set `waitingDetail` with tool name + input summary. |
| `Stop` (light work, ≤10 calls) | working → `waiting` | Waiting | ThumbsUp | Store response excerpt (last 50). Reset tool call counter. |
| `Stop` (heavy work, >10 calls) | working → `waiting` | Dance | - | Same as above, different animation. |
| `SubagentStart` | (no change) | - | Jump | Increment subagentCount. Track pending subagent for team auto-detection. |
| `SubagentStop` | (no change) | - | - | Decrement subagentCount (min 0). |
| `TeammateIdle` | (no change) | - | - | Log teammate idle info. |
| `TaskCompleted` | (no change) | - | ThumbsUp | Log task completion with description/ID. |
| `PreCompact` | (no change) | - | - | Log context compaction. |
| `Notification` | (no change) | - | - | Log notification message/title. |
| `SessionEnd` | any → `ended` | Death | - | Release PID cache. Team cleanup (15s delayed). SSH sessions: mark `isHistorical`, preserve terminal ref. Non-SSH: keep ENDED in memory (broadcast keeps IndexedDB in sync). |
| [approval timeout] | working → `approval` | Waiting | - | Heuristic fallback when PostToolUse doesn't arrive. |
| [input timeout] | working → `input` | Waiting | - | For userInput tool category (AskUserQuestion, EnterPlanMode). |
| [auto-idle timer] | waiting/prompting/working/approval/input → `idle` | Idle | - | See auto-idle table above. |

## Approval Detection

When `PreToolUse` fires, a timeout timer starts. If `PostToolUse` doesn't arrive within the category timeout, the session transitions to `approval` or `input`.

### Tool Category Timeouts (config.ts)

| Category | Tools | Timeout | Resulting Status |
|----------|-------|---------|-----------------|
| **fast** | Read, Write, Edit, Grep, Glob, NotebookEdit | 3s | `approval` |
| **userInput** | AskUserQuestion, EnterPlanMode, ExitPlanMode | 3s | `input` |
| **medium** | WebFetch, WebSearch | 15s | `approval` |
| **slow** | Bash, Task | 8s | `approval` |

### Refinements

- **hasChildProcesses check**: For `slow` tools (Bash, Task), checks `pgrep -P <pid>` with 2s timeout. If child processes exist → tool is still running, skip approval transition. Returns `true` on error (safer default).
- **PermissionRequest event**: At medium+ hook density, Claude sends a `PermissionRequest` hook — a reliable signal that immediately cancels the timer and sets `approval` status.
- **Known limitation**: Auto-approved long-running commands (npm install, builds) briefly show "approval" for ~8s until PostToolUse clears it.

## Session Persistence (Snapshots)

Sessions are saved to `/tmp/claude-session-center/sessions-snapshot.json` (or Windows/Electron equivalent):

- **Save interval**: Every 10s via `startPeriodicSave()`
- **On shutdown**: SIGTERM/SIGINT triggers a final `saveSnapshot()`
- **Atomic write**: Written to `.tmp` file then renamed (prevents corruption)
- **Permissions**: Mode `0o600` (user-only read/write)

### Snapshot Structure

```typescript
{
  version: 1,
  savedAt: number,
  eventSeq: number,           // for ring buffer continuity on reconnect
  mqOffset: number,           // last processed MQ byte offset
  sessions: Record<string, Session>,
  projectSessionCounters: Record<string, number>,
  pidToSession: Record<string, string>,       // pid -> sessionId
  pendingResume: Record<string, PendingResume>, // terminalId -> {oldSessionId, timestamp}
}
```

### Snapshot Load Behavior (loadSnapshot)

| Session Type | Behavior After Restart |
|---|---|
| SSH session, PID still alive | Restored as `idle` (PTY is dead, but Claude still running) |
| SSH session, PID dead | Restored as `idle` (user must manually close) |
| SSH historical (already ended) | Restored as-is |
| Non-SSH session (ended) | Kept with `ServerRestart` event; eligible for auto-link |
| Stale terminal refs | `terminalId` cleared on all SSH sessions (PTYs never survive restart) |
| Duplicate ended sessions (same path+source) | Deduped — keep most recent by activity |
| Map key / sessionId mismatch | Repaired (keep newer by lastActivityAt) |

Sessions tagged with `ServerRestart` are eligible for **Priority 0.5 auto-resume**: when `claude --resume` sends a `SessionStart` in the same directory, the old card is re-keyed instead of creating a new one.

## Session Matching (Extended Priority System)

When a hook arrives with an unknown `session_id`, `matchSession()` (in `sessionMatcher.ts`) links it to an existing session using a multi-priority fallback chain. Called from `handleEvent()` in `sessionStore.ts`.

| Priority | Strategy | Condition | Risk |
|----------|----------|-----------|------|
| **0** | pendingResume + terminal ID | Explicit resume action, terminalId match | Low |
| **0** (fallback) | pendingResume + projectPath | Exactly 1 pending resume shares same cwd | Medium |
| **0.5** | Snapshot auto-resume by projectPath | Ended/idle session with `ServerRestart` event, same cwd, exactly 1 candidate (or 1 ENDED over zombies) | Medium |
| **1** | `agent_terminal_id` direct Map key | sessions Map key === hookData.agent_terminal_id | Low |
| **1b** | `agent_terminal_id` terminalId scan | Scan all sessions for s.terminalId or s.lastTerminalId === agent_terminal_id (skips CONNECTING) | Low |
| **1.5** | Cached PID match | pidToSession.get(claude_pid) returns existing session | Medium |
| **2** | Pending workDir link | tryLinkByWorkDir(cwd) returns terminalId; re-key or create SSH session | Medium |
| **3** | Path scan (CONNECTING sessions) | Scan CONNECTING sessions by normalized path; if >1 match, pick newest | Medium |
| **4** | PID parent check | getTerminalByPtyChild(claude_pid) returns terminalId | High |

**SSH-only mode**: If no match is found at any priority, `matchSession()` returns `null` and the event is silently dropped (no display-only cards created).

### reKeyResumedSession() Logic

When a session is re-keyed (all priority levels):

1. Delete old Map entry by `oldSessionId`
2. Clear stale PID mapping
3. Archive old data to `previousSessions[]` (max 5 kept; deduped by sessionId)
4. Reset fresh state: status=IDLE, empty prompt/tool/response logs, totalToolCalls=0
5. Preserve: `previousSessions`, `sshConfig`, `source`, `terminalId`
6. Push `{type: 'SessionResumed'}` to events
7. Set `session.sessionId = newSessionId`, `replacesId = oldSessionId`
8. Insert under new Map key

### CONNECTING Orphan Merge (handleEvent)

After a re-key, `handleEvent()` scans for a CONNECTING session with the same `projectPath`. If found:
- Transfer `terminalId`, `opsTerminalId`, `sshConfig`, `sshHost`, `sshCommand` to the re-keyed session
- Remove the orphan from sessions Map and broadcast `session_removed`

This prevents duplicate cards when workspace auto-load creates a CONNECTING session at the same time as a post-restart re-key.
