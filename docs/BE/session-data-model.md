# Session Data Model

## Session Statuses

| Status | Meaning | Animation | Emote |
|---|---|---|---|
| `connecting` | Terminal created, waiting for Claude to start | Walking | Wave |
| `idle` | Claude started, waiting for user prompt | Idle | - |
| `prompting` | User submitted a prompt | Walking | Wave |
| `working` | Claude is using tools (PreToolUse/PostToolUse) | Running | - |
| `approval` | Waiting for user to approve a tool | Waiting | - |
| `input` | Waiting for user answer (AskUserQuestion) | Waiting | - |
| `waiting` | Claude finished responding (Stop event) | Waiting/Dance | ThumbsUp |
| `ended` | Session ended (SessionEnd or process died) | Death | - |

Defined in `server/constants.js`:

```js
export const SESSION_STATUS = {
  IDLE: 'idle',
  PROMPTING: 'prompting',
  WORKING: 'working',
  APPROVAL: 'approval',
  INPUT: 'input',
  WAITING: 'waiting',
  ENDED: 'ended',
  CONNECTING: 'connecting',
};
```

## Animation States

| Animation | CSS Class | Used When |
|---|---|---|
| `Idle` | Idle loop | Session idle, no activity |
| `Walking` | Walking cycle | Connecting, prompting |
| `Running` | Running cycle | Tool execution (working) |
| `Waiting` | Waiting pose | Approval, input, stop |
| `Death` | Death animation | Session ended |
| `Dance` | Dance loop | Heavy work completed (Stop event) |

```js
export const ANIMATION_STATE = {
  IDLE: 'Idle',
  WALKING: 'Walking',
  RUNNING: 'Running',
  WAITING: 'Waiting',
  DEATH: 'Death',
  DANCE: 'Dance',
};
```

## Emotes

| Emote | Used When |
|---|---|
| `Wave` | Session connecting, user prompt submitted |
| `ThumbsUp` | Light work completed (Stop event) |
| `Jump` | Subagent spawned (TaskStart) |
| `Yes` | Positive acknowledgment |

```js
export const EMOTE = {
  WAVE: 'Wave',
  THUMBS_UP: 'ThumbsUp',
  JUMP: 'Jump',
  YES: 'Yes',
};
```

## Session Object Schema

Created in `server/sessionStore.js` `createTerminalSession()`.

```js
{
  // ── Identity ──────────────────────────────────────────────────
  sessionId: string,              // unique ID (from hook or terminal ID)
  terminalId: string | null,      // linked PTY terminal ID
  lastTerminalId: string | null,  // previous terminal (after restart/disconnect)
  replacesId: string | null,      // old session ID this one replaces (re-keying)

  // ── Project Info ──────────────────────────────────────────────
  projectPath: string,            // absolute working directory
  projectName: string,            // directory basename (e.g., "my-app")
  title: string,                  // display title (auto-generated or user-set)
  label: string,                  // user label ("important", "heavy", etc.)
  summary: string | null,         // AI-generated session summary

  // ── State ─────────────────────────────────────────────────────
  status: string,                 // SESSION_STATUS value (see table above)
  animationState: string,         // ANIMATION_STATE value (CSS character animation)
  emote: string | null,           // EMOTE value (overlay on character)

  // ── Timestamps ────────────────────────────────────────────────
  startedAt: number,              // Date.now() when session created
  lastActivityAt: number,         // last hook event timestamp
  endedAt: number | null,         // when session ended (null if active)

  // ── Prompt & Tool Tracking ────────────────────────────────────
  currentPrompt: string,          // current/last user prompt text
  promptHistory: string[],        // all past prompts
  toolUsage: object,              // { toolName: count } aggregated map
  totalToolCalls: number,         // running total of tool calls
  toolLog: object[],              // detailed tool call log entries
  responseLog: object[],          // Claude response excerpts
  events: object[],               // lifecycle events array

  // ── Active Tool State ─────────────────────────────────────────
  pendingTool: string | null,     // tool name currently executing
  waitingDetail: string | null,   // detail about what's being waited on

  // ── Process Info ──────────────────────────────────────────────
  cachedPid: number | null,       // Claude process PID (from hook enrichment)
  model: string,                  // Claude model ID (sonnet, opus, haiku, etc.)
  permissionMode: string | null,  // permission mode from hook
  transcriptPath: string | null,  // path to Claude transcript file

  // ── SSH / Terminal Config ─────────────────────────────────────
  source: string,                 // 'ssh' (dashboard-created) or detected source
                                  // (vscode, iterm, warp, terminal, etc.)
  sshHost: string,                // hostname (e.g., "localhost", "prod-server")
  sshCommand: string,             // command run in terminal (e.g., "claude")
  sshConfig: {                    // full SSH config for reconnect
    host: string,                 //   hostname
    port: number,                 //   SSH port (default 22)
    username: string,             //   SSH username
    authMethod: string,           //   "key" | "password"
    privateKeyPath: string,       //   path to SSH private key
    workingDir: string,           //   remote working directory
    command: string,              //   command to execute
  } | null,

  // ── Team / Subagent ───────────────────────────────────────────
  subagentCount: number,          // active subagent count
  lastSubagentName: string | null,// name of last spawned subagent
  teamId: string | null,          // team this session belongs to
  parentSessionId: string | null, // parent session (if this is a subagent)

  // ── UI State ──────────────────────────────────────────────────
  archived: 0 | 1,               // archived flag
  isHistorical: boolean,          // ended SSH session kept for history view
  queueCount: number,             // number of queued prompts
  accentColor: string | null,     // custom card border color
  characterModel: string | null,  // custom CSS character model override
  previousSessions: object[],     // history of resumed session IDs
}
```

## State Machine

```
                          ┌──────────────────────────────────────────────┐
                          │              State Transitions               │
                          └──────────────────────────────────────────────┘

  [create terminal] ─────► connecting
                               │
                     SessionStart
                               │
                               ▼
                        ┌──► idle ◄─────────────────── [2min idle timeout]
                        │      │                              ▲
                        │ UserPromptSubmit                     │
                        │      │                              │
                        │      ▼                              │
                        │  prompting                          │
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
                        │   │    │    approval ◄── PermissionRequest
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
                        │   │  waiting ───────────────────────┘
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

## Hook Event to State Mapping

| Hook Event | Status Transition | Animation | Emote |
|---|---|---|---|
| `SessionStart` | any -> `idle` | Idle | - |
| `UserPromptSubmit` | idle/waiting -> `prompting` | Walking | Wave |
| `PreToolUse` | prompting/working -> `working` | Running | - |
| `PostToolUse` | working -> `working` | Running | - |
| `PermissionRequest` | working -> `approval` | Waiting | - |
| `Stop` (light work) | working -> `waiting` | Waiting | ThumbsUp |
| `Stop` (heavy work) | working -> `waiting` | Dance | - |
| `SessionEnd` | any -> `ended` | Death | - |
| `TaskStart` | (no status change) | - | Jump |
| `TaskEnd` | (no status change) | - | - |
| [approval timeout] | working -> `approval` | Waiting | - |
| [input timeout] | working -> `input` | Waiting | - |
| [2min idle] | waiting -> `idle` | Idle | - |

## Approval Detection

When `PreToolUse` fires, a timeout starts. If `PostToolUse` doesn't arrive within the timeout, the session transitions to `approval` or `input`.

### Tool Category Timeouts

| Category | Tools | Timeout | Resulting Status |
|---|---|---|---|
| fast | Read, Write, Edit, Grep, Glob, NotebookEdit | 3s | `approval` |
| userInput | AskUserQuestion, EnterPlanMode, ExitPlanMode | 3s | `input` |
| medium | WebFetch, WebSearch | 15s | `approval` |
| slow | Bash, Task | 8s | `approval` |

**PermissionRequest** hook event (medium+ density) is a reliable signal that immediately sets `approval` status, replacing the heuristic timeout.

## Session Persistence (Snapshots)

Sessions are saved to `data/snapshots/sessions-snapshot.json`:
- **Periodically**: every 10 seconds
- **On shutdown**: SIGTERM/SIGINT triggers a final save

On server restart, `loadSnapshot()` restores sessions:

| Session Type | Behavior After Restart |
|---|---|
| External (VS Code, iTerm) | Restored as-is if Claude PID is still alive |
| SSH/local terminal | Marked `ended` (PTY is dead), kept for history |
| Dead PID sessions | Marked `ended` with `ServerRestart` event |

Ended sessions with `ServerRestart` events are eligible for **Priority 0.5 auto-resume**: if `claude --resume` sends a `SessionStart` in the same directory, the old card is re-keyed instead of creating a duplicate.

## Session Matching (5-Priority System)

When a hook arrives with an unknown `session_id`, the matcher links it to an existing session:

| Priority | Strategy | Condition | Risk |
|---|---|---|---|
| 0 | pendingResume + terminal ID / workDir | Explicit resume action | Low |
| 0.5 | Snapshot auto-resume by projectPath | Ended session with `ServerRestart`, same cwd, no `agent_terminal_id` | Medium |
| 1 | `agent_terminal_id` env var | Dashboard-created terminal with `AGENT_MANAGER_TERMINAL_ID` | Low |
| 2 | `tryLinkByWorkDir` | Pending link with matching workDir | Medium |
| 3 | Path scan (connecting sessions) | Scan all `connecting` sessions by normalized path | Medium |
| 4 | PID parent check | Claude PID is child of known PTY process | High |

If no match is found, a display-only card is created with the detected source.
