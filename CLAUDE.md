# AI Agent Session Center

Localhost dashboard (port 3333) that monitors AI coding agent sessions (Claude Code, Gemini CLI, Codex) via hooks. Sessions are visualized as 3D robot characters in an interactive cyberdrome. Supports SSH terminals, team/subagent tracking, prompt queuing, workspace snapshots, and session resume.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 18+ (ESM), Express 5, ws 8, tsx |
| Frontend | React 19, Three.js / @react-three/fiber, Zustand 5, Vite 7 |
| Desktop | Electron 34, electron-builder 25 |
| Terminal | node-pty (IPC in Electron, WebSocket in browser) |
| Hooks | Bash script → JSONL file-based MQ (HTTP POST fallback) |
| Persistence | SQLite / better-sqlite3 (server) + IndexedDB / Dexie (browser) |

## Commands

```bash
npm run dev              # Vite + tsx watch (HMR)
npm run build            # Production build
npm start                # Start production server
npm test                 # Vitest
npm run test:e2e         # Playwright E2E
npm run test:coverage    # Coverage report
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint src/
npm run format           # Prettier
npm run electron:dev     # Build + launch Electron app
npm run electron:build   # Build distributable (DMG/NSIS)
npm run install-hooks    # Install hooks into CLI settings
npm run uninstall-hooks  # Remove all dashboard hooks
npm run setup            # Interactive setup wizard
npm run reset            # Remove hooks, clean config, backup
```

## Feature Documentation

**All feature logic is documented in `docs/feature/`.** Each doc covers function, purpose, source files, implementation, cross-feature dependencies, and change risks.

**MANDATORY WORKFLOW — Before implementing any new feature or modifying an existing one:**
1. Read this CLAUDE.md to identify which feature domain is involved
2. Read the corresponding feature doc(s) in `docs/feature/` to understand the current implementation, source files, dependencies, and change risks
3. Check the Impact Matrix below to identify connected features that may be affected
4. Read those connected feature docs too, so you don't introduce regressions
5. After completing the work, update every feature doc that was affected by the change (via `/update-feature-docs`)

**Feature docs are manifest-backed.** `docs/feature/.manifest.json` is the machine-readable source of truth for file→doc mapping, symbol inventory, and last-aligned timestamps. Skills read and update it — do not edit it by hand. If it drifts, run `/align-existing-feature-docs` (use `--rebuild-manifest` if the manifest itself is corrupted).

| Domain | Docs | What they cover |
|--------|------|----------------|
| [`server/`](docs/feature/server/) | 13 | [Hook System](docs/feature/server/hook-system.md), [Session Management](docs/feature/server/session-management.md), [Session Matching](docs/feature/server/session-matching.md), [Approval Detection](docs/feature/server/approval-detection.md), [WebSocket](docs/feature/server/websocket-manager.md), [API](docs/feature/server/api-endpoints.md), [Database](docs/feature/server/database.md), [Terminal/SSH](docs/feature/server/terminal-ssh.md), [Teams](docs/feature/server/team-subagent.md), [Process Monitor](docs/feature/server/process-monitor.md), [Auth](docs/feature/server/authentication.md), [File Index Cache](docs/feature/server/file-index-cache.md), [Floating Session Spawner](docs/feature/server/floating-session-spawner.md) |
| [`frontend/`](docs/feature/frontend/) | 24 | [State](docs/feature/frontend/state-management.md), [Persistence](docs/feature/frontend/client-persistence.md), [WS Client](docs/feature/frontend/websocket-client.md), [Detail Panel](docs/feature/frontend/session-detail-panel.md), [Conversation View](docs/feature/frontend/conversation-view.md), [Session Summary](docs/feature/frontend/summary-tab.md), [File Browser](docs/feature/frontend/file-browser.md), [Terminal UI](docs/feature/frontend/terminal-ui.md), [Settings](docs/feature/frontend/settings-system.md), [Shortcuts](docs/feature/frontend/keyboard-shortcuts.md), [Queue](docs/feature/frontend/prompt-queue.md), [Queue Scheduler](docs/feature/frontend/queue-scheduler.md), [Command Autocomplete](docs/feature/frontend/command-autocomplete.md), [Views](docs/feature/frontend/views-routing.md), [Agenda](docs/feature/frontend/agenda.md), [Workspace Snapshot](docs/feature/frontend/workspace-snapshot.md), [Setup Wizard](docs/feature/frontend/setup-wizard.md), [Auth UI](docs/feature/frontend/auth-ui.md), [Project Browser](docs/feature/frontend/project-browser.md), [Floating Terminal Fork](docs/feature/frontend/floating-terminal-fork.md), [Review Tab](docs/feature/frontend/review-tab.md), [Session Creation Modals](docs/feature/frontend/session-creation-modals.md), [UI Primitives](docs/feature/frontend/ui-primitives.md), [File Open Chooser](docs/feature/frontend/file-open-chooser.md) |
| [`3d/`](docs/feature/3d/) | 3 | [Cyberdrome Scene](docs/feature/3d/cyberdrome-scene.md), [Robot System](docs/feature/3d/robot-system.md), [Particles/Effects](docs/feature/3d/particles-effects.md) |
| [`multimedia/`](docs/feature/multimedia/) | 2 | [Sound & Alarm System](docs/feature/multimedia/sound-alarm-system.md), [TTS Voice Output](docs/feature/multimedia/tts-voice-output.md) |
| [`electron/`](docs/feature/electron/) | 3 | [App Lifecycle](docs/feature/electron/app-lifecycle.md), [PTY Host](docs/feature/electron/pty-host.md), [IPC Transport](docs/feature/electron/ipc-transport.md) |

See [`docs/feature/README.md`](docs/feature/README.md) for the full index (45 docs), dependency graph, and impact matrix.

## Architecture

### Data Flow

```
AI CLI (Claude/Gemini/Codex)
  → hooks/dashboard-hook.sh (jq enrichment, ~2-5ms)
  → /tmp/claude-session-center/queue.jsonl (atomic append ~0.1ms)
  → server/mqReader.ts (fs.watch + debounce)
  → server/hookProcessor.ts (validate + route)
  → server/sessionStore.ts (state machine + coordinator)
  → server/wsManager.ts (broadcast to browsers)
  → Browser (Zustand stores → React render)
Total: 3-17ms end-to-end
```

### Server Modules

```
server/
  index.ts              — thin orchestrator
  hookInstaller.js      — auto-install hooks on startup
  portManager.ts        — port resolution, conflict kill
  hookRouter.ts         — POST /api/hooks (HTTP fallback)
  apiRouter.ts          — all REST endpoints (~102KB, largest file)
  mqReader.ts           — JSONL queue reader
  hookProcessor.ts      — validation + event processing
  fileIndexCache.ts     — cached + fs.watch'd fuzzy file index
  commandIndex.ts       — slash-command catalog for prompt autocomplete
  floatingSessionSpawner.ts — fork-translate / fork-explain floating PTY spawner
  floatingPrompt.ts     — synthesizes the prompt body for floating fork sessions
  extractPreviousAnswer.ts  — pulls last assistant turn for translate-answer mode
  ttsManager.ts         — Google Cloud TTS proxy
  sessionStore.ts       — coordinator (~57KB, delegates to sub-modules)
    sessionMatcher.ts   — 8-priority session matching
    sessionTitle.ts     — derives/normalizes session display titles
    approvalDetector.ts — tool approval timeouts
    teamManager.ts      — subagent team tracking
    processMonitor.ts   — PID liveness checking
    autoIdleManager.ts  — idle transition timers
  wsManager.ts          — WebSocket broadcast + terminal relay
  sshManager.ts         — SSH/PTY terminal management
  db.ts                 — SQLite (WAL mode, 7 tables)
  authManager.ts        — password auth + tokens
  hookStats.ts          — performance metrics
  config.ts             — tool categories, timeouts
  constants.ts          — event types, statuses, WS message types
  serverConfig.ts       — data/server-config.json loader
  logger.ts             — debug-aware logging
```

### Frontend Modules

```
src/
  stores/               — 11 Zustand stores (session, settings, queue, queueHistory, room, camera, ui, ws, agenda, shortcut, floatingSessions)
  hooks/                — useWebSocket, useTerminal, useSound, useAuth, useKeyboardShortcuts, useKnownProjects, useSettingsInit, useWorkspaceAutoSave, useWorkspaceAutoLoad, useGlobalQueueScheduler, useClickOutside, useSelectionPopup, useDropdownFlipX
  lib/                  — wsClient, db (Dexie), soundEngine, ambientEngine, alarmEngine, workspaceSnapshot, cliDetect, cyberdromeScene, fileSystemProvider, format, robot3DGeometry, robot3DModels, robotPositionPersist, robotStateMap, sceneThemes, shortcutKeys, ansi, remoteControlName, selectionExtractors, tooltips, translationLog, ttsEngine, transcript, commandMessage, queueScheduler, queueHistoryExport, pinnedRespawn, sessionSort, commandIndex, commandSuggestions, timePicker, rehypeSavedSelections, searchNormalize, terminalSend, filePathLink, popupResponse
  components/
    3d/                 — CyberdromeScene, CyberdromeEnvironment, SessionRobot, Robot3DModel, RobotDialogue, RobotLabel, RobotListSidebar, RoomLabels, SceneOverlay, CameraController, StatusParticles, SubagentConnections, robotPositionStore
    session/            — DetailPanel, DetailTabs, ConversationView, ProjectTab, ProjectTabContainer, FloatingTerminalPanel, FloatingTerminalRoot, PopoutTerminalView, FileTree, FindInFileBar, ContentSearchModal, QueueTab, QueueHistorySheet, QueueItemEditModal, LoopExcludeWindowsModal, NotesTab, SummaryTab, SummarizeModal, AiPopupHistory, SessionControlBar, SessionSwitcher, LinkifiedText, KillConfirmModal, AlertModal, FileOpenChooser, PopupResponse, TexViewer, imageViewport
    terminal/           — TerminalContainer, TerminalToolbar, themes
    translate/          — SelectionPopup
    settings/           — SettingsPanel (7 tabs), ThemeSettings, SoundSettings, ShortcutSettings, HookSettings, ApiKeySettings, TranslationSettings, SummaryPromptSettings
    modals/             — NewSessionModal, QuickSessionModal, GlobalSearchModal, RestorePickerModal, ShortcutSettingsModal, ShortcutsPanel, ShortcutRow
    layout/             — NavBar, Header, HeaderAgentStrip, TitleBar, WorkdirLauncher
    agenda/             — AddTaskForm, AgendaFilterBar, AgendaTaskCard
    auth/               — LoginScreen
    setup/              — SetupWizard + steps/ (Welcome, DepsCheck, Configure, Install, Done)
    ui/                 — Combobox, Modal, ResizablePanel, Select, Tabs, AutocompleteTextarea, TimePicker12, ToastContainer, SavingOverlay, WorkspaceLoadingOverlay, SearchInput, Tooltip
  routes/               — LiveView, HistoryView, ProjectBrowserView, QueueView, AgendaView, ReviewView
  styles/               — CSS modules + 9 theme files
  types/                — shared TypeScript types (server + client)
```

### Electron

```
electron/
  main.ts               — app lifecycle, BrowserWindow, embedded Express server
  preload.ts            — contextBridge (electronAPI)
  ptyHost.ts            — VS Code-style PTY host (node-pty, 128KB ring buffer)
  tray.ts               — system tray
  ipc/                  — setupHandlers, appHandlers, terminalHandlers
```

Dual terminal transport: IPC (Electron, ~0.1ms) vs WebSocket (browser, ~1-5ms). Renderer auto-detects via `window.electronAPI?.createPty`.

## Session State Machine

```
SessionStart       → idle       (Idle animation)
UserPromptSubmit   → prompting  (Walking + Wave, seeks desk)
PreToolUse         → working    (Running, tool-specific animation)
PostToolUse        → working    (stays)
[timeout]          → approval   (Waiting — needs tool approval)
[timeout]          → input      (Waiting — needs user answer)
PermissionRequest  → approval   (reliable signal, overrides heuristic)
Stop               → waiting    (ThumbsUp/Dance)
[2min idle]        → idle
SessionEnd         → ended      (Death — kept in memory)
```

## Impact Matrix

Before modifying a feature, check what else it can break:

| Change | Impacts |
|--------|---------|
| Hook script / MQ format | Session Matching, Session Management, Hook Stats |
| Session state machine | 3D Robots, Sound/Alarms, Approval Detection, Auto-Idle, all frontend stores |
| Session Matching | Terminal/SSH, Session Resume, Team linking |
| WebSocket protocol | Frontend WS Client, Terminal UI, all real-time UI |
| API contracts | ALL frontend HTTP calls, Electron PTY registration |
| DB schema | API Endpoints, Client Persistence (IndexedDB mirror) |
| Terminal/SSH | Session Matching (pending links), PTY Host registration |
| Zustand store shapes | ALL subscribing components |
| Theme CSS variables | ALL visual components (2D + 3D), Terminal themes |
| Electron IPC channels | Preload bridge, Terminal UI dual transport |
| Queue scheduler tick / `queueHistoryStore` | Prompt Queue, Loops, per-session automation, Client Persistence (queueHistory) |
| Command/file index (`commandIndex`) | Command Autocomplete, Prompt Queue editor, Queue Tab |
| Transcript reconstruction (`transcript.ts` / `commandMessage.ts`) | Conversation View, Review Tab (AI Popups) |
| Floating session spawn / fork | Floating Terminal Fork, Floating Session Spawner, Review Tab, pop-out window, Session Matching |
| Shared UI primitives (Modal/Select/Tabs/Tooltip) | ALL components that consume them (Settings, modals, panels) |
| TTS / GCP API key | Settings toggle, Terminal UI hold-to-speak, `/api/tts/*` endpoints — per-user `googleTtsApiKey` stored client-side, forwarded per request. **Never** reintroduce ambient credentials (gcloud ADC / service-account files) — leaks across users |

## Key Invariants

- **Never mutate session objects** — always spread/new Map
- **Never use Zustand inside R3F Canvas** — causes React Error #185; all store reads in DOM layer, data flows via props
- **Never block the hook script** — background subshell (`& disown`) for all processing
- **Never hardcode port 3333** — read from config/env/CLI flag
- **Never modify `~/.claude/settings.json` without atomic write** — write-to-tmp + rename
- **Server imports use `.js` extensions** — required for NodeNext module resolution with tsx
- **File browser uses `resolveProjectPath()`** — prevents directory traversal
- **SSH inputs validated with Zod + shell metacharacter regex** — prevents injection
- **Floating overlays must stay inside the viewport** — any `position: absolute`/`fixed` dropdown, popover, menu, flyout, or context menu must handle the viewport edge: vertical flip (`Select`'s `flipUp`), horizontal nudge ([`useDropdownFlipX`](src/hooks/useDropdownFlipX.ts)), or coordinate clamp (`clampToViewport` in FileOpenChooser/LabelPicker/SelectionPopup). **Never ship a `right: 0` / `left: 0` / `*: 100%`-anchored menu with no edge guard** — near a window edge it clips its own content. This is a runtime bug no linter catches; it is review-time + render-checked (run `/frontend-ui-polish` on a narrow-window screenshot).
- **Never write test/debug screenshots to the repo root** — Playwright/MCP captures and scratch images go to `test-screenshots/` (gitignored) or `/tmp`; images that ship live in `static/` only. `.gitignore` blocks committing any stray image outside `static/`, but root dumps still clutter the working tree, so always pass an absolute path under a scratch dir when capturing.
