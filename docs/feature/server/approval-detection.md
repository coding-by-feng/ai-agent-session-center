# Tool Approval Detection

## Function
Detects when a session is waiting for user approval (tool permission) or user input using timeout heuristics and the PermissionRequest event.

## Purpose
Enables the dashboard to show approval/input status, trigger alarms, and alert users when their sessions need attention.

## Source Files
| File | Role |
|------|------|
| `server/approvalDetector.ts` (~5.8KB, 135 lines) | Timer management, category-based timeouts, child-process check, **thinking-spinner guard** (`isAgentBusyOutput` + `BUSY_SPINNER_RE`), timer Map |
| `server/sshManager.ts` | `getTerminalOutputTail(terminalId, maxBytes)` — supplies the live terminal tail the spinner guard inspects |
| `server/config.ts` | Tool category definitions + timeouts/labels for approval detection (the approval slice only; this file also hosts auto-idle/animation/launch-flag config consumed by other features) |
| `server/sessionStore.ts` | Coordinator — calls `startApprovalTimer`/`clearApprovalTimer` per hook event and handles `PermissionRequest` directly |

## Implementation

### Category Timeouts
Defined in `config.ts` as `TOOL_CATEGORIES` + `TOOL_TIMEOUTS`. A tool not in any category gets timeout `0` (no detection).

| Category | Tools | Timeout (ms) | Resulting status (`WAITING_REASONS`) |
|----------|-------|--------------|--------------------------------------|
| fast | Read, Write, Edit, Grep, Glob, NotebookEdit | 3000 | approval |
| userInput | AskUserQuestion, EnterPlanMode, ExitPlanMode | 3000 | input |
| medium | WebFetch, WebSearch | 15000 | approval |
| slow | Bash, Task | 8000 | approval |

A precomputed `_toolToCategory` Map gives O(1) lookups via `getToolCategory()`; `getToolTimeout()`, `getWaitingStatus()`, and `getWaitingLabel()` derive from it.

### Timer Behavior (`startApprovalTimer`)
- On `PreToolUse`, the existing timer for the session is cleared and a new one is started (`pendingToolTimers` = `Map<sessionId, timeoutHandle>`).
- Before starting, `session.pendingTool` and `session.pendingToolDetail` are stamped on the session (set to `null` when the tool has no timeout).
- When the timer fires it re-looks-up the live session (avoids stale closure). It only transitions if the session is still `WORKING` and still has a `pendingTool`. On fire it sets `status` (from `getWaitingStatus`, default `approval`), `animationState = Waiting`, and `waitingDetail` (from `getWaitingLabel`), then broadcasts.

### Child-Process Check (`hasChildProcesses`)
- Only for `category === 'slow'` AND when `session.cachedPid` is set: runs `pgrep -P {pid}` (`execFileSync`, 2s timeout, PID validated as positive int).
- Non-empty output -> children exist -> command still running -> skip the transition.
- On `pgrep` error the function returns `true` (safer default: assume still running) so a failed probe never produces a false "approval".

### Thinking-Spinner Guard (`isAgentBusyOutput`)
- Runs for **all** categories, before the child-process check, when the timer fires. Samples the session's live terminal tail (`getTerminalOutputTail(terminalId, 2048)` in `sshManager.ts`, wired via the optional `getTerminalOutput` callback `sessionStore` passes to `startApprovalTimer`).
- `isAgentBusyOutput` strips ANSI (`stripAnsi`), inspects the last ~600 chars, and matches `BUSY_SPINNER_RE` — an elapsed-time counter `(… 2m 44s …)` paired with `esc to interrupt` / a token counter / `thinking`. That footer is the AI CLIs' live "working" spinner (e.g. `✽ Enchanting… (2m 44s · ↓ 6.8k tokens · almost done thinking with xhigh effort)`); it is shown only while busy, never at an approval prompt (which has no elapsed-time spinner).
- If a spinner is present -> the agent is actively thinking/running -> **skip** the transition. This fixes a false "approval" during long xhigh-effort thinking phases, which `hasChildProcesses` cannot catch (in-process thinking spawns no child process). Only the tail is inspected so a stale spinner left in scrollback doesn't keep a finished turn "busy". When there is no linked terminal (`session.terminalId` is null) the guard is a no-op and the prior behavior stands.

### PermissionRequest Event
- Handled directly in `sessionStore.ts` (not in `approvalDetector`). On `PermissionRequest` it clears the heuristic timer, sets `status = approval`, `animationState = Waiting`, builds `waitingDetail` (`Approve {tool}: {summary}` or `Approve {tool}`), and records `permissionMode` from the hook payload. This is the reliable signal that replaces the timeout heuristic (emitted at medium+ hook density).

### Timer Clearing (`clearApprovalTimer`)
- Clears the timeout, deletes the Map entry, and resets `pendingTool`, `pendingToolDetail`, and `waitingDetail` on the session.
- Called from `sessionStore.ts` on: `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Stop`, and from `processMonitor` when a session's process is detected dead.
- `SessionEnd` does not explicitly clear timers, but the timer callback is a no-op once `status` is no longer `WORKING`.

### waitingDetail Labels (`WAITING_LABELS` in `config.ts`)
- approval: `Approve {toolName}: {detail}` (or `Approve {toolName}` when no detail)
- input / AskUserQuestion: `Waiting for your answer`
- input / EnterPlanMode: `Review plan mode request`
- input / ExitPlanMode: `Review plan`
- input fallback (other tool): `Waiting for input on {toolName}`

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — reads session status, writes approval/input transitions
- [Hook System](./hook-system.md) — triggered by PreToolUse, cleared by PostToolUse/PermissionRequest
- [Process Monitor](./process-monitor.md) — dead process clears timers

### Depended On By
- [Sound & Alarm System](../multimedia/sound-alarm-system.md) — approval/input status triggers alarm sounds
- [Robot System](../3d/robot-system.md) — approval/input status drives the Waiting animation + alert banner

### Shared Resources
- `pendingToolTimers` Map (`Map<sessionId, timeoutHandle>`)
- Session fields written here: `status`, `animationState`, `waitingDetail`, `pendingTool`, `pendingToolDetail` (read: `cachedPid`)
- `config.ts` tool-category tables (`TOOL_CATEGORIES`, `TOOL_TIMEOUTS`, `WAITING_REASONS`, `WAITING_LABELS`)

## Change Risks
- Changing `TOOL_TIMEOUTS` affects the false-positive rate (too short = premature "approval"; too long = sluggish alerts).
- `BUSY_SPINNER_RE` (`approvalDetector.ts`) must stay in sync with the CLIs' spinner-footer format. If a CLI changes its footer (drops `esc to interrupt` / the `(Ns · … tokens)` counter), the guard stops suppressing false approvals during thinking. It must also never match an approval prompt — keep the elapsed-time-counter requirement so `(esc)` in a prompt option can't trigger it. Only the **tail** is inspected (last ~600 chars) so stale scrollback spinners don't pin a finished turn to "busy".
- Auto-approved long-running `slow` commands (npm install, builds) briefly show as "approval" for ~8s until `PostToolUse` clears it; the `cachedPid` + `hasChildProcesses` guard mitigates but does not eliminate this.
- Breaking `PermissionRequest` handling in `sessionStore.ts` removes the reliable signal and forces reliance on the timeout heuristic.
- `config.ts` is shared: it also defines `AUTO_IDLE_TIMEOUTS`, `PROCESS_CHECK_INTERVAL`, `STATUS_ANIMATIONS`, and the Claude launch-flag/session-name helpers (`applyClaudeLaunchFlags`, `reconstructPermissionFlags`, `appendSessionName`, etc.). Editing those touches Auto-Idle, Process Monitor, and session resume/fork rather than approval detection — change them with their owning features in mind.
