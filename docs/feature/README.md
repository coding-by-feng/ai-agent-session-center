# AI Agent Session Center — Feature Documentation

Feature documentation organized by domain. Each doc describes function, purpose, source files, implementation details, and cross-feature dependencies.

> Manifest-backed: `docs/feature/.manifest.json` is the machine-readable source of truth for file→doc mapping, symbol inventory, and last-aligned timestamps. This index is regenerated from it — do not hand-edit the manifest. Run `/align-existing-feature-docs` to reconcile, or `/update-feature-docs` after a change.

## Index

### Server (`server/`)

| Doc | Feature | Key Files |
|-----|---------|-----------|
| [API Endpoints](server/api-endpoints.md) | Provides all HTTP REST API endpoints for session management, terminal creation, file browsing, analytics… | `server/apiRouter.ts`, `server/constants.ts`, `server/index.ts` |
| [Approval Detection](server/approval-detection.md) | Detects when a session is waiting for user approval (tool permission) or user input using timeout heuristics | `server/approvalDetector.ts`, `server/config.ts`, `server/sessionStore.ts` |
| [Authentication](server/authentication.md) | Optional password-based authentication for the dashboard, protecting API endpoints and WebSocket connections | `server/authManager.ts`, `server/serverConfig.ts` |
| [Database](server/database.md) | Persistent storage for sessions, prompts, responses, tool calls, events, notes, and agenda tasks (better-sqlite3, WAL) | `server/db.ts` |
| [File Index Cache](server/file-index-cache.md) | Per-project cached + fs.watch'd file index for fast fuzzy file search | `server/fileIndexCache.ts`, `server/apiRouter.ts` |
| [Floating Session Spawner](server/floating-session-spawner.md) | Builds a synthesized prompt for a selection-popup / translate action and spawns a fork-style CLI session in the origin's workdir | `server/floatingSessionSpawner.ts`, `server/floatingPrompt.ts`, `server/extractPreviousAnswer.ts` |
| [Hook System](server/hook-system.md) | Captures AI CLI lifecycle events via bash hook scripts and delivers them through a file-based JSONL queue (HTTP fallback) | `hooks/dashboard-hook.sh`, `hooks/dashboard-hook-gemini.sh`, `server/mqReader.ts` |
| [Process Monitor](server/process-monitor.md) | Periodically checks whether AI CLI processes are still alive and transitions dead sessions to ended | `server/processMonitor.ts`, `server/autoIdleManager.ts`, `server/config.ts` |
| [Session Management](server/session-management.md) | Coordinates session lifecycle, state transitions, and in-memory storage via the coordinator pattern | `server/sessionStore.ts`, `server/sessionMatcher.ts`, `server/sessionTitle.ts` |
| [Session Matching](server/session-matching.md) | Links incoming hook events (unknown session IDs) to terminal sessions via an 8-priority cascade | `server/sessionMatcher.ts` |
| [Team / Subagent](server/team-subagent.md) | Tracks parent-child relationships between agent sessions (teams) and links subagents to their parent | `server/teamManager.ts`, `src/types/team.ts` |
| [Terminal / SSH](server/terminal-ssh.md) | Creates and manages PTY terminal processes for SSH connections, local shells, and tmux sessions | `server/sshManager.ts`, `server/config.ts`, `src/types/terminal.ts` |
| [WebSocket Manager](server/websocket-manager.md) | Broadcasts session state changes, relays terminal I/O, and handles reconnect replay | `server/wsManager.ts` |

### Frontend (`frontend/`)

| Doc | Feature | Key Files |
|-----|---------|-----------|
| [Agenda / Tasks](frontend/agenda.md) | Personal todo list with priority, tags, optional due date, and completion tracking + `/api/agenda` CRUD | `src/stores/agendaStore.ts`, `src/routes/AgendaView.tsx`, `src/components/agenda/AgendaFilterBar.tsx` |
| [Auth UI](frontend/auth-ui.md) | Client half of password auth: single-field login form plus the `useAuth` hook (status, login/out, token) | `src/components/auth/LoginScreen.tsx`, `src/hooks/useAuth.ts` |
| [Client Persistence](frontend/client-persistence.md) | Browser IndexedDB via Dexie.js — 15 tables mirroring server data plus local-only settings/queue/translation state | `src/lib/db.ts` |
| [Command Autocomplete](frontend/command-autocomplete.md) | Inline `/`-slash-command + `@`-file autocomplete inside prompt textareas (queue editor, queue tab) | `src/lib/commandIndex.ts`, `server/commandIndex.ts`, `src/components/ui/AutocompleteTextarea.tsx` |
| [Conversation View](frontend/conversation-view.md) | Renders the full interleaved transcript of a session — prompts, responses, tool calls/results, lifecycle | `src/components/session/ConversationView.tsx`, `src/lib/transcript.ts`, `src/components/session/DetailPanel.tsx` |
| [File Browser](frontend/file-browser.md) | VS Code-style project file browser: lazy tree + multi-tab viewer with fuzzy find, image/TeX viewers | `src/components/session/ProjectTabContainer.tsx`, `src/components/session/ProjectTab.tsx`, `src/components/session/FileTree.tsx` |
| [File-Open Chooser](frontend/file-open-chooser.md) | Anchored popover on file-path link clicks: open in app, open with OS default app, or reveal in Finder | `src/components/session/FileOpenChooser.tsx`, `src/components/session/LinkifiedText.tsx`, `src/lib/fileSystemProvider.ts` |
| [Floating Terminal Fork](frontend/floating-terminal-fork.md) | Spawns a forked AI CLI session in a draggable picture-in-picture window for explain/translate/define/vocab flows | `src/components/translate/SelectionPopup.tsx`, `src/components/session/FloatingTerminalPanel.tsx`, `src/stores/floatingSessionsStore.ts` |
| [Keyboard Shortcuts](frontend/keyboard-shortcuts.md) | Global rebindable keyboard shortcuts with context-aware suppression and conflict detection | `src/hooks/useKeyboardShortcuts.ts`, `src/stores/shortcutStore.ts`, `src/lib/shortcutKeys.ts` |
| [Project Browser](frontend/project-browser.md) | Standalone full-page browser at `/project-browser?path=…&file=…`, reusing `ProjectTab` | `src/routes/ProjectBrowserView.tsx`, `src/hooks/useKnownProjects.ts`, `src/components/session/ProjectTab.tsx` |
| [Prompt Queue](frontend/prompt-queue.md) | Per-session prompt queuing with drag-reorder, cross-session moves, attachments, and per-session automation | `src/stores/queueStore.ts`, `src/components/session/QueueTab.tsx`, `src/routes/QueueView.tsx` |
| [Queue Scheduler & History](frontend/queue-scheduler.md) | App-level 1s tick that fires due queue items, plus queue history/favorites, loop scheduling, and quiet-hours windows | `src/lib/queueScheduler.ts`, `src/hooks/useGlobalQueueScheduler.ts`, `src/stores/queueHistoryStore.ts` |
| [Review Tab](frontend/review-tab.md) | Persists every selection / translate / AI-popup action with context and surfaces the history (favorites, aliases, notes, archive) | `src/routes/ReviewView.tsx`, `src/components/session/AiPopupHistory.tsx`, `src/lib/translationLog.ts` |
| [Session Creation Modals](frontend/session-creation-modals.md) | Entry points for launching sessions — NewSessionModal (local-only) + WorkdirLauncher + QuickSessionModal | `src/components/modals/NewSessionModal.tsx`, `src/components/modals/QuickSessionModal.tsx`, `src/components/layout/WorkdirLauncher.tsx` |
| [Session Detail Panel](frontend/session-detail-panel.md) | Slide-in panel with 7 tabs, session switcher, control bar, and split/floating PROJECT modes | `src/components/session/DetailPanel.tsx`, `src/components/session/DetailTabs.tsx`, `src/components/session/SessionControlBar.tsx` |
| [Session Summary](frontend/summary-tab.md) | AI-generated single-paragraph session summaries: read-only Summary tab + Summarize modal + prompt settings | `src/components/session/SummaryTab.tsx`, `src/components/session/SummarizeModal.tsx`, `src/components/settings/SummaryPromptSettings.tsx` |
| [Settings System](frontend/settings-system.md) | 7-tab settings panel, theme system (9 themes), per-CLI sound profiles, API-key storage, voice/summary prefs | `src/components/settings/SettingsPanel.tsx`, `src/components/settings/ThemeSettings.tsx`, `src/components/settings/SoundSettings.tsx` |
| [Setup Wizard](frontend/setup-wizard.md) | First-run onboarding (deps, config, hook install) over `data/server-config.json` | `src/components/setup/SetupWizard.tsx`, `src/components/setup/steps/WelcomeStep.tsx`, `src/components/setup/steps/DepsCheckStep.tsx` |
| [Shared UI Primitives](frontend/ui-primitives.md) | Reusable React building blocks: Modal, Select, Combobox, Tabs, Tooltip, ResizablePanel, ToastContainer, SearchInput | `src/components/ui/Modal.tsx`, `src/components/ui/Select.tsx`, `src/components/ui/Tabs.tsx` |
| [State Management](frontend/state-management.md) | 11 Zustand stores (session, WS, UI, settings, queue, queue-history, camera, room, shortcut, agenda, floatingSessions) | `src/stores/sessionStore.ts`, `src/stores/wsStore.ts`, `src/stores/uiStore.ts` |
| [Terminal UI](frontend/terminal-ui.md) | xterm.js 5 with dual transport (IPC/WS), bookmarks, fork/clone, select-to-translate, hold-to-speak | `src/hooks/useTerminal.ts`, `src/components/terminal/TerminalContainer.tsx`, `src/components/terminal/TerminalToolbar.tsx` |
| [Views / Routing](frontend/views-routing.md) | App entry, React Router route tree, persistent layout chrome (title bar, header, nav, activity feed, global search) | `src/main.tsx`, `src/App.tsx`, `src/components/layout/TitleBar.tsx` |
| [WebSocket Client](frontend/websocket-client.md) | Browser WebSocket with auto-reconnect, event replay, backpressure protection, and message routing | `src/lib/wsClient.ts`, `src/hooks/useWebSocket.ts`, `src/types/websocket.ts` |
| [Workspace Snapshot](frontend/workspace-snapshot.md) | Serializes the live workspace (sessions, sub-tabs, rooms, scrollback prefill) for save/restore | `src/lib/workspaceSnapshot.ts`, `src/hooks/useWorkspaceAutoSave.ts`, `src/hooks/useWorkspaceAutoLoad.ts` |

### 3D Scene (`3d/`)

| Doc | Feature | Key Files |
|-----|---------|-----------|
| [Cyberdrome Scene](3d/cyberdrome-scene.md) | Interactive R3F 3D office where each session is a navigating robot in a room-based layout | `src/components/3d/CyberdromeScene.tsx`, `src/components/3d/CyberdromeEnvironment.tsx`, `src/components/3d/CameraController.tsx` |
| [Particles & Effects](3d/particles-effects.md) | Status-transition particle bursts and animated subagent connection beams between parent/child robots | `src/components/3d/StatusParticles.tsx`, `src/components/3d/SubagentConnections.tsx` |
| [Robot System](3d/robot-system.md) | Animated robot characters with navigation AI, 8 animation states, and 6 model variants | `src/components/3d/SessionRobot.tsx`, `src/components/3d/Robot3DModel.tsx`, `src/components/3d/RobotDialogue.tsx` |

### Multimedia (`multimedia/`)

| Doc | Feature | Key Files |
|-----|---------|-----------|
| [Sound & Alarm System](multimedia/sound-alarm-system.md) | Three-layer audio: 15 synthesized event sounds, 5 ambient presets, approval/input alarms | `src/lib/soundEngine.ts`, `src/lib/ambientEngine.ts`, `src/lib/alarmEngine.ts` |
| [TTS Voice Output](multimedia/tts-voice-output.md) | Hold-Space bilingual (EN+zh) text-to-speech of the latest terminal output via Google Cloud TTS | `server/ttsManager.ts`, `src/lib/ttsEngine.ts`, `src/hooks/useTerminal.ts` |

### Electron (`electron/`)

| Doc | Feature | Key Files |
|-----|---------|-----------|
| [App Lifecycle](electron/app-lifecycle.md) | Main process: app lifecycle, BrowserWindow, system tray, setup-wizard IPC, embedded Express server | `electron/main.ts`, `electron/tray.ts`, `electron/ipc/appHandlers.ts` |
| [IPC Transport](electron/ipc-transport.md) | Bridges renderer ↔ main (PTY host, setup wizard, lifecycle) via typed IPC + preload contextBridge | `electron/ipc/terminalHandlers.ts`, `electron/preload.ts`, `src/types/electron.d.ts` |
| [PTY Host](electron/pty-host.md) | VS Code-style node-pty host in the main process with IPC relay, output buffering, shell-ready detection | `electron/ptyHost.ts` |

---

## Cross-Feature Dependency Graph

```
Hook System ──────────────────┐
  (bash MQ, JSONL)            │
                              ▼
                     Session Management ◄──── Process Monitor
                     (coordinator hub)        (PID liveness)
                        │  │  │
          ┌─────────────┘  │  └──────────────┐
          ▼                ▼                  ▼
   Session Matching   Approval Detection   Team/Subagent
   (8-priority)       (timeout heuristic)  (parent-child)
                              │
                              ▼
                     WebSocket Manager ────► Frontend WS Client
                     (broadcast + relay)     (reconnect, replay)
                        │                        │
          ┌─────────────┤                        ▼
          ▼             ▼                 State Management
    Terminal/SSH    API Endpoints          (11 Zustand stores)
    (PTY, buffer)  (REST routes)              │
          │             │              ┌──────┼──────────┐
          ▼             ▼              ▼      ▼          ▼
     PTY Host      Database      3D Scene  Detail     Settings
     (Electron)    (SQLite)      (R3F)     Panel      System
          │                         │        │
          ▼                         ▼        ▼
    IPC Transport              Robot Sys  Terminal UI
    (preload bridge)           Particles  File Browser
                                          Queue, Shortcuts
                               Sound & Alarm System
                               (approval alarms, event sounds)
```

### Additional Frontend Feature Layers

Newer feature docs that build on the core graph above:

- **Queue Scheduler & History** → Prompt Queue, State Management (queue-history store), Client Persistence, Terminal UI (auto-send), Loops/quiet-hours.
- **Command Autocomplete** → API Endpoints (`/api/commands`, file index), Prompt Queue editor, Queue Tab, Shared UI Primitives.
- **Conversation View** & **Session Summary** → Session Detail Panel (tabs), API Endpoints, Database/Client Persistence.
- **Floating Terminal Fork** ↔ **Floating Session Spawner** (server) → Review Tab, Terminal UI, Session Matching, pop-out window.
- **Review Tab** → Floating Terminal Fork, Client Persistence (translationLogs), API Endpoints.
- **Shared UI Primitives** → consumed by Settings, Session Creation Modals, all panels/modals.
- **Views / Routing** → hosts Live / History / Queue / Agenda / Review / Project-Browser routes + global search overlay.

## Impact Matrix

When modifying a feature, check which features it can affect:

| If you change... | Check these features for impact |
|------------------|-------------------------------|
| Hook script / MQ format | Session Matching, Session Management, Hook Stats |
| Session state machine | 3D Robots, Sound/Alarms, Approval Detection, Auto-Idle, Frontend stores |
| Session Matching priorities | Terminal/SSH, Session Resume, Team linking, Floating fork resolution |
| WebSocket protocol | Frontend WS Client, Terminal UI, All real-time UI |
| API endpoint contracts | ALL frontend HTTP calls, Electron PTY registration, Command Autocomplete |
| Database schema | API Endpoints, Client Persistence (IndexedDB mirror), Conversation View, Summary |
| Terminal/SSH creation | Session Matching (pending links), PTY Host registration |
| Zustand store shapes | ALL components that subscribe to stores |
| Theme CSS variables | ALL visual components (2D + 3D), Terminal themes |
| Sound action mappings | Settings panel, Alarm engine, Per-CLI profiles |
| Electron IPC channels | Preload bridge, Terminal UI dual transport |
| Robot animation states | Robot state map, Settings (character model), 3D scene, Particles |
| Queue scheduler tick / queue-history store | Prompt Queue, Loops, Per-session automation, Client Persistence (queueHistory) |
| Command/file index (`commandIndex`) | Command Autocomplete, Prompt Queue editor, Queue Tab |
| Transcript reconstruction (`transcript.ts`) | Conversation View, Review Tab (AI Popups) |
| Floating session spawn / fork | Floating Terminal Fork, Review Tab, Pop-out window, Session Matching |
| Shared UI primitives (Modal/Select/Tabs/Tooltip) | ALL components that consume them (settings, modals, panels) |

## Template

Each feature doc follows this structure:

```markdown
# Feature Name

## Function        — What it does (1-2 sentences)
## Purpose         — Why it exists
## Source Files    — Table of files and roles
## Implementation  — Key algorithms, data flow
## Dependencies & Connections
  ### Depends On       — What this feature needs
  ### Depended On By   — What needs this feature
  ### Shared Resources — Shared state, events, APIs
## Change Risks    — What could break
```
