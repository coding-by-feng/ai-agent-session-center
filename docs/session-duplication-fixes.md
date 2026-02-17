# Session Card Duplication Fixes

> Comprehensive analysis of all bugs that caused duplicate session cards and the fixes applied.

## Problem Statement

Clicking **Resume/Reconnect** on a session card — or restarting the server and refreshing the browser — would create duplicate session cards pointing to the same SSH terminal. In the worst case, a single resume click produced **two extra cards**, resulting in three cards for one logical session.

---

## Root Causes Overview

| # | Root Cause | Trigger | Impact |
|---|-----------|---------|--------|
| 1 | `AGENT_MANAGER_TERMINAL_ID` not propagated over SSH | Any remote SSH session | Priority 1 matching fails; falls through to weaker heuristics |
| 2 | `projectPath` resolves `~` to local homedir for remote sessions | Remote SSH resume | Priority 0 path matching fails (local vs remote path) |
| 3 | Stale `pendingResume`/`pendingLinks` when `--resume` reuses same session_id | `claude --resume` with unchanged ID | Dangling entries cause future sessions to mis-match |
| 4 | `createTerminal()` always registers `pendingLinks` — even for resume | Resume with dead terminal | Another Claude session in same directory steals terminal via Priority 2 |
| 5 | Close button race with `session_removed` broadcast | Closing a card, then server broadcast | IndexedDB record re-created after deletion |
| 6 | Server Map key diverges from `session.sessionId` after re-key | Resume with new session_id | Snapshot sends both old key and new key → two cards |
| 7 | `pendingResume` not persisted across Ctrl+C restart | Stop server, restart, refresh | Resume data lost; hooks create new display-only card |

---

## Fix 1: Export `AGENT_MANAGER_TERMINAL_ID` Over SSH

**File:** `server/sshManager.js`

**Problem:** The terminal ID environment variable is set in the local PTY's `env` object, but SSH doesn't forward arbitrary env vars to the remote shell. Remote hooks never include `agent_terminal_id`, so Priority 1 matching (`tryMatchByTerminalId`) always fails.

**Fix:** Export the variable explicitly in the remote shell command — both for direct launch and tmux launch:

```javascript
// Direct launch (sshManager.js)
if (!local) {
  launchCmd += `export AGENT_MANAGER_TERMINAL_ID='${terminalId}'`;
}

// Tmux launch (sshManager.js)
if (!local) {
  tmuxSendCmd += `export AGENT_MANAGER_TERMINAL_ID='${terminalId}' && `;
}
```

**Also applied to resume prefix** in `server/apiRouter.js`:

```javascript
if (isRemote) {
  prefix += `export AGENT_MANAGER_TERMINAL_ID='${newTerminalId}' && `;
  if (cfg.workingDir) prefix += `cd '${cfg.workingDir}' && `;
}
```

---

## Fix 2: Update SSH `projectPath` From Hook's Actual CWD

**File:** `server/sessionStore.js` — `handleEvent()` SessionStart handler

**Problem:** When `createTerminalSession()` is called for a remote SSH session, it resolves `~` to the **local** homedir (e.g., `/Users/kason`). But the hook reports the **remote** cwd (e.g., `/home/user/project`). This mismatch causes Priority 0 path-based matching to fail on resume.

**Fix:** On `SessionStart`, update `projectPath` from the hook's cwd — but **only for SSH sessions** to avoid overwriting source-derived project names on display-only sessions (VS Code, Terminal, iTerm, etc.):

```javascript
if (cwd && cwd !== session.projectPath && session.source === 'ssh') {
  const oldPath = session.projectPath;
  session.projectPath = cwd;
  session.projectName = cwd.split('/').filter(Boolean).pop() || session.projectName;
  // source is NEVER overwritten
}
```

**Key constraint:** User explicitly required: *"don't lose the session card source, like VS Code, Terminal, etc."* — so the update is scoped to `session.source === 'ssh'` only.

---

## Fix 3: Clean Stale `pendingResume`/`pendingLinks` on Direct ID Match

**File:** `server/sessionMatcher.js`

**Problem:** When `claude --resume <id>` reuses the **same** session_id, the session is found by direct `Map.get(session_id)`. But `reconnectSessionTerminal()` / `createTerminal()` already registered `pendingResume` and `pendingLinks` entries. These are never consumed because the matcher returns early on direct match. Dangling entries then incorrectly match future, unrelated hooks.

**Fix:** Clean up stale entries when a session is found by direct ID:

```javascript
if (session) {
  if (hook_event_name === 'SessionStart' && session.terminalId) {
    if (pendingResume.has(session.terminalId)) {
      pendingResume.delete(session.terminalId);
    }
    consumePendingLink(session.projectPath);
  }
  return session;
}
```

Also consume `pendingLinks` after a successful Priority 0 resume match:

```javascript
// After Priority 0 match succeeds
if (session && session.projectPath) {
  consumePendingLink(session.projectPath);
}
```

---

## Fix 4: Consume `pendingLinks` Immediately After Resume Terminal Creation

**File:** `server/apiRouter.js` — resume endpoint

**Problem:** This was the **primary root cause** of the "two extra cards on resume" bug. The flow:

1. User clicks Resume → API calls `createTerminal()` → registers `pendingLinks.set(workDir, { terminalId })`
2. The **current conversation's Claude session** (running in the same working directory) fires a hook
3. Hook arrives → Priority 2 (`tryLinkByWorkDir`) matches the pendingLink → **steals the terminal** → creates a duplicate card
4. The actual resume Claude starts → `pendingResume` is consumed → but the terminal is already stolen → falls through all priorities → creates **another** display-only card

**Fix:** Immediately consume the pendingLink after `createTerminal()`, since the resume flow uses `pendingResume` (not `pendingLinks`) for matching:

```javascript
const newTerminalId = await createTerminal(newConfig, null);

// Immediately consume the pendingLink that createTerminal registered.
// The resume flow uses pendingResume (not pendingLinks) for session matching.
// If we leave the pendingLink alive, ANY other Claude session in the same
// working directory could match it via Priority 2 (tryLinkByWorkDir),
// stealing the terminal and creating a duplicate card.
consumePendingLink(newConfig.workingDir || session.projectPath || '');

const result = reconnectSessionTerminal(sessionId, newTerminalId);
```

---

## Fix 5: Close Button IndexedDB Race Condition

**File:** `public/js/sessionCard.js`

**Problem:** The close button handler did `get → put (mark as ended)` on IndexedDB. But the server also broadcasts `session_removed`, and the broadcast handler calls `del('sessions', sid)`. Race condition:

1. Close button fires → `get()` starts
2. `session_removed` broadcast arrives → `del()` completes
3. Close button's `get()` resolves → `put()` **re-creates** the deleted record

On next refresh, IndexedDB has the "ghost" record → duplicate card.

**Fix:** Use `del()` directly instead of `get → put`:

```javascript
// Delete from IndexedDB immediately — don't race with the server's
// session_removed broadcast which also calls del('sessions', sid).
db.del('sessions', sid).catch(() => {});
```

---

## Fix 6: Snapshot Deduplication (Map Key/SessionId Divergence)

**File:** `public/js/app.js` — `onSnapshotCb`

**Problem:** After `reKeyResumedSession()`, the server's `sessions` Map may briefly contain entries where the Map key differs from `session.sessionId` (e.g., old key still lingering). The snapshot sends both, and the browser creates two cards for the same logical session.

**Fix:** Deduplicate by `sessionId` value, keeping only the most recent entry:

```javascript
const deduped = new Map();
for (const [id, session] of Object.entries(sessions)) {
  const sid = session.sessionId || id;
  const existing = deduped.get(sid);
  if (!existing || (session.lastActivityAt || 0) > (existing.lastActivityAt || 0)) {
    deduped.set(sid, session);
  }
}
```

Also handle `replacesId` in `onSessionUpdateCb` to clean up old cards and migrate IndexedDB child records:

```javascript
if (session.replacesId) {
  delete allSessions[session.replacesId];
  removeCard(session.replacesId);
  migrateSessionId(session.replacesId, session.sessionId);
  del('sessions', session.replacesId);
}
```

---

## Fix 7: Persist `pendingResume` Across Server Restart

**File:** `server/sessionStore.js` — `saveSnapshot()` / `loadSnapshot()`

**Problem:** `pendingResume` is an in-memory Map. When the server is stopped (Ctrl+C) and restarted, all pending resume data is lost. If a session was in `connecting` status when the server stopped, the next hook from Claude has no `pendingResume` entry to match against → creates a new display-only card.

**Fix:** Include `pendingResume` in the snapshot that's persisted to SQLite:

```javascript
// saveSnapshot()
pendingResume: Object.fromEntries(pendingResume)

// loadSnapshot()
if (snapshot.pendingResume) {
  for (const [k, v] of Object.entries(snapshot.pendingResume)) {
    pendingResume.set(k, v);
  }
}
```

---

## Session Matching Priority System

For context, here's the 5-priority fallback system that these fixes protect:

| Priority | Strategy | Reliability |
|----------|----------|-------------|
| 0 | `pendingResume` + terminal ID / workDir | High — explicit resume action |
| 1 | `AGENT_MANAGER_TERMINAL_ID` env var | High — direct match (Fix 1 enables this for SSH) |
| 2 | `tryLinkByWorkDir` (pendingLinks) | Medium — ambiguous if multiple sessions in same dir |
| 3 | Path scan (connecting sessions) | Medium — ambiguous if multiple connecting |
| 4 | PID parent check | Low — unreliable across shells |

---

## How the Fixes Work Together

```
User clicks Resume
        │
        ▼
  apiRouter.js resume endpoint
  ├── createTerminal() → registers pendingLinks
  ├── consumePendingLink() ← FIX 4: immediately remove
  ├── reconnectSessionTerminal() → registers pendingResume
  │   └── pendingResume persisted to snapshot ← FIX 7
  └── writeWhenReady(AGENT_MANAGER_TERMINAL_ID + resumeCmd) ← FIX 1
        │
        ▼
  Claude starts, sends SessionStart hook
        │
        ▼
  sessionMatcher.js
  ├── Direct ID match? → clean stale entries ← FIX 3
  ├── Priority 0: pendingResume match → consume pendingLinks ← FIX 3
  ├── Priority 1: AGENT_MANAGER_TERMINAL_ID ← FIX 1 (now works over SSH)
  └── Priority 2: tryLinkByWorkDir → no stale link to steal ← FIX 4
        │
        ▼
  sessionStore.js handleEvent (SessionStart)
  ├── Update projectPath from hook cwd (SSH only) ← FIX 2
  └── reKeyResumedSession if new session_id
        │
        ▼
  Browser receives session_update
  ├── replacesId → remove old card, migrate IndexedDB ← FIX 6
  └── Snapshot deduplication on refresh ← FIX 6
```

---

## Files Modified

| File | Fixes Applied |
|------|--------------|
| `server/sshManager.js` | Fix 1 (env var export), Fix 4 (`consumePendingLink` function) |
| `server/apiRouter.js` | Fix 1 (resume prefix), Fix 4 (consume after createTerminal) |
| `server/sessionStore.js` | Fix 2 (SSH projectPath), Fix 7 (pendingResume persistence) |
| `server/sessionMatcher.js` | Fix 3 (stale cleanup on direct match + Priority 0 match) |
| `public/js/app.js` | Fix 6 (snapshot dedup, replacesId handling) |
| `public/js/sessionCard.js` | Fix 5 (close button IndexedDB race) |
