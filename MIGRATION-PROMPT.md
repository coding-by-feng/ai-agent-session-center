# AI Agent Session Center — Full Stack Modernization (Agent Teams)

> **Usage**: Paste this entire prompt into Claude Code. It will create a team,
> spawn agents, create tasks with dependencies, and orchestrate the migration.

---

## Mission

Migrate the AI Agent Session Center from zero-build vanilla JS + Express to a
fully typed **TypeScript** codebase with **React 19 + Vite** frontend — while
preserving **100% of existing functionality**, the signature dark neon visual
identity, and every hard-won bugfix in the session-terminal linkage system.

---

## Current State

| Dimension       | Current                                                      |
|-----------------|--------------------------------------------------------------|
| Frontend        | Vanilla JS ES modules, zero build, ~7,100 LOC / 27 modules  |
| Backend         | Node 18 ESM + Express 5 + ws 8 + node-pty + better-sqlite3, ~8,300 LOC |
| Styling         | Pure CSS ~39K LOC, 9 themes, 20 character models, CSS-only animations |
| State (server)  | In-memory Map + SQLite + JSON snapshots                      |
| State (client)  | Plain objects + IndexedDB + localStorage                     |
| Tests           | Node built-in test runner, 8 server tests (~1,600 LOC), 0 frontend tests |
| Types           | JSDoc @ts-check + .d.ts files (no tsc build)                 |
| Build           | None (CDN script tags for xterm.js)                          |

---

## Target Stack

| Layer            | Technology              | Replaces                          |
|------------------|-------------------------|-----------------------------------|
| Build            | Vite 6                  | Zero build / import maps          |
| UI Framework     | React 19                | Vanilla DOM manipulation          |
| Language         | TypeScript 5.7 (strict) | JSDoc @ts-check                   |
| Routing          | React Router 7          | navController.js manual tabs      |
| Client State     | Zustand 5               | Plain objects + scattered state   |
| Server State     | TanStack Query v5       | Manual fetch                      |
| WebSocket        | Custom useWebSocket hook | wsClient.js                      |
| Drag & Drop      | @dnd-kit/core + sortable| Native Drag API                   |
| Terminal         | xterm.js 5 (React wrap) | terminalManager.js                |
| Charts           | Recharts                | Custom SVG chartUtils.js          |
| Forms            | React Hook Form + Zod   | Manual form handling              |
| CSS Strategy     | CSS Modules + keep existing CSS vars/animations/characters/themes | Global CSS |
| IndexedDB        | Dexie.js                | Raw IndexedDB browserDb.js        |
| Sound            | Custom useSound hook    | soundManager.js                   |
| Test (unit)      | Vitest + React Testing Library | Node built-in runner        |
| Test (e2e)       | Playwright              | None                              |
| Lint             | ESLint 9 flat config + typescript-eslint | None             |
| Format           | Prettier                | None                              |
| Backend validate | Zod schemas             | Manual regex                      |

---

## Team Structure

Create a team named `modernize` with these agents:

### 1. `lead` (you, the orchestrator)
- Creates all tasks with dependencies
- Spawns and assigns agents
- Reviews completed work, resolves conflicts
- Runs final integration verification

### 2. `infra` — Infrastructure & Tooling Agent
- **Type**: `general-purpose` | **Mode**: `bypassPermissions`
- **Owns**: Vite config, TypeScript configs, ESLint, Prettier, path aliases, package.json scripts, project structure scaffolding
- **Creates**: The skeleton that all other agents build on

### 3. `backend` — Backend TypeScript Migration Agent
- **Type**: `general-purpose` | **Mode**: `bypassPermissions`
- **Owns**: All `server/*.js` → `server/*.ts` migration, Zod validation schemas, server-side types
- **Constraint**: Must not change any API contract. Must preserve all 7 session deduplication fixes and the 5-priority matching logic exactly.
- **MUST READ** before starting: `server/sessionStore.js`, `server/sessionMatcher.js`, `server/sshManager.js`, `server/apiRouter.js` — these contain battle-tested linkage/dedup logic

### 4. `frontend-core` — Frontend Foundation Agent
- **Type**: `general-purpose` | **Mode**: `bypassPermissions`
- **Owns**: React app shell, routing, WebSocket provider, Zustand stores, auth gate, Dexie.js DB, shared hooks, shared UI components
- **MUST preserve**: `replacesId` handling in WS snapshot callback, IndexedDB session migration on re-key, snapshot deduplication logic

### 5. `frontend-features` — Frontend Features Agent
- **Type**: `general-purpose` | **Mode**: `bypassPermissions`
- **Owns**: Session cards, detail panel, terminal integration, character system, sound system, drag-and-drop, prompt queue, session groups, session controls, quick actions, keyboard shortcuts
- **MUST preserve**: Close button `del()` (not get→put) for IndexedDB race fix, resume button flow, terminal subscribe/reconnect

### 6. `frontend-views` — Frontend Views & Settings Agent
- **Type**: `general-purpose` | **Mode**: `bypassPermissions`
- **Owns**: History view, Timeline view, Analytics view, Queue view, Settings panel (all tabs), charts (Recharts migration)

### 7. `tester` — Testing Agent
- **Type**: `general-purpose` | **Mode**: `bypassPermissions`
- **Owns**: Vitest config, all unit tests, integration tests, Playwright e2e tests
- **Target**: 80%+ coverage on stores, hooks, utilities; e2e for critical flows
- **MUST include**: Dedicated test suite for session-terminal linkage (see Testing section)

### 8. `css-agent` — CSS Migration & Visual Parity Agent
- **Type**: `general-purpose` | **Mode**: `bypassPermissions`
- **Owns**: CSS Modules extraction, legacy dashboard.css decomposition, dead CSS removal
- **Constraint**: Must NOT alter CSS variables, animations, character styles, or theme files

---

## CRITICAL DOMAIN KNOWLEDGE: Session-Terminal Linkage

> This is the most complex and bug-prone part of the codebase. All agents touching
> backend or frontend session logic MUST understand this lifecycle end-to-end.

### Lifecycle Overview

```
Phase 1: User clicks "New Terminal"
  ├── sshManager.createTerminal()
  │   ├── Generate terminalId: "term-{timestamp}-{random}"
  │   ├── Spawn PTY (local shell or ssh -t user@host)
  │   ├── Inject env: AGENT_MANAGER_TERMINAL_ID = terminalId
  │   ├── For remote SSH: also export env var in shell command  ← FIX 1
  │   ├── detectShellReady() — waits for prompt pattern ($ % # >)
  │   │   └── 100ms settle timer, 5s/15s fallback timeout
  │   ├── Register pendingLinks[workDir] = { terminalId, host }
  │   └── Once shell ready → write launch command
  │
  ├── sessionStore.createTerminalSession(terminalId, config)
  │   ├── Session keyed by terminalId (Claude session_id doesn't exist yet)
  │   ├── status = "connecting", source = "ssh"
  │   └── Card appears in dashboard immediately
  │
Phase 2: Claude starts → SessionStart hook → sessionMatcher.matchSession()
  │
  │   5-PRIORITY MATCHING (in order, first match wins):
  │
  │   Priority 0: pendingResume match
  │   ├── Check pendingResume.has(agent_terminal_id)
  │   │   └── YES → reKeyResumedSession() + consumePendingLink()
  │   └── Path fallback: scan pendingResume for matching projectPath
  │       ├── Exactly 1 → re-key; 0 → fall through; 2+ → AMBIGUOUS skip
  │       └── consumePendingLink() after match  ← FIX 3
  │
  │   Priority 0.5: Auto-link snapshot-restored ended sessions
  │   ├── Scan for: status=ended + ServerRestart event + matching projectPath + <30min
  │   └── Also matches zombie SSH sessions (non-ended, source=ssh, no terminalId, stale >60s)
  │
  │   Priority 1: AGENT_MANAGER_TERMINAL_ID env var (primary happy path)
  │   └── hookData.agent_terminal_id → sessions.get(terminalId) → re-key
  │
  │   Priority 2: Work directory link (tryLinkByWorkDir)
  │   └── pendingLinks[hook.cwd] → match → re-key
  │       Risk: two terminals in same directory will collide
  │
  │   Priority 3: Path scan (connecting sessions)
  │   └── Scan all "connecting" sessions with matching projectPath
  │
  │   Priority 4: PID parent check
  │   └── ps -o ppid= — least reliable, breaks across shell boundaries
  │
  │   Fallback: Create display-only card with detected source
  │
Phase 3: Re-keying (when match found)
  │   Before: sessions["term-abc"] = { sessionId: "term-abc", terminalId: "term-abc" }
  │   After:  sessions["a1b2c3d4"] = { sessionId: "a1b2c3d4", terminalId: "term-abc" }
  │   └── terminalId stays the same, only Map key + sessionId change
  │   └── replacesId = old sessionId → broadcast to client → client removes old card
  │
Phase 4: Server shutdown (Ctrl+C)
  │   saveSnapshot() persists: sessions, pidToSession, pendingResume, eventSeq
  │
Phase 5: Server restart → loadSnapshot() triage
  │   SSH sessions: kill orphaned PIDs, mark ended + ServerRestart, clear terminalId
  │   Non-SSH: restore if PID alive, mark ended if PID dead
  │   Restore pendingResume entries (refresh timestamps for 2-min cleanup window)
  │   Repair Map key / sessionId mismatches (defensive dedup)
  │
Phase 6: Resume flow
  │   User clicks Resume →
  │   ├── Terminal alive? → resumeSession() → pendingResume.set()
  │   └── Terminal dead? → createTerminal() → consumePendingLink()  ← FIX 4
  │       → reconnectSessionTerminal() → pendingResume.set()
  │       → writeWhenReady("claude --resume <id> || claude --continue")
  │       → SessionStart hook → Priority 0 matches via pendingResume
```

### The 7 Session Deduplication Fixes

These fixes were hard-won through real-world debugging. Each one prevents a
specific class of duplicate session cards. **ALL MUST BE PRESERVED EXACTLY.**

#### Fix 1: Export `AGENT_MANAGER_TERMINAL_ID` Over SSH
**Files**: `sshManager.js`, `apiRouter.js`
**Bug**: SSH doesn't forward arbitrary env vars. Remote hooks never included
`agent_terminal_id`, so Priority 1 matching always failed for SSH sessions.
**Fix**: Explicitly `export AGENT_MANAGER_TERMINAL_ID='${terminalId}'` in the
remote shell command — for both direct launch and tmux launch, and in the
resume prefix command.

#### Fix 2: Update SSH `projectPath` From Hook's Actual CWD
**Files**: `sessionStore.js` (handleEvent SessionStart)
**Bug**: `createTerminalSession()` resolves `~` to local homedir for remote SSH.
But hooks report the remote CWD. Mismatch breaks Priority 0 path matching.
**Fix**: On SessionStart, update `projectPath` from hook CWD — but ONLY for
`session.source === 'ssh'`. Never overwrite source for VS Code/iTerm/etc.

#### Fix 3: Clean Stale `pendingResume`/`pendingLinks` on Direct ID Match
**Files**: `sessionMatcher.js`
**Bug**: When `claude --resume` reuses the SAME session_id, the session is
found by direct `Map.get()`. But `reconnectSessionTerminal()` already registered
`pendingResume` and `pendingLinks` entries that are never consumed. Dangling
entries then incorrectly match future unrelated hooks.
**Fix**: On direct ID match during SessionStart, clean up any stale
`pendingResume` and `pendingLinks` entries for that session's terminalId.
Also consume `pendingLinks` after successful Priority 0 match.

#### Fix 4: Consume `pendingLinks` Immediately After Resume Terminal Creation
**Files**: `apiRouter.js` (resume endpoint)
**Bug**: PRIMARY ROOT CAUSE of "two extra cards on resume". Flow:
1. Resume → `createTerminal()` → registers `pendingLinks[workDir]`
2. Current conversation's Claude (same workDir) fires hook
3. Priority 2 matches pendingLink → STEALS the terminal → duplicate card
4. Actual resume Claude starts → pendingResume consumed → but terminal stolen
   → falls through → creates ANOTHER display-only card
**Fix**: Call `consumePendingLink()` immediately after `createTerminal()` in the
resume endpoint. The resume flow uses `pendingResume` (not `pendingLinks`).

#### Fix 5: Close Button IndexedDB Race Condition
**Files**: `sessionCard.js`
**Bug**: Close button did `get → put (mark ended)` on IndexedDB. Server also
broadcasts `session_removed` → `del()`. Race condition: `del()` completes
between `get()` and `put()`, then `put()` re-creates the deleted record.
**Fix**: Use `del()` directly instead of `get → put`. One-liner:
`db.del('sessions', sid).catch(() => {})`

#### Fix 6: Snapshot Deduplication (Map Key/SessionId Divergence)
**Files**: `app.js` (onSnapshotCb)
**Bug**: After `reKeyResumedSession()`, the server Map may briefly have entries
where Map key differs from `session.sessionId`. Snapshot sends both → two cards.
**Fix**: Client-side dedup: group by `session.sessionId`, keep most recent
`lastActivityAt`. Also handle `replacesId` in `onSessionUpdateCb` to remove
old card + migrate IndexedDB child records:
```javascript
if (session.replacesId) {
  delete allSessions[session.replacesId];
  removeCard(session.replacesId);
  migrateSessionId(session.replacesId, session.sessionId);
  del('sessions', session.replacesId);
}
```

#### Fix 7: Persist `pendingResume` Across Server Restart
**Files**: `sessionStore.js` (saveSnapshot/loadSnapshot)
**Bug**: `pendingResume` was in-memory only. Server restart lost all pending
resume data → next hook creates new card instead of linking to resumed session.
**Fix**: Include `pendingResume` in snapshot. On load, restore entries with
refreshed timestamps (resets 2-min cleanup window). Only restore entries whose
referenced session still exists.

### Server-Side Maps for Linkage

| Map | Key | Value | In Snapshot? |
|-----|-----|-------|-------------|
| `sessions` | sessionId (or terminalId before re-key) | Session object | Yes |
| `pidToSession` | Claude PID (number) | sessionId | Yes |
| `pendingResume` | terminalId | `{ oldSessionId, timestamp }` | Yes |
| `pendingLinks` | workDir path | `{ terminalId, host, createdAt }` | No (recreated on terminal creation) |
| `terminals` | terminalId | `{ pty, sessionId, config, wsClient, shellReady, ... }` | No (PTYs die with server) |

### Session Fields Critical for Linkage

| Field | Description | Set By |
|-------|-------------|--------|
| `sessionId` | Map key. Initially = terminalId, re-keyed to Claude's session_id | createTerminalSession → matchSession |
| `terminalId` | Live PTY reference. Null after disconnect/restart | createTerminalSession → cleared on end/restart |
| `lastTerminalId` | Previous terminalId, preserved for resume | SessionEnd handler / loadSnapshot |
| `cachedPid` | Claude's PID from hook enrichment | Hook enrichment |
| `replacesId` | One-time flag: old sessionId before re-key (consumed after broadcast) | reKeyResumedSession |
| `sshConfig` | SSH connection params for reconnect/resume | createTerminalSession |
| `previousSessions` | Archived data from prior incarnations | resumeSession / reconnectSessionTerminal |
| `source` | `"ssh"` / `"vscode"` / `"iterm"` etc. — NEVER overwritten after creation | createTerminalSession / detectHookSource |
| `isHistorical` | True for ended SSH sessions — prevents re-display on snapshot | loadSnapshot cleanup |

---

## Task Graph (with dependencies)

```
PHASE 1 — Infrastructure (no blockers)
├── T1: Scaffold Vite + React + TS project structure         [infra]
├── T2: Configure TypeScript (strict, paths, server+client)  [infra]
├── T3: Configure ESLint 9 + Prettier                        [infra]
├── T4: Install all new dependencies                         [infra]
│
PHASE 2 — Shared Contracts (blocked by T1-T4)
├── T5: Define all shared TypeScript types                   [backend]
│       Session (including ALL linkage fields: terminalId,
│       lastTerminalId, cachedPid, replacesId, sshConfig,
│       previousSessions, isHistorical, source),
│       HookPayload, WSMessage, TerminalConfig, SshConfig,
│       PendingResume, PendingLink, Settings,
│       PromptQueueItem, Group, Analytics, etc.
│       → src/types/*.ts — ALL agents import from here
│
PHASE 3 — Parallel Workstreams (blocked by T5)
│
├── BACKEND TRACK (blocked by T5)
│   ├── T6:  Migrate leaf modules                            [backend]
│   │        constants, logger, serverConfig, config,
│   │        hookStats, portManager
│   ├── T7:  Migrate sub-modules                             [backend]
│   │        approvalDetector, autoIdleManager,
│   │        processMonitor, teamManager, sessionMatcher
│   │        ⚠️ sessionMatcher: preserve ALL 5 priorities,
│   │        reKeyResumedSession(), detectHookSource(),
│   │        Fix 3 (stale cleanup on direct/P0 match)
│   │        (blocked by T6)
│   ├── T8:  Migrate data + auth modules                     [backend]
│   │        db.ts, authManager.ts
│   │        (blocked by T6)
│   ├── T9:  Migrate I/O modules                             [backend]
│   │        sshManager, mqReader, hookProcessor, hookRouter
│   │        ⚠️ sshManager: preserve Fix 1 (env var export
│   │        over SSH for both direct + tmux launch),
│   │        detectShellReady() with 100ms settle,
│   │        pendingLinks lifecycle, consumePendingLink()
│   │        (blocked by T7, T8)
│   ├── T10: Migrate coordinators                            [backend]
│   │        wsManager, apiRouter, sessionStore
│   │        ⚠️ apiRouter: preserve Fix 4 (consumePendingLink
│   │        immediately after createTerminal in resume),
│   │        Fix 1 (resume prefix env var export)
│   │        ⚠️ sessionStore: preserve Fix 2 (SSH projectPath
│   │        update from hook CWD, ONLY source=ssh),
│   │        Fix 7 (pendingResume in snapshot save/load),
│   │        loadSnapshot triage (SSH vs non-SSH),
│   │        Map key/sessionId mismatch repair,
│   │        snapshot deduplication by projectPath+source,
│   │        debounced broadcast with dedup by sessionId
│   │        (blocked by T9)
│   └── T11: Migrate entry point                             [backend]
│            index.ts + add Zod validation to all API routes
│            (blocked by T10)
│
├── FRONTEND CORE TRACK (blocked by T5)
│   ├── T12: React app shell                                 [frontend-core]
│   │        main.tsx, App.tsx, Vite proxy config,
│   │        React Router setup (Live/History/Timeline/
│   │        Analytics/Queue routes)
│   ├── T13: Zustand stores                                  [frontend-core]
│   │        sessionStore, uiStore, settingsStore,
│   │        queueStore, groupStore, wsStore
│   │        (blocked by T12)
│   ├── T14: WebSocket hook + provider                       [frontend-core]
│   │        useWebSocket (connect, reconnect, replay,
│   │        auth token, snapshot hydration → Zustand)
│   │        ⚠️ MUST preserve Fix 6:
│   │        - Snapshot dedup: group by sessionId, keep
│   │          most recent lastActivityAt
│   │        - onSessionUpdate: if session.replacesId,
│   │          delete old from store + removeCard +
│   │          migrateSessionId in IndexedDB +
│   │          del('sessions', replacesId)
│   │        (blocked by T13)
│   ├── T15: Dexie.js database                               [frontend-core]
│   │        Schema migration from raw IndexedDB v2,
│   │        typed CRUD, useIndexedDB hooks
│   │        ⚠️ MUST include migrateSessionId() function
│   │        that moves all child records (prompts, tools,
│   │        responses, events, notes, queue) from old
│   │        sessionId to new sessionId — used by Fix 6
│   │        (blocked by T12)
│   ├── T16: Auth gate component                             [frontend-core]
│   │        Login screen, auth context, token injection
│   │        into fetch + WS
│   │        (blocked by T14)
│   ├── T17: Shared UI components                            [frontend-core]
│   │        Modal, Tabs, SearchInput, ResizablePanel,
│   │        ToastContainer
│   │        (blocked by T12)
│   └── T18: Layout components                               [frontend-core]
│            Header (stats bar), NavBar, ActivityFeed
│            (blocked by T13, T17)
│
├── CSS TRACK (blocked by T12)
│   ├── T19: Set up CSS Modules structure                    [css-agent]
│   │        Create src/styles/, copy base.css,
│   │        animations.css, characters/, themes/
│   │        as global imports
│   ├── T20: Decompose legacy dashboard.css                  [css-agent]
│   │        Extract into component CSS Modules:
│   │        SessionCard.module.css, DetailPanel.module.css,
│   │        Terminal.module.css, etc.
│   │        (blocked by T19)
│   └── T21: Dead CSS audit and removal                      [css-agent]
│            (blocked by ALL frontend features complete)
│
├── FRONTEND FEATURES TRACK (blocked by T14, T15, T17, T18, T19)
│   ├── T22: Session cards + grid                            [frontend-features]
│   │        SessionCard.tsx, SessionGrid.tsx (dnd-kit),
│   │        status reordering, pin/mute, inline title edit
│   │        ⚠️ Close/dismiss button MUST use del() not
│   │        get→put for IndexedDB (Fix 5 race condition)
│   ├── T23: Character system                                [frontend-features]
│   │        RobotViewport.tsx, CharacterModel.tsx (20 models),
│   │        CharacterSelector.tsx, movement effects
│   │        (blocked by T22)
│   ├── T24: Detail panel                                    [frontend-features]
│   │        DetailPanel.tsx (slide-in, resizable),
│   │        DetailTabs.tsx, PromptHistory.tsx,
│   │        ActivityLog.tsx (search/highlight),
│   │        NotesTab.tsx, SummaryTab.tsx
│   │        (blocked by T22)
│   ├── T25: Terminal integration                            [frontend-features]
│   │        TerminalContainer.tsx (xterm.js wrapper),
│   │        TerminalToolbar.tsx (themes, fullscreen),
│   │        useTerminal hook, WS relay, reconnect
│   │        (blocked by T24)
│   ├── T26: Sound system                                    [frontend-features]
│   │        soundEngine.ts (Web Audio synthesis),
│   │        useSound hook, per-action toggles, volume
│   │        (parallel with T22-T25)
│   ├── T27: Session groups                                  [frontend-features]
│   │        SessionGroup.tsx, groupStore integration,
│   │        drag between groups (dnd-kit), collapse/expand
│   │        (blocked by T22)
│   ├── T28: Prompt queue                                    [frontend-features]
│   │        QueueTab.tsx, queueStore, auto-send on
│   │        waiting status, compose UI, move between sessions
│   │        (blocked by T24)
│   ├── T29: Session controls + resume flow                  [frontend-features]
│   │        Kill (modal), Archive, Resume, Labels
│   │        (ONEOFF/HEAVY/IMPORTANT with accent frames),
│   │        Summarize (modal + API), Duration alerts
│   │        ⚠️ Resume button must call POST /sessions/:id/resume
│   │        which triggers the full Fix 1+3+4+7 chain server-side
│   │        (blocked by T22)
│   ├── T30: Quick actions                                   [frontend-features]
│   │        NewSessionModal.tsx (full SSH form),
│   │        QuickSessionModal.tsx, label quick-launch,
│   │        workdir history, tmux list
│   │        (blocked by T17)
│   └── T31: Keyboard shortcuts                              [frontend-features]
│            useKeyboardShortcuts hook, all existing bindings
│            (/, Escape, ?, S, K, A, T, M)
│            (blocked by T22, T24)
│
├── FRONTEND VIEWS TRACK (blocked by T14, T15, T17, T18, T19)
│   ├── T32: Settings panel                                  [frontend-views]
│   │        SettingsPanel.tsx + sub-tabs:
│   │        Theme, Sound, Label, Hook density, API keys,
│   │        Import/Export, Summary prompts
│   ├── T33: History view                                    [frontend-views]
│   │        HistoryView.tsx, server paginated query
│   │        (TanStack Query), filters, sort, detail click
│   │        (parallel with T32)
│   ├── T34: Analytics view                                  [frontend-views]
│   │        AnalyticsView.tsx, 4 analytics cards,
│   │        Recharts bar/line/heatmap
│   │        (parallel with T32)
│   ├── T35: Timeline view                                   [frontend-views]
│   │        TimelineView.tsx, granularity controls,
│   │        Recharts or SVG timeline
│   │        (parallel with T32)
│   └── T36: Queue view                                      [frontend-views]
│            QueueView.tsx (global queue across sessions)
│            (blocked by T28 for store contract)
│
└── PHASE 4 — Testing
    ├── T37: Vitest config + migrate 8 existing server tests [tester]
    │        (blocked by T6)
    ├── T38: Backend unit tests                              [tester]
    │        Cover db.ts, authManager, hookProcessor
    │        (blocked by T11)
    ├── T39: Session linkage + dedup test suite               [tester]
    │        ⚠️ DEDICATED suite — see "Linkage Test Cases" below
    │        (blocked by T11)
    ├── T40: Frontend store + hook unit tests                [tester]
    │        All Zustand stores, useWebSocket, useSound,
    │        useTerminal, useKeyboardShortcuts, utils
    │        (blocked by T18)
    ├── T41: Frontend component tests                        [tester]
    │        SessionCard, DetailPanel, TerminalContainer,
    │        Settings, Modals (React Testing Library)
    │        (blocked by T31)
    ├── T42: Playwright e2e tests                            [tester]
    │        Smoke: page loads, WS connects
    │        Session lifecycle: appear → select → detail
    │        Terminal: create → SSH → I/O → fullscreen
    │        Groups: drag session → group
    │        Settings: change → persist → reload
    │        Kill: confirm → removed
    │        (blocked by T31)
    └── T43: Coverage enforcement                            [tester]
             80%+ on stores, hooks, utils
             Session linkage suite: 100% of fix scenarios covered
             (blocked by T39-T42)

PHASE 5 — Integration & Polish (blocked by ALL above)
├── T44: Full integration test                               [lead]
│        npm run dev → all features work, HMR works
│        npm run build → production bundle, npm start serves it
├── T45: Performance optimization                            [lead]
│        React.memo on SessionCard, lazy routes,
│        code splitting, virtual scroll for large lists
├── T46: Accessibility pass                                  [frontend-core]
│        ARIA labels, keyboard nav, focus management,
│        reduced motion media query
└── T47: Final cleanup                                       [lead]
         Remove old public/js/, confirm npm scripts,
         update CLAUDE.md, update README
```

---

## Linkage Test Cases (T39 — MANDATORY)

The `tester` agent MUST write these test cases for `sessionMatcher.ts` and
`sessionStore.ts`. Each test validates one of the 7 dedup fixes:

```
Test Suite: Session-Terminal Linkage

describe('Fix 1: AGENT_MANAGER_TERMINAL_ID over SSH')
  ✓ Direct launch command includes export AGENT_MANAGER_TERMINAL_ID
  ✓ Tmux launch command includes export AGENT_MANAGER_TERMINAL_ID
  ✓ Resume prefix for remote sessions includes export AGENT_MANAGER_TERMINAL_ID
  ✓ Priority 1 matching works when env var is present in hook

describe('Fix 2: SSH projectPath update from hook CWD')
  ✓ SessionStart updates projectPath for source=ssh when hook CWD differs
  ✓ SessionStart does NOT update projectPath for source=vscode
  ✓ SessionStart does NOT overwrite source field
  ✓ projectName is derived from updated projectPath

describe('Fix 3: Stale pendingResume/pendingLinks cleanup')
  ✓ Direct ID match on SessionStart cleans pendingResume for that terminalId
  ✓ Direct ID match on SessionStart consumes pendingLinks for that projectPath
  ✓ Priority 0 match consumes pendingLinks after successful match
  ✓ Dangling pendingResume does not match unrelated future hooks

describe('Fix 4: consumePendingLink after resume terminal creation')
  ✓ Resume endpoint calls consumePendingLink immediately after createTerminal
  ✓ Another Claude in same workDir does NOT steal the resume terminal
  ✓ Resume flow uses pendingResume (not pendingLinks) for matching

describe('Fix 5: Close button IndexedDB race')
  ✓ Close/dismiss uses del() not get→put on IndexedDB
  ✓ Concurrent session_removed + close does not re-create record

describe('Fix 6: Snapshot deduplication')
  ✓ Snapshot with divergent Map key/sessionId deduplicates to one card
  ✓ session_update with replacesId removes old card
  ✓ session_update with replacesId migrates IndexedDB child records
  ✓ session_update with replacesId deletes old IndexedDB session record

describe('Fix 7: pendingResume persistence across restart')
  ✓ saveSnapshot includes pendingResume entries
  ✓ loadSnapshot restores pendingResume with refreshed timestamps
  ✓ loadSnapshot skips pendingResume entries for deleted sessions
  ✓ Restored pendingResume enables Priority 0 match after restart

describe('5-Priority Matching System')
  ✓ Priority 0 matches before Priority 1
  ✓ Priority 1 matches before Priority 2
  ✓ Priority 2 matches before Priority 3
  ✓ Ambiguous Priority 0.5 (2+ candidates) falls through
  ✓ Ambiguous Priority 3 (2+ connecting) falls through
  ✓ No match creates display-only card with detected source
  ✓ reKeyResumedSession sets replacesId and resets session state
  ✓ reKeyResumedSession clears stale PID mapping

describe('loadSnapshot Triage')
  ✓ SSH + PID alive → SIGTERM + mark ended + ServerRestart event
  ✓ SSH + PID dead → mark ended + ServerRestart event
  ✓ SSH + no PID → mark ended (zombie cleanup)
  ✓ Non-SSH + PID alive → restore as-is
  ✓ Non-SSH + PID dead → mark ended + ServerRestart event
  ✓ All SSH sessions: clear terminalId, preserve lastTerminalId
  ✓ Map key/sessionId mismatch → repaired
  ✓ Duplicate ended sessions (same projectPath+source) → deduplicated
```

---

## Shared Type Contracts (T5 — All agents import from here)

```typescript
// src/types/session.ts
export type SessionStatus =
  | 'connecting' | 'idle' | 'prompting' | 'working'
  | 'approval' | 'input' | 'waiting' | 'ended';

export type AnimationState =
  | 'idle' | 'walking' | 'running' | 'waiting'
  | 'celebrating' | 'death';

export type Emote = 'none' | 'wave' | 'thumbsUp' | 'thinking' | 'alert' | null;

export type SessionSource =
  | 'ssh' | 'vscode' | 'iterm' | 'terminal' | 'warp'
  | 'tmux' | 'cursor' | 'windsurf' | 'jetbrains'
  | 'kitty' | 'ghostty' | 'alacritty' | 'wezterm' | 'hyper'
  | 'unknown' | string;  // detectHookSource can return raw term_program

export interface Session {
  sessionId: string;
  status: SessionStatus;
  animationState: AnimationState;
  emote: Emote;
  projectName: string;
  projectPath: string;
  source: SessionSource;
  characterModel: string;
  colorIndex: number;
  currentPrompt: string;
  totalToolCalls: number;
  toolUsage: Record<string, number>;
  promptHistory: PromptEntry[];
  toolLog: ToolLogEntry[];
  responseLog: ResponseEntry[];
  events: SessionEvent[];
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  muted: boolean;
  pinned: boolean;
  label: string | null;
  accentColor: string | null;
  title: string | null;
  teamId: string | null;
  parentSessionId: string | null;
  isSubagent: boolean;

  // ── Linkage Fields (CRITICAL) ──
  terminalId: string | null;
  lastTerminalId: string | null;
  cachedPid: number | null;
  replacesId: string | null;        // One-time: consumed after first broadcast
  sshConfig: SshConfig | null;
  previousSessions: ArchivedSession[];
  isHistorical: boolean;
  queueCount: number;
}

export interface PendingResume {
  oldSessionId: string;
  timestamp: number;
}

export interface PendingLink {
  terminalId: string;
  host: string | null;
  createdAt: number;
}

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  authMethod: 'key' | 'password' | 'agent';
  keyPath?: string;
  workingDir?: string;
  tmuxSession?: string;
  tmuxMode?: 'attach' | 'wrap' | 'none';
  command?: string;
}

// src/types/websocket.ts
export type ServerMessage =
  | { type: 'snapshot'; sessions: Record<string, Session>; teams: Team[]; seq: number }
  | { type: 'session_update'; session: Session; seq: number }
  | { type: 'session_removed'; session_id: string }
  | { type: 'team_update'; teams: Team[] }
  | { type: 'hook_stats'; stats: HookStats }
  | { type: 'terminal_output'; terminalId: string; data: string }
  | { type: 'terminal_exit'; terminalId: string; code: number }
  | { type: 'terminal_ready'; terminalId: string }
  | { type: 'clear_browser_db' }

export type ClientMessage =
  | { type: 'terminal_input'; terminalId: string; data: string }
  | { type: 'terminal_resize'; terminalId: string; cols: number; rows: number }
  | { type: 'terminal_subscribe'; terminalId: string }
  | { type: 'terminal_disconnect'; terminalId: string }
  | { type: 'update_queue_count'; sessionId: string; count: number }
  | { type: 'REPLAY'; sinceSeq: number }
```

### REST API Contract

All existing endpoints, request shapes, and response shapes must remain
identical. The `backend` agent adds Zod validation but does NOT change any
contract.

### CSS Contract

- `src/styles/base.css` — CSS variables are the single source of truth for colors
- `src/styles/animations.css` — All keyframe definitions stay as-is
- `src/styles/characters/*.css` — All 20 character CSS files stay as-is
- `src/styles/themes/*.css` — All 9 theme overrides stay as-is
- Component-specific styles go into `*.module.css` files
- Character animation is driven by `data-status`, `data-animation`, `data-emote`
  HTML attributes — React components must set these as data attributes

---

## Target Directory Structure

```
ai-agent-session-center/
├── src/                          # NEW — React frontend
│   ├── main.tsx                  # Vite entry
│   ├── App.tsx                   # Root: auth gate + WS provider + router
│   ├── routes/
│   │   ├── LiveView.tsx
│   │   ├── HistoryView.tsx
│   │   ├── TimelineView.tsx
│   │   ├── AnalyticsView.tsx
│   │   └── QueueView.tsx
│   ├── components/
│   │   ├── layout/               # Header, NavBar, ActivityFeed, Toast
│   │   ├── session/              # SessionCard, SessionGrid, DetailPanel, etc.
│   │   ├── terminal/             # TerminalContainer, Toolbar, Fullscreen
│   │   ├── character/            # RobotViewport, CharacterModel, Selector
│   │   ├── modals/               # NewSession, QuickSession, Kill, Summarize, etc.
│   │   ├── settings/             # SettingsPanel + sub-tab components
│   │   ├── charts/               # BarChart, LineChart, Heatmap (Recharts)
│   │   └── ui/                   # Modal, Tabs, SearchInput, ResizablePanel
│   ├── hooks/
│   │   ├── useWebSocket.ts
│   │   ├── useSession.ts
│   │   ├── useTerminal.ts
│   │   ├── useSound.ts
│   │   ├── useDragAndDrop.ts
│   │   ├── useKeyboardShortcuts.ts
│   │   ├── useIndexedDB.ts
│   │   ├── useDebounce.ts
│   │   └── useResizeObserver.ts
│   ├── stores/
│   │   ├── sessionStore.ts       # Zustand — includes replacesId handling
│   │   ├── uiStore.ts
│   │   ├── settingsStore.ts
│   │   ├── queueStore.ts
│   │   ├── groupStore.ts
│   │   └── wsStore.ts
│   ├── lib/
│   │   ├── db.ts                 # Dexie.js — includes migrateSessionId()
│   │   ├── wsClient.ts           # Framework-agnostic WS client
│   │   ├── soundEngine.ts        # Web Audio synthesis
│   │   ├── alarmEngine.ts
│   │   └── utils.ts
│   ├── types/                    # Shared TS types (server + client)
│   │   ├── session.ts
│   │   ├── hook.ts
│   │   ├── websocket.ts
│   │   ├── terminal.ts
│   │   ├── settings.ts
│   │   └── api.ts
│   └── styles/
│       ├── base.css              # CSS variables (KEEP)
│       ├── animations.css        # Keyframes (KEEP)
│       ├── characters/           # 20 character CSS files (KEEP)
│       ├── themes/               # 9 theme files (KEEP)
│       ├── global.css            # Shared global styles
│       └── modules/              # Component CSS Modules
├── server/                       # MIGRATED to TypeScript
│   ├── index.ts
│   ├── sessionStore.ts           # Coordinator + Fix 2, 7
│   ├── sessionMatcher.ts         # 5-priority matching + Fix 3
│   ├── sshManager.ts             # PTY + Fix 1
│   ├── apiRouter.ts              # REST API + Fix 1, 4
│   ├── ... (all other .js → .ts)
│   └── tsconfig.json
├── test/
│   ├── server/                   # Vitest server tests
│   │   └── linkage/              # Dedicated linkage + dedup tests (T39)
│   ├── client/                   # Vitest + RTL component/hook tests
│   └── e2e/                      # Playwright tests
├── hooks/                        # Bash hook scripts (UNCHANGED)
├── bin/                          # CLI entry (UNCHANGED)
├── index.html                    # Vite HTML entry
├── vite.config.ts
├── tsconfig.json
├── tsconfig.server.json
├── eslint.config.js              # ESLint 9 flat config
├── .prettierrc
├── vitest.config.ts
├── playwright.config.ts
└── package.json
```

---

## Agent Coordination Rules

1. **Types-first**: No agent writes implementation until T5 (shared types) is
   complete and reviewed by lead. Types are the contract.

2. **No API changes**: Backend agent must not alter any REST endpoint path,
   request body shape, response body shape, or WS message format.

3. **Store-first for frontend**: `frontend-core` must complete stores (T13)
   before `frontend-features` or `frontend-views` start.

4. **CSS preservation**: The `css-agent` never modifies CSS variable values,
   animation keyframes, character definitions, or theme overrides.

5. **Incremental verification**: Each agent must verify `tsc --noEmit` passes
   before reporting task complete. Backend agent runs existing tests after each
   module migration.

6. **No feature addition**: Match behavior 1:1 with current code.
   No new features, no "improvements", no extra error handling.

7. **Linkage code is frozen logic**: The 7 dedup fixes and 5-priority matcher
   are BEHAVIORAL contracts. Agents may add types and restructure for TS, but
   the logic, ordering, and edge-case handling must be identical. When in doubt,
   read the original JS and port line-by-line.

8. **Conflict resolution**: If two agents need the same file, message lead.

9. **Progress reporting**: After each task, agents message lead with: what was
   done, files changed, and any issues discovered.

---

## Critical Constraints

- **ZERO feature regression** — every existing feature works identically
- **Preserve visual identity** — dark neon aesthetic, glow effects, character animations
- **Preserve CSS animations** — all 20 character models stay as pure CSS
- **Preserve hook pipeline** — bash hooks → file MQ → server is untouched
- **Preserve WS protocol** — all message types and payloads unchanged
- **Preserve REST API** — all endpoints, request/response shapes unchanged
- **Preserve terminal** — xterm.js + node-pty + WS relay works identically
- **Preserve session linkage** — all 7 dedup fixes, 5-priority matcher, re-key flow
- **Preserve snapshot lifecycle** — save/load/triage logic including pendingResume
- **Backwards-compatible data** — IndexedDB migration from v2, localStorage preserved
- **Single `npm run dev`** — Vite dev server proxies API + WS to Express backend
- **`npm run build && npm start`** — production bundle served by Express

---

## npm Scripts (Target)

```json
{
  "scripts": {
    "dev": "concurrently \"vite\" \"tsx watch server/index.ts\"",
    "build": "vite build && tsc -p tsconfig.server.json",
    "start": "node dist/server/index.js",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit && tsc -p tsconfig.server.json --noEmit",
    "lint": "eslint .",
    "format": "prettier --write \"src/**/*.{ts,tsx,css}\" \"server/**/*.ts\"",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "test:coverage": "vitest run --coverage",
    "setup": "npm install && node hooks/setup-wizard.js && npm run dev",
    "install-hooks": "node hooks/install-hooks.js",
    "uninstall-hooks": "node hooks/install-hooks.js --uninstall",
    "reset": "node hooks/reset.js"
  }
}
```

---

## Success Criteria

- [ ] `npm run dev` — Vite HMR + Express backend, all features work
- [ ] `npm run build && npm start` — production bundle served correctly
- [ ] `npm run typecheck` — zero errors in strict mode
- [ ] `npm run lint` — zero errors
- [ ] `npm test` — all pass, 80%+ coverage on stores/hooks/utils
- [ ] `npm run test:e2e` — Playwright suite passes
- [ ] All 20 character models render and animate correctly
- [ ] All 9 themes switch correctly
- [ ] All keyboard shortcuts work
- [ ] SSH terminal: create → I/O → resize → fullscreen → reconnect
- [ ] Hook pipeline: file MQ + HTTP fallback
- [ ] Session state machine transitions correctly
- [ ] **Session linkage**: new terminal → hook arrives → Priority 1 matches → card re-keys
- [ ] **Resume flow**: Resume click → new terminal → pendingResume → Priority 0 matches
- [ ] **Server restart**: snapshot save → restart → load → triage → resume still works
- [ ] **No duplicate cards**: all 7 dedup fix scenarios verified by dedicated tests
- [ ] Approval/input detection heuristic works
- [ ] Team/subagent tracking works
- [ ] Prompt queue auto-send works
- [ ] Session groups with drag-and-drop work
- [ ] Sound effects play correctly
- [ ] History, Timeline, Analytics views render with real data
- [ ] Settings persist across browser reload
- [ ] Auth gate (password) works
- [ ] WebSocket reconnect + replay works
- [ ] Mobile responsive layout preserved

---

## File-by-File Migration Reference

### Frontend (27 modules → React)

| Original (public/js/) | LOC | Target (src/) |
|------------------------|-----|---------------|
| app.js | 518 | main.tsx + App.tsx + hooks/useWebSocket.ts |
| wsClient.js | 116 | lib/wsClient.ts + hooks/useWebSocket.ts |
| sessionPanel.js | 116 | Removed (facade unnecessary in React) |
| sessionCard.js | 724 | components/session/SessionCard.tsx + SessionGrid.tsx |
| detailPanel.js | 704 | components/session/DetailPanel.tsx + sub-tabs |
| terminalManager.js | 699 | components/terminal/TerminalContainer.tsx + hooks/useTerminal.ts |
| robotManager.js | 538 | components/character/RobotViewport.tsx + CharacterModel.tsx |
| settingsManager.js | 959 | components/settings/*.tsx + stores/settingsStore.ts |
| browserDb.js | 926 | lib/db.ts (Dexie.js) + hooks/useIndexedDB.ts |
| promptQueue.js | 530 | components/session/QueueTab.tsx + stores/queueStore.ts |
| sessionGroups.js | 766 | components/session/SessionGroup.tsx + stores/groupStore.ts |
| sessionControls.js | 739 | modals/*.tsx + hooks |
| quickActions.js | 702 | modals/NewSessionModal.tsx + QuickSessionModal.tsx |
| soundManager.js | 259 | lib/soundEngine.ts + hooks/useSound.ts |
| movementManager.js | 155 | CSS class toggling in SessionCard.tsx |
| statsPanel.js | 138 | components/layout/Header.tsx |
| historyPanel.js | 289 | routes/HistoryView.tsx |
| analyticsPanel.js | 473 | routes/AnalyticsView.tsx + components/charts/*.tsx |
| timelinePanel.js | 279 | routes/TimelineView.tsx |
| chartUtils.js | 383 | components/charts/*.tsx (Recharts) |
| navController.js | 32 | React Router 7 |
| keyboardShortcuts.js | 84 | hooks/useKeyboardShortcuts.ts |
| alarmManager.js | 109 | lib/alarmEngine.ts |
| sceneManager.js | 7 | Removed (stub) |
| utils.js | 64 | lib/utils.ts |
| constants.js | 72 | types/ + lib/constants.ts |

### Backend (all server/*.js → server/*.ts)

Rename, add types, replace manual validation with Zod. No behavioral changes.
Linkage modules (sessionMatcher, sessionStore, sshManager, apiRouter) require
line-by-line verification of fix preservation.

---

## How to Execute

Paste this prompt to Claude Code. Claude will:

1. `TeamCreate` → team `modernize`
2. `TaskCreate` → all 47 tasks from the graph above, with `addBlockedBy` dependencies
3. Spawn 7 agents as `Task` calls with `team_name: "modernize"`
4. Assign tasks to agents via `TaskUpdate` with `owner`
5. Agents work in parallel on independent tracks
6. Lead monitors progress, reviews, resolves conflicts
7. Final integration verification and cleanup
