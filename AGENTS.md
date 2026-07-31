# AI Agent Session Center: Agent Guidance

This file is the durable coding-agent entrypoint for this repository. It is
based on `CLAUDE.md`; read `CLAUDE.md` for the full architecture notes and keep
the two files aligned when project guidance changes.

## Project Snapshot

AI Agent Session Center is a localhost dashboard on port 3333 for monitoring AI
coding agent sessions from Claude Code, Codex, and related tools. It
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

# [agent-manager] recent context, 2026-07-31 12:16pm GMT+12

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (21,805t read) | 634,122t work | 97% savings

### Jul 29, 2026
S1836 Fix terminal tab "need to reconnect" bug + incorrect session name in common room — code path investigation completed (Jul 29 at 9:48 PM)
S1837 docs/feature/.manifest.json — Atomically Updated to 46 Features with saved-prompts.md (Jul 29 at 11:28 PM)
### Jul 30, 2026
S1839 agent-manager Electron Distributable Build — Completed Successfully (Jul 30 at 11:28 AM)
S1846 agent-manager Electron Distributable Built — v2.10.40 (Jul 30 at 1:17 PM)
S1882 agent-manager Electron Build Status Check — Is the build done? (Jul 30 at 2:31 PM)
S1891 macOS WindowServer High CPU Usage — Root Cause Investigation on Apple M4 Mac (Jul 30 at 8:21 PM)
S1904 User sent "of" — ambiguous/incomplete message, no actionable request (Jul 30 at 8:48 PM)
### Jul 31, 2026
S1906 Interruption Detection Daemon Feature Requested for Queue System (Jul 31 at 4:31 AM)
S1910 Interrupt Detection Daemon Proposed for Agent Queue System (Jul 31 at 9:55 AM)
13365 11:37a 🔵 appendSessionName in server/config.ts Only Escapes Double Quotes — Shell Injection Confirmed
13366 " 🟣 sessionNameQuoting.test.ts — Comprehensive Shell Safety Test Suite Created
13367 11:38a 🔵 agent-manager Session Name Shell Injection — Root Cause and Fix Scope Identified
13368 " 🔴 server/config.ts — CONTROL_CHARS_RE Regex Fixed: Raw Bytes Replaced with Escaped Sequences
13369 11:39a 🔴 electron/ptyHost.ts Shell Injection Fixed — Session Title Properly Escaped
13370 " 🔵 Test Failure — Mirror Drift Detector Regex Pattern Needs Adjustment
13371 " 🔴 agent-manager Session Name Shell Injection — Full Fix Applied to server/config.ts and electron/ptyHost.ts
13372 11:40a 🔴 agent-manager Resume Command Verbosity — Root Cause Was Long-Form Fallback Pattern, Not a Bug
13373 " ⚖️ Shell Safety Approach — Escape All Double-Quote-Context Metacharacters, Not Just Quotes
13374 11:41a ✅ agent-manager Session Name Quoting — Work Complete, Tests at 32/33
13375 " 🟣 sessionNameQuoting.test.ts — extractSessionName and stripClaudeSessionName APIs Confirmed
13376 11:42a ✅ CLAUDE.md — Session Title Shell Injection Invariant Added to Key Invariants Section
13377 " 🔵 buildResumeCommand — `--continue` Fallback Deliberately Avoided; Fresh Claude Used Instead
13378 " ⚖️ Daemon Feature Proposed — Interrupt Detection with Auto-Prompt Resume
13379 11:43a ⚖️ Daemon Feature Proposed — Session Interrupt Detection with Auto-Resume Prompt
13380 11:44a ⚖️ Interrupt Detection Daemon Proposed for Agent Queue System
13381 " ⚖️ Interrupt Detection Daemon Proposed for Agent Queue System
13382 " ⚖️ Interrupt Detection Daemon Proposed for Agent Queue System
13383 11:45a 🔴 Session Name Shell Injection Fixed — `appendSessionName` Now Shell-Quotes Titles
13384 " 🔴 CLAUDE_CODE_CHILD_SESSION Env Stripping Expanded — Transcript Persistence Now Reliable
13385 " 🔴 `hasChildProcesses` Made Async — Event Loop No Longer Blocked on `pgrep`
13386 " 🟣 Interruption Detector — PTY Scans for Transient Failure Banners (529, 5xx, Rate Limit)
13387 " 🟣 Resume Command Shortened When Transcript Verified on Disk
13388 " 🔴 Hookless CLI Model Field Fixed — No Longer Stores Full Launch Command as Model
13389 " 🟣 Server Logger Now Persists to Disk with Rotation — Packaged Electron Logs Survive
13390 " ✅ Build Toolchain Upgraded — Node 22, `@electron/rebuild` 4.2.0, `node-gyp` 12.4.0
13392 11:48a ✅ agent-manager — Large Multi-Fix Branch Staged for Code Review (56 Files, ~1,929 Insertions)
13395 11:50a ✅ Gemini Hook Support Deprecated — Uninstall Cleanup Added to Hook Installer
13396 " 🔴 Approval Timer — `isAgentBusyOutput` Guard Added for In-Process Thinking
13397 " 🔵 Queue Scheduler `pickNext` Priority Order — 5 Tiers Confirmed
13398 11:51a 🔵 Queue Store — `DEFAULT_AUTOMATION` Stable Reference Prevents Infinite Re-Renders
13399 " ✅ Gemini CLI Removed from `commandIndex.ts` — Zero Remaining References
13400 " 🔵 Queue DnD Probe Script — 5-Config Matrix Tests `setDragImage` / `.dragging` / Re-render
13401 11:52a ✅ Gemini Removed from `floatingSessionSpawner.ts` — TypeScript Typecheck Passes Clean
13402 " 🟣 Auto-Resume Watchdog — UI Toggle + Scheduler Integration in Queue System
13403 " ⚖️ Gemini Event Constants Retained in `EVENT_TYPES` — Backward-Compat for Legacy Hook Data
13404 11:53a ✅ Gemini CLI Deprecation — Server-Side Removal Completed Across 3 Files
13405 11:54a 🔵 Frontend Gemini Surface Map — 13 Component Files Still Reference Gemini
13406 " ✅ Gemini Deprecation — Frontend Component Cleanup Still Pending After Lib/Store Pass
13408 11:55a ⚖️ Gemini Deprecation Strategy — Phased Removal with Backward-Compat Stubs
13410 11:59a 🔴 settingsStore test: codex default volume corrected from 0.7 to 0.5
13411 " 🔴 extractModelFromCommand regression — returns "" for ANSI-contaminated strings with spaces
13412 " 🔄 Gemini test cases removed from floatingSpawnerCli and constants test files
13414 12:02p 🔵 Kokoro TTS Click-to-Speak Debug Investigation — Build Audit
13415 12:03p ✅ Feature Docs Updated — Gemini Deprecation Phase 1
13416 12:04p ✅ Feature Docs Purged of Gemini References — 9 Files + Manifest Updated
13417 12:05p 🔵 Kokoro TTS Worker Runtime Diagnostic — Worker Functional, No COOP/COEP Headers
13421 12:06p ✅ update-feature-docs Session Complete — Gemini Purge Across Docs and Manifest
13422 12:07p ✅ Gemini Deprecation Docs — Final Sweep, AGENTS.md Cleaned, Audit Report Written
13423 " 🔵 Kokoro TTS Worker Fully Functional — UI Click Path Is the Bug, Not the Worker
S1914 Kokoro TTS Worker Fully Functional — UI Click Path Is the Bug, Not the Worker (Jul 31 at 12:07 PM)

Access 634k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>
