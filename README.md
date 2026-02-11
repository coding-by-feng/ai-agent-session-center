# AI Agent Session Center

A real-time dashboard for monitoring and managing all your AI coding agent sessions. Launch, monitor, and control Claude Code, Codex CLI, and Gemini CLI sessions from a unified interface with embedded SSH terminals, approval alerts, and comprehensive analytics.

[![npm version](https://img.shields.io/npm/v/ai-agent-session-center.svg)](https://www.npmjs.com/package/ai-agent-session-center)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-yellow)](./LICENSE)

---

## Quick Start

### Using npx (Recommended - No Install Required)

```bash
npx ai-agent-session-center
```

That's it! The dashboard will start at **http://localhost:3333** and automatically configure hooks.

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
npm start
```

### CLI Options

```bash
ai-agent-session-center [options]

Options:
  --port <number>    Server port (default: 3333)
  --no-open          Don't auto-open browser
  --debug            Enable verbose logging

Examples:
  npx ai-agent-session-center --port 8080
  ai-agent-session-center --no-open --debug
```

All active AI agent sessions appear automatically as animated character cards with live status updates.

---

## Usage Guide

### Starting Your First Session

1. **Launch the dashboard:**
   ```bash
   npm start
   ```
   Opens at http://localhost:3333

2. **Create a session:**
   - Click **+ NEW SESSION** button (or press `T`)
   - Fill in the launch form:
     - **Connection:** Choose "Local" for localhost or "SSH" for remote
     - **Label:** Tag for organization (e.g., "frontend", "api", "debug")
     - **Title:** Optional custom display name
     - **CLI:** Select Claude Code, Codex CLI, Gemini CLI, or custom command
     - **Directory:** Working directory for the session
     - **API Key:** Optional per-session override

3. **Watch it appear:**
   - A new animated character card appears in the dashboard
   - The character animates based on what Claude is doing
   - Status updates in real-time via WebSocket

### Using the Terminal

1. **Open a session's terminal:**
   - Click any session card
   - Click the **Terminal** tab in the detail panel

2. **Execute commands:**
   - Type any command and press Enter
   - Commands run in Claude's shell environment
   - See output in real-time

3. **Queue prompts for Claude:**
   - Type a prompt in the text area at the top
   - Press `Ctrl+Enter` to add to queue
   - Send when ready (queued prompts appear as chips)

4. **Fullscreen mode:**
   - Press `F11` while terminal is focused
   - Press `F11` again to exit

### Responding to Approvals

When Claude needs approval for a tool call:

1. **You'll notice:**
   - Card border turns **screaming yellow**
   - Character **shakes** with floating **"!"**
   - **3-burst alarm** plays (repeats every 10s)
   - Banner says "NEEDS YOUR APPROVAL"

2. **Respond:**
   - Click the card to open detail panel
   - Or switch to your terminal where Claude is running
   - Approve/deny the tool call in the terminal
   - Card returns to normal once resolved

3. **False alarm?**
   - Fast tools (Read, Grep, Glob) auto-approve instantly
   - Only blocking tools trigger alerts
   - Adjust thresholds in `server/config.js` if needed

### Managing Multiple Sessions

1. **Use labels:**
   - Launch sessions with descriptive labels
   - Quick presets: **ONEOFF**, **★ HEAVY**, **⚠ IMPORTANT**

2. **Organize into groups:**
   - Drag sessions onto group headers
   - Or assign from detail panel → **Group** dropdown
   - Groups persist in localStorage

3. **Pin important sessions:**
   - Click the **★** icon in the detail panel
   - Pinned sessions stay at the top

4. **Archive completed work:**
   - Press `A` with session selected
   - Or click **ARCHIVE** in detail panel
   - View archived sessions in **History** tab

### Searching Session History

1. **Open History tab:**
   - Click **History** in the navigation bar

2. **Full-text search:**
   - Type in the search box (or press `/` anywhere)
   - Searches prompts, responses, and tool names
   - Powered by SQLite FTS5 for fast results

3. **Filter results:**
   - Use dropdowns for project, status, date range
   - Sort by date, duration, prompt count, or tool calls
   - Paginated (50 per page)

4. **View a historical session:**
   - Click any row to open full details
   - All conversation history, tools, and events preserved

### Analyzing Usage Patterns

1. **Open Analytics tab:**
   - Click **Analytics** in the navigation bar

2. **Tool Usage breakdown:**
   - See which tools Claude uses most
   - Bar chart with percentages
   - Filter by date range

3. **Duration Trends:**
   - How long your sessions run over time
   - Choose granularity: hour/day/week/month
   - Line chart visualization

4. **Daily Heatmap:**
   - See when you use Claude most
   - Hour-by-day grid
   - Darker = more active

### Customizing Appearance

1. **Open Settings:**
   - Click the gear icon or press `S`

2. **Change theme:**
   - **Appearance** section → **Theme** dropdown
   - 9 themes available (6 dark, 3 light)
   - Changes apply instantly

3. **Adjust card size:**
   - **Card Size** dropdown: small/compact/normal/large
   - Useful when monitoring many sessions

4. **Character model:**
   - **Default Character** dropdown
   - 20 models to choose from
   - Override per-session in detail panel

5. **Animation controls:**
   - **Animation Intensity:** 0-100% (how dramatic)
   - **Animation Speed:** 0.5x-3x (how fast)
   - **Scanline Effect:** CRT-style overlay toggle

### Customizing Sounds

1. **Open Settings → Sounds:**
   - Enable/disable sound globally
   - Adjust master volume (0-100%)

2. **Configure per-action sounds:**
   - 19 actions organized by category
   - 16 available tones (chirp, ping, alarm, etc.)
   - Click **Preview** to hear each tone
   - Set any action to "none" to mute it

3. **Examples:**
   - `approvalNeeded` → `urgentAlarm` (default screamer)
   - `toolWrite` → `blip` (subtle edit notification)
   - `sessionEnd` → `cascade` (satisfying completion)

### Customizing Movement Effects

1. **Open Settings → Movement:**
   - Configure visual effects per action
   - 18 effects available

2. **Effect types:**
   - **sweat** — droplets fall from character
   - **shake** — vibration for urgency
   - **sparkle** — celebratory stars
   - **fade** — ghost-like transparency
   - **breathe** — subtle pulse

3. **Defaults:**
   - `toolWrite` → sweat drops
   - `approvalNeeded` → shake
   - `sessionEnd` → fade
   - `taskComplete` → sparkle

### Working with Teams

When Claude spawns agent teams:

1. **Auto-detection:**
   - Dashboard detects parent/child relationships
   - Team badge appears on parent session card

2. **View team members:**
   - Click the **Team** badge
   - Modal shows all team members
   - Navigate between team members

3. **Monitoring teams:**
   - All team members appear as separate cards
   - Grouped together visually
   - Each has independent status/terminal

### Advanced Workflows

**Workflow 1: Quick iteration cycles**
1. Launch with **⚡ QUICK** button
2. Terminal tab → queue multiple prompts
3. Send all at once with batch submit
4. Monitor progress via character animations

**Workflow 2: Remote development**
1. **+ NEW SESSION** → SSH connection
2. Enter hostname from your `~/.ssh/config`
3. Choose working directory on remote
4. Terminal uses native SSH (respects your agent)

**Workflow 3: Long-running tasks**
1. Launch session with **⚠ IMPORTANT** label
2. Set duration alert in detail panel
3. Let it run in background
4. Get notified when threshold exceeded

**Workflow 4: Multi-project juggling**
1. Create groups: "Frontend", "Backend", "DevOps"
2. Launch sessions with appropriate labels
3. Drag sessions into groups
4. Minimize inactive groups

**Workflow 5: Session review**
1. Archive completed sessions
2. **History** tab → search for specific work
3. **Export** button → download full transcript
4. **Summarize** → generate AI summary

---

## Core Features

### 🚀 Launch Sessions

**Three Ways to Start:**

1. **+ NEW SESSION** — Full SSH terminal with configuration:
   - Local or remote connections (native SSH, uses your ~/.ssh/config and agent)
   - Session labels for organization (e.g., "frontend", "api", "debug")
   - Custom titles for disambiguation
   - Choose CLI: Claude Code, Codex CLI, Gemini CLI, or custom command
   - tmux integration: attach to existing sessions or wrap new ones
   - Per-session terminal themes
   - API keys (optional per-session override of global settings)

2. **⚡ QUICK** — Launch with last config + just pick a label
   - Remembers your SSH config from the last full launch
   - One-click workflow for rapid session spawning

3. **Preset Labels** — Quick buttons for common workflows:
   - **ONEOFF** — One-off task with completion review reminder
   - **★ HEAVY** — High-priority session (auto-pinned to top)
   - **⚠ IMPORTANT** — Alert on completion

**Pro Tip:** Use `T` keyboard shortcut to open New Session modal

---

### 📺 Embedded Terminals

Each session gets a **full xterm.js terminal** in the detail panel:

- **Direct command execution** — Run commands in the same shell Claude is using
- **Prompt queue** — Add prompts to a queue, send them with Ctrl+Enter
- **Session persistence** — Reconnects automatically if dashboard refreshes
- **Fullscreen mode** — F11 to go fullscreen for focused work
- **Terminal themes** — 7 built-in themes (or match dashboard theme)
- **tmux support** — Attach to existing tmux sessions or create new ones

**Workflow:** Click any session card → Terminal tab → Start typing. Your commands run in the same environment as Claude.

---

### 🚨 Approval Alerts (Never Miss a Blocked Tool)

When Claude needs your approval for a tool call:

- Card turns **screaming yellow** with "NEEDS YOUR APPROVAL" banner
- Character **shakes** with floating **"!"** exclamation mark
- **3-burst alarm** plays and **repeats every 10 seconds** until you respond
- No false alarms — auto-approved tools (Read, Grep, Glob) resolve instantly

**Detection:** Monitors tool timing. If `PostToolUse` doesn't arrive within 3s (fast tools) or 15s (medium tools like WebFetch), approval is required.

**Input Detection:** Tools requiring your answer (`AskUserQuestion`, `EnterPlanMode`) trigger a distinct "WAITING FOR YOUR ANSWER" state with a softer chime sound.

---

## Live Session Dashboard

Every active Claude Code session appears as an animated character card. At a glance you can see:

- **What each session is doing** — idle, prompting, working, waiting for input, or needing approval
- **Project name and working directory** for each session
- **Live duration timer** counting up since session start
- **Prompt count and tool call count** updating in real time
- **Activity feed** at the bottom showing events as they happen

### Status Colors

| Status | What it means | Visual |
|--------|---------------|--------|
| **Idle** | No activity | Green border, calm character |
| **Prompting** | You just sent a prompt | Cyan pulse, walking animation |
| **Working** | Claude is calling tools | Orange pulse, running animation |
| **Waiting** | Claude finished, your turn | Soft blue, gentle pulse |
| **Approval** | Tool blocked, needs your yes/no | Yellow screaming, alarm sound |
| **Input** | Waiting for your answer | Purple glow, chime sound |
| **Ended** | Session closed | Red, faded, auto-removed after 60s |

### Auto-Idle Timeouts

Sessions automatically transition to prevent stale states:

- Prompting &rarr; Waiting (30s)
- Waiting &rarr; Idle (2 min)
- Working &rarr; Idle (3 min)
- Approval/Input &rarr; Idle (10 min safety net)

---

## 20 Character Models

All characters are CSS-animated (no WebGL required). Pick a character globally or per-session.

**Robot** &middot; **Cat** &middot; **Alien** &middot; **Ghost** &middot; **Orb** &middot; **Dragon** &middot; **Penguin** &middot; **Octopus** &middot; **Mushroom** &middot; **Fox** &middot; **Unicorn** &middot; **Jellyfish** &middot; **Owl** &middot; **Bat** &middot; **Cactus** &middot; **Slime** &middot; **Pumpkin** &middot; **Yeti** &middot; **Crystal** &middot; **Bee**

Set a global default in Settings > Character Model, or override per-session in the detail panel.

---

## Session Detail Panel

Click any session card to open a slide-in panel with everything about that session:

- **Conversation** — full prompt/response history in order, with tool calls inline
- **Tool Log** — every tool call with input summaries and timestamps
- **Events** — raw session event stream
- **Notes** — attach persistent notes to any session
- **Summary** — AI-generated session summaries (uses prompt templates you can customize)

### Session Controls

| Button | What it does |
|--------|-------------|
| **OPEN IN EDITOR** | Jump to the project in your editor |
| **KILL** | Send SIGTERM to the Claude process (with confirmation) |
| **ARCHIVE** | Hide from live view, still accessible in history |
| **SUMMARIZE** | Generate an AI summary using a prompt template |
| **EXPORT** | Download the full session transcript as JSON |
| **NOTES** | Add/view persistent notes |
| **ALERT** | Get notified when a session exceeds a duration threshold |

You can also set per-session **character models**, **accent colors**, and **custom titles**.

---

## Session Groups

Organize sessions into named groups. Drag-and-drop or assign from the detail panel. Groups are persisted in localStorage. Useful when running many sessions across different projects.

---

## Team Detection

When Claude Code spawns agent teams (via the Agent SDK), the dashboard detects parent/child session relationships and groups them together. Click the team badge to see all members in a modal.

---

## Sound System

16 synthesized tones (no audio files needed) mapped to 19 configurable actions, all generated via the Web Audio API:

**Tones:** chirp, ping, chime, ding, blip, swoosh, click, beep, warble, buzz, cascade, fanfare, alarm, thud, urgentAlarm, none

**Actions organized by category:**

| Category | Actions |
|----------|---------|
| **Session Events** | sessionStart, sessionEnd, promptSubmit, taskComplete |
| **Tool Calls** | toolRead, toolWrite, toolEdit, toolBash, toolGrep, toolGlob, toolWebFetch, toolTask, toolOther |
| **System** | approvalNeeded, inputNeeded, alert, kill, archive, subagentStart, subagentStop |

The `urgentAlarm` is the approval screamer — a loud 3-burst square wave alarm that repeats every 10 seconds until you act.

Configure in **Settings > Sounds**: pick which tone plays for each action, adjust master volume, or mute entirely.

---

## Movement Effects

18 visual effects that trigger per-action, mirroring the sound system:

**none** &middot; **sweat** &middot; **energy-ring** &middot; **sparks** &middot; **steam** &middot; **eye-cycle** &middot; **think-pulse** &middot; **head-tilt** &middot; **float** &middot; **breathe** &middot; **sway** &middot; **sparkle** &middot; **bounce** &middot; **flash** &middot; **shake** &middot; **fade** &middot; **shrink** &middot; **dissolve**

Each action (same 19 as sounds) can be assigned any effect. Defaults are sensible — `toolWrite` triggers sweat drops, `approvalNeeded` triggers shake, `sessionEnd` triggers fade.

---

## 9 Themes

| Dark | Light |
|------|-------|
| Command Center (default) | Light |
| Cyberpunk | Warm |
| Dracula | Blonde |
| Nord | |
| Monokai | |
| Solarized | |

Switch in **Settings > Appearance**. Every element respects the active theme via CSS custom properties.

---

## Session History

All sessions are persisted to a local SQLite database (`data/sessions.db`). The **History** tab gives you:

- Full-text search across all prompts, responses, and tool names (powered by FTS5)
- Filter by project, status, or date range
- Sort by date, duration, prompt count, or tool calls
- Pagination (50 per page)

Historical sessions from `~/.claude/projects/` are auto-imported on startup via JSONL parsing.

---

## Timeline View

Visual timeline showing when sessions were active. Switch between hourly, daily, or weekly granularity. Filter by project and date range.

---

## Analytics

The **Analytics** tab shows usage patterns:

- **Tool Usage** — bar chart of which tools Claude uses most, with percentages
- **Duration Trends** — how long your sessions run over time (hour/day/week/month granularity)
- **Active Projects** — ranked by session count
- **Daily Heatmap** — hour-by-day grid showing when you use Claude most

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search bar |
| `Esc` | Close panel / modal |
| `S` | Open settings |
| `K` | Kill selected session |
| `A` | Archive selected session |
| `E` | Export selected session |
| `N` | Session notes |
| `?` | Show shortcuts help |

---

## Settings

**Appearance** — theme, font size (10-20px), card size (small/compact/normal/large), scanline CRT effect, animation intensity and speed sliders, default character model

**Sounds** — enable/disable, master volume, per-action tone selection with live preview

**Advanced** — summary prompt template editor, import/export settings as JSON, reset to defaults, activity feed toggle

All settings persist in the SQLite database and survive restarts.

---

## How It Works

```
Claude Code ──(hooks)──> Express Server ──(WebSocket)──> Browser Dashboard
                              │
                         SQLite DB
                     (sessions, analytics,
                      settings, notes)
```

1. Claude Code fires hook events (session start, prompt, tool use, stop, etc.)
2. A bash hook script enriches the JSON with terminal metadata (PID, TTY, terminal app, tab ID) and POSTs it to `localhost:3333`
3. The server processes events, updates the in-memory state machine + SQLite (dual-write)
4. WebSocket pushes updates to all connected browsers
5. The dashboard renders everything in real time with CSS animations and Web Audio

All hooks run with `async: true` and fire-and-forget — they never slow down Claude.

### Terminal Support

The hook script detects and enriches events with metadata from: **iTerm2**, **Kitty**, **Warp**, **WezTerm**, **Ghostty**, **VS Code**, **JetBrains IDEs**, and **tmux**. It also manages terminal tab titles (sets them to "Claude: \<project\>" via OSC escape sequences).

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js (ESM) + Express 5 |
| WebSocket | ws 8 |
| Database | SQLite (better-sqlite3) with WAL mode + FTS5 |
| Frontend | Vanilla JS (ES2022, zero build step) |
| Characters | CSS-animated (20 models) |
| Audio | Web Audio API (synthesized, no audio files) |
| Font | JetBrains Mono |
| Hooks | Bash (macOS/Linux) + PowerShell (Windows) |

---

## Project Structure

```
server/
├── index.js           # Express + WebSocket server entry (port 3333)
├── sessionStore.js    # In-memory state machine with SQLite dual-write
├── hookRouter.js      # POST /api/hooks endpoint
├── apiRouter.js       # REST API (sessions, analytics, settings, search)
├── wsManager.js       # WebSocket broadcast to connected browsers
├── db.js              # SQLite schema, tables, FTS5, prepared statements
├── config.js          # Tool categories, timeouts, status animations
├── queryEngine.js     # Session search, filtering, pagination
├── analytics.js       # Tool usage, duration trends, heatmaps
├── importer.js        # Historical JSONL session importer
└── logger.js          # Debug-aware colored logging

public/
├── index.html         # Dashboard UI
├── css/
│   └── dashboard.css  # 9 themes, animations, responsive layout
└── js/
    ├── app.js             # Bootstrap: WS connect, event routing
    ├── sessionPanel.js    # Session cards, detail panel, drag-drop groups
    ├── robotManager.js    # 20 CSS character models
    ├── soundManager.js    # 16 synthesized tones, per-action mapping
    ├── movementManager.js # 18 movement effects, per-action mapping
    ├── settingsManager.js # Settings persistence, theme/font management
    ├── statsPanel.js      # Global stats header bar
    ├── wsClient.js        # WebSocket client with auto-reconnect
    ├── navController.js   # View switching (live/history/timeline/analytics)
    ├── historyPanel.js    # Full-text search, filters, pagination
    ├── timelinePanel.js   # Hour/day/week timeline charts
    ├── analyticsPanel.js  # Tool breakdown, duration trends, heatmaps
    └── chartUtils.js      # SVG bar charts, line charts, heatmaps

hooks/
├── dashboard-hook.sh   # Bash: enriches JSON, POSTs to localhost:3333
├── dashboard-hook.ps1  # PowerShell: Windows variant
└── install-hooks.js    # Merges hook config into ~/.claude/settings.json
```

---

## License

MIT
