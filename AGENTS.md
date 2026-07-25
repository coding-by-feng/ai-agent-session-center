# AI Agent Session Center: Agent Guidance

This file is the durable coding-agent entrypoint for this repository. It is
based on `CLAUDE.md`; read `CLAUDE.md` for the full architecture notes and keep
the two files aligned when project guidance changes.

## Project Snapshot

AI Agent Session Center is a localhost dashboard on port 3333 for monitoring AI
coding agent sessions from Claude Code, Gemini CLI, Codex, and related tools. It
uses hooks to ingest session events, visualizes sessions as 3D robots, supports
SSH terminals, team/subagent tracking, prompt queuing, workspace snapshots, and
session resume.

Core stack:

- Backend: Node.js 18+, ESM, Express 5, ws 8, tsx
- Frontend: React 19, Three.js / `@react-three/fiber`, Zustand 5, Vite 7
- Desktop: Electron 34, electron-builder 25
- Terminal: `node-pty` through Electron IPC, WebSocket fallback in browser
- Hooks: Bash hook script with JSONL file queue and HTTP POST fallback
- Persistence: SQLite / `better-sqlite3` on the server, IndexedDB / Dexie in the
  browser

## Common Commands

```bash
npm run dev              # Vite + tsx watch
npm run build            # Production build
npm start                # Start production server
npm test                 # Vitest
npm run test:e2e         # Playwright E2E
npm run test:coverage    # Coverage report
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint src/
npm run format           # Prettier
npm run electron:dev     # Build and launch Electron app
npm run electron:build   # Build distributables
npm run install-hooks    # Install CLI hooks
npm run uninstall-hooks  # Remove dashboard hooks
npm run setup            # Interactive setup wizard
npm run reset            # Remove hooks, clean config, backup
```

Use the smallest verification command that fits the change. For shared contracts,
state shape, server routes, Electron IPC, terminal behavior, or feature-doc work,
prefer at least `npm run typecheck` plus any targeted tests that cover the touched
area.

## Feature Documentation Workflow

All feature logic is documented under `docs/feature/`. Before implementing a new
feature or modifying an existing one:

1. Read `CLAUDE.md` to identify the affected feature domain.
2. Read the corresponding doc(s) in `docs/feature/`.
3. Check the impact matrix in `CLAUDE.md` for connected features.
4. Read connected feature docs before changing shared behavior.
5. After the code change, use `$update-feature-docs` to update every affected
   feature doc.

`docs/feature/.manifest.json` is machine-readable source of truth for file to
doc mappings, symbols, and last-aligned timestamps. Do not hand-edit it. If it
drifts, run `$align-existing-feature-docs`; request a manifest rebuild when the
manifest itself is corrupted.

Feature-doc domains:

- `docs/feature/server/`: hooks, sessions, matching, approvals, WebSocket, API,
  database, terminal/SSH, teams, process monitoring, auth, file index cache, and
  floating session spawning
- `docs/feature/frontend/`: Zustand state, persistence, WebSocket client,
  session detail, conversation/file/terminal/queue/review views, settings,
  shortcuts, command autocomplete, workspace snapshots, setup, auth UI, project
  browser, floating terminals, creation modals, file-open chooser, and UI
  primitives
- `docs/feature/3d/`: cyberdrome scene, robot system, particles/effects
- `docs/feature/multimedia/`: sound/alarm and TTS voice output
- `docs/feature/electron/`: app lifecycle, PTY host, and IPC transport

## Architecture Notes

Event flow:

```text
AI CLI
  -> hooks/dashboard-hook.sh
  -> /tmp/claude-session-center/queue.jsonl
  -> server/mqReader.ts
  -> server/hookProcessor.ts
  -> server/sessionStore.ts
  -> server/wsManager.ts
  -> browser Zustand stores and React render
```

Important server areas:

- `server/index.ts`: orchestration and startup
- `server/apiRouter.ts`: REST API surface
- `server/mqReader.ts`, `server/hookProcessor.ts`, `server/hookRouter.ts`: hook
  ingestion and routing
- `server/fileIndexCache.ts`, `server/commandIndex.ts`: cached file and
  slash-command indexes
- `server/sessionStore.ts` and helpers: session state, matching, titles,
  approvals, teams, liveness, and auto-idle
- `server/wsManager.ts`: WebSocket broadcast and terminal relay
- `server/sshManager.ts`: SSH/PTY terminal management
- `server/db.ts`: SQLite storage
- `server/authManager.ts`: password auth and tokens
- `server/floatingSessionSpawner.ts`, `server/floatingPrompt.ts`,
  `server/extractPreviousAnswer.ts`: floating/forked session support

Important frontend areas:

- `src/stores/`: Zustand state stores for session, settings, queue, room,
  camera, UI, WebSocket, agenda, shortcuts, and floating sessions
- `src/hooks/`: WebSocket, terminal, sound, auth, shortcuts, settings init,
  workspace auto-save/load, queue scheduler, selection popup, and outside-click
  behavior
- `src/lib/`: client transport, IndexedDB, audio, workspace snapshots, CLI
  detection, scene utilities, file system provider, formatting, shortcuts,
  transcript, queue scheduling, history export, command suggestions, and TTS
- `src/components/3d/`: scene, robots, labels, particles, camera, overlays, and
  3D state display
- `src/components/session/`: detail panel, tabs, conversation, project/file
  browser, floating panels, queue/history, notes, summaries, linkified text,
  dialogs, TeX/image viewers
- `src/components/terminal/`: terminal container, toolbar, themes
- `src/components/settings/`, `src/components/modals/`, `src/components/layout/`,
  `src/components/agenda/`, `src/components/auth/`, `src/components/setup/`,
  `src/components/ui/`: domain UI and shared primitives
- `src/routes/`: live, history, project browser, queue, agenda, and review views

Electron uses `electron/main.ts` for app lifecycle and windows,
`electron/preload.ts` for the context bridge, `electron/ptyHost.ts` for the
Node PTY host with ring buffer replay, and `electron/ipc/` for IPC handlers.
Terminal transport is IPC in Electron and WebSocket in browser; renderer code
detects Electron through `window.electronAPI?.createPty`.

## Session State Machine

Session state drives the 3D robots, sounds, approvals, auto-idle, and session UI.
Treat changes here as cross-cutting:

```text
SessionStart      -> idle       (idle animation)
UserPromptSubmit  -> prompting  (walking/wave, seeks desk)
PreToolUse        -> working    (running, tool-specific animation)
PostToolUse       -> working    (stays working)
[timeout]         -> approval   (waiting for tool approval)
[timeout]         -> input      (waiting for user answer)
PermissionRequest -> approval   (reliable signal, overrides heuristic)
Stop              -> waiting    (thumbs up / dance)
[2 min idle]      -> idle
SessionEnd        -> ended      (death animation, kept in memory)
```

## High-Risk Change Areas

Check connected docs and tests when touching these contracts:

- Hook script or MQ format affects session matching, management, and hook stats.
- Session state changes affect robots, sound/alarms, approvals, auto-idle, and
  frontend stores.
- Session matching affects terminal/SSH, session resume, team linking, and
  external-session discovery.
- WebSocket messages affect the WS client, terminal UI, and real-time UI.
- API contracts affect frontend HTTP calls and Electron PTY registration.
- DB schema affects API endpoints and IndexedDB mirroring.
- Terminal/SSH behavior affects session matching and PTY registration.
- Zustand store shape changes affect all subscribing components.
- Theme CSS variables affect 2D UI, 3D UI, and terminal themes.
- Electron IPC channel changes affect preload and terminal transport.
- Queue scheduler or `queueHistoryStore` changes affect prompt queue, loops,
  per-session automation, and client persistence.
- Command or file indexes affect command autocomplete, queue editors, project
  browsing, and file picking.
- Transcript reconstruction affects conversation view and review tab.
- Floating session spawn/fork changes affect floating terminal fork, review tab,
  pop-out windows, and session matching.
- Shared UI primitives affect settings, modals, panels, and any consumer.
- TTS or Google Cloud API-key work must keep per-user API keys client-side and
  forwarded per request. Do not reintroduce ambient credentials such as gcloud
  ADC or service-account files.

## Key Invariants

- Never mutate session objects in place; create new objects and Maps.
- Never use Zustand directly inside React Three Fiber Canvas code; pass data from
  DOM layers through props to avoid React Error #185.
- Never block the hook script; background processing with a detached subshell.
- Never hardcode port 3333; read from config, env, or CLI flags.
- Never modify `~/.claude/settings.json` without an atomic temp-write and rename.
- Server imports use `.js` extensions for NodeNext module resolution with tsx.
- File browser path access must go through `resolveProjectPath()`.
- External sessions must be traced rather than dropped. Never persist
  process-discovered `external-<pid>` cards in workspace snapshots, and keep
  the recurring external-process scan asynchronous.
- SSH inputs must stay validated with Zod and shell-metacharacter checks.
- Floating overlays must stay inside the viewport. Reuse the existing
  flip/nudge/clamp helpers and render-check narrow layouts.
- Put test and debug screenshots in `test-screenshots/` or `/tmp`; only
  shipping images belong in `static/`.

## Editing Expectations

- Follow existing local patterns before adding abstractions.
- Keep behavior changes narrow and update docs when user-facing features,
  backend endpoints, UI components, shortcuts, or architecture patterns change.
- Preserve unrelated worktree changes; inspect current diffs before editing.
- Use structured parsers and existing helpers instead of ad hoc string handling
  when the project already has a suitable utility.
- For frontend changes, verify the rendered app when feasible, especially for 3D,
  Electron, terminal, or responsive layout work.


<claude-mem-context>
# Memory Context

# [agent-manager] recent context, 2026-07-20 7:05pm GMT+12

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (21,183t read) | 767,197t work | 97% savings

### Jul 17, 2026
S1384 agent-manager: Activity-sort feature complete — sort-by-recent-activity toggle in SessionSwitcher, with TDD, adversarial review, CSS fix, and docs (Jul 17 at 3:29 PM)
S1386 agent-manager: Session Remark Feature — Architecture Design and DB Safety Analysis (Jul 17 at 4:17 PM)
S1383 agent-manager: Sort-by-activity feature for SessionSwitcher — implementation, TDD, adversarial review, docs, and pre-commit verification (Jul 17 at 4:17 PM)
S1404 agent-manager Feature Docs Full Alignment — align-existing-feature-docs workflow run to fix 184 documentation drift issues across 45 docs (Jul 17 at 4:24 PM)
S1422 agent-manager: Add sort-by-recent-active-status icon to session rail (no rooms) — triggered /ascii-review-first which surfaced two bugs and one design trap before any code was written (Jul 17 at 5:01 PM)
S1424 electron-build — Build and verify agent-manager v2.10.35 Electron DMG for macOS arm64 (Jul 17 at 5:39 PM)
S1434 YouTube History Tab — Watch History Tracking Bug Reported (Jul 17 at 6:06 PM)
S1468 AASC: Fix room skill icons to same line + persist effort level (ultracode) across workspace restart/resume (Jul 17 at 10:47 PM)
### Jul 18, 2026
10524 12:44a 🔵 Rail overflow threshold: 3-icon layout spills at title length ≥19 chars (2-icon at ≥22)
10526 12:45a ✅ session-detail-panel.md updated to document NoteIcon and progress-remark row
10527 " 🔴 Rail overflow CONFIRMED: flex-wrap:nowrap on .switcherBarVertical .switcherToggle is the fix
10528 " ✅ api-endpoints.md and state-management.md updated for remark feature
10532 11:03a ⚖️ agent-manager: Two UI Requests — Skill Icon Alignment + Session Effort Inheritance on Resume
10533 " ⚖️ agent-manager: Two UI Fixes Requested — Skill Icon Alignment + Post-Resume Effort Inheritance
10534 11:05a 🔵 Active Claude Sessions Count Check — 19 Sessions Visible in UI
10535 11:06a ⚖️ agent-manager: Two UI Fixes Requested — Skill Icon Alignment + AASC Effort Inheritance
10537 11:08a 🔵 Effort level and model deterministically applied via launch flags at spawn time
10539 " 🟣 Two AASC UI/UX feature requests: room skill icon layout and effort-level persistence on resume
S1476 agent-manager: Room session icon alignment (collapse chevron + kill skull on same line) + AASC effort inheritance after restart/resume (Jul 18 at 11:13 AM)
10546 11:16a 🔵 Code inspection reveals effort/model persistence chain — 4 points must capture fields, 1 already applies them
10547 11:18a 🔵 Database schema and session hydration: effortLevel not persisted to DB, sessions are in-memory only
10550 11:19a 🔵 Existing test patterns show how to add effortLevel/model to snapshot and respawn pipelines
10551 11:20a 🟣 Room skill icons layout fix: add .roomHeaderRow CSS for horizontal alignment
10552 11:21a 🟣 Effort persistence: capture effortLevel and model in SessionSnapshot interface and export pipeline
10555 11:23a 🟣 agent-manager: Effort Persistence — SessionSnapshot Extended with effortLevel and model Fields
10558 11:24a 🟣 agent-manager: Effort Persistence — Complete 6-Step Fix (workspaceSnapshot + apiRouter + pinnedRespawn + Tests)
10559 " 🔵 agent-manager: applyClaudeLaunchFlags Verified Correct — All 7 Flag Scenarios Pass Under Node 26
10563 11:25a 🔵 agent-manager: workspaceSnapshot.ts Pre-existing ESLint Error — `_id` Unused Variable on HEAD
10569 11:28a ⚖️ agent-manager: Room Header Icon Fix — roomHeaderRow Wrapper Visually Verified via Playwright
10570 " 🟣 agent-manager: Effort Persistence — SessionSnapshot Fields + Resume Flow Implemented
10575 11:29a 🔵 agent-manager: pinnedRespawn.ts Contains NUL Bytes — Pre-existing, Not Caused by Effort-Persistence Edit
10576 " 🟣 agent-manager: Step ④ Implemented — buildRespawnBody Now Preserves effortLevel and model
10577 " 🟣 agent-manager: SessionSwitcher.tsx Room Header Icons Wrapped in roomHeaderRow Div
10580 11:30a ⚖️ agent-manager: Two UI Feature Requests — Room Session Icon Alignment + AASC Effort Inheritance
10583 " 🟣 agent-manager: AASC Effort Inheritance + Room Header Icon Alignment — Implementation Confirmed
10586 11:33a 🔵 agent-manager: Adversarial Code Review — Zero Confirmed Bugs Across All Three Dimensions
11016 9:31p 🔵 agent-manager Test Suite: 10 Files Failing, 65 Passing
11017 9:32p 🔵 agent-manager: Full List of 6 Failing Tests Identified
11018 9:33p 🔵 agent-manager: better-sqlite3 Node Version Mismatch — Root Cause of Server Test Failures
11019 " 🔵 agent-manager: ESLint Reports 146 Problems (121 Errors) in Working Branch
11021 " 🟣 agent-manager v2.10.38 Released — External Session Tracking, Bare-@ File Picker, Queue Inline-Edit Autocomplete
11022 9:37p 🟣 agent-manager v2.10.38 Released to GitHub
S1585 agent-manager v2.10.38 Electron Release — GitHub release published with full changelog (Jul 18 at 9:37 PM)
11038 9:47p ⚖️ AASC Electron App: Open /tmp File Links in Default Browser Instead of App
11041 " 🔵 agent-manager: File Path Link Architecture — FileOpenChooser + FileSystemProvider
11053 9:54p ⚖️ AASC Electron App — File Links Open in Default Browser Instead of App
11057 9:56p ⚖️ AASC Electron App — File Links Open in Default Browser Instead of App
11058 9:59p 🔵 AASC Electron App: File Link Architecture — Why /tmp Paths Fail to Open Externally
11062 10:00p 🔵 AASC: /api/files/stream Empirically Works for /tmp/claude-queue-images with dirname Split
11063 " ⚖️ AASC: File Link Browser Diversion — Full Architecture Plan
11068 10:02p ⚖️ AASC Electron App — File Links Open in Default Browser Instead of App
11069 10:04p ⚖️ AASC Electron App — File Links Open in Default Browser Instead of App
11071 10:05p ⚖️ AASC Electron App — File Link Browser-Open: Pure Client-Side Architecture Decided
11072 " ⚖️ AASC Electron App — File Links Open in Default Browser Instead of App
11073 10:08p ⚖️ AASC Electron App — File Links Open in Default Browser Instead of App
11074 " ⚖️ AASC Electron App — File Links Open in Default Browser Instead of App
### Jul 20, 2026
11097 4:39p 🔵 Codex Session Kill Failure + Empty Terminal Investigation Requested
11106 4:43p 🔵 Codex Session Kill Issue — Empty Terminal Investigation Requested
11108 4:44p 🔵 ai-agent-session-center Release State — v2.10.38 is Latest, HEAD Ahead by 3 Commits
11111 4:45p 🔵 agent-manager Electron Release Pre-flight — All Feature Doc Hashes Current

Access 767k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>
