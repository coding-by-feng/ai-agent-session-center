# Team & Subagent Tracking

## Function
Tracks parent-child relationships between AI agent sessions (teams) and links subagents to their parent sessions.

## Purpose
When Claude spawns subagents via the Task tool, users need to see the relationship in the dashboard (connection lines, team grouping).

## Source Files
| File | Role |
|------|------|
| `server/teamManager.ts` (~10KB) | Team creation, member linking, cleanup, config reader |

## Implementation

### Auto-Detection (Path-Based)
- SubagentStart on parent -> addPendingSubagent() records {parentSessionId, parentCwd, agentType, agentId, timestamp}
- New SessionStart within 10s with matching cwd (exact or parent/child path relationship) -> linked into team
- Stale entries pruned after 10s in findPendingSubagentMatch() and after 30s in addPendingSubagent()

### Direct Linking (Priority 0)
- CLAUDE_CODE_PARENT_SESSION_ID env var -> linkByParentSessionId() directly links child to parent (preferred mechanism)

### Team Object
- teamId: "team-{parentSessionId}"
- parentSessionId
- childSessionIds: Set
- teamName: "{projectName} Team"
- createdAt

### Team Config
- ~/.claude/teams/{teamName}/config.json with per-member tmuxPaneId, backendType, agentColor
- Team name sanitized (only a-zA-Z0-9_-. ) for path traversal prevention

### Cleanup
- Member end -> remove from childSessionIds
- Parent end + all children ended -> delete team after 15s delay
- Cleanup timer cancelled if a new child joins before the 15s delay expires

### Serialization
- childSessionIds Set -> array for WebSocket broadcast

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — reads/writes session teamId, teamRole fields
- [Hook System](./hook-system.md) — triggered by SubagentStart/SubagentStop events + CLAUDE_CODE_PARENT_SESSION_ID env var

### Depended On By
- [WebSocket Manager](./websocket-manager.md) — team_update broadcasts
- 3D scene (frontend) — SubagentConnections renders connection beams between parent/child
- Frontend state management — team data in session store

### Shared Resources
- teams Map
- sessionToTeam Map
- pendingSubagents list
- cleanupTimers Map

## Change Risks
- Breaking auto-detection means subagents appear as independent sessions
- Changing team cleanup timing can leave stale teams or premature deletion
- Config path traversal prevention is critical
