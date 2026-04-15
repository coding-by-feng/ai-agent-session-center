# Session Matcher (8-Priority System)

## Function
Links incoming hook events (with unknown session IDs) to existing terminal sessions using an 8-priority cascade of matching strategies.

## Purpose
Hooks fire from CLI processes that don't know about dashboard terminals. The matcher bridges this gap so events appear on the correct session card.

## Source Files
| File | Role |
|------|------|
| `server/sessionMatcher.ts` (~23KB) | 8-priority matching engine |

## Implementation

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
- Maps env vars (TERM_PROGRAM, VSCODE_PID, etc.) to source labels (13 defined types: ssh, vscode, jetbrains, iterm, warp, kitty, ghostty, alacritty, wezterm, hyper, terminal, tmux, unknown; plus raw TERM_PROGRAM fallback)

### Session Re-keying
- reKeyResumedSession() transfers data from old key to new session_id
- Sets replacesId for DB migration

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — reads sessions Map, pendingResume Map, pendingLinks Map
- [Hook System](./hook-system.md) — receives hook payloads with env vars for matching

### Depended On By
- [Session Management](./session-management.md) — provides match results for event routing
- [Terminal/SSH](./terminal-ssh.md) — pendingLinks registered on terminal creation

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
