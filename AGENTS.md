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
5. After the code change, update every affected feature doc.

`docs/feature/.manifest.json` is machine-readable source of truth for file to
doc mappings, symbols, and last-aligned timestamps. Do not hand-edit it. If it
drifts, run the feature-doc alignment workflow rather than patching the manifest
manually.

Feature-doc domains:

- `docs/feature/server/`: hooks, sessions, matching, approvals, WebSocket, API,
  database, terminal/SSH, teams, process monitoring, auth, file index cache, and
  floating session spawning
- `docs/feature/frontend/`: Zustand state, persistence, WebSocket client,
  session detail, conversation/file/terminal/queue/review views, settings,
  shortcuts, command autocomplete, workspace snapshots, setup, auth UI, project
  browser, floating terminals, creation modals, and UI primitives
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
- WebSocket messages affect the WS client, terminal UI, and real-time UI.
- API contracts affect frontend HTTP calls and Electron PTY registration.
- DB schema affects API endpoints and IndexedDB mirroring.
- Terminal/SSH behavior affects session matching and PTY registration.
- Zustand store shape changes affect all subscribing components.
- Theme CSS variables affect 2D UI, 3D UI, and terminal themes.
- Electron IPC channel changes affect preload and terminal transport.
- Queue scheduler or `queueHistoryStore` changes affect prompt queue, loops,
  per-session automation, and client persistence.
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
- SSH inputs must stay validated with Zod and shell-metacharacter checks.

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

# [agent-manager] recent context, 2026-06-09 8:31pm GMT+12

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (23,315t read) | 2,394,995t work | 99% savings

### May 29, 2026
S881 prompt-queue.md — Chain Gate Documentation Updated with atRest Completion Signal (May 29 at 6:40 PM)
S900 Loop test — user asked Claude to say "hi Kason" (May 29 at 6:59 PM)
### Jun 1, 2026
S925 agent-manager Electron Build v2.10.28 — DMG and ZIP Produced Successfully (Jun 1 at 9:36 AM)
### Jun 4, 2026
S941 agent-manager Electron Build v2.10.28 — DMG + ZIP Produced Successfully (Jun 4 at 8:59 AM)
S946 agent-manager SelectionPopup: Selected text appears lost when custom prompt textarea is focused — fix by adding selection preview (Jun 4 at 8:12 PM)
S973 agent-manager: Recursive fork mode for floating sessions — implement, verify, and document (Jun 4 at 10:23 PM)
### Jun 6, 2026
S1029 agent-manager SessionSwitcher: Add pencil icon hint to session title to improve rename discoverability (Jun 6 at 3:43 PM)
### Jun 8, 2026
S1031 agent-manager SessionSwitcher: Add pencil icon hint to session title for rename discoverability — simplify pass applied (Jun 8 at 9:38 AM)
S1037 agent-manager Full-Screen File View: Hide Session Header When Zoomed In (Jun 8 at 9:51 AM)
6696 11:50a 🟣 agent-manager: Hide Session Numbers/Names in Full-Screen File Zoom View
6697 " 🟣 agent-manager File Viewer: Hide Session Header in Full-Screen Mode
6698 11:51a 🟣 agent-manager Full-Screen File View: Hide Session Header Bar
6699 " 🔵 agent-manager Full-Screen File Viewer: Z-Index Layering Architecture Confirmed
6700 11:53a 🔵 agent-manager SessionSwitcher: CSS lives in DetailPanel.module.css, not SessionSwitcher.module.css
6701 " 🟣 agent-manager: Hide Session Header in Full-Screen File Viewer
6702 11:54a 🔵 agent-manager ProjectTab: Fullscreen File Viewer Not Using createPortal — Parent Session Elements Remain Visible
6703 " 🟣 agent-manager File Viewer: Hide Session Header in Full-Screen Mode
6705 11:55a 🟣 agent-manager Full-Screen File View: Hide Session Header When Zoomed In
6727 1:19p 🔵 agent-manager Feature Docs Manifest: 225 MISSING-FILE Entries Detected
6729 1:20p 🔵 agent-manager Drift Detection False Positives — Files Exist, awk PATH Bug Caused 225 MISSING-FILE
6733 1:24p 🔵 agent-manager Feature Docs: Accurate Drift — 32 Stale Docs, 1 Missing Source, 55 Uncovered Files
6734 " 🔵 agent-manager Git History Since Manifest — 13 Feature Commits Adding AI Popups, Queue Scheduler, Effort Flags
6736 1:26p ⚖️ agent-manager Feature Docs Alignment Plan — 39 Audits + 5 New Docs, All 55 Uncovered Files Assigned
6738 1:27p ⚖️ agent-manager align-feature-docs Workflow — 44 Parallel Agents, Structured DOC_SCHEMA, 6 Finding Kinds
6739 1:28p 🟣 agent-manager align-feature-docs Workflow Launched — 44 Parallel Agents Running
6743 1:36p ✅ agent-manager Feature Docs: session-creation-modals.md Audit & Realignment
6744 " ✅ agent-manager Feature Docs: review-tab.md Audit & Realignment
6745 " ✅ agent-manager Feature Docs: settings-system.md Audit & Realignment
6747 1:37p ✅ agent-manager Feature Docs: terminal-ui.md Major Overhaul
6748 " 🔵 agent-manager: openclaw CLI Type Exists in cliDetect but NOT in settingsStore Sound Profiles
6749 " 🔵 agent-manager: ui-primitives.md Does Not Exist — Multiple Docs Reference a Missing File
6750 " 🔵 agent-manager: App.tsx Bootstrap Architecture — Queue Hydration Before WebSocket Connect
6753 1:40p ✅ agent-manager: websocket-client.md Comprehensively Rewritten with Full Message Contracts
6754 " ✅ agent-manager: views-routing.md Expanded from 53 Lines to Full Architecture Doc
6755 " 🔵 agent-manager: floatingSessionSpawner.ts Full Architecture — Context Inheritance, Recursive Fork, ultracode Injection
6756 " 🔵 agent-manager: Server Startup — Security Headers, WS Origin Validation, CSWSH Prevention
6757 " ✅ agent-manager: Multiple Feature Docs Corrected in Sound/Alarm/TTS System
6758 " 🔵 agent-manager: API Endpoints Comprehensive List — 70+ Routes Confirmed in apiRouter.ts
6759 " 🔵 agent-manager: TTS Hold-to-Speak — Poll Interval 1.2s, readRecentText Returns {text, absBottom}
6760 " 🔵 agent-manager: Workspace Snapshot Export Gating — Only Active Non-Archived Sessions with sshConfig
6768 1:55p ✅ agent-manager: align-existing-feature-docs Skill Re-Invoked — Continuing Feature Doc Alignment Pass
6770 1:56p ✅ agent-manager Feature Docs Audit Complete — 412 Findings Across 39 Docs, 5 New Docs Created
6771 1:57p ✅ agent-manager Feature Docs Alignment — 41 Docs Updated, 5 Created, 6015 Lines Added
6777 3:52p 🔵 agent-manager ConversationView Architecture — JSONL Transcript Fetch with In-Memory Fallback
6778 3:53p 🔵 agent-manager LinkifiedText → uiStore.pendingFileOpen → DetailPanel Navigation Chain
6779 " 🔵 agent-manager Electron main.ts — Pop-Out Terminal Windows, Graceful Shutdown, Loading Screen Architecture
6780 " 🔵 agent-manager Electron Preload API Surface — Full ElectronAPI via contextBridge
6781 " 🔵 agent-manager server/apiRouter.ts File API Endpoint Map
6782 " 🔵 agent-manager PTY Subscribe/Unsubscribe Architecture — Ring Buffer Replay and Per-Renderer Fan-Out
6783 " 🔵 agent-manager File Browser — PDF via iframe Blob URL, No pdf.js Dependency
6784 " 🔵 agent-manager Reveal-in-Finder — Cross-Platform execFile Implementation
6785 " 🔵 agent-manager transcript.ts — JSONL Transcript Fetched via /api/sessions/{id}/transcript
6787 4:06p 🔵 agent-manager useTerminal.ts — Dual Transport: Electron IPC PTY vs WebSocket, with mergeChunks Optimization
6788 " 🔵 agent-manager TerminalContainer — Hold-to-Speak TTS via Spacebar, Polling readRecentText
6789 " 🔵 agent-manager SelectionPopup — Spawns Floating Sessions via POST /api/sessions/spawn-floating
6790 " 🔵 agent-manager fileSystemProvider — LocalFileSystemProvider Uses File System Access API (Chromium Only)
6791 " 🔵 agent-manager package.json — Version 2.10.30, Key Dependencies Confirmed
6796 4:11p 🔵 agent-manager: LinkifiedText.tsx — File-Path Clickable Links in Session Text
6797 " 🔵 agent-manager uiStore: Room Filter, Workspace Load, and File-Open State Architecture
S1048 agent-manager: LinkifiedText.tsx — File-Path Clickable Links in Session Text (Jun 8 at 4:11 PM)

Access 2395k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>