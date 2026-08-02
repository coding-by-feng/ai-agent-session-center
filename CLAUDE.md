# AI Agent Session Center

Localhost dashboard (port 3333) that monitors AI coding agent sessions (Claude Code, Codex) via hooks. Sessions are visualized as 3D robot characters in an interactive cyberdrome. Supports SSH terminals, team/subagent tracking, prompt queuing, workspace snapshots, and session resume.

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
| [`frontend/`](docs/feature/frontend/) | 26 | [State](docs/feature/frontend/state-management.md), [Persistence](docs/feature/frontend/client-persistence.md), [WS Client](docs/feature/frontend/websocket-client.md), [Detail Panel](docs/feature/frontend/session-detail-panel.md), [Conversation View](docs/feature/frontend/conversation-view.md), [Session Summary](docs/feature/frontend/summary-tab.md), [File Browser](docs/feature/frontend/file-browser.md), [Terminal UI](docs/feature/frontend/terminal-ui.md), [Settings](docs/feature/frontend/settings-system.md), [Shortcuts](docs/feature/frontend/keyboard-shortcuts.md), [Queue](docs/feature/frontend/prompt-queue.md), [Queue Scheduler](docs/feature/frontend/queue-scheduler.md), [Command Autocomplete](docs/feature/frontend/command-autocomplete.md), [Views](docs/feature/frontend/views-routing.md), [Agenda](docs/feature/frontend/agenda.md), [Workspace Snapshot](docs/feature/frontend/workspace-snapshot.md), [Setup Wizard](docs/feature/frontend/setup-wizard.md), [Auth UI](docs/feature/frontend/auth-ui.md), [Project Browser](docs/feature/frontend/project-browser.md), [Floating Terminal Fork](docs/feature/frontend/floating-terminal-fork.md), [Review Tab](docs/feature/frontend/review-tab.md), [Session Creation Modals](docs/feature/frontend/session-creation-modals.md), [UI Primitives](docs/feature/frontend/ui-primitives.md), [File Open Chooser](docs/feature/frontend/file-open-chooser.md), [Saved Prompts](docs/feature/frontend/saved-prompts.md), [Auto-Resume Watchdog](docs/feature/frontend/auto-resume-watchdog.md) |
| [`3d/`](docs/feature/3d/) | 3 | [Cyberdrome Scene](docs/feature/3d/cyberdrome-scene.md), [Robot System](docs/feature/3d/robot-system.md), [Particles/Effects](docs/feature/3d/particles-effects.md) |
| [`multimedia/`](docs/feature/multimedia/) | 2 | [Sound & Alarm System](docs/feature/multimedia/sound-alarm-system.md), [TTS Voice Output](docs/feature/multimedia/tts-voice-output.md) |
| [`electron/`](docs/feature/electron/) | 3 | [App Lifecycle](docs/feature/electron/app-lifecycle.md), [PTY Host](docs/feature/electron/pty-host.md), [IPC Transport](docs/feature/electron/ipc-transport.md) |

See [`docs/feature/README.md`](docs/feature/README.md) for the full index (47 docs), dependency graph, and impact matrix.

## Architecture

### Data Flow

```
AI CLI (Claude/Codex)
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
  apiRouter.ts          — all REST endpoints (~117KB, largest file)
  mqReader.ts           — JSONL queue reader
  hookProcessor.ts      — validation + event processing
  interruptionDetector.ts — edge-triggered PTY scan for transient-failure banners (API 5xx / rate limit / network)
  fileIndexCache.ts     — cached + fs.watch'd fuzzy file index
  commandIndex.ts       — slash-command + skill catalog for prompt autocomplete (Codex skills via $CODEX_HOME)
  floatingSessionSpawner.ts — fork-translate / fork-explain floating PTY spawner
  floatingPrompt.ts     — synthesizes the prompt body for floating fork sessions
  extractPreviousAnswer.ts  — pulls last assistant turn for translate-answer mode
  ttsManager.ts         — Google Cloud TTS proxy
  noteMedia.ts          — note image/video store (files on disk + note_media metadata, hourly orphan sweep)
  ptyRing.ts            — lazily-grown terminal replay ring (dup of electron/ptyRing.ts)
  sessionTrim.ts        — per-session in-memory text caps + ArchivedSession builder
  codexModelCatalog.ts  — spawns Codex to list its models; 5min TTL cache, 8s query timeout
  terminalCapacity.ts   — session-vs-PTY budget (MAX_SESSIONS = 50, MAX_TERMINALS = 130; ops shells excluded)
  sessionStore.ts       — coordinator (~57KB, delegates to sub-modules)
    sessionMatcher.ts   — 8-priority session matching
    sessionAliasResolver.ts — follows session-id alias chains (null on gap/cycle)
    sessionKillPolicy.ts    — Codex-session detection + live PID peer lookup for kills
    sessionUpdateCoalescer.ts — merges throttled session updates, preserving one-shot `replacesId`
    sessionTitle.ts     — derives/normalizes session display titles
    approvalDetector.ts — tool approval timeouts
    teamManager.ts      — subagent team tracking
    processMonitor.ts   — PID liveness checking
    autoIdleManager.ts  — idle transition timers
  wsManager.ts          — WebSocket broadcast + terminal relay
  sshManager.ts         — SSH/PTY terminal management
  db.ts                 — SQLite (WAL mode, 8 tables)
  authManager.ts        — password auth + tokens
  hookStats.ts          — performance metrics
  config.ts             — tool categories, timeouts
  constants.ts          — event types, statuses, WS message types
  serverConfig.ts       — data/server-config.json loader
  logger.ts             — debug-aware logging; also persists to <userData>/logs/server.log (data/logs/ outside Electron)
```

### Frontend Modules

```
src/
  stores/               — 14 Zustand stores (session, settings, queue, queueHistory, promptSnippet, notes, label, room, camera, ui, ws, agenda, shortcut, floatingSessions)
  hooks/                — useWebSocket, useTerminal, useSound, useAuth, useKeyboardShortcuts, useKnownProjects, useSettingsInit, useWorkspaceAutoSave, useWorkspaceAutoLoad, useGlobalQueueScheduler, useClickOutside, useSelectionPopup, useDropdownFlipX
  lib/                  — wsClient, db (Dexie), soundEngine, ambientEngine, alarmEngine, workspaceSnapshot, cliDetect, cyberdromeScene, fileSystemProvider, format, robot3DGeometry, robot3DModels, robotPositionPersist, robotStateMap, sceneThemes, shortcutKeys, ansi, remoteControlName, selectionExtractors, tooltips, translationLog, ttsEngine, transcript, commandMessage, queueScheduler, queueHistoryExport, queueMovePlacement, promptSnippetPool, promptSnippetInsert, pinnedRespawn, sessionSort, commandIndex, commandSuggestions, autocompleteTrigger, timePicker, rehypeSavedSelections, searchNormalize, terminalSend, filePathLink, popupResponse, mountedProjectsLru, projectEditGuard, robotPalette, robotModelMeta, roomGrid, kokoroTts, kokoroWorker, terminalLinkHandler, terminalTransport, resumeWatchdog
  components/
    3d/                 — CyberdromeScene, CyberdromeEnvironment, SessionRobot, Robot3DModel, RobotDialogue, RobotLabel, RobotListSidebar, RoomLabels, SceneOverlay, CameraController, StatusParticles, SubagentConnections, robotPositionStore
    session/            — DetailPanel, DetailTabs, ConversationView, ProjectTab, ProjectTabContainer, FloatingTerminalPanel, FloatingTerminalRoot, PopoutTerminalView, FileTree, FindInFileBar, ContentSearchModal, QueueTab, QueueHistorySheet, QueueItemEditModal, PromptSnippetPicker, LoopExcludeWindowsModal, NotesTab, SummaryTab, SummarizeModal, AiPopupHistory, SessionControlBar, SessionSwitcher, LinkifiedText, KillConfirmModal, AlertModal, FileOpenChooser, PopupResponse, TexViewer, imageViewport
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
  ptyHost.ts            — VS Code-style PTY host (node-pty)
  ptyRing.ts            — lazily-grown replay ring (dup of server/ptyRing.ts)
  tray.ts               — system tray
  crashLogger.ts        — main-process crash capture (uncaughtException, render/child-process-gone, native crashReporter) -> <userData>/logs/main.log
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
| Session Matching | Terminal/SSH, Session Resume, Team linking, External-session cards (Priority 5 + process-scan discovery), terminal adoption (Priority 4.5) |
| WebSocket protocol | Frontend WS Client, Terminal UI, all real-time UI |
| API contracts | ALL frontend HTTP calls, Electron PTY registration |
| DB schema | API Endpoints, Client Persistence (IndexedDB mirror) |
| Terminal/SSH | Session Matching (pending links), PTY Host registration |
| Zustand store shapes | ALL subscribing components |
| Theme CSS variables | ALL visual components (2D + 3D), Terminal themes |
| Adding/removing a theme (`ThemeName`) | `THEMES` array + theme CSS (imported from **both** `global.css` and `main.tsx`), `sceneThemes.ts` (`Record<ThemeName, …>` — a compile error if missed), `light-overrides.css` scanline group, optional xterm palette |
| `--font-mono` | The `windows-xp` theme forces `font-family: var(--font-mono) !important` on every element outside the xterm subtree, so a component needing its own font must **redefine the variable** on its root rather than declaring `font-family` (see `TexViewer.module.css`) |
| Electron IPC channels | Preload bridge, Terminal UI dual transport |
| Queue scheduler tick / `queueHistoryStore` | Prompt Queue, Loops, per-session automation, Client Persistence (queueHistory), Auto-Resume Watchdog (runs first in the same tick, shares the send mutex) |
| Fault detection (`interruptionDetector.ts`) / `session.interruption` | Auto-Resume Watchdog, Terminal/SSH (`onData` seams), Session Management (clear-on-hook rule), Session Detail Panel (`⚠` chip) |
| Command/file index (`commandIndex`) | Command Autocomplete, Prompt Queue editor, Queue Tab |
| Saved prompts (`promptSnippetStore` / `PromptSnippetPicker`) | Prompt Queue compose row, `QueueItemEditModal` MAIN + both chain sections, Client Persistence (`promptSnippets`, Dexie v7) |
| Autocomplete sigils (`autocompleteTrigger`/`entryPrefix`) | Command Autocomplete, Prompt Queue editor, Queue Tab, Queue Scheduler chain steps |
| Transcript reconstruction (`transcript.ts` / `commandMessage.ts`) | Conversation View, Review Tab (AI Popups) |
| Floating session spawn / fork | Floating Terminal Fork, Floating Session Spawner, Review Tab, pop-out window, Session Matching |
| Shared UI primitives (Modal/Select/Tabs/Tooltip) | ALL components that consume them (Settings, modals, panels) |
| Replay ring (`ptyRing.ts`) | PTY Host + Terminal/SSH — duplicated across `electron/` and `server/` (tsconfig roots can't cross-import); `test/ptyRing.test.ts` runs one suite against both and fails on drift |
| Per-session text caps (`sessionTrim.ts`) | Session Management, Session Matching, Conversation View, Database (`insertFullPrompt` ordering) |
| Eager import roots (`main.tsx`/`App.tsx`/`AppLayout`) | Bundle size for every renderer incl. pop-out windows |
| Mounted-project LRU (`mountedProjectsLru`/`projectEditGuard`) | Session Detail Panel, File Browser — unpersisted ProjectTab state must register with the edit guard |
| TTS / GCP API key | Settings toggle, Terminal UI hold-to-speak, `/api/tts/*` endpoints — per-user `googleTtsApiKey` stored client-side, forwarded per request. **Never** reintroduce ambient credentials (gcloud ADC / service-account files) — leaks across users |

## Key Invariants

- **Never mutate session objects** — always spread/new Map
- **Never use Zustand inside R3F Canvas** — causes React Error #185; all store reads in DOM layer, data flows via props
- **The 3D Canvas must never run at `frameloop="always"` unconditionally.** Electron disables `MacWebContentsOcclusion`, so — unlike a browser tab — a window buried behind another app is *not* reported hidden and keeps its rAF loop running: a 60 fps scene with shadows + antialiasing + 8 `useFrame` sites × session count, rendering forever in the background. `frameloop` is gated by [`resolveFrameloop(visible, focused)`](src/lib/sceneFrameloop.ts) → `never` / `demand` / `always`. **`demand` only works with the `FramePump`** (`invalidate()` on a `UNFOCUSED_FRAME_MS` interval): the robot walk cycles and particle drift are continuous `useFrame` animations, not state-change redraws, so a bare `demand` freezes the scene mid-stride. Keep `sceneFrameloop.ts` import-free (no Three.js) — it is read from the DOM layer.
- **Never call a process probe synchronously on the event loop.** `hasChildProcesses` (approval detection) runs `pgrep -P <pid>` once per approval-timer expiry *per session*; as `execFileSync` it blocked the one loop that also serves WS broadcast, terminal relay and hook processing, so a single session's probe froze every session — worse the busier the box, since `pgrep` scales with the process table. It is `execFile` + `promisify` now, and because the `await` yields, the timer **must** re-read the session afterwards and bail unless it is still `working` with a `pendingTool` (else a `PostToolUse` that landed mid-probe gets overwritten).
- **Never block the hook script** — background subshell (`& disown`) for all processing
- **Never hardcode port 3333** — read from config/env/CLI flag
- **Never modify `~/.claude/settings.json` without atomic write** — write-to-tmp + rename
- **Server imports use `.js` extensions** — required for NodeNext module resolution with tsx
- **File browser uses `resolveProjectPath()`** — prevents directory traversal
- **One terminal = one card — a lost `SessionStart` must never split a session in two.** Every re-key path in `matchSession` (P0.5/1/1b/2/3) is gated on `hook_event_name === SESSION_START`, so a single dropped startup hook used to strand the origin card in `ended` (Terminal tab: "Terminal disconnected / Reconnect" on a session that is actively running) while Priority 5 minted an untitled twin on the *same live PTY* — the "Unnamed" card in Common Area. **Priority 4.5** ([`sessionMatcher.ts`](server/sessionMatcher.ts)) closes this: when exactly one session owns `agent_terminal_id` (via `terminalId` or `lastTerminalId`), it re-keys that session on ANY forward event. Its four guards carry the whole load — **sole owner only**, skip `CONNECTING` (P3's), exclude `SessionEnd`/`Stop` (a late teardown must not drag a live card backward), exclude subagent events (`teamManager` owns those). Widening any guard recreates the terminal-hijack bug the P2/P3 gate exists to prevent; narrowing back to `SESSION_START` recreates the split. Adoption is **preventative only** — once two cards exist the direct-id lookup short-circuits the cascade, so pre-existing duplicates must be closed by hand. Covered by `test/sessionMatcher.adoption.test.ts`; watch for the `ADOPTED terminal …` log line, which means a `SessionStart` was lost.
- **A session's display name is never `session.title` alone** — `title` stays `''` until the first `UserPromptSubmit` (that emptiness is what makes `buildAutoTitle` fire exactly once), so any card that reaches the UI without a recorded prompt renders blank. Always go through [`sessionDisplayTitle()`](src/lib/sessionDisplayTitle.ts) (`title || projectName || 'Unnamed'`) — used by `RobotListSidebar`, `RobotLabel`, `DetailPanel`, and both `sessionSort` tie-breaks. Seeding a non-empty `title` at creation instead would permanently suppress the auto-title, so the fallback must stay display-only. Keep the helper import-free: it is consumed by both 2D and 3D code.
- **Only `ppid` proves a discovered process is external — never `cwd`.** A dashboard-launched agent fires no hook while it waits at a login/trust prompt, so the 20s scan sees a live pid with a real tty and no owner and looks exactly like an external session. The old `CONNECTING`-in-same-cwd guard expires after 120s (`autoIdleManager`), which is how 12 duplicate pairs accumulated on 2026-07-29 — 9 with byte-identical titles. `registerDiscoveredSession` now resolves `ppid → PTY → session` first (`PTY → /bin/zsh -l → claude`, so the agent's parent **is** `term.pty.pid`) and binds the pid to that terminal's session instead of minting a card. Two rules: **(1)** cwd may *suppress* card creation but must **never bind** a pid — many sessions share one directory, so binding on cwd attaches a live pid to an arbitrary sibling; **(2)** use [`getTerminalByPtyPid`](server/sshManager.ts) (pure Map scan), **never** `getTerminalByPtyChild` — it does the same lookup via `execSync` and would block the event loop on the interval. Excluding `external-<pid>` pids from the scan's `tracked` set is what lets an already-minted duplicate be reconciled away; re-adding them freezes every existing duplicate forever. Covered by `test/discoveryReconcile.test.ts`.
- **External sessions are traced, not dropped** — an unmatched hook with a controlling tty becomes a Priority 5 "external" card (`isExternal`, real sessionId); a 20s process scan (`startExternalDiscovery`) surfaces hookless `claude` CLIs as thin `external-<pid>` cards. **Never persist `external-<pid>` discovered cards to the snapshot** (dead/reused PID → phantom on restart; they're re-discovered within 20s). Keep the process scan async (never `execFileSync` on the interval — it blocks the event loop)
- **Codex skills are `$name`, never `/name`** — Codex has a dedicated `$` popup and is instructed to act on `$SkillName`; a queued `/retouch-current-prompt` is silently inert there. `entryPrefix()` in [`src/lib/commandIndex.ts`](src/lib/commandIndex.ts) is the ONE place that decides the sigil — hardcoding `'/' + name` in the dropdown reintroduces the dead-prompt bug with no error anywhere. Codex skills live under `$CODEX_HOME/skills` (never hardcode `~/.codex`), including the dot-prefixed `.system/` tier of preinstalled skills; walk skill dirs with `statSync`, since `Dirent.isDirectory()` is false for the symlinked skill dirs people commonly use. Conversely `$` must stay Codex-only — on a Claude session every `$HOME` would pop a dropdown.
- **A spawned PTY must never inherit the launching Claude Code session's env markers.** Every PTY builds its env from the app's own `process.env`, so when the app is started from *inside* a Claude Code session — i.e. the normal dev loop, an agent running `npm run electron:build` / `npm run dev` / `open`ing the built app — it hands its children `CLAUDECODE=1`, **`CLAUDE_CODE_CHILD_SESSION=1`**, `CLAUDE_CODE_SESSION_ID=<launcher>`. Claude Code ≥ 2.1.x reads an inherited `CLAUDE_CODE_CHILD_SESSION` as "I am a nested child session" and **disables transcript persistence** (`⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`): no `~/.claude/projects/<encoded>/<sessionId>.jsonl` is ever written, even though hooks keep reporting a `transcript_path` for it. Everything built on `--resume` then fails with `No conversation found with session ID: <id>` — the AI popup's fork lands on a dead shell, workspace restore silently starts fresh instead of resuming, the Conversation tab is empty, and translate-answer reads an *unrelated* session (its `findTranscriptFile` falls back to the newest `.jsonl` in the dir). Nothing logs an error; a Finder launch of the same build works fine, which is what makes this invisible. [`stripInheritedClaudeSessionEnv`](server/config.ts) (`INHERITED_CLAUDE_SESSION_ENV_KEYS`) is applied at **all three** spawn sites — `createTerminal` + `attachToTmuxPane` ([`sshManager.ts`](server/sshManager.ts)) and the [`ptyHost.ts`](electron/ptyHost.ts) mirror, which cannot import from `server/` (same tsconfig-roots constraint as `ptyRing.ts`), so `test/claudeSessionEnv.test.ts` asserts the mirror's source text and fails on drift. Never widen the scrub to credentials (`ANTHROPIC_API_KEY`), `CLAUDE_CONFIG_DIR`, user feature flags, or `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`. Separately, **`promptHistory.length > 0` is not proof a session can be resumed** — history survives restore/`/clear`/re-keys — so the fork gate goes through [`resolveResumableClaudeSessionId`](server/extractPreviousAnswer.ts), which requires the transcript on disk and deliberately has no "newest jsonl" fallback.
- **A turn killed by a transient API error is indistinguishable from a finished one — except in the PTY bytes.** A `529 Overloaded` still ends with `Stop`, so the session lands in `waiting` exactly like a clean finish; `isSendableStatus('waiting')` is true, so the queue *already* fired the next item into work that never completed. [`interruptionDetector.ts`](server/interruptionDetector.ts) supplies the missing signal by scanning PTY output at the `onData` seam, and [`resumeWatchdog.ts`](src/lib/resumeWatchdog.ts) decides whether to auto-continue. Three rules hold the whole thing up. **(1) Detection is edge-triggered** — the banner sits in scrollback, so a level check (`tail contains /529/`) re-fires forever; the carry buffer is dropped on report and an identical `kind:line` inside `DEDUPE_MS = 60s` is suppressed. **(2) `session.interruption` is cleared on `UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`SessionStart` — NEVER on `Stop`**, which is the event a 529 also produces; clearing there makes the feature a silent no-op. That same rule is what makes an *echoed* error string harmless (the echo is followed by `prompting`). **(3) The retry budget is a rolling-window ledger of prompts actually sent (`ATTEMPT_WINDOW_MS = 30min`, default 3), not a per-fault counter.** Keying it to the fault self-destructs: the resume works for one turn → the server clears `interruption` → the same outage kills the next turn → a new `detectedAt` → a fresh budget → an unattended loop burning API quota. Backoff is 30s/2m/8m **plus jitter**, because a provider-wide 529 faults every session at once and un-jittered retries hammer an already-overloaded API. Coverage is limited to server-owned PTYs: `pty-*` terminals (`electronAPI.createPty`) live in `ptyHost`, where the server sees no bytes and `POST /api/terminals/:id/write` 404s — the queue can't fire into them either, so fix the **write** path before "fixing" detection there.
- **A session title is untrusted input that reaches a live shell.** `buildAutoTitle` derives it from the first 60 characters of the user's **first prompt** (`makeShortTitle` does no shell sanitizing), and workspace-snapshot import carries titles in from a shared JSON file — then [`appendSessionName`](server/config.ts) interpolates it into `-n "<title>"` on a command written verbatim into a PTY. Escaping only `"` left `$(…)`, backticks and `$VAR` live inside the double quotes, so a session titled ``a`id`b`` executed `id` on every resume, clone, fork and pinned respawn. `quoteSessionTitle` escapes all four characters the shell still honours inside double quotes (`\`, `$`, `` ` ``, `"`) — **backslash first**, or escaping `"` lets a `\`+`"` pair forge a quote break — and collapses `/[\x00-\x1F\x7F]+/` (a raw newline would end the command line and make the tail a second command). It also **replaces** an existing `-n` instead of skipping: the old "don't double-add" guard treated any existing flag as valid, so one command carrying an unquoted `-n KTS Deployment` propagated through every later resume/clone/fork, with `claude` reading `Deployment` as a stray positional argument (i.e. an unintended initial prompt). Keep the value **double**-quoted — `stripClaudeSessionName`/`extractSessionName` parse the `"…"` form (both accept `\` escapes; extract unescapes so strip → re-append is lossless), and `'\''`-style single-quoting would break both for any title with an apostrophe. [`electron/ptyHost.ts`](electron/ptyHost.ts) mirrors this and cannot import from `server/`, so `test/sessionNameQuoting.test.ts` asserts its source text.
- **SSH inputs validated with Zod + shell metacharacter regex** — prevents injection
- **Floating overlays must stay inside the viewport** — any `position: absolute`/`fixed` dropdown, popover, menu, flyout, or context menu must handle the viewport edge: vertical flip (`Select`'s `flipUp`), horizontal nudge ([`useDropdownFlipX`](src/hooks/useDropdownFlipX.ts)), or coordinate clamp (`clampToViewport` in FileOpenChooser/LabelPicker/SelectionPopup). **Never ship a `right: 0` / `left: 0` / `*: 100%`-anchored menu with no edge guard** — near a window edge it clips its own content. This is a runtime bug no linter catches; it is review-time + render-checked (run `/frontend-ui-polish` on a narrow-window screenshot).
- **An overlay inside a scrolling ancestor must be portaled — edge guards cannot save it.** If any ancestor has `overflow: auto`/`scroll`, an `absolute`-positioned descendant is clipped by that box (and per CSS a `visible` axis computes to `auto` when the other is `auto`, so `overflow-y: auto` alone clips **both** axes). Flip/clamp helpers make this *worse than useless*: they measure `window.innerWidth`/`innerHeight`, a boundary far outside the real clip edge, so the guard silently never fires and the menu always renders cropped — it looks guarded in review and is not. `QueueMovePicker` hit exactly this inside `.queueBody` (`max-height: 250px; overflow-y: auto`) and now `createPortal`s to `document.body` as `position: fixed`, placing itself from the trigger's viewport rect via the pure [`computeMovePickerPosition`](src/lib/queueMovePlacement.ts); `SelectionPopup`/`Tooltip`/[`PromptSnippetPicker`](src/components/session/PromptSnippetPicker.tsx) use the same portal approach — the last one is opened from *two* different scroll boxes (`.queueBody` and `.chainModalBody`), so it can never be un-portaled. Re-anchoring such a menu in CSS (`top`/`right` on the class) or dropping the portal silently reintroduces the clip. **Portaling is only half the fix, though: it also re-parents the menu out of the panel's stacking context and into the root one, where its z-index is suddenly measured against full-screen siblings instead of its own row.** `.queueMovePicker` kept the `z-index: 50` it had as an in-panel child and so rendered *behind* `.detailOverlay` (z-index **100**) — fully placed, correctly sized, invisible; clicking MOVE looked like a dead button. Every `<body>`-portaled overlay must therefore sit in the 10000+ band with the others (`Tooltip` 10000, `SelectionPopup`/`queueMovePicker` 10050, `PromptSnippetPicker` 10150). The two rules live in different CSS modules that cannot reference each other, so nothing type-checks or lints this — `QueueMovePicker.test.tsx` asserts the source text instead, the same drift-guard pattern as `test/sessionNameQuoting.test.ts`. A portaled menu must also re-place on `scroll` with **`capture: true`** — scroll doesn't bubble, so an inner container's scroll is only observable during capture — and must animate opacity only, since `getBoundingClientRect()` includes an in-flight transform.
- **Never import a Three.js-touching module from 2D code** — `robot3DGeometry.ts`, `robot3DModels.ts` and `cyberdromeScene.ts` all `import * as THREE` and build geometry at module scope, so one import from an eagerly-loaded component pulls ~1.2 MB into the boot path. Use the dependency-free `robotPalette.ts` / `robotModelMeta.ts` / `roomGrid.ts` instead, and keep those three free of imports.
- **One queue editor, and a curated snippet library — not two of each.** A queue row's `EDIT` opens [`QueueItemEditModal`](src/components/session/QueueItemEditModal.tsx) for **every** type; the old type-branch (inline textarea for `once`, modal for loop/schedule) and the ⚙ button that existed solely to reach the modal for a `once` item are both gone. Re-adding a lightweight in-row editor recreates the original bug: squeezed between the position number and the action group it renders as a sliver, and its autocomplete dropdown is clipped by `.queueBody`. Separately, [`promptSnippetStore`](src/stores/promptSnippetStore.ts) (`promptSnippets`, Dexie **v7**) is **curated — nothing may write to it automatically.** Raw prompt history stays a read-only pooled view (the picker's RECENT tab, [`poolRecentPrompts`](src/lib/promptSnippetPool.ts)); only an explicit 🔖 promotes text into the library. Auto-saving every prompt is the exact thing the feature exists to avoid. Keep it distinct from `queueHistoryStore`: ★ saves a whole **item** (type + interval + chains) as a new queue row, 🔖 saves bare **text** appended into a box being typed. Insertion goes through the one shared rule in [`appendSnippet`](src/lib/promptSnippetInsert.ts).
- **A note's bytes never go in SQLite, and its Markdown renderer never goes in the eager chunk.** Images/video pasted into a note are written to `<data dir>/note-media/<id>.<ext>` with metadata in `note_media`; the note text stores only `![name](/api/note-media/<id>)`, so a 40 MB recording costs a ~40-byte row instead of 55 MB of base64 reloaded on every notes fetch. Do **not** model this on `/api/queue-images` — that one writes to `/tmp` and deletes after 24h, which is right for handing a path to a CLI and fatal for a note. Uploads land *before* the note is saved (the editor needs a real URL at the caret), so `sweepOrphanNoteMedia()` runs hourly over rows older than `ORPHAN_TTL_MS` that no note references — **globally**, not per session, since note text is copy-pasteable between sessions. Filenames come from a server-generated hex id + an allowlisted extension in a flat dir, and `resolveNoteMedia` re-checks `/^[a-f0-9]{32}$/`, so no caller-supplied text ever reaches `join()`. **SVG is excluded from the MIME allowlist** — same-origin + scriptable = stored XSS. On the client, [`NoteMarkdown`](src/components/session/NoteMarkdown.tsx) (~300 kB of react-markdown/remark/rehype) and `NotesTab` itself are **both** `lazy()` — `DetailPanel` is in the eager entry chunk, so a static import silently moves the whole stack onto the boot path; only `notesStore` stays eager, for DetailTabs' count badge. One more trap: a bare `.noteBody code { background }` rule (0-1-1) outranks highlight.js's `.hljs` (0-1-0) and repaints every fenced block into unreadable light-on-light — scope inline-code styling as `:not(pre) > code`.
- **Never add a static import of a heavy component to `main.tsx` / `App.tsx` / `AppLayout`** — those are the eager roots; use `lazy()`. Eager JS is 1,244,984 bytes (was 2,523,500). No linter catches a regression: after touching an eager root, run `npm run build` and confirm the entry chunk has **zero** static chunk imports (recipe in [views-routing.md](docs/feature/frontend/views-routing.md)). Do **not** "fix" bundle size with `manualChunks` — Rollup groups a package's shared deps into the same chunk, which is how `@react-three/fiber`'s zustand once dragged all of Three.js into the entry.
- **`db.insertFullPrompt()` must run before `pushPrompt()` and share its timestamp** — `promptHistory` is capped/truncated in memory and `upsertSession` re-inserts from that capped copy; the full row written first wins via `INSERT OR IGNORE` on `UNIQUE(session_id, timestamp)`. Reorder them and SQLite silently keeps truncated prompt text.
- **A session's ops shell must be flagged and torn down** — the optional "Commands Terminal" spawns a *second* PTY per session. It must carry `isOps: true` (so `terminalCapacity.ts` keeps it out of the 50-**session** budget; the absolute PTY ceiling is `MAX_TERMINALS = 130`), and every teardown path (`killSession`, `DELETE /api/sessions/:id`, `clearAllSessions`) must close `session.opsTerminalId`. It is a bare login shell that never exits on its own. Miss either half and the cap fires early with a number the user can't reconcile with the session count they see — which is exactly how a single 50-PTY cap came to reject new sessions at ~25.
- **`ArchivedSession` carries only what the UI reads** (`sessionId`, `startedAt`, `endedAt`, `promptHistory`) — it is built solely by `toArchivedSession()`. Adding a field without adding a consumer reintroduces the ~46 KB/entry of write-only logs it was slimmed to remove.
- **Never write test/debug screenshots to the repo root** — Playwright/MCP captures and scratch images go to `test-screenshots/` (gitignored) or `/tmp`; images that ship live in `static/` only. `.gitignore` blocks committing any stray image outside `static/`, but root dumps still clutter the working tree, so always pass an absolute path under a scratch dir when capturing.
