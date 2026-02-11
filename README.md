# Claude Command Center

A real-time dashboard for monitoring all your Claude Code sessions. Each session gets an animated character card with live status updates, sound effects, and approval alerts so you never miss a beat.

![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![Express](https://img.shields.io/badge/Express-5.0-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

---

## Setup

```bash
npm run setup   # installs deps, registers hooks, starts the server
```

Opens at **http://localhost:3333**. Every Claude Code session you open will now show up on the dashboard automatically.

---

## Never Miss an Approval Again

This is the main reason this exists. When Claude proposes a tool that needs your yes/no:

- The card turns **screaming yellow** with a pulsing "NEEDS YOUR APPROVAL" banner
- The character starts **shaking** with a floating **"!"** above its head
- A **3-burst alarm** plays and **repeats every 10 seconds** until you act
- No false alarms — auto-approved tools (Read, Grep, etc.) resolve instantly and never trigger it

Detection works by timing: if `PreToolUse` fires and `PostToolUse` doesn't arrive within 3 seconds (fast tools) or 15 seconds (medium tools like WebFetch), the tool is blocked waiting for you. Tools that legitimately run for minutes (Bash, Task) are excluded from detection entirely.

Input-requiring tools (`AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`) get their own distinct "WAITING FOR YOUR ANSWER" state with a 3-second timeout.

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
