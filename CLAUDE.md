# AI Agent Session Center

## Project Overview

A localhost dashboard (port 3333) that monitors all active AI coding agent sessions (Claude Code, Gemini CLI, Codex) via hooks. Each session is represented by a 3D robot character in an interactive cyberdrome scene. Users can click on any robot/session to view full prompt history, response history, tool logs, and session details. Supports SSH terminal connections, team/subagent tracking, prompt queuing, and session resume.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js 18+ (ESM) + Express 5 + ws 8 + tsx |
| Frontend | React 19 + Three.js + @react-three/fiber + Zustand + Vite |
| Terminal | node-pty for SSH/local PTY sessions |
| Hooks | Bash script (file-based MQ primary, HTTP fallback) |
| Persistence | SQLite (server) + IndexedDB via Dexie (browser) |
| Port | 3333 (configurable) |

## Commands

```bash
# Install dependencies
npm install

# Development (Vite dev server + backend with HMR)
npm run dev

# Build frontend for production
npm run build

# Start production server (serves built frontend)
npm start

# Start without opening browser
npm run start:no-open

# Start in debug mode (verbose logging)
npm run debug

# Interactive setup wizard (install + configure + start)
npm run setup

# Install hooks into ~/.claude/settings.json
npm run install-hooks

# Uninstall all dashboard hooks
npm run uninstall-hooks

# Reset everything (remove hooks, clean config, create backup)
npm run reset

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

## Architecture

### Hook Delivery Pipeline

```
Claude Code / Gemini / Codex
        |
        v
  Hook Script (bash)
  - Reads stdin JSON
  - Enriches with PID, TTY, terminal env vars
  - Single jq pass (~2-5ms)
        |
        v
  /tmp/claude-session-center/queue.jsonl
  - Atomic POSIX append (~0.1ms)
  - Fallback: HTTP POST to localhost:3333/api/hooks
        |
        v
  mqReader.js
  - fs.watch() + 10ms debounce for instant notification
  - 500ms fallback poll + 5s health check
  - Reads new bytes from last offset
  - Handles partial lines and truncation
        |
        v
  hookProcessor.js
  - Validates payload (session_id, event type, PID)
  - Calls handleEvent() on sessionStore
  - Records stats (latency, processing time)
  - Broadcasts to WebSocket clients
        |
        v
  sessionStore.js (coordinator)
  - Delegates to sub-modules:
    sessionMatcher  -> match hook to session
    approvalDetector -> tool approval timeouts
    teamManager     -> subagent team tracking
    processMonitor  -> PID liveness checks
    autoIdleManager -> idle transition timers
        |
        v
  wsManager.js
  - Broadcasts session_update to all connected browsers
  - Supports replay (ring buffer of last 500 events)
        |
        v
  Browser (IndexedDB + UI)
```

### Latency Expectations

| Stage | Typical | Notes |
|-------|---------|-------|
| jq enrichment | 2-5ms | Single jq invocation in bash |
| File append | ~0.1ms | POSIX atomic for writes < 4096 bytes |
| fs.watch + debounce | 0-10ms | Instant on macOS/Linux |
| Server processing | ~0.5ms | handleEvent + broadcast |
| **Total end-to-end** | **3-17ms** | Hook fired to browser updated |

### Module Relationships

```
server/index.ts (thin orchestrator)
  ├── hookInstaller.js    — auto-install hooks on startup
  ├── portManager.ts      — resolve port, kill conflicts
  ├── hookRouter.ts       — POST /api/hooks (HTTP transport)
  ├── apiRouter.ts        — all REST API endpoints
  ├── mqReader.ts         — file-based JSONL queue reader
  ├── hookProcessor.ts    — shared validation + processing pipeline
  ├── sessionStore.ts     — coordinator (delegates to sub-modules)
  │   ├── sessionMatcher.ts    — 5-priority session matching
  │   ├── approvalDetector.ts  — tool approval timeout logic
  │   ├── teamManager.ts       — team/subagent tracking
  │   ├── processMonitor.ts    — PID liveness checking
  │   └── autoIdleManager.ts   — idle transition timers
  ├── wsManager.ts        — WebSocket broadcast + terminal relay
  ├── sshManager.ts       — SSH/PTY terminal management
  ├── hookStats.ts        — in-memory performance stats
  ├── config.ts           — tool categories, timeouts, animation maps
  ├── constants.ts        — all magic strings (events, statuses, WS types)
  ├── serverConfig.ts     — loads data/server-config.json
  └── logger.ts           — debug-aware logging utility
```

### Frontend Module Structure

```
src/
  ├── main.tsx             — React entry point
  ├── App.tsx              — Router + layout + providers
  ├── components/
  │   ├── 3d/              — Three.js 3D scene
  │   │   ├── CyberdromeScene.tsx    — root 3D canvas
  │   │   ├── CyberdromeEnvironment.tsx — floor, walls, rooms
  │   │   ├── SessionRobot.tsx       — per-session 3D robot
  │   │   ├── Robot3DModel.tsx       — procedural robot geometry
  │   │   ├── RobotDialogue.tsx      — speech bubble overlays
  │   │   ├── StatusParticles.tsx    — status particle effects
  │   │   ├── SubagentConnections.tsx — team connection lines
  │   │   ├── RobotListSidebar.tsx   — 2D robot list overlay
  │   │   └── CameraController.tsx   — animated camera
  │   ├── session/         — detail panel, tabs, controls
  │   ├── terminal/        — xterm.js terminal components
  │   ├── settings/        — settings panel components
  │   ├── modals/          — modal dialogs
  │   ├── layout/          — nav, header, activity feed
  │   └── ui/              — shared UI components
  ├── routes/              — LiveView, HistoryView, AnalyticsView, etc.
  ├── stores/              — Zustand state management
  ├── hooks/               — React hooks (useWebSocket, useTerminal, etc.)
  ├── lib/                 — utilities (wsClient, db, sound, alarms, etc.)
  ├── styles/              — CSS/theme files
  └── types/               — TypeScript type definitions
```

## Project Structure

```
server/
├── index.ts              # Express + WS server entry (thin orchestrator)
├── apiRouter.ts          # REST API endpoints (sessions, terminals, hooks, SSH)
├── hookRouter.ts         # POST /api/hooks endpoint (HTTP transport adapter)
├── hookProcessor.ts      # Shared hook validation + processing pipeline
├── mqReader.ts           # File-based JSONL message queue reader
├── sessionStore.ts       # Session state machine (coordinator)
├── sessionMatcher.ts     # 5-priority session matching logic
├── approvalDetector.ts   # Tool approval timeout detection
├── teamManager.ts        # Team/subagent tracking and auto-detection
├── processMonitor.ts     # PID liveness checking for auto-cleanup
├── autoIdleManager.ts    # Auto-idle transition timers
├── wsManager.ts          # WebSocket broadcast + bidirectional terminal relay
├── sshManager.ts         # SSH/PTY terminal creation and management
├── hookInstaller.js      # Auto-install hook scripts on startup (plain JS)
├── portManager.ts        # Port resolution and conflict management
├── hookStats.ts          # In-memory hook performance statistics
├── config.ts             # Tool categories, timeouts, animation mappings
├── constants.ts          # Centralized magic strings (events, statuses, WS types)
├── serverConfig.ts       # Loads user config from data/server-config.json
├── authManager.ts        # Password auth, token management
├── db.ts                 # SQLite database (better-sqlite3)
└── logger.ts             # Debug-aware logging utility

src/
├── main.tsx              # React entry point (mounts to #root)
├── App.tsx               # Router, layout, providers
├── components/
│   ├── 3d/               # Three.js 3D cyberdrome scene
│   ├── session/          # Detail panel, tabs, controls, modals
│   ├── terminal/         # xterm.js terminal components
│   ├── settings/         # Settings panel (theme, sound, hooks, API keys)
│   ├── modals/           # New session, quick session modals
│   ├── layout/           # NavBar, Header, ActivityFeed, WorkdirLauncher
│   ├── auth/             # Login screen
│   └── ui/               # Modal, Tabs, SearchInput, ResizablePanel, Toast
├── routes/               # LiveView, HistoryView, AnalyticsView, TimelineView, QueueView
├── stores/               # Zustand stores (session, settings, queue, room, camera, ui, ws)
├── hooks/                # useWebSocket, useTerminal, useAuth, useSound, useKeyboardShortcuts
├── lib/                  # wsClient, db (Dexie), soundEngine, alarmEngine, format, etc.
├── styles/               # CSS/theme files
└── types/                # TypeScript type definitions

static/
├── favicon.svg           # Favicon
└── apple-touch-icon.svg  # Apple touch icon

hooks/
├── dashboard-hook.sh     # Main hook: enrich JSON + append to MQ file
├── dashboard-hook.ps1    # Windows PowerShell variant
├── dashboard-hook-gemini.sh  # Gemini CLI hook adapter
├── dashboard-hook-codex.sh   # Codex CLI hook adapter
├── install-hooks.js      # CLI: install/uninstall hooks with density levels
├── setup-wizard.js       # Interactive setup wizard (port, CLI selection)
└── reset.js              # Reset: remove hooks, clean config, create backup

bin/
└── cli.js                # npx/global CLI entry point

data/
├── server-config.json    # User configuration (port, density, CLIs, debug)
└── backups/              # Backup snapshots from reset operations
```

## Key Design Decisions

- **File-based MQ over HTTP**: Hooks append JSON to `/tmp/claude-session-center/queue.jsonl` instead of HTTP POST. Eliminates process spawn overhead (no curl), achieves ~0.1ms delivery via POSIX atomic append.
- **5-priority session matching**: Hooks don't know about SSH terminals. The matcher tries pendingResume, terminal ID, workDir link, path scan, and PID fallback to link hooks to the correct terminal session.
- **Approval detection heuristic**: Uses tool-category timeouts to detect when Claude is waiting for user approval. PermissionRequest hook event (medium+ density) provides a reliable signal that replaces the heuristic.
- **Vite + React frontend**: React 19 with Three.js for 3D scene rendering. Vite for dev server (HMR) and production builds (`dist/client/`).
- **Dual persistence**: SQLite on server (sessions, snapshots) + IndexedDB via Dexie in browser (history, settings, queue).
- **Coordinator pattern**: sessionStore.js delegates to focused sub-modules rather than being a monolith.
- **Atomic settings writes**: Hook installation uses write-to-temp + rename to prevent corrupting `~/.claude/settings.json`.

## Session State Machine

```
SessionStart    -> idle      (Idle animation)
UserPromptSubmit -> prompting (Wave + Walking)
PreToolUse      -> working   (Running)
PostToolUse     -> working   (stays)
[timeout]       -> approval  (Waiting — needs user approval)
[timeout]       -> input     (Waiting — needs user answer)
PermissionRequest -> approval (Waiting — reliable signal)
Stop            -> waiting   (ThumbsUp/Dance + Waiting)
[2min idle]     -> idle      (Idle)
SessionEnd      -> ended     (Death, removed after 10s for hooks / kept for SSH)
```

## Session Matching Strategy

When a hook event arrives with an unknown `session_id`, the matcher uses a 5-priority fallback system to link it to an existing terminal session:

| Priority | Strategy | When Used | Risk |
|----------|----------|-----------|------|
| 0 | pendingResume + terminal ID / workDir | Session resume after disconnect | Low — explicit user action |
| 1 | `agent_terminal_id` env var | SSH terminal injects `AGENT_MANAGER_TERMINAL_ID` | Low — direct match |
| 2 | `tryLinkByWorkDir` | Claude starts in same directory as terminal's workingDir | Medium — two sessions in same dir |
| 3 | Path scan (connecting sessions) | Scan all `connecting` status sessions by normalized path | Medium — ambiguous if multiple |
| 4 | PID parent check | Check if Claude's PID is a child of a known PTY process | High — unreliable across shells |

If no match is found, a display-only card is created with the detected source (VS Code, iTerm, Warp, etc.).

## Approval Detection Heuristic

When `PreToolUse` fires, an approval timer starts. If `PostToolUse` doesn't arrive within the timeout, the session transitions to `approval` or `input` status.

### Tool Category Timeouts

| Category | Tools | Timeout | Waiting Status |
|----------|-------|---------|----------------|
| fast | Read, Write, Edit, Grep, Glob, NotebookEdit | 3s | approval |
| userInput | AskUserQuestion, EnterPlanMode, ExitPlanMode | 3s | input |
| medium | WebFetch, WebSearch | 15s | approval |
| slow | Bash, Task | 8s | approval |

### Refinements

- **hasChildProcesses check**: For `slow` tools (Bash, Task), if the cached PID has child processes (checked via `pgrep -P`), the tool is still running and not waiting for approval.
- **PermissionRequest event**: At medium+ hook density, Claude sends a `PermissionRequest` hook which is a reliable signal. It immediately clears the timeout heuristic and sets approval status.
- **Known limitation**: Auto-approved long-running commands (npm install, builds) will briefly show as "approval" for ~8s until PostToolUse clears it.

## Hook Delivery Pipeline

### Primary: File-based Message Queue

```
Hook bash script
  → jq enrichment (PID, TTY, terminal env, timestamp)
  → echo "$ENRICHED" >> /tmp/claude-session-center/queue.jsonl
  → Background subshell + disown (non-blocking)

Server mqReader.js
  → fs.watch() for instant notification
  → 10ms debounce to coalesce rapid events
  → Read from byte offset (no re-reading processed data)
  → Split on newlines, parse JSON
  → processHookEvent() for each line
  → Truncate file at 1MB threshold
```

### Fallback: HTTP POST

When the MQ directory doesn't exist (server not started), hooks fall back to:
```
curl -s --connect-timeout 1 -m 3 -X POST \
  -H "Content-Type: application/json" \
  --data-binary @- \
  http://localhost:3333/api/hooks
```

## Important Files

- `~/.claude/settings.json` - Where Claude hooks are registered (hookInstaller.js auto-manages)
- `~/.claude/hooks/dashboard-hook.sh` - The hook script deployed to `~/.claude/hooks/`
- `~/.gemini/settings.json` - Where Gemini hooks are registered
- `~/.codex/config.toml` - Where Codex notify hook is registered
- `/tmp/claude-session-center/queue.jsonl` - File-based message queue
- `data/server-config.json` - Server configuration (port, density, CLIs, debug)

## Interaction: Click-to-Select Session

When user clicks a session card:
1. Character plays acknowledgment animation
2. Detail panel slides in from the right (resizable)
3. Panel shows: project name, prompt history (scrollable), activity log, tool calls, response excerpts, terminal, notes, queue, summary
4. Tabs: Conversation | Activity | Terminal | Notes | Queue | Summary
5. Other cards dim slightly to highlight the selected one
6. Click elsewhere, close button, or press Escape to deselect

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search |
| `Escape` | Close modal / deselect session |
| `?` | Toggle shortcuts panel |
| `S` | Toggle settings |
| `K` | Kill selected session |
| `A` | Archive selected session |
| `T` | New terminal session |
| `M` | Mute/unmute all |

## Styles

- Dark navy background (#0a0a1a)
- Neon accent colors: cyan (prompting), orange (working), green (idle), red (ended), yellow (approval), purple (input)
- JetBrains Mono font
- Glowing card borders that pulse based on status
- Styles in `src/styles/`, component-level CSS modules

## Multi-CLI Support

The dashboard supports monitoring three AI coding CLIs:

| CLI | Hook Script | Config Location | Events |
|-----|------------|-----------------|--------|
| Claude Code | dashboard-hook.sh | ~/.claude/settings.json | SessionStart, PreToolUse, etc. |
| Gemini CLI | dashboard-hook-gemini.sh | ~/.gemini/settings.json | BeforeAgent, AfterAgent, etc. |
| Codex | dashboard-hook-codex.sh | ~/.codex/config.toml | agent-turn-complete |

## Hook Density Levels

| Level | Events | Use Case |
|-------|--------|----------|
| high | All 14 Claude events | Full monitoring, approval detection |
| medium | 12 events (no TeammateIdle, PreCompact) | Default, good balance |
| low | 5 events (Start, Prompt, Permission, Stop, End) | Minimal overhead |

## Troubleshooting

### Port 3333 in Use

The server automatically kills the process occupying port 3333 on startup. To use a different port:
```bash
# Via CLI flag
npm start -- --port 4444

# Via environment variable
PORT=4444 npm start

# Via config file
echo '{"port": 4444}' > data/server-config.json
```

### Hooks Not Firing

1. Check hooks are registered: `cat ~/.claude/settings.json | grep dashboard-hook`
2. Verify the hook script exists: `ls -la ~/.claude/hooks/dashboard-hook.sh`
3. Check the hook script is executable: `chmod +x ~/.claude/hooks/dashboard-hook.sh`
4. Test manually: `echo '{"session_id":"test","hook_event_name":"SessionStart"}' | ~/.claude/hooks/dashboard-hook.sh`
5. Re-install hooks: `npm run install-hooks`

### jq Not Installed

The hook script requires `jq` for JSON enrichment. Without it, hooks still work but send unenriched JSON (no PID, TTY, or terminal detection).
```bash
# macOS
brew install jq

# Ubuntu/Debian
sudo apt-get install jq
```

### Sessions Not Appearing

1. Check the MQ file exists: `ls /tmp/claude-session-center/queue.jsonl`
2. Check for data in the queue: `tail -5 /tmp/claude-session-center/queue.jsonl`
3. Check server logs for errors: `npm run debug`
4. Verify hook density includes SessionStart: `npm run install-hooks`

### WebSocket Disconnections

The WebSocket client auto-reconnects with exponential backoff (1s base, 10s max). On reconnect, it replays missed events from the server's ring buffer (last 500 events). If sessions appear stale after reconnect, refresh the browser.
