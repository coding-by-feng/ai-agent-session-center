# Tool Approval Detection

## Function
Detects when a session is waiting for user approval (tool permission) or user input using timeout heuristics and the PermissionRequest event.

## Purpose
Enables the dashboard to show approval/input status, trigger alarms, and alert users when their sessions need attention.

## Source Files
| File | Role |
|------|------|
| `server/approvalDetector.ts` (~4KB) | Timer management, category-based timeouts, child process check |
| `server/config.ts` | Tool category definitions (fast/userInput/medium/slow) |

## Implementation

### Category Timeouts

| Category | Tools | Timeout |
|----------|-------|---------|
| fast | Read/Write/Edit/Grep/Glob/NotebookEdit | 3s |
| userInput | AskUserQuestion/EnterPlanMode/ExitPlanMode | 3s |
| medium | WebFetch/WebSearch | 15s |
| slow | Bash/Task | 8s |

### Timer Behavior
- Timer fires -> set approval/input status with waitingDetail label
- All timers stored in Map<sessionId, timeoutHandle>; new timer replaces existing

### Child Process Check
- hasChildProcesses check for slow tools: pgrep -P {pid}
- If children exist -> command still running, skip status transition

### PermissionRequest Event
- PermissionRequest event (medium+ density) immediately clears heuristic timer and sets approval directly (more reliable)

### Timer Clearing
- Timers explicitly cleared on: PostToolUse, PostToolUseFailure, PermissionRequest, Stop, dead process (via processMonitor)
- SessionEnd does not explicitly clear timers, but the timer callback is a no-op when session status is not WORKING

### waitingDetail Labels
- "Approve {toolName}: {inputSummary}"
- "Waiting for your answer"
- "Review plan mode request"
- "Review plan"

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — reads session status, writes approval/input transitions
- [Hook System](./hook-system.md) — triggered by PreToolUse, cleared by PostToolUse/PermissionRequest
- [Process Monitor](./process-monitor.md) — dead process clears timers

### Depended On By
- Sound/alarm system (frontend) — approval status triggers alarm sounds
- 3D robot system (frontend) — approval status triggers waiting animation + alert banner

### Shared Resources
- Timer Map
- session status field

## Change Risks
- Changing timeouts affects false positive rate
- Auto-approved long-running commands (npm install, builds) briefly show as "approval" for ~8s
- Breaking PermissionRequest handling removes the reliable signal
