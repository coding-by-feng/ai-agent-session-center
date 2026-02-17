# Session Card ↔ SSH Terminal: Linkage Flow

This document describes how session cards in the dashboard are linked to SSH terminal sessions, including the matching logic, restart recovery, and resume flow.

---

## Phase 1: Terminal Creation

When the user clicks "New Terminal", two things happen simultaneously:

### 1a. PTY Process Spawned (`sshManager.js`)

```
createTerminal(config, wsClient)
  │
  ├── Generate terminalId: "term-{timestamp}-{random}"
  ├── Spawn shell via node-pty (local shell or `ssh -t user@host`)
  │     └── Inject env: AGENT_MANAGER_TERMINAL_ID = terminalId
  ├── Start shell ready detector (detectShellReady)
  │     └── Watches PTY output for prompt pattern ($ % # >)
  │     └── 100ms settle timer to avoid false-matching MOTD
  │     └── Fallback timeout: 5s (local) / 15s (remote)
  ├── Register pending link: pendingLinks[workDir] = { terminalId, host }
  ├── Stream PTY output → WebSocket client + ring buffer
  │
  └── Once shell ready detected:
        └── Write launch command (e.g., "cd /myproject && claude")
```

**Key point**: The launch command is NOT sent on a blind timer. `detectShellReady()` watches PTY output and waits until a shell prompt is visible before writing. This prevents commands from being lost if SSH hasn't finished connecting.

### 1b. Session Card Created (`sessionStore.js`)

```
createTerminalSession(terminalId, config)
  │
  ├── Session keyed by terminalId (not Claude session ID — doesn't exist yet)
  ├── status = "connecting"
  ├── source = "ssh"
  ├── terminalId = terminalId
  └── Card appears in dashboard immediately
```

**State at this point:**
```
sessions["term-abc"] = {
  sessionId: "term-abc",
  terminalId: "term-abc",
  status: "connecting",
  source: "ssh",
  projectPath: "/myproject"
}
```

---

## Phase 2: Hook Arrives — Session Matching

When Claude starts inside the terminal, it fires a `SessionStart` hook with its own `session_id` (a UUID like `a1b2c3d4-...`). The server must figure out which terminal card this hook belongs to.

`matchSession()` in `sessionMatcher.js` implements a **5-priority fallback system**:

### Priority 0: Pending Resume Match

**When**: A `pendingResume` entry exists (user clicked Resume before this hook arrived).

```
SessionStart hook arrives with session_id + agent_terminal_id + cwd
  │
  ├── Check pendingResume.has(agent_terminal_id)
  │     └── YES → reKeyResumedSession() → done
  │
  └── Path fallback: scan pendingResume for matching projectPath
        ├── Exactly 1 match → reKeyResumedSession() → done
        ├── 0 matches → fall through
        └── 2+ matches → AMBIGUOUS, skip (log warning)
```

After matching, calls `consumePendingLink(projectPath)` to prevent duplicate match at Priority 2.

### Priority 0.5: Auto-link to Snapshot-Restored Sessions

**When**: After server restart, sessions loaded from snapshot are marked `ended` with a `ServerRestart` event.

```
SessionStart hook arrives with cwd
  │
  └── Scan all sessions for:
        - status = "ended"
        - has ServerRestart event
        - projectPath matches cwd
        - ended less than 30 minutes ago
        │
        ├── Exactly 1 candidate → reKeyResumedSession() → done
        ├── 0 candidates → fall through
        └── 2+ candidates → AMBIGUOUS, skip
```

Also matches zombie SSH sessions (non-ended, source=ssh, no terminalId, stale >60s).

### Priority 1: `AGENT_MANAGER_TERMINAL_ID` (Primary Happy Path)

**When**: The hook's enriched data includes `agent_terminal_id` from the env var injected at terminal creation.

```
hookData.agent_terminal_id = "term-abc"
  │
  └── sessions.get("term-abc") exists?
        └── YES → Re-key: delete "term-abc", set sessionId = hook's session_id
```

**This is the most reliable matcher** — direct env var injection, no heuristics.

### Priority 2: Work Directory Link (`tryLinkByWorkDir`)

**When**: `pendingLinks` map has an entry for the hook's `cwd`.

```
pendingLinks["/myproject"] = { terminalId: "term-abc" }
  │
  └── Hook cwd = "/myproject" → match!
        └── Re-key session from "term-abc" to hook's session_id
```

**Risk**: Two terminals in the same directory will collide.

### Priority 3: Path Scan (Connecting Sessions)

**When**: Scans all `connecting` sessions for a matching `projectPath`.

```
Scan sessions where:
  - status = "connecting"
  - has terminalId
  - projectPath matches cwd
  │
  ├── Exactly 1 → re-key
  └── 0 or 2+ → fall through
```

### Priority 4: PID Parent Check

**When**: Checks if Claude's PID is a child of any known PTY process.

```
hookData.claude_pid → ps -o ppid= → compare with terminal PIDs
```

**Least reliable** — breaks across shell boundaries (zsh → bash → claude).

### Fallback: Display-Only Card

If nothing matches, a new card is created with the detected source (vscode, iterm, warp, etc.). No terminal is attached.

---

## Phase 3: Re-keying

When a match is found, the session Map key changes:

```
Before: sessions["term-abc"] = { sessionId: "term-abc", terminalId: "term-abc", status: "connecting" }
After:  sessions["a1b2c3d4"] = { sessionId: "a1b2c3d4", terminalId: "term-abc", status: "idle" }
```

The `terminalId` field stays the same (it's the PTY reference). Only the Map key and `sessionId` change.

---

## Phase 4: Server Shutdown (Ctrl+C)

```
Ctrl+C (SIGINT)
  │
  ├── gracefulShutdown()
  │     ├── stopPeriodicSave()
  │     ├── stopMqReader()
  │     ├── saveSnapshot()  ← saves sessions, pidToSession, AND pendingResume
  │     ├── closeDb()
  │     └── server.close() → process.exit(0)
  │
  └── Snapshot contains:
        ├── sessions (with live status, cachedPid, terminalId)
        ├── projectSessionCounters
        ├── pidToSession
        ├── pendingResume  ← survives restart for Priority 0 disambiguation
        └── eventSeq
```

**Key point**: `saveSnapshot()` saves sessions AS-IS with their live status. It does NOT add `ServerRestart` events — that happens at load time.

---

## Phase 5: Server Restart — Snapshot Restoration

`loadSnapshot()` performs triage on each saved session:

### SSH Sessions

| State in snapshot | PID alive? | Action |
|---|---|---|
| Active + cachedPid | Yes | **Kill** (SIGTERM) — PTY is dead, Claude is orphaned. Mark `ended` + `ServerRestart` |
| Active + cachedPid | No | Mark `ended` + `ServerRestart` |
| Active + no cachedPid | — | Mark `ended` + `ServerRestart` (zombie cleanup) |
| Connecting + no cachedPid | — | Mark `ended` + `ServerRestart` (zombie cleanup) |
| Already ended + historical | — | Restore for history display |

**Post-restoration cleanup** (all SSH sessions):
- Clear `terminalId` → `null` (all PTYs are dead after restart)
- Save old value as `lastTerminalId` (needed for Resume)

### Non-SSH Sessions (VS Code, iTerm, etc.)

| State in snapshot | PID alive? | Action |
|---|---|---|
| Active + cachedPid | Yes | Restore as-is (external terminal survived) |
| Active + cachedPid | No | Mark `ended` + `ServerRestart` |
| Active + no cachedPid | — | Restore as-is, processMonitor will check later |
| Already ended | — | **Not restored** (silently dropped) |

### pendingResume Restoration

```
For each entry in snapshot.pendingResume:
  │
  ├── Referenced session still exists in sessions Map?
  │     ├── YES → Restore with refreshed timestamp (reset 2-min cleanup window)
  │     └── NO → Skip (session was cleaned up)
  │
  └── Terminal ID is stale (PTY dead), but Priority 0's path-based
      fallback only needs oldSessionId + projectPath to match
```

---

## Phase 6: Resume Flow

### Case A: Terminal Still Alive

Rare after restart, but possible if the user resumes before the terminal dies.

```
User clicks Resume
  │
  ├── resumeSession(sessionId)
  │     ├── Archive previous session data into previousSessions[]
  │     ├── pendingResume.set(lastTerminalId, { oldSessionId })
  │     ├── session.terminalId = lastTerminalId
  │     └── session.status = "connecting"
  │
  └── writeToTerminal(terminalId, "claude --resume <id> || claude --continue\r")
```

### Case B: Terminal Dead — Create New One (Normal Post-Restart Path)

```
User clicks Resume
  │
  ├── POST /api/sessions/:id/resume
  │
  ├── Terminal exists? NO → create new terminal
  │     ├── createTerminal({ command: '' })  ← skipAutoLaunch
  │     │     ├── Spawn shell/SSH
  │     │     ├── detectShellReady() → shellReady promise
  │     │     └── Register pendingLinks[workDir]
  │     │
  │     ├── reconnectSessionTerminal(sessionId, newTerminalId)
  │     │     ├── Archive previous session data
  │     │     ├── pendingResume.set(newTerminalId, { oldSessionId })
  │     │     ├── session.terminalId = newTerminalId
  │     │     └── session.status = "connecting"
  │     │
  │     └── writeWhenReady(newTerminalId, "claude --resume <id> || ...\r")
  │           └── Awaits shellReady, then writes command
  │
  └── When Claude starts → SessionStart hook fires
        │
        └── matchSession() — Priority 0 matches:
              ├── pendingResume.has(agent_terminal_id) → re-key
              └── or path fallback → re-key
```

### Resume After Restart (Full Sequence)

```
                        ┌──────────────────┐
                        │  Server Running   │
                        │  Session A: idle  │
                        │  Session B: idle  │
                        │  (both in /proj)  │
                        └────────┬─────────┘
                                 │
                           Ctrl+C (SIGINT)
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │  saveSnapshot()          │
                    │  A: status=idle, pid=123 │
                    │  B: status=idle, pid=456 │
                    │  pendingResume: {}       │
                    └────────────┬────────────┘
                                 │
                           Server restarts
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │  loadSnapshot()          │
                    │  A: pid 123 dead → ended │
                    │     + ServerRestart      │
                    │  B: pid 456 dead → ended │
                    │     + ServerRestart      │
                    └────────────┬────────────┘
                                 │
                    User clicks Resume on A
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │  reconnectSessionTerminal│
                    │  pendingResume[newTerm]   │
                    │    = { oldSessionId: A }  │
                    │  A: status = connecting   │
                    └────────────┬────────────┘
                                 │
                    writeWhenReady → waits for shell prompt
                                 │
                    Shell ready → "claude --resume A || claude --continue"
                                 │
                    Claude starts → SessionStart hook
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │  matchSession()          │
                    │  Priority 0: pendingResume│
                    │    has newTerm → match A! │
                    │  Re-key: A → new Claude  │
                    │  session_id              │
                    └─────────────────────────┘
```

**Without pendingResume**: Priority 0.5 would see TWO ended sessions with `ServerRestart` in `/proj` → ambiguous → new card created instead of linking to A.

**With pendingResume**: Priority 0 fires first and unambiguously matches A because `pendingResume` explicitly records which session was being resumed.

---

## Shell Ready Detection (`detectShellReady`)

Instead of a blind `setTimeout(500ms)`, commands are sent only when the shell prompt is visible.

```
PTY spawned
  │
  ├── onData listener: accumulates output in buffer
  │     └── On each chunk: reset 100ms settle timer
  │           └── After 100ms silence: check last line
  │                 └── Strip ANSI escapes
  │                 └── Match /[#$%>]\s*$/ on last non-empty line
  │                 └── If match → resolve(true) → command is sent
  │
  ├── onExit listener: resolve(false) if PTY dies before prompt
  │
  └── Fallback timeout: 5s (local) / 15s (remote)
        └── resolve(false) → command sent anyway with warning log
```

| Scenario | Before (blind delay) | After (prompt detection) |
|---|---|---|
| Local shell (fast) | 100ms blind wait | ~200ms (prompt + 100ms settle) |
| Remote SSH (fast network) | 500ms blind wait | ~600ms (SSH + prompt + settle) |
| Remote SSH (slow network) | **Command lost** | Waits up to 15s, then fallback |
| SSH password prompt | Sends command as password | 15s timeout, then fallback + warn |
| SSH connection failure | Command to dead PTY | onExit fires, command skipped |
| Resume (new terminal) | 600ms blind wait | Waits for prompt, then sends |

---

## Data Structures

### Server-Side Maps

| Map | Key | Value | Persisted in snapshot? |
|---|---|---|---|
| `sessions` | sessionId (or terminalId before re-key) | Session object | Yes |
| `pidToSession` | Claude PID (number) | sessionId | Yes |
| `pendingResume` | terminalId | `{ oldSessionId, timestamp }` | Yes |
| `pendingLinks` | workDir path | `{ terminalId, host, createdAt }` | No (recreated on terminal creation) |
| `terminals` | terminalId | `{ pty, sessionId, config, wsClient, shellReady, ... }` | No (PTYs die with server) |

### Session Object Key Fields for Linkage

| Field | Description | Set by |
|---|---|---|
| `sessionId` | Map key. Initially = terminalId, re-keyed to Claude's session_id | createTerminalSession → matchSession |
| `terminalId` | Reference to live PTY. Null after disconnect/restart | createTerminalSession → cleared on end/restart |
| `lastTerminalId` | Previous terminalId, preserved for resume | SessionEnd handler / loadSnapshot |
| `cachedPid` | Claude's process ID | Hook enrichment |
| `source` | `"ssh"` / `"vscode"` / `"iterm"` / etc. | createTerminalSession / detectHookSource |
| `replacesId` | One-time flag: the old sessionId before re-key | reKeyResumedSession (consumed after broadcast) |
| `sshConfig` | SSH connection params for reconnect | createTerminalSession |
| `previousSessions` | Array of archived data from prior incarnations | resumeSession / reconnectSessionTerminal |

---

## Known Limitations

1. **Two sessions, same directory, no pendingResume**: Priority 0.5 and Priority 3 skip ambiguous matches. A new card is created.

2. **`pendingLinks` not persisted**: After restart, Priority 2 (`tryLinkByWorkDir`) can never match for pre-existing terminals. This is fine because all terminals are dead anyway — Priority 1 (`agent_terminal_id`) handles fresh terminals.

3. **Shell prompt detection heuristic**: Unusual prompts that don't end with `$ % # >` won't be detected. The 5s/15s fallback timeout ensures commands are eventually sent.

4. **`autoIdleManager` cleanup**: Restored `pendingResume` entries get 2 minutes before cleanup. If the user doesn't trigger a resume within that window, the entries are garbage collected.
