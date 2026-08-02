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

# [agent-manager] recent context, 2026-08-02 11:08pm GMT+12

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (18,922t read) | 1,798,599t work | 99% savings

### Jul 30, 2026
S1846 agent-manager Electron Distributable Built — v2.10.40 (Jul 30 at 1:17 PM)
S1882 agent-manager Electron Build Status Check — Is the build done? (Jul 30 at 2:31 PM)
S1891 macOS WindowServer High CPU Usage — Root Cause Investigation on Apple M4 Mac (Jul 30 at 8:21 PM)
S1904 User sent "of" — ambiguous/incomplete message, no actionable request (Jul 30 at 8:48 PM)
### Jul 31, 2026
S1906 Interruption Detection Daemon Feature Requested for Queue System (Jul 31 at 4:31 AM)
S1910 Interrupt Detection Daemon Proposed for Agent Queue System (Jul 31 at 9:55 AM)
S1914 Kokoro TTS Worker Fully Functional — UI Click Path Is the Bug, Not the Worker (Jul 31 at 11:44 AM)
S1918 agent-manager v2.10.40 — Built and Packaged with interruptionDetector, crashLogger, and Session Name Quoting Fix (Jul 31 at 12:07 PM)
S1919 Local TTS Feature — WebGPU vs WASM performance investigation and review-first plan for on-device text-to-speech (Jul 31 at 2:58 PM)
### Aug 1, 2026
13645 11:59a 🔵 agent-manager Font Architecture — JetBrains Mono Primary, Share Tech Mono in 3D Components
13646 12:00p 🟣 Windows XP Theme — New UI Theme Requested via Screenshot Reference
13647 12:01p 🔴 TexViewer Font Override Fix for Windows XP Theme
13648 " 🟣 Windows XP Theme Added to agent-manager UI via URL Query Param
13649 12:02p 🔵 Windows XP Theme Renders Without Console Errors; Settings Button Functional
13650 12:04p 🔵 Windows XP Theme — Full Theme Swatch List + Settings Panel Visual Verified
13651 " 🔴 Windows XP 3D Theme — Lighting Overexposure Fix for Bliss Grass Colors
13652 12:05p 🔵 Windows XP Theme Verified via Playwright Screenshot After Color Fix
13653 12:06p 🟣 Windows XP Theme — CSS Font Stack Verified via Playwright
13654 " 🟣 Windows XP Theme — New UI Theme Requested via Screenshot Reference
13655 12:07p 🟣 Windows XP Theme Added to agent-manager
13656 " 🔵 Windows XP Theme Files — Feature Doc Mapping Audit
13657 12:08p 🟣 Windows XP Theme — New UI Theme Requested via Screenshot Reference
13658 " 🟣 Windows XP Theme Added to agent-manager — Luna Palette + Font + Chrome Override
13659 12:09p 🟣 Windows XP Style Theme — Addition Requested via Image Reference
13660 12:10p 🟣 Windows XP (Luna) Theme Added to agent-manager
13661 " 🟣 Windows XP Theme Added — Font Override Architecture for TexViewer Compatibility
13662 12:13p 🟣 Windows XP Theme Request Initiated — Agent Manager UI
13663 12:14p 🔵 agent-manager — Hardcoded #0a0a1a Dark Backgrounds Pre-Date Theme Application
13664 " ✅ agent-manager Default Theme Changed from command-center to windows-xp
13665 12:15p 🔴 Flash-of-Dark-Content Fixed — Pre-Theme Paint Sites Updated for Windows XP Default
13666 12:16p 🟣 Windows XP Theme — Build Verification + First-Run Harness Mode
13667 12:17p 🔵 Windows XP Theme — Runtime CSS Variables and Font Verified via Playwright
13668 12:18p 🟣 Windows XP Theme Addition — New UI theme styled after Windows XP added to agent-manager
13669 12:20p 🟣 Windows XP Theme Addition — New UI theme styled after Windows XP added to agent-manager
13670 12:22p 🟣 Windows XP Theme Addition — New UI theme styled after Windows XP added to agent-manager
13671 12:24p 🔵 agent-manager Feature Doc Manifest — index.html Has No Mapped Feature Doc
13672 12:26p 🟣 Windows XP Theme Addition — User Request to Add XP-Style UI Theme
13673 12:29p 🟣 Windows XP Theme Addition — Final Verification Results
13674 12:30p 🔵 firstRunFlow.test.tsx — Two Flaky Tests Timing Out After XP Theme Addition
13675 12:31p 🟣 Windows XP Theme Addition — New UI theme styled after Windows XP added to agent-manager
13676 12:32p 🔵 XP Theme WIP Stashed — Regression Tests Verified Before Re-Apply
13677 12:36p 🟣 Windows XP Theme Addition — New UI theme styled after Windows XP added to agent-manager
13678 12:41p 🔵 agent-manager Z-Index Layer Map — Queue Move Picker Investigation
13679 " 🔵 Queue Items Not Rendering in Harness — IndexedDB Seed Version Mismatch
13680 12:42p 🔵 Queue Panel Toggle Behavior in Harness — Zero-Width Textareas After Expand
13681 12:43p 🔵 Queue ADD Button Fails in Static Harness — API Write Blocked by Stub
13682 12:46p 🔵 Queue Move Action Root Cause — z-index 50 Buried Behind Detail Panel at 100
13683 " 🔴 Queue Move Picker z-index Fixed from 50 → 10050 — MOVE Action Now Works
13684 12:47p ✅ Queue Move Picker Fix Verified in Production Build
13685 12:51p ✅ Post-Fix Full Verification — Typecheck Clean, Tests 1541/1548 Pass
13686 12:52p 🔴 Queue MOVE Picker Fix Committed — dd20c77
13687 12:57p ✅ update-feature-docs Skill Invoked After Windows XP Theme Addition
13688 " 🔵 update-feature-docs Audit — File-to-Doc Mapping with 3 Unmapped Files
13690 12:58p 🔵 Root index.ts is a Stale Orphaned Copy of server/index.ts
13691 " 🔵 update-feature-docs Session Interrupted — Partial Audit Complete
13692 12:59p 🔵 update-feature-docs — Session Awaiting Tool Execution Data
13693 1:00p 🔵 update-feature-docs Skill — Repeated Interruptions, No Doc Writes Completed
13694 1:01p 🔵 update-feature-docs — No New Tool Outputs in Latest Continuation
S1931 User said "hi" — session status check after prior work on agent-manager app (Aug 1 at 2:54 PM)
13723 8:11p 🔵 agent-manager Product Identity — Name, Version, and Purpose Confirmed

Access 1799k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>
