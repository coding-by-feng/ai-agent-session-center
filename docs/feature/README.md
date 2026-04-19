# AI Agent Session Center — Feature Documentation

Feature documentation organized by domain. Each doc describes function, purpose, source files, implementation details, and cross-feature dependencies.

## Index

### Server (`server/`)

| Doc | Feature | Key Files |
|-----|---------|-----------|
| [Hook System](server/hook-system.md) | Bash MQ, JSONL delivery, hook processor, density levels | `hooks/dashboard-hook.sh`, `server/mqReader.ts`, `server/hookProcessor.ts` |
| [Session Management](server/session-management.md) | Session store, lifecycle, state machine, coordinator pattern | `server/sessionStore.ts`, `server/autoIdleManager.ts` |
| [Session Matching](server/session-matching.md) | 8-priority hook-to-session matcher | `server/sessionMatcher.ts` |
| [Approval Detection](server/approval-detection.md) | Tool approval timeouts, PermissionRequest signal | `server/approvalDetector.ts` |
| [WebSocket Manager](server/websocket-manager.md) | WS broadcast, terminal relay, reconnect replay | `server/wsManager.ts` |
| [API Endpoints](server/api-endpoints.md) | REST API (sessions, terminals, files, analytics) | `server/apiRouter.ts` |
| [Database](server/database.md) | SQLite persistence (6 tables, WAL mode) | `server/db.ts` |
| [Terminal / SSH](server/terminal-ssh.md) | PTY creation, SSH, tmux, shell-ready detection | `server/sshManager.ts` |
| [Team / Subagent](server/team-subagent.md) | Parent-child session tracking, team config | `server/teamManager.ts` |
| [Process Monitor](server/process-monitor.md) | PID liveness checking, auto-idle transitions | `server/processMonitor.ts`, `server/autoIdleManager.ts` |
| [Authentication](server/authentication.md) | Password auth, token management, middleware | `server/authManager.ts` |
| [File Index Cache](server/file-index-cache.md) | Cached + fs.watch'd fuzzy file index for typeahead | `server/fileIndexCache.ts` |

### Frontend (`frontend/`)

| Doc | Feature | Key Files |
|-----|---------|-----------|
| [State Management](frontend/state-management.md) | 9 Zustand stores (session, UI, settings, queue, camera, room, WS, agenda, shortcut) | `src/stores/*.ts` |
| [Client Persistence](frontend/client-persistence.md) | Dexie.js IndexedDB (12 tables, dedup, migration) | `src/lib/db.ts` |
| [WebSocket Client](frontend/websocket-client.md) | WS client, reconnect, event replay | `src/lib/wsClient.ts`, `src/hooks/useWebSocket.ts` |
| [Session Detail Panel](frontend/session-detail-panel.md) | Detail panel, 7 tabs, controls, split view | `src/components/session/DetailPanel.tsx` |
| [File Browser](frontend/file-browser.md) | Project browser, find-in-file, file tree, bookmarks | `src/components/session/ProjectTab*.tsx` |
| [Terminal UI](frontend/terminal-ui.md) | xterm.js, dual transport (IPC/WS), bookmarks, fork | `src/hooks/useTerminal.ts`, `src/components/terminal/` |
| [Settings System](frontend/settings-system.md) | Settings panel, 9 themes, sound profiles, API keys | `src/components/settings/`, `src/stores/settingsStore.ts` |
| [Keyboard Shortcuts](frontend/keyboard-shortcuts.md) | Rebindable shortcuts, context-aware suppression | `src/hooks/useKeyboardShortcuts.ts`, `src/stores/shortcutStore.ts` |
| [Prompt Queue](frontend/prompt-queue.md) | Per-session prompt queuing, auto-send | `src/stores/queueStore.ts` |
| [Views / Routing](frontend/views-routing.md) | 5 routes (Live, History, ProjectBrowser, Queue, Agenda) | `src/routes/*.tsx` |
| [Agenda / Tasks](frontend/agenda.md) | Personal task manager (priority, tags, due dates) + `/api/agenda` CRUD | `src/routes/AgendaView.tsx`, `src/stores/agendaStore.ts`, `src/components/agenda/*` |
| [Workspace Snapshot](frontend/workspace-snapshot.md) | Save/load live workspace (sessions, sub-tabs, rooms) | `src/lib/workspaceSnapshot.ts`, `src/hooks/useWorkspaceAuto*.ts` |
| [Setup Wizard](frontend/setup-wizard.md) | First-run 5-step onboarding (deps, config, hook install) | `src/components/setup/SetupWizard.tsx` |
| [Auth UI](frontend/auth-ui.md) | Login screen, token-gated app boot | `src/components/auth/LoginScreen.tsx`, `src/hooks/useAuth.ts` |
| [Project Browser](frontend/project-browser.md) | Standalone `/project-browser` route wrapping `ProjectTab` | `src/routes/ProjectBrowserView.tsx` |

### 3D Scene (`3d/`)

| Doc | Feature | Key Files |
|-----|---------|-----------|
| [Cyberdrome Scene](3d/cyberdrome-scene.md) | R3F scene, rooms, camera, layout, zero-Zustand rule | `src/components/3d/CyberdromeScene.tsx`, `src/lib/cyberdromeScene.ts` |
| [Robot System](3d/robot-system.md) | 6 model variants, 8 animation states, navigation AI, ref-based rendering | `src/components/3d/SessionRobot.tsx`, `src/components/3d/Robot3DModel.tsx` |
| [Particles & Effects](3d/particles-effects.md) | Status particles, subagent connection beams | `src/components/3d/StatusParticles.tsx`, `src/components/3d/SubagentConnections.tsx` |

### Multimedia (`multimedia/`)

| Doc | Feature | Key Files |
|-----|---------|-----------|
| [Sound & Alarm System](multimedia/sound-alarm-system.md) | 16 synthesized sounds, 6 ambient presets, approval/input alarms | `src/lib/soundEngine.ts`, `src/lib/ambientEngine.ts`, `src/lib/alarmEngine.ts` |

### Electron (`electron/`)

| Doc | Feature | Key Files |
|-----|---------|-----------|
| [App Lifecycle](electron/app-lifecycle.md) | Main process, window, tray, server embedding | `electron/main.ts`, `electron/tray.ts` |
| [PTY Host](electron/pty-host.md) | VS Code-style PTY host, 128KB output buffer, shell-ready | `electron/ptyHost.ts` |
| [IPC Transport](electron/ipc-transport.md) | IPC handlers, context bridge, dual transport | `electron/ipc/*.ts`, `electron/preload.ts` |

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
    Terminal/SSH    API Endpoints          (9 Zustand stores)
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

## Impact Matrix

When modifying a feature, check which features it can affect:

| If you change... | Check these features for impact |
|------------------|-------------------------------|
| Hook script / MQ format | Session Matching, Session Management, Hook Stats |
| Session state machine | 3D Robots, Sound/Alarms, Approval Detection, Auto-Idle, Frontend stores |
| Session Matching priorities | Terminal/SSH, Session Resume, Team linking |
| WebSocket protocol | Frontend WS Client, Terminal UI, All real-time UI |
| API endpoint contracts | ALL frontend HTTP calls, Electron PTY registration |
| Database schema | API Endpoints, Client Persistence (IndexedDB mirror) |
| Terminal/SSH creation | Session Matching (pending links), PTY Host registration |
| Zustand store shapes | ALL components that subscribe to stores |
| Theme CSS variables | ALL visual components (2D + 3D), Terminal themes |
| Sound action mappings | Settings panel, Alarm engine, Per-CLI profiles |
| Electron IPC channels | Preload bridge, Terminal UI dual transport |
| Robot animation states | Robot state map, Settings (character model), 3D scene |

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
