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

# [agent-manager] recent context, 2026-07-29 3:56pm GMT+12

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (29,634t read) | 1,402,108t work | 98% savings

### Jul 17, 2026
S1422 agent-manager: Add sort-by-recent-active-status icon to session rail (no rooms) — triggered /ascii-review-first which surfaced two bugs and one design trap before any code was written (Jul 17 at 5:01 PM)
S1424 electron-build — Build and verify agent-manager v2.10.35 Electron DMG for macOS arm64 (Jul 17 at 5:39 PM)
S1434 YouTube History Tab — Watch History Tracking Bug Reported (Jul 17 at 6:06 PM)
S1468 AASC: Fix room skill icons to same line + persist effort level (ultracode) across workspace restart/resume (Jul 17 at 10:47 PM)
### Jul 18, 2026
S1476 agent-manager: Room session icon alignment (collapse chevron + kill skull on same line) + AASC effort inheritance after restart/resume (Jul 18 at 11:13 AM)
S1585 agent-manager v2.10.38 Electron Release — GitHub release published with full changelog (Jul 18 at 11:31 AM)
S1743 Kokoro TTS On-Disk Integration State Confirmed via History Check (Jul 18 at 9:37 PM)
### Jul 23, 2026
11784 9:49p 🟣 Kokoro-82M Local Browser TTS Added to AASC Terminal
11785 9:50p 🔵 Kokoro TTS On-Disk Integration State Confirmed via History Check
S1755 agent-manager Terminal Left-Alignment Bug — Confirmed Root Cause: fitAddon Hidden-Container Race at 3 Unguarded Call Sites (Jul 23 at 9:50 PM)
### Jul 24, 2026
11838 10:08a 🔵 Terminal Output Garbling — Root Cause Investigation in agent-manager
11848 10:12a 🔵 Terminal Hard-Wrapped at ~30 Cols — Root-Cause Analysis Initiated
11853 10:14a 🔵 agent-manager package.json Has No npm Scripts Defined
11855 10:16a 🔵 Terminal 30-Col Bug — Full Code Trace of Fit/Resize Lifecycle Completed
11857 10:18a 🔵 agent-manager package.json Accidentally Stripped — Scripts/DevDeps/Build Sections Lost
11858 10:19a 🔴 agent-manager package.json Restored — Scripts and DevDependencies Sections Recovered
11860 10:21a 🔵 agent-manager Host Disk Space Survey — Docker Consuming 65GB, Build Context ~2.4GB
11861 " 🔵 Terminal Output Rendering — Messy/Left-Aligned Display Issue Investigated
11863 10:22a 🔵 Terminal Narrow-Width Bug — Root Cause Deep Investigation (agent-manager)
11864 " 🔵 switcherBarVertical flex-wrap:nowrap Already Applied to Fix Title Row Overflow
11866 10:23a 🔵 Terminal "Messy Left-Aligned Output" — Root Cause Traced to FloatingTerminalPanel Viewport Clamp
11868 10:25a 🔵 Ring-Replay Hypothesis Refuted — Terminal Width Bug Is Live-Stream Only, Not Replay Artifact
11874 10:27a 🔵 Terminal Narrow-Col Bug — Root Causes Fully Traced in agent-manager
11876 10:28a 🔵 Agent-Manager Terminal — Messy/Left-Aligned Output Root Cause Investigation
11877 10:29a 🔵 Agent-Manager Terminal — PTY Spawns at Hardcoded 120×40, Resize Race Likely Causes Messy Output
11878 10:31a 🔵 Terminal "Messy Output" Root Cause Investigation — agent-manager Electron App
11881 10:32a 🔵 Terminal Resize Guards — Partial, Not Sufficient to Prevent Narrow-Column Commits
11882 10:33a 🔵 Terminal Output Rendering — Left-Alignment Corruption Investigated
11883 10:34a 🔵 Terminal Left-Alignment Bug — Root Cause Traced to Ring Buffer Replay of Narrow-Column Output
11884 10:35a 🔵 Terminal Layout Bug — FitAddon Source Confirmed: proposeDimensions Uses CSS Width at Measurement Time
11886 10:36a 🔵 Terminal Narrow-Column Bug — Session Switch Triggers Float Remount and Problematic Re-Attach
11891 10:37a 🔵 xterm.js Cell Width Measurement — Two Strategies; OffscreenCanvas Path Bypasses DOM Layout
11892 10:38a 🔵 Root Cause Confirmed — xterm.js Always Uses OffscreenCanvas in Electron; Zero-Width Guard Never Fires
11894 10:39a 🔵 refreshOutput Transport Asymmetry — WS Branch Gets Full Repair via terminal_ready; IPC Branch Does Not
11905 10:42a 🔵 FloatingTerminalPanel.module.css Has CSS Transition at Line 96 — Confirms Animation Race Window
11906 " 🔵 settingsStore fontSize Is UI Root Font-Size (document.documentElement) — NOT xterm Terminal Font
11907 " 🔵 Zoom-as-Root-Cause Refuted — Two Real Secondary Bugs Found: Frozen fontSize and One-Way Panel Width Ratchet
11908 " 🔵 xterm.js css.cell.width Derivation — Device Dimensions / DPR / Cols (Font-Driven, Not Container-Driven)
11922 10:50a 🔵 Local Disk Usage Profile — Claude Projects and Caches
11924 10:52a 🔵 Docker Storage Audit — 50GB+ Reclaimable Space Identified
11931 11:08a 🔵 Terminal Output Messy Left-Alignment — Root Cause Investigation
11932 11:10a 🔵 Terminal Messy Left-Alignment — Root Cause Traced to fitAddon Resize Race in agent-manager
11933 " 🔵 agent-manager Terminal Left-Alignment Bug — Confirmed Root Cause: fitAddon Hidden-Container Race at 3 Unguarded Call Sites
S1753 Terminal output messy and left-aligned — root cause investigation in agent-manager xterm.js terminal (Jul 24 at 11:10 AM)
12027 6:51p 🔵 Agent Manager Queue Panel — Full CSS Class Inventory Traced
12029 6:52p 🟣 Queue Item Click/Keyboard Reorder — ▲/▼ Buttons Added to QueueTab
12030 6:53p 🔵 Queue Reorder UI — HTML Harness Created for Visual Width Testing
12031 6:54p 🔴 Queue Action Row — flex-wrap Added to Prevent Overflow at Narrow Widths
S1765 Queue Panel Docs Updated — ▲/▼ Click Reorder + flex-wrap Documented in prompt-queue.md (Jul 24 at 6:55 PM)
### Jul 25, 2026
12384 7:54p 🔵 agent-manager Pre-Release State — 70 Files Uncommitted Since v2.10.38
12385 7:55p ✅ gitignore Updated — .native-cache/ Added for better-sqlite3 ABI Binaries
12386 7:56p 🔵 kokoro-js Missing from package.json Dependencies Despite Being Used
12387 " ✅ package.json main Field Switched to Electron Build Output
12388 7:57p 🔵 yargs ESM/CJS Conflict on Node.js v26 — require() Fails in ES Module Scope
12389 " 🔵 package-lock.json Was Significantly Stale — 876 Insertions After Sync
12390 7:59p 🟣 agent-manager v2.10.39 Released — Kokoro TTS, Terminal Fixes, Session Identity Hardening
### Jul 27, 2026
12467 6:23a ⚖️ AASC Electron App — Memory Optimization Investigation Initiated
### Jul 29, 2026
12676 3:35p ✅ Kason MCP Removed from Codex
12678 3:38p 🔵 agent-manager (AASC) — No Promotion Docs Found in Project or Memory
12679 " 🔵 agent-manager Docs — No AASC Promotion Content Found

Access 1402k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>
