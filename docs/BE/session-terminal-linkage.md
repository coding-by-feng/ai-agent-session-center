# Session–Terminal Linkage

## Overview

Every session card in the dashboard is linked to exactly one PTY terminal (and optionally one ops terminal). Linkage is bidirectional:

- **Terminal side** (`sshManager.ts`): creates the PTY, injects `AGENT_MANAGER_TERMINAL_ID` into its env, registers a pending link by working directory.
- **Session side** (`sessionMatcher.ts` + `sessionStore.ts`): matches incoming hook events to existing sessions via an 8-priority fallback system, re-keys sessions when needed, and merges orphaned CONNECTING cards after restart.

The system runs in **SSH-only mode**: if no terminal match is found for a hook event, the session is silently dropped (`return null`). No display-only cards are ever created.

---

## Phase 1: Terminal Creation

There are two paths for terminal creation, depending on the runtime environment:

### Path A: Server-side (Browser / SSH)

When the user creates a session via the browser UI, `createTerminal()` in `sshManager.ts` runs:

1. Generates `terminalId = "term-{Date.now()}-{random6}"`.
2. Spawns the PTY with `AGENT_MANAGER_TERMINAL_ID=terminalId` in its environment (local) or injects via `export` command after connect (SSH).
3. Registers a **pending link** (unless `command === ''` — i.e., ops terminals are excluded):
   ```
   pendingLinks: workDir -> { terminalId, host, createdAt }
   ```
   Expires after 60 s (cleaned by `setInterval` every 30 s).
4. Detects shell ready via `detectShellReady()`: watches PTY output for a prompt matching `[#$%>]\s*$` after 50 ms of silence; times out at 2 s (local) or 10 s (SSH).

### Path B: Electron PTY Host (Desktop App)

When the user creates a session in the Electron desktop app, `createPty()` in `electron/ptyHost.ts` runs:

1. Generates `terminalId = "term-{Date.now()}-{random6}"`.
2. Spawns the PTY directly via `node-pty` in Electron's main process with `AGENT_MANAGER_TERMINAL_ID=terminalId` in its env.
3. Strips `CLAUDECODE` env var to prevent nested-session detection.
4. Relays output to the renderer via IPC (`pty:data`) instead of WebSocket.
5. Detects shell ready via `detectShellReady()`: same prompt regex, 50ms settle, 2s timeout.
6. **Registers with the server** via `POST /api/terminals/register`:
   - Creates a CONNECTING session card in `sessionStore.ts`
   - Registers a pending link for session matching (Priority 2)
   - This keeps the hook pipeline and WebSocket broadcast in sync

### Session Card Creation (Both Paths)

Regardless of the creation path, `createTerminalSession()` in `sessionStore.ts` immediately creates a **CONNECTING** session card so it appears in the dashboard before the first hook arrives:

```
status = CONNECTING
terminalId = <new terminal ID>
opsTerminalId = <ops terminal ID or null>
hadOpsTerminal = true/false
```

---

## Phase 2: Session Matching

`matchSession()` in `sessionMatcher.ts` is called for every incoming hook event. It returns the matched/created `Session` or `null` (SSH-only mode).

### Direct Lookup (no priority label)

```
sessions.get(session_id)
```

If the session already exists in the Map, return it immediately. On `SESSION_START`, also clean up any stale `pendingResume` and `pendingLink` entries for that terminal/path.

### Priority 0 — Pending Resume (explicit reconnect)

**Trigger**: `SESSION_START` only.

When the user clicks **Resume** in the UI, `reconnectSessionTerminal()` registers:
```
pendingResume: newTerminalId -> { oldSessionId, timestamp }
```

Priority 0 matches by `agent_terminal_id` first, then falls back to `projectPath` (only if exactly one candidate exists — ambiguous paths are skipped). On match, calls `reKeyResumedSession()`.

### Priority 0.5 — Snapshot-Restored Auto-Link

**Trigger**: `SESSION_START` + `cwd` present.

After a server restart, sessions are restored from snapshot. This priority re-keys a restored card when a new Claude process starts in the same directory. Three match categories (all require `projectPath` equality):

| Category | Condition |
|----------|-----------|
| ENDED + ServerRestart event | Ended within last 30 minutes |
| IDLE + ServerRestart event | `terminalId` is null (PID didn't survive) |
| Zombie SSH | `source=ssh`, not ENDED, no `terminalId`, stale >60 s |

**Tie-breaking**: if exactly one candidate → re-key. If multiple, prefer the single ENDED over any zombies. If still ambiguous → skip and create a new card.

### Priority 1 — Direct Terminal ID Match

```typescript
sessions.get(agent_terminal_id)
```

Handles the **first** hook from a fresh Claude start. The terminal's pre-created CONNECTING card is stored under key `terminalId`. Re-keys it to `session_id`, consumes pending link.

### Priority 1b — Terminal ID Property Scan

**Trigger**: `SESSION_START` only.

After the first re-key (Priority 1), the session moves from `map-key=T1` to `map-key=S1`, but `S1.terminalId` still equals `T1`. On subsequent starts (restart, `--resume`, crash recovery), this scan finds `S1` and re-keys it.

- Intentionally matches ENDED sessions (reactivating the same card).
- Skips CONNECTING sessions (handled by Priority 3).

### Priority 1.5 — Cached PID Match

**Trigger**: `SESSION_START` only.

When `claude --resume` creates a new `session_id` in the same process, the old PID is still cached:
```
pidToSession: pid -> oldSessionId
```
If `hookData.claude_pid` matches a cached PID, re-key the old session. Handles cases where the PTY died (server restart) but the Claude process survived.

### Priority 2 — Pending WorkDir Link

```typescript
tryLinkByWorkDir(cwd, session_id)   // consumes pendingLink
```

Matches a `pendingLink` by working directory. Three sub-cases:

1. Pre-created session stored under `map-key=terminalId` → re-key to `session_id`.
2. Existing session with `s.terminalId === linkedTerminalId` (resume case) → re-key.
3. No existing session → create new SSH session card (`source='ssh'`, inherits SSH config from any same-terminal or same-path session).

### Priority 3 — CONNECTING Path Scan

Scans all CONNECTING sessions by normalized `projectPath`. Requires `terminalId` to be set. If exactly one candidate → re-key. If multiple → pick the most recently created (avoids duplicate display cards).

### Priority 4 — PID Parent Check

```typescript
getTerminalByPtyChild(claude_pid)
```

Checks if Claude's PID is a child of a known PTY process. Unreliable across shells; last resort.

### SSH-Only Mode (no match)

```typescript
return null;  // caller discards the event
```

If all priorities fail, the hook event is dropped silently. No display-only cards are created.

---

## Session Matching Summary Table

| Priority | Strategy | Trigger | Risk |
|----------|----------|---------|------|
| Direct | `sessions.get(session_id)` | Any event | None — exact |
| 0 | `pendingResume` by terminalId or path | `SESSION_START` | Low — explicit user action |
| 0.5 | Snapshot-restored card auto-link | `SESSION_START` + cwd | Medium — ambiguous when multiple sessions share path |
| 1 | `sessions.get(agent_terminal_id)` | Any event | Low — direct key match |
| 1b | `s.terminalId === agent_terminal_id` scan | `SESSION_START` | Low — handles post-rekey restarts |
| 1.5 | `pidToSession.get(claude_pid)` | `SESSION_START` | Low — strong PID signal |
| 2 | `tryLinkByWorkDir(cwd)` | Any event | Medium — two sessions in same dir |
| 3 | CONNECTING path scan | Any event | Medium — picks newest on tie |
| 4 | PID parent check | Any event | High — unreliable across shells |
| — | SSH-only drop | — | — |

---

## Phase 3: reKeyResumedSession()

Called by priorities 0, 0.5, 1b, 1.5, and the workDir sub-cases in Priority 2. Transitions an existing session to a new `session_id`:

**Preserved fields**: `sshConfig`, `source`, `terminalId`, `lastTerminalId`, `opsTerminalId`, `hadOpsTerminal`, `pinned`, `muted`, `accentColor`, `label`, `previousSessions`

**Reset fields**: `status → idle`, `animationState → idle`, `promptHistory`, `toolLog`, `responseLog`, `toolUsage`, `totalToolCalls`, `currentPrompt`, `emote`, `startedAt`, `endedAt`, `isHistorical`

**History archival**: Before reset, the old session's data is pushed to `previousSessions[]` (max 5 entries, FIFO). Deduplication check: skips if the last entry already has the same `sessionId`.

**PID cleanup**: Removes `cachedPid` from `pidToSession` map; next hook will re-cache with the new session ID.

---

## Phase 4: CONNECTING Orphan Merge

Runs in `sessionStore.handleEvent()` after any re-key (`session.replacesId` is set).

After a server restart, the workspace auto-load creates a fresh CONNECTING session for a path while Priority 0.5 re-keys the old ended session. Without merging, both cards would persist.

The merge logic scans for any CONNECTING session with the same `projectPath` and a `terminalId` set:

```
If found exactly one orphan:
  session.terminalId = orphan.terminalId
  session.opsTerminalId = orphan.opsTerminalId (if set)
  session.sshConfig = orphan.sshConfig (if set)
  sessions.delete(orphanKey)
  broadcast SESSION_REMOVED for orphan
```

This is safe for Priority 1/2/3 re-keys because they consume the CONNECTING session during re-key itself — no orphan survives.

---

## Phase 5: Pending Link Lifecycle

| Event | Effect on pendingLinks |
|-------|----------------------|
| `createTerminal()` (non-ops) | Register `workDir → { terminalId, host, createdAt }` |
| Priority 2 match | `consumePendingLink(cwd)` — removes entry |
| Priority 0/1 match (SessionStart) | `consumePendingLink(session.projectPath)` — prevents duplicate Priority 2 match |
| 60 s elapsed | Auto-expire via `setInterval(30 s)` |
| Ops terminal created | No registration (`command === ''`) |

---

## Phase 6: Pending Resume Lifecycle

`pendingResume: Map<terminalId, { oldSessionId, timestamp }>`

| Event | Effect |
|-------|--------|
| User clicks Resume in UI | `reconnectSessionTerminal()` registers entry |
| `resumeSession()` API called | Registers entry before re-keying |
| Priority 0 matches by terminalId | Consumed (`pendingResume.delete(termId)`) |
| Priority 0 matches by path | Consumed |
| Direct session lookup (SessionStart) | Cleaned up if stale |
| 2 minutes elapsed | `startPendingResumeCleanup()` garbage-collects |
| Server restart | Entries **persisted** in snapshot and restored (terminal IDs are stale but path-based fallback still works) |

---

## Phase 7: Server Restart & Snapshot Restore

### Save

Snapshot written to:
- `APP_USER_DATA/snapshots/sessions.json` (Electron)
- `/tmp/claude-session-center/snapshots/sessions.json` (fallback)

Includes: all sessions, `pidToSession`, `pendingResume`, `projectSessionCounters`, MQ byte offset.

### Restore (`loadSnapshot()`)

For each session in the snapshot:

| Condition | Action |
|-----------|--------|
| SSH session (`terminalId` set) | Restore as `status=idle`, emit `ServerRestart` event |
| Non-SSH, PID alive | Restore as original status |
| Non-SSH, PID dead | Restore as `status=ended`, emit `ServerRestart` event |
| `isHistorical=true` | Restore as-is (already ended) |

`pendingResume` entries are restored only if the referenced `oldSessionId` still exists in the session Map.

Log line on completion:
```
Snapshot loaded: N sessions restored (preserved as idle), M already ended, P PIDs tracked, Q pendingResume entries
```

---

## Phase 8: Resume via UI

User clicks **Resume** on an ENDED session:

1. `POST /api/sessions/:id/resume` in `apiRouter.ts`
2. `createTerminal(config, null)` — spawns new PTY
3. `consumePendingLink(workDir)` — immediately removes pending link to prevent Priority 2 from stealing it
4. `reconnectSessionTerminal(sessionId, newTerminalId)`:
   - Archives current data to `previousSessions[]`
   - Updates `session.terminalId = newTerminalId`, `session.lastTerminalId = oldTerminalId`
   - Registers `pendingResume: newTerminalId → { oldSessionId }`
5. Once shell ready (`writeWhenReady`):
   - **Local**: `claude --resume <id>` or `claude --continue` (no args) or `startupCommand`
   - **SSH**: `export AGENT_MANAGER_TERMINAL_ID=<terminalId>; cd <workDir>; claude --resume <id>`
6. Claude sends `SESSION_START` hook with a new `session_id`
7. `matchSession()` Priority 0 re-keys the session

---

## Phase 9: Ops Terminal Linkage

An ops terminal is a secondary blank shell (no auto-launch command) for ad-hoc commands.

### Creation

Created alongside the main terminal when `enableOpsTerminal=true` in New Session modal:

```typescript
createTerminal({ ...config, command: '' }, null)   // blank shell
createTerminalSession(mainTerminalId, config, opsTerminalId)
// → session.opsTerminalId = opsTerminalId
// → session.hadOpsTerminal = true
```

### Reconnect

When the ops terminal exits, the user can reconnect:

```
POST /api/sessions/:id/reconnect-ops-terminal
```

`reconnectOpsTerminal(sessionId, newOpsId)`:
- `session.opsTerminalId = newOpsId`
- `session.hadOpsTerminal = true`

### After Restart

On server restart, `opsTerminalId` is null (PTY died). If the CONNECTING orphan created by workspace auto-load has an `opsTerminalId`, the CONNECTING orphan merge (Phase 4) transfers it to the re-keyed session.

---

## Phase 10: Hook Source Detection

`detectHookSource()` in `sessionMatcher.ts` classifies the originating terminal for display purposes:

| Signal | Detected Source |
|--------|----------------|
| `hookData.vscode_pid` or `term_program` contains `vscode`/`code` | `vscode` |
| `term_program` contains JetBrains product name | `jetbrains` |
| `term_program` contains `iterm` | `iterm` |
| `term_program` contains `warp` | `warp` |
| `term_program` contains `kitty` | `kitty` |
| `term_program` contains `ghostty` or `hookData.is_ghostty` | `ghostty` |
| `term_program` contains `alacritty` | `alacritty` |
| `term_program` contains `wezterm` or `hookData.wezterm_pane` | `wezterm` |
| `term_program` contains `hyper` | `hyper` |
| `term_program` = `apple_terminal` | `terminal` |
| `hookData.tmux` | `tmux` |
| Any other `term_program` value | `<raw value>` |
| Nothing | `terminal` |

Source is stored on the `Session.source` field and used for icon display in the UI.

---

## Data Flow Diagram

### Browser / SSH Path

```
User clicks "New Session" (browser)
        │
        ▼
createTerminal()           ← sshManager.ts
  ├─ spawn PTY (AGENT_MANAGER_TERMINAL_ID injected into env)
  ├─ pendingLinks.set(workDir, { terminalId })
  └─ detectShellReady() → 50ms settle + prompt regex
        │
        ▼
createTerminalSession()    ← sessionStore.ts
  └─ sessions.set(terminalId, { status: CONNECTING, terminalId })
        │
        ▼ (Claude starts, sends SessionStart hook)
        │
matchSession()             ← sessionMatcher.ts  (same for both paths)
  ├─ Direct lookup → return early
  ├─ Priority 0: pendingResume by terminalId or path
  ├─ Priority 0.5: snapshot-restored card auto-link
  ├─ Priority 1: sessions.get(agent_terminal_id)
  ├─ Priority 1b: s.terminalId === agent_terminal_id scan
  ├─ Priority 1.5: pidToSession.get(claude_pid)
  ├─ Priority 2: tryLinkByWorkDir(cwd)
  ├─ Priority 3: CONNECTING path scan (pick newest on tie)
  ├─ Priority 4: PID parent check
  └─ null → event dropped (SSH-only mode)
        │
        ▼ (if re-keyed: replacesId set)
handleEvent() orphan scan  ← sessionStore.ts
  └─ merge CONNECTING orphan at same path → transfer terminalId/opsTerminalId
        │
        ▼
broadcastAsync({ type: SESSION_UPDATE, session })
  └─ 20ms debounce per sessionId → WebSocket clients
```

### Electron PTY Host Path

```
User clicks "New Session" (desktop app)
        │
        ▼
window.electronAPI.createPty(config)
        │ IPC invoke 'pty:create'
        ▼
createPty()                ← electron/ptyHost.ts
  ├─ spawn PTY via node-pty (AGENT_MANAGER_TERMINAL_ID injected into env)
  ├─ subscribe onData → send 'pty:data' to renderer via IPC
  ├─ detectShellReady() → 50ms settle + prompt regex
  └─ POST /api/terminals/register → server
        │
        ▼
apiRouter.ts               ← server
  ├─ createTerminalSession() → sessions.set(terminalId, { status: CONNECTING })
  └─ registerPendingLink(workDir, terminalId)
        │
        ▼ (Claude starts, sends SessionStart hook via MQ)
        │
matchSession()             ← sessionMatcher.ts  (same 8-priority system)
        │
        ▼
broadcastAsync()           ← sessionStore.ts → WebSocket → browser/renderer
```
