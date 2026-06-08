# Session Matcher (8-Priority System)

## Function
Links incoming hook events (with unknown session IDs) to existing terminal sessions using an 8-priority cascade of matching strategies.

## Purpose
Hooks fire from CLI processes that don't know about dashboard terminals. The matcher bridges this gap so events appear on the correct session card.

## Source Files
| File | Role |
|------|------|
| `server/sessionMatcher.ts` (~25KB, 535 lines) | 8-priority matching engine + fork routing + source detection |

## Implementation

### Fork Routing (pre-step, before any priority)
Before PID caching and the priority cascade, `matchSession()` detects `claude --resume '<originId>' --fork-session`. A fork fires ALL hooks (including `SessionEnd` and PID updates) with `session_id == originId`. When the hook also carries `agent_terminal_id`, the matcher looks up that terminal key; if the candidate has `isFork === true` and owns the terminal (`terminalId` or `lastTerminalId` matches), the event is redirected to the fork session. This runs *before* PID caching so the fork's PID does not get mapped to the origin (which would otherwise let `processMonitor` end the origin when the fork dies).

### PID Caching
After fork routing, the matcher caches `claude_pid → session.sessionId` in `pidToSession` (keyed on the resolved `session.sessionId`, not the raw hook `session_id`, so fork redirects map the PID to the fork). On `SessionStart` for a session found by direct Map lookup, stale `pendingResume` and `pendingLinks` entries for that terminal/path are cleaned up to prevent future mis-matches.

### Priority Cascade

| Priority | Strategy | Risk |
|----------|----------|------|
| 0 | pendingResume + terminal ID (explicit user action) | Low |
| 0 fallback | pendingResume + workDir (single candidate only) | Medium |
| 0.5 | Snapshot-restored ended session by cwd/zombie SSH (post-restart linking) | Medium |
| 1 | agent_terminal_id direct Map key (pre-created terminal) | Low |
| 1b | Scan by terminalId property (subsequent starts in same terminal) | Low |
| 1.5 | Cached PID match (same process, new session_id) | Medium |
| 2 | tryLinkByWorkDir via pendingLinks Map (SSH terminal) | Medium |
| 3 | Path scan of CONNECTING sessions (picks newest if >1) | Medium |
| 4 | PID parent check via pgrep -P (unreliable across shells) | High |

### SSH-Only Mode
- Unmatched events silently dropped (no display-only cards)

### Session Source Detection
- `detectHookSource()` maps enriched hook env fields (`vscode_pid`, `term_program`, `is_ghostty`, `wezterm_pane`, `tmux`) to one of 11 labels: `vscode`, `jetbrains`, `iterm`, `warp`, `kitty`, `ghostty`, `alacritty`, `wezterm`, `hyper`, `terminal`, `tmux`. If `term_program` is set but unrecognized, the raw lowercased `term_program` string is returned; otherwise it defaults to `terminal`.
- The `ssh` source is NOT produced here — it is assigned in Priority 2 via `createDefaultSession(..., 'ssh', ...)` when a workDir link resolves to an SSH terminal.

### Session Re-keying
- `reKeyResumedSession()` transfers a session from its old key to the new `session_id`, resets live state (status→`idle`, animation→`idle`, clears emote/endedAt/currentPrompt, zeroes `totalToolCalls`/`toolUsage`, empties `promptHistory`/`toolLog`/`responseLog`/`events`) and appends a `SessionResumed` event.
- Before resetting, the old session's data is archived into `previousSessions` (deduped against the last entry to avoid double-archiving when `resumeSession()` already archived), capped at 5 entries. `previousSessions` itself is intentionally preserved across re-keys to maintain the history chain.
- Clears the stale `cachedPid → session` mapping in `pidToSession` so the next hook re-caches under the new ID.
- Merge branch: if the target `newSessionId` already exists in the map (e.g. restored from a server snapshot on a second restart), the existing session's accumulated data is preserved and only the terminal-linkage fields (`terminalId`, `opsTerminalId`, `sshConfig`/`sshHost`/`sshCommand`) are transferred from the new terminal — avoiding overwrite with the fresh `term-*` session's empty state.
- Sets `replacesId` so the DB / IndexedDB mirror can migrate the old record to the new ID.

### Team & Counter Side-effects (new sessions)
- For newly created sessions, `matchSession()` copies enriched team fields when present and not already set: `agent_name`, `agent_type`, `team_name`, `agent_color`.
- Increments a per-project counter in `projectSessionCounters` keyed by `projectName`.

### CLI Source Preservation
- `createDefaultSession()` copies hook-provided `cli_source` into the session as `cliSource`. Codex hooks set this explicitly, which keeps robot/header badges and later UI gating from relying only on model-name or event-shape heuristics.

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — reads sessions Map, pendingResume Map, pidToSession Map, projectSessionCounters Map
- [Hook System](./hook-system.md) — receives enriched hook payloads with env vars for matching
- [Terminal/SSH](./terminal-ssh.md) — imports `tryLinkByWorkDir`, `getTerminalByPtyChild`, `consumePendingLink` from `sshManager.ts` (Priority 2/4 + pendingLink cleanup)

### Depended On By
- [Session Management](./session-management.md) — provides match results for event routing
- [Terminal/SSH](./terminal-ssh.md) — pendingLinks registered on terminal creation are consumed here
- [Team/Subagent](./team-subagent.md) — `matchSession()` seeds `agentName`/`agentType`/`teamName`/`agentColor` onto new sessions from enriched hook data

### Shared Resources
- sessions Map
- pendingResume Map
- pendingLinks Map
- pidToSession Map

## Change Risks
- Most dangerous module to change
- Wrong matches cause events to appear on wrong sessions
- Breaking Priority 1 blocks all SSH terminal integration
- Breaking Priority 0 blocks session resume
- Priority 2 misfire risk if two sessions share same workDir
- Fork routing must stay BEFORE PID caching — moving it after would map a fork's PID onto the origin session and let `processMonitor` end the origin when the fork dies
- The source-code module docstring still says "5-priority"; the real cascade has more steps (0, 0-fallback, 0.5, 1, 1b, 1.5, 2, 3, 4) — trust the table above, not the comment
