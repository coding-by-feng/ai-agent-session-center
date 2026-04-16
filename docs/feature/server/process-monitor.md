# Process Monitor & Auto-Idle

## Function
Periodically checks if AI CLI processes are still alive and transitions dead sessions to ended state.

## Purpose
Detects when Claude/Gemini/Codex crashes or exits without sending a SessionEnd hook. Also manages auto-idle transitions for stale sessions.

## Source Files
| File | Role |
|------|------|
| `server/processMonitor.ts` (~9KB) | PID liveness checking, dead process cleanup |
| `server/autoIdleManager.ts` (~5KB) | Idle transition timers |
| `server/config.ts` | Provides `PROCESS_CHECK_INTERVAL` constant |

## Implementation

### Process Check
- Runs every 15s (configurable via serverConfig.processCheckInterval)
- process.kill(pid, 0) for each non-ended session with cachedPid
- Sessions with active PTY terminal skipped (terminal is source of truth)

### Dead Process Triggers
- Session -> ended + Death animation
- PID released from pidToSession
- Approval timer cleared
- Team cleanup
- Broadcast
- SSH sessions marked isHistorical, lastTerminalId preserved, terminalId cleared
- Non-SSH sessions kept in memory (no auto-delete; user must manually close via UI)

### findClaudeProcess() Fallback Chain
- Cached PID -> pgrep -f claude + lsof/proc cwd match -> TTY fallback -> last resort unclaimed PID

### Auto-Idle Timeouts

| Status | Timeout | Transitions To |
|--------|---------|----------------|
| prompting | 30s | waiting |
| waiting | 2min | idle |
| working | 3min | idle |
| approval/input | 10min | idle (safety net) |

### Auto-Idle Checking
- Checked every 10s by autoIdleManager
- Also cleans up stale pendingResume entries every 15s (entries older than 2min with sessions still in CONNECTING status are reverted to idle)

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — reads sessions Map, writes status transitions
- [Approval Detection](./approval-detection.md) — clears timers on dead process
- [Team & Subagent Tracking](./team-subagent.md) — triggers team cleanup on member death

### Depended On By
- [Session Management](./session-management.md) — relies on process monitor for cleanup
- [WebSocket Manager](./websocket-manager.md) — dead process broadcasts to browsers

### Shared Resources
- pidToSession Map
- sessions Map

## Change Risks
- Increasing check interval delays dead session detection
- False positives (kill(pid,0) fails for permission reasons) can prematurely end sessions
- findClaudeProcess fallback chain is fragile -- changes can cause wrong PID matches
