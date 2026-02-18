# AI Agent Session Center

A real-time dashboard for monitoring and managing all your AI coding agent sessions. Launch, monitor, and control Claude Code, Codex CLI, and Gemini CLI sessions from a unified interface with an immersive 3D Cyberdrome visualization, embedded SSH terminals, approval alerts, team/subagent tracking, and comprehensive analytics.

[![npm version](https://img.shields.io/npm/v/ai-agent-session-center.svg)](https://www.npmjs.com/package/ai-agent-session-center)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-yellow)](./LICENSE)

https://github.com/coding-by-feng/ai-agent-session-center/raw/main/docs/demo.mp4

---

## Quick Start

### Using npx (Recommended)

```bash
npx ai-agent-session-center
```

The dashboard starts at **http://localhost:3333** and automatically configures hooks.

### Global Install

```bash
npm install -g ai-agent-session-center
ai-agent-session-center
```

### From Source

```bash
git clone https://github.com/coding-by-feng/ai-agent-session-center.git
cd ai-agent-session-center
npm install
npm run dev    # React + Vite dev server
# or
npm start      # Production server (serves built frontend)
```

### CLI Options

```bash
ai-agent-session-center [options]

Options:
  --port <number>    Server port (default: 3333)
  --no-open          Don't auto-open browser
  --debug            Enable verbose logging
  --setup            Re-run the interactive setup wizard
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js 18+ (ESM) + Express 5 + ws 8 |
| Frontend | React 19 + TypeScript + Vite |
| 3D Visualization | Three.js + React Three Fiber + drei |
| State Management | Zustand + React Query |
| Terminal | xterm.js + node-pty |
| Database | SQLite (better-sqlite3, WAL mode) + IndexedDB (browser) |
| Forms | React Hook Form + Zod validation |
| Charts | Recharts |
| Drag & Drop | @dnd-kit |
| Hooks | Bash script (file-based MQ primary, HTTP fallback) |
| Testing | Vitest (407+ tests) + Playwright (E2E) |
| Port | 3333 (configurable) |

---

## Core Features

### 3D Cyberdrome Visualization

The main dashboard view is a fully interactive 3D office environment rendered with React Three Fiber. Each active session is represented by an animated 3D robot character that navigates the scene in real time.

- **Dynamic room system** -- rooms are created and destroyed as sessions come and go, laid out in a 4-column grid with 12x12 unit rooms and corridors
- **8 desks per room** with monitors, keyboards, and chairs -- robots sit at desks when working
- **6 robot model variants**: Standard, Mech, Drone, Spider, Orb, Tank
- **16-color neon palette** for robot accents and wireframe overlays
- **CLI source badges** on each robot's chest (C = Claude, G = Gemini, X = Codex, O = OpenClaw)
- **Status-driven animations**: idle bob, thinking head-tilt, working charge effect, alert visor flash, and more
- **Tool-specific working animations**: reading (head scan), writing (rapid arm typing), bash (arm extended), task (both arms raised), web (antenna glow)
- **Cross-room pathfinding** with door waypoints and wall collision avoidance
- **Casual areas**: Coffee Lounge (6 tables, counter, coffee machine) and Gym (bench press, treadmill, rowing machine, bike, pull-up bar, leg press, punching bag, cable machine, kettlebells, dumbbells)
- **Status particles** burst on state transitions (confetti, rings, rising sparks)
- **Subagent connection beams** -- animated dashed laser-lines between parent and child sessions
- **Floating dialogue bubbles** showing current prompt, tool activity, or approval status
- **Robot name labels** with status dot and alert banners (pure WebGL billboards)
- **Scene environment**: circuit traces on the floor, rising data particles, grid overlays, star field, room sconce lighting
- **Camera fly-to** on robot selection with smooth lerp animation
- **Map controls overlay**: zoom in/out, top-down view, reset
- **Robot list sidebar**: sortable agent list with status indicators
- **Position persistence** -- robot positions saved to sessionStorage across page reloads

### 9 Scene Themes

Every visual element in both the 3D scene and the UI respects the active theme via 35+ color properties:

| Dark | Light |
|------|-------|
| Command Center (default) | Light |
| Cyberpunk | Warm |
| Dracula | Blonde |
| Nord | |
| Monokai | |
| Solarized | |

---

### Session Management

Every active AI coding session appears as an animated robot. At a glance you can see:

- **What each session is doing** -- idle, prompting, working, waiting, approval needed, or input needed
- **Project name and working directory**
- **Live duration timer**
- **Prompt count and tool call count** updating in real time
- **Activity feed** at the bottom showing events as they happen

#### Status Colors

| Status | What it means | Visual |
|--------|---------------|--------|
| **Idle** | No activity | Green, robot seeks coffee lounge |
| **Prompting** | You just sent a prompt | Cyan, robot walks to desk |
| **Working** | Claude is calling tools | Orange, charging effect, sits at desk |
| **Waiting** | Claude finished, your turn | Cyan, robot goes to gym |
| **Approval** | Tool blocked, needs yes/no | Yellow, visor flash, alarm |
| **Input** | Waiting for your answer | Purple, arm raised |
| **Ended** | Session closed | Red, offline animation |
| **Connecting** | SSH terminal connecting | Gray, boot animation |

#### Auto-Idle Timeouts

Sessions automatically transition to prevent stale states:

- Prompting -> Waiting (30s)
- Waiting -> Idle (2 min)
- Working -> Idle (3 min)
- Approval/Input -> Idle (10 min safety net)

---

### Launch Sessions

**Three ways to start:**

1. **+ NEW SESSION** -- Full SSH terminal with configuration:
   - Local or remote connections (native SSH, uses your `~/.ssh/config` and agent)
   - Session labels for organization (ONEOFF, HEAVY, IMPORTANT, or custom)
   - Choose CLI: Claude Code, Codex CLI, Gemini CLI, or custom command
   - tmux integration: attach to existing sessions or wrap new ones
   - Per-session terminal themes, API keys, titles
   - Working directory history (last 20, MRU)

2. **QUICK SESSION** -- Launch with last config, just pick a label

3. **Preset Labels** -- Quick buttons for common workflows:
   - **ONEOFF** -- One-off task with completion review reminder
   - **HEAVY** -- High-priority session (auto-pinned to top)
   - **IMPORTANT** -- Alert on completion

---

### Embedded Terminals

Each session gets a **full xterm.js terminal** in the detail panel:

- **Direct command execution** in the same shell Claude is using
- **Prompt queue** -- compose and stage prompts, send with Ctrl+Enter
- **Auto-reconnect** on dashboard refresh
- **Fullscreen mode** for focused work
- **8 terminal themes** + auto (matches dashboard theme)
- **tmux support** -- attach to existing sessions or create new ones
- **Team terminal view** -- split-view of all team member terminals
- **Output ring buffer** -- 128KB replay for new connections

---

### Approval Alerts

When Claude needs your approval for a tool call:

- Card turns **screaming yellow** with "AWAITING APPROVAL" banner
- Robot **visor flashes** with escalating urgency (faster after 15s, lateral shake after 30s)
- **3-burst alarm** plays and **repeats every 10 seconds** until you respond
- No false alarms -- auto-approved tools resolve instantly
- **`hasChildProcesses` check** for Bash/Task tools prevents false positives during long-running commands
- **PermissionRequest** hook event provides a reliable direct signal (medium+ density)

**Input Detection:** Tools requiring your answer (`AskUserQuestion`, `EnterPlanMode`) trigger a distinct purple "NEEDS INPUT" state.

---

### Session Detail Panel

Click any robot or session card to open a slide-in panel with:

| Tab | Content |
|-----|---------|
| **Terminal** | xterm.js terminal with WebSocket relay, reconnect button |
| **Prompts** | Full prompt history, numbered and timestamped, with COPY buttons. Previous sessions shown as collapsible accordions for resumed sessions. |
| **Activity** | Interleaved tool calls, events, and response excerpts (newest first) |
| **Notes** | Per-session persistent notes with timestamps |
| **Summary** | AI-generated session summaries with 5 built-in templates |
| **Queue** | Prompt queue management -- compose, reorder, send, move between sessions |

#### Session Controls

| Action | Description |
|--------|------------|
| **Kill** | SIGTERM -> SIGKILL with confirmation modal |
| **Archive** | Move to history, keep in IndexedDB |
| **Resume** | Reconnect ended SSH session (`claude --resume`) |
| **Summarize** | AI summary using configurable prompt templates |
| **Notes** | Attach persistent notes |
| **Alert** | Duration threshold notifications |
| **Labels** | ONEOFF / HEAVY / IMPORTANT with custom label history |
| **Title** | Inline-editable custom titles |

#### Summary Templates (5 built-in)

- Detailed Technical Summary (default)
- Quick Bullet Points
- Changelog Entry
- Handoff Notes
- PR Description

Custom templates can be created, edited, and saved.

---

### Team & Subagent Tracking

When Claude spawns agent teams:

- **Auto-detection** via `CLAUDE_CODE_PARENT_SESSION_ID` env var or path-based matching
- **Team badge** on parent session with member list
- **Animated connection beams** between parent and child robots in the 3D scene
- **Team config reader** loads `~/.claude/teams/{name}/config.json` for member roles and colors
- **Team terminal view** with split panes for all members
- **Auto-cleanup** when all team members end

---

### Prompt Queue

Stage and manage prompts for any session:

- **Compose** prompts in the Queue tab textarea
- **Reorder** via drag-and-drop
- **Send** individual items or auto-send on terminal focus
- **Move** prompts between sessions (enter move mode, click target)
- **Drag to terminal** -- drop queue items directly onto the terminal
- **Ctrl+Enter** sends the first queued prompt
- **Global queue view** (Queue route) shows all queued prompts across sessions with export

---

### Sound System

16 synthesized tones (Web Audio API, no audio files) mapped to 20 configurable actions:

**Tones:** chirp, ping, chime, ding, blip, swoosh, click, beep, warble, buzz, cascade, fanfare, alarm, thud, urgentAlarm, none

**Per-CLI sound profiles** with independent volume and action mappings for Claude, Gemini, Codex, and OpenClaw.

**6 ambient presets** (procedurally generated): Off, Rain, Lo-Fi, Server Room, Deep Space, Coffee Shop.

**Label completion alerts**: ONEOFF triggers alarm+shake, HEAVY triggers urgentAlarm+electric frame, IMPORTANT triggers fanfare+liquid frame.

---

### Analytics

The **Analytics** route shows usage patterns:

- **Summary stats** -- total sessions, prompts, tool calls, avg duration, most-used tool, busiest project
- **Tool usage** -- horizontal bar chart with counts and percentages (top 15)
- **Active projects** -- ranked by session count with last activity date
- **Daily heatmap** -- 7x24 grid showing when you use AI agents most

---

### History & Search

The **History** route provides:

- **Full-text search** across prompts, responses, and tool names (powered by SQLite)
- **Filter** by project, status, or date range
- **Sort** by date, duration, prompt count, or tool calls
- **Pagination** (50 per page)
- Click any row to open the full detail panel with conversation history

---

### Timeline View

Visual timeline showing session activity over time:

- **Grouped bar chart** with sessions (cyan), prompts (green), and tool calls (orange)
- **Granularity**: hour / day / week / month
- **Filter** by project and date range

---

### Session Groups

Organize sessions into named groups:

- **4 default groups**: Priority, Active, Background, Review
- **12-column CSS grid layout** with 5 presets (1-col, 2-col, 3-col, 1/3+2/3, 2/3+1/3)
- **Drag-and-drop** sessions between groups
- **Resizable** group columns (drag handles)
- **Collapsible** groups
- **Auto-assign** new sessions to last-used group

---

### Authentication

Optional password protection for the dashboard:

- **scrypt-based** password hashing with timing-safe comparison
- **24-hour tokens** via cookie, Authorization header, or query param
- **WebSocket authentication** -- unauthenticated connections rejected with code 4001
- Hooks bypass auth (they must work without login)

---

## How It Works

```
AI CLI (Claude / Gemini / Codex)
         |
    Hook Script (bash)
    - Reads stdin JSON
    - Enriches with PID, TTY, terminal env vars, team data
    - Single jq pass (~2-5ms)
         |
         v
  /tmp/claude-session-center/queue.jsonl
  - Atomic POSIX append (~0.1ms)
  - Fallback: HTTP POST to localhost:3333/api/hooks
         |
         v
  Server (Express + WebSocket)
  - mqReader.js: fs.watch() + 10ms debounce
  - hookProcessor.js: validate + process
  - sessionStore.js: state machine + SQLite dual-write
  - wsManager.js: broadcast to all browsers
         |
         v
  React Frontend
  - Zustand stores + React Three Fiber 3D scene
  - IndexedDB for client-side persistence
```

**End-to-end latency: 3-17ms** (hook fired to browser updated)

All hooks run async with fire-and-forget -- they never slow down your AI CLI.

### Hook Delivery

The primary transport is a **file-based message queue** (JSONL). The bash hook script appends enriched JSON to `/tmp/claude-session-center/queue.jsonl` via POSIX atomic append (~0.1ms). The server watches this file with `fs.watch()` and reads from a byte offset (no re-reading). Falls back to HTTP POST when the MQ directory doesn't exist.

### Session Matching (5-Priority System)

When a hook event arrives with an unknown `session_id`, the matcher links it to the correct terminal session:

| Priority | Strategy | Risk |
|----------|----------|------|
| 0 | `pendingResume` + terminal ID / workDir | Low |
| 1 | `agent_terminal_id` env var | Low |
| 2 | `tryLinkByWorkDir` | Medium |
| 3 | Path scan (connecting sessions) | Medium |
| 4 | PID parent check | High |

If no match is found, a display-only card is created with the detected source (VS Code, iTerm, Warp, Ghostty, etc.).

### Terminal Detection

The hook script detects and enriches events with metadata from: **iTerm2**, **Kitty**, **Warp**, **WezTerm**, **Ghostty**, **VS Code**, **JetBrains IDEs**, **Alacritty**, **Hyper**, and **tmux**.

---

## Multi-CLI Support

| CLI | Hook Script | Config Location | Events |
|-----|------------|-----------------|--------|
| Claude Code | dashboard-hook.sh | ~/.claude/settings.json | 14 events (high density) |
| Gemini CLI | dashboard-hook-gemini.sh | ~/.gemini/settings.json | 7 events |
| Codex | dashboard-hook-codex.sh | ~/.codex/config.toml | 1 event |

### Hook Density Levels

| Level | Claude Events | Use Case |
|-------|--------------|----------|
| high | All 14 | Full monitoring, approval detection |
| medium | 12 (no TeammateIdle, PreCompact) | Default, good balance |
| low | 5 (Start, Prompt, Permission, Stop, End) | Minimal overhead |

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search bar |
| `?` | Toggle shortcuts panel |
| `Esc` | Close panel / modal / send escape to terminal |
| `S` | Toggle settings |
| `K` | Kill selected session |
| `A` | Archive selected session |
| `T` | Open new session modal |
| `M` | Toggle global mute |
| `Ctrl+Enter` | Send first queued prompt to terminal |

---

## Settings

**Appearance** -- theme, font size, scanline CRT effect, animation intensity and speed sliders, default robot model

**Sound** -- enable/disable, master volume, per-action tone selection, per-CLI sound profiles, ambient presets (rain, lo-fi, server room, deep space, coffee shop)

**Labels** -- per-label sound, movement effect, and frame effect configuration (fire, electric, golden aura, liquid energy, plasma overload)

**Hooks** -- density selector, install/uninstall buttons

**API Keys** -- Anthropic, OpenAI, Gemini key inputs (used for per-session overrides)

**Import/Export** -- export all settings as JSON, import to restore, reset to defaults

---

## Commands

```bash
# Development (React + Vite hot reload + server)
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Start without opening browser
npm run start:no-open

# Start in debug mode
npm run debug

# Interactive setup wizard
npm run setup

# Install hooks
npm run install-hooks

# Uninstall hooks
npm run uninstall-hooks

# Reset everything (remove hooks, clean config, create backup)
npm run reset

# Run tests (407+ Vitest tests)
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage

# E2E tests (Playwright)
npm run test:e2e

# Type check
npm run typecheck

# Lint
npm run lint

# Format
npm run format
```

---

## Project Structure

```
src/                          # React 19 + TypeScript frontend
├── App.tsx                   # Auth gate, router, layout
├── routes/
│   ├── LiveView.tsx          # 3D Cyberdrome scene (lazy-loaded)
│   ├── HistoryView.tsx       # Session history with search
│   ├── TimelineView.tsx      # Timeline visualization
│   ├── AnalyticsView.tsx     # Usage analytics
│   └── QueueView.tsx         # Global prompt queue
├── components/
│   ├── 3d/                   # Three.js / R3F components
│   │   ├── CyberdromeScene.tsx      # Canvas wrapper (zero Zustand inside Canvas)
│   │   ├── CyberdromeEnvironment.tsx # Walls, desks, floors, lighting, particles
│   │   ├── SessionRobot.tsx         # Per-session robot (memoized, ref-based animation)
│   │   ├── Robot3DModel.tsx         # Robot geometry, materials, animations
│   │   ├── RobotDialogue.tsx        # Floating speech bubbles
│   │   ├── RobotLabel.tsx           # Name tags with status dots
│   │   ├── RobotListSidebar.tsx     # DOM overlay agent list
│   │   ├── StatusParticles.tsx      # Particle bursts on transitions
│   │   ├── SubagentConnections.tsx  # Parent-child laser beams
│   │   ├── CameraController.tsx     # Smooth fly-to animation
│   │   ├── RoomLabels.tsx           # Floor text labels
│   │   └── SceneOverlay.tsx         # Map controls + room badges
│   ├── session/              # Session detail panel and controls
│   ├── terminal/             # xterm.js terminal + toolbar
│   ├── settings/             # Settings panel tabs
│   ├── modals/               # New session, quick session, shortcuts
│   ├── layout/               # Header, navbar, activity feed
│   ├── auth/                 # Login screen
│   └── ui/                   # Modal, tabs, search, toast, resize
├── stores/                   # Zustand stores
│   ├── sessionStore.ts       # Sessions, selection, teams
│   ├── settingsStore.ts      # All user preferences
│   ├── roomStore.ts          # Dynamic room management
│   ├── uiStore.ts            # Modals, panels, toasts
│   ├── wsStore.ts            # WebSocket connection state
│   ├── queueStore.ts         # Prompt queue
│   └── cameraStore.ts        # Camera fly-to targets
├── hooks/                    # React hooks
├── lib/                      # Utilities, sound engine, scene config
└── styles/                   # CSS modules

server/                       # Node.js backend
├── index.js                  # Express + WS orchestrator
├── apiRouter.js              # REST API endpoints
├── hookRouter.js             # POST /api/hooks (HTTP fallback)
├── hookProcessor.js          # Hook validation + processing
├── mqReader.js               # File-based JSONL queue reader
├── sessionStore.js           # In-memory state machine (coordinator)
│   ├── sessionMatcher.js     # 5-priority session matching
│   ├── approvalDetector.js   # Tool approval timeout logic
│   ├── teamManager.js        # Team/subagent tracking
│   ├── processMonitor.js     # PID liveness checking
│   └── autoIdleManager.js    # Idle transition timers
├── wsManager.js              # WebSocket broadcast + terminal relay
├── sshManager.js             # SSH/PTY terminal management
├── db.js                     # SQLite schema + queries
├── hookInstaller.js          # Auto-install hooks on startup
├── hookStats.js              # Performance statistics
├── config.js                 # Tool categories, timeouts
├── constants.js              # Centralized magic strings
├── serverConfig.js           # User config from data/server-config.json
└── logger.js                 # Debug-aware logging

public/                       # Legacy vanilla JS frontend (fallback)
hooks/                        # Hook scripts + installers
├── dashboard-hook.sh         # Main hook (bash)
├── dashboard-hook.ps1        # Windows PowerShell variant
├── dashboard-hook-gemini.sh  # Gemini CLI adapter
├── dashboard-hook-codex.sh   # Codex CLI adapter
├── install-hooks.js          # CLI installer
├── setup-wizard.js           # Interactive 6-step setup
└── reset.js                  # Full reset with backup

bin/cli.js                    # npx/global CLI entry point
data/server-config.json       # User configuration
```

---

## REST API

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List all in-memory sessions |
| `PUT` | `/api/sessions/:id/title` | Update title |
| `PUT` | `/api/sessions/:id/label` | Update label |
| `PUT` | `/api/sessions/:id/accent-color` | Update accent color |
| `POST` | `/api/sessions/:id/kill` | Kill session (SIGTERM -> SIGKILL) |
| `POST` | `/api/sessions/:id/resume` | Resume SSH session |
| `POST` | `/api/sessions/:id/summarize` | AI summarization |
| `DELETE` | `/api/sessions/:id` | Delete session |

### Terminals

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/terminals` | Create PTY terminal (max 10) |
| `GET` | `/api/terminals` | List active terminals |
| `DELETE` | `/api/terminals/:id` | Close terminal |

### History & Analytics

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/db/sessions` | Search/list sessions (paginated) |
| `GET` | `/api/db/sessions/:id` | Full session detail |
| `GET` | `/api/db/search` | Full-text search |
| `GET` | `/api/db/projects` | Distinct projects |
| `GET` | `/api/db/analytics/summary` | Summary stats |
| `GET` | `/api/db/analytics/tools` | Tool breakdown |
| `GET` | `/api/db/analytics/projects` | Active projects |
| `GET` | `/api/db/analytics/heatmap` | Activity heatmap |

### Other

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/auth/status` | Auth status |
| `POST` | `/api/auth/login` | Login |
| `GET` | `/api/hooks/status` | Hook density and installed events |
| `POST` | `/api/hooks/install` | Install hooks |
| `GET` | `/api/ssh-keys` | List SSH keys from `~/.ssh/` |
| `POST` | `/api/tmux-sessions` | List tmux sessions on host |
| `GET` | `/api/teams/:id/config` | Read team config |

---

## Troubleshooting

### Port 3333 in Use

The server automatically kills the process occupying port 3333 on startup. To use a different port:

```bash
npx ai-agent-session-center --port 4444
PORT=4444 npm start
```

### Hooks Not Firing

1. Check hooks are registered: `cat ~/.claude/settings.json | grep dashboard-hook`
2. Verify the hook script exists: `ls -la ~/.claude/hooks/dashboard-hook.sh`
3. Verify executable: `chmod +x ~/.claude/hooks/dashboard-hook.sh`
4. Test manually: `echo '{"session_id":"test","hook_event_name":"SessionStart"}' | ~/.claude/hooks/dashboard-hook.sh`
5. Re-install: `npm run install-hooks`

### jq Not Installed

The hook script requires `jq` for JSON enrichment. Without it, hooks still work but send unenriched JSON.

```bash
# macOS
brew install jq

# Ubuntu/Debian
sudo apt-get install jq
```

### Sessions Not Appearing

1. Check MQ file: `ls /tmp/claude-session-center/queue.jsonl`
2. Check data: `tail -5 /tmp/claude-session-center/queue.jsonl`
3. Debug mode: `npm run debug`
4. Verify density includes SessionStart: `npm run install-hooks`

### WebSocket Disconnections

Auto-reconnects with exponential backoff (1s base, 10s max). On reconnect, replays missed events from the server's ring buffer (last 500 events).

---

## License

MIT
