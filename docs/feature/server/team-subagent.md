# Team & Subagent Tracking

## Function
Tracks parent-child relationships between AI agent sessions (teams) and links subagents to their parent sessions.

## Purpose
When Claude spawns subagents via the Task tool, users need to see the relationship in the dashboard (connection lines, team grouping).

## Source Files
| File | Role |
|------|------|
| `server/teamManager.ts` (~10KB) | Team creation, member linking, cleanup, team-config reader |
| `src/types/team.ts` | Shared type definitions: `Team`, `TeamSerialized`, `PendingSubagent`, `TeamMemberConfig`, `TeamConfig`, `TeamLinkResult` |

## Implementation

### Type Definitions (`src/types/team.ts`)
- `Team` — internal object stored in the `teams` Map. Uses a `Set<string>` for `childSessionIds`. Fields: `teamId`, `parentSessionId`, `childSessionIds`, `teamName` (`string | null`), `createdAt`.
- `TeamSerialized` — wire/JSON form: identical to `Team` but `childSessionIds` is a `string[]`. Produced by `serializeTeam()` for WebSocket broadcast.
- `PendingSubagent` — auto-detection entry: `parentSessionId`, `parentCwd`, `agentType`, `agentId` (`string | null`), `timestamp`.
- `TeamMemberConfig` — per-member fields read from team config: `tmuxPaneId?`, `backendType?`, `color?`.
- `TeamConfig` — `{ members?: Record<string, TeamMemberConfig> }`, keyed by agent name.
- `TeamLinkResult` — return shape of the link functions: `{ teamId, team: TeamSerialized }`.

### Direct Linking (Priority 0)
- Subagent `SessionStart` carrying `parent_session_id` (sourced from the `CLAUDE_CODE_PARENT_SESSION_ID` env var via the hook) → `linkByParentSessionId()` links the child directly to the parent. This is the preferred mechanism (no path guessing).
- `linkByParentSessionId()` also accepts `agentType`, `agentName`, and `teamName` (from hook fields `agent_type` / `agent_name` / `team_name`):
  - If `teamName` is provided it overrides the auto-derived team name.
  - `agentName` is stored on the child session (`childSession.agentName`).
  - When a team name is known, it reads the team config and copies per-member metadata onto the child session: `tmuxPaneId`, `backendType`, and `color` → `childSession.agentColor`.
- Bails out (returns `null`) if either id is empty, ids are equal, or the parent session is not found.

### Auto-Detection Fallback (Path-Based)
- `SubagentStart` on the parent → `addPendingSubagent()` records `{ parentSessionId, parentCwd, agentType, agentId, timestamp }`.
- A new `SessionStart` (when no `parent_session_id` is present) → `findPendingSubagentMatch()` compares the child cwd against pending parent cwds; a match (exact, or one path is a prefix of the other with a `/` boundary) consumes the entry and links the child via `linkSessionToTeam()`.
- Stale-entry pruning: `findPendingSubagentMatch()` drops entries older than 10s (10000ms); `addPendingSubagent()` drops entries older than 30s (30000ms).

### Team Object
- `teamId`: `team-{parentSessionId}`
- `parentSessionId`
- `childSessionIds`: `Set<string>` (internal) / `string[]` (serialized)
- `teamName`: defaults to `"{projectName} Team"` from the parent session; may be overridden by the hook's `team_name`
- `createdAt`
- On link, the parent gets `teamRole = 'leader'`, children get `teamRole = 'member'` and the linked `agentType`.

### Team Config
- `~/.claude/teams/{teamName}/config.json` with `members` keyed by agent name; each member may carry `tmuxPaneId`, `backendType`, `color`.
- `readTeamConfig(teamName)` sanitizes the name (only `a-zA-Z0-9_-. ` retained) for path-traversal prevention, then reads/parses the file; returns `null` if missing or invalid.
- `getTeamConfigPath(teamName)` returns the sanitized config path (currently an exported helper with no internal callers).

### Cleanup
- Member end → `handleTeamMemberEnd()` removes the session from `childSessionIds` and `sessionToTeam`.
- Parent end + all children ended → team deleted after a 15s (15000ms) `setTimeout`. The timer handle is tracked in `cleanupTimers` (issue #42).
- Cleanup timer is cancelled inside `linkSessionToTeam()` if a new child joins before the delay expires.

### Accessors & Serialization
- `serializeTeam()` converts the `childSessionIds` Set → array for broadcast.
- Exports: `getTeam(teamId)`, `getAllTeams()`, `getTeamForSession(sessionId)`, `getTeamIdForSession(sessionId)`.
- `getMemberTmuxPaneId(teamId, sessionId, sessions)` — validates membership and returns the session's stored `tmuxPaneId` (currently an exported helper with no internal callers).

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — `sessionStore.ts` invokes the link/cleanup functions and reads/writes session `teamId`, `teamRole`, `agentType`, `agentName`, `agentColor`, `tmuxPaneId`, `backendType` fields.
- [Hook System](./hook-system.md) — driven by `SubagentStart` / `SessionStart` / `SessionEnd` events. The hook (`hooks/dashboard-hook.sh`) forwards env vars `CLAUDE_CODE_PARENT_SESSION_ID`, `CLAUDE_CODE_TEAM_NAME`, `CLAUDE_CODE_AGENT_NAME`, `CLAUDE_CODE_AGENT_TYPE`, `CLAUDE_CODE_AGENT_ID`, `CLAUDE_CODE_AGENT_COLOR` as JSON fields `parent_session_id` / `team_name` / `agent_name` / `agent_type` / `agent_id` / `agent_color`.

### Depended On By
- [WebSocket Manager](./websocket-manager.md) — when a session-update delta carries a `team`, `hookProcessor.ts` broadcasts a `team_update` (`WS_TYPES.TEAM_UPDATE`) message alongside the `session_update`.
- [API Endpoints](./api-endpoints.md) — `apiRouter.ts` imports `getTeam` and `readTeamConfig` for the team endpoints below.
- [3D Robot System](../3d/robot-system.md) — `SubagentConnections` renders connection beams between parent and child robots from team data.
- [Frontend State Management](../frontend/state-management.md) — team data stored alongside sessions in the session store.

### API Endpoints
- `GET /api/teams/:teamId/config` — 404 `Team not found` if `getTeam()` misses; 404 `Team has no name — cannot locate config` when `team.teamName` is null (only possible when the parent session was missing at team-creation time, since `linkSessionToTeam` sets the name only inside its `if (parentSession)` branch — an auto-created team otherwise always gets `"{projectName} Team"`); otherwise returns `{ teamName, config }` from `readTeamConfig()` (config `null` if no file).
- `POST /api/teams/:teamId/members/:sessionId/terminal` — validates the session is a team member, then attaches a terminal to its tmux pane (subject to `MAX_TERMINALS`).

### Shared Resources (module-level state in `teamManager.ts`)
- `teams` Map (`teamId` → `Team`)
- `sessionToTeam` Map (`sessionId` → `teamId`)
- `pendingSubagents` array
- `cleanupTimers` Map (`teamId` → timer handle)

## Change Risks
- Breaking auto-detection or direct linking means subagents appear as independent sessions.
- Changing team cleanup timing can leave stale teams or cause premature deletion.
- Config path-traversal sanitization (`readTeamConfig` / `getTeamConfigPath`) is security-critical — do not relax the allow-list regex.
- The `team_update` broadcast piggybacks on the throttled session-update path; removing the `delta.team` branch in `hookProcessor.ts` stops team updates reaching the frontend.
