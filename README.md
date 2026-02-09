# Claude Command Center

A real-time dashboard for monitoring all active Claude Code sessions. Each session gets an animated CSS robot that reacts to what Claude is doing — and screams at you when it needs your approval.

Zero build tools. Pure vanilla JS, Express, and WebSocket.

![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![Express](https://img.shields.io/badge/Express-5.0-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

---

## Quick Start

```bash
git clone <repo-url>
cd claude-command-center
npm install
npm run install-hooks   # registers hooks in ~/.claude/settings.json
npm start               # http://localhost:3333
```

---

## Key Features

### Approval Detection

When Claude proposes a tool that needs your yes/no, the dashboard detects it automatically:

- **How**: if `PreToolUse` fires and `PostToolUse` doesn't arrive within 3 seconds, the tool is blocked waiting for you
- **Card**: solid yellow border, pulsing glow, **"NEEDS YOUR APPROVAL"** banner with the tool name
- **Robot**: bouncing body, floating **"!"** above its head, huge yellow eyes, tilting head
- **Sound**: 3-burst urgent alarm, **repeats every 10 seconds** until you approve/deny
- **No false alarms**: auto-approved tools (Read, Grep, etc.) clear in milliseconds and never trigger it

### 3-Tier Session Status

| Status | Meaning | Card | Robot |
|--------|---------|------|-------|
| **idle** | No activity for a while | Green border, calm | Gentle float, green glow |
| **prompting** | User just submitted a prompt | Cyan pulse | Antenna pulse, eyes widen |
| **working** | Claude is using tools | Orange pulse | Eyes scanning, typing dots |
| **waiting** | Claude finished, ready for next prompt | Soft blue border | Blue eyes, gentle chest pulse |
| **approval** | Tool blocked — needs your yes/no | Screaming yellow, banner, scale-up | Bouncing, "!" emote, yellow glow |
| **ended** | Session closed | Red, faded | Grey, dash eyes, fade out |

### Live Robot Characters

Every session gets an animated robot built entirely in CSS:

- **Head** with LED eyes and mouth
- **Antenna** with glowing ball
- **Torso** with chest light and typing dots
- **Ground shadow** responding to animations
- Unique accent color per session (8-color palette)
- Status-dependent animations that change in real time

### Session Detail Panel

Click any session card to open a full detail panel:

- **Prompts** tab — full prompt history (newest first)
- **Responses** tab — Claude's responses with timestamps
- **Tool Log** tab — every tool call with input summary
- **Events** tab — all session events chronologically
- **Notes** tab — add persistent notes to any session
- Editable session title, model info, live duration timer

### Session Controls

| Button | Action |
|--------|--------|
| **KILL** | Send SIGTERM to the Claude process (with confirmation modal) |
| **ARCHIVE** | Hide session from live view, visible in history |
| **EXPORT** | Download full session data as JSON |
| **NOTES** | Add/delete persistent notes |
| **ALERT** | Set duration alerts (e.g., notify after 30 min) |

---

## All Features

### Sound System
- 16 synthesized tones via Web Audio API (no audio files)
- 19 configurable actions across 3 categories (Session, Tools, System)
- `urgentAlarm` — loud 3-burst alarm for approval detection, repeats every 10s
- Per-action sound selection with live preview in settings
- Master volume control, enable/disable toggle
- Per-session mute button on each card

### 9 Themes

| Dark | Light |
|------|-------|
| Command Center (default) | Light |
| Cyberpunk | Warm |
| Dracula | Blonde |
| Nord | |
| Monokai | |
| Solarized | |

Full CSS variable system — every element respects the active theme.

### Analytics Dashboard
- **Tool Usage** — horizontal bar chart of all tool types
- **Duration Trends** — session duration over time
- **Active Projects** — ranked project activity
- **Daily Heatmap** — hour-by-day activity grid
- Summary stats: total sessions, avg duration, busiest project, most-used tool

### Session History
- Full-text search across all sessions
- Filter by project, status (idle/waiting/working/approval/ended/archived), date range
- Sort by date, duration, prompts, or tool calls
- Pagination

### Timeline View
- Visual timeline of session activity
- Granularity: hourly, daily, or weekly
- Filter by project and date range

### JSONL Import
- Auto-imports historical sessions from `~/.claude/projects/` on startup
- Parses JSONL transcripts into prompts, responses, tool calls, and events
- Generates session titles from project name + prompt summary

### Settings
- Theme selection with live preview
- Font size adjustment (10px–20px)
- Card size: Small, Compact, Normal, Large
- Scanline overlay toggle
- Activity feed visibility
- Import/Export settings as JSON
- Reset to defaults

### Keyboard Shortcuts

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

## How It Works

```
Claude Code Sessions ──(hooks POST)──> Express Server ──(WebSocket)──> Browser
                                            │
                                       SQLite DB
                                    (session history)
```

1. Claude Code fires hook events (session start, prompt, tool use, stop, etc.)
2. `dashboard-hook.sh` POSTs event JSON to `localhost:3333`
3. Express processes events, updates in-memory state + SQLite
4. WebSocket broadcasts to all connected browsers
5. Dashboard renders animated robots and live session data

All hooks run asynchronously (`async: true`) — they never block Claude.

---

## Architecture

```
server/
├── index.js              # Express + WebSocket server, alert checking
├── db.js                 # SQLite schema + migrations
├── sessionStore.js       # In-memory state machine with DB dual-write
├── hookRouter.js         # POST /api/hooks endpoint
├── apiRouter.js          # REST API (sessions, notes, alerts, export)
├── analytics.js          # Analytics queries (tool usage, trends, heatmap)
├── queryEngine.js        # Session search/filter/pagination
├── importer.js           # JSONL transcript import
└── wsManager.js          # WebSocket broadcast

public/
├── index.html            # Dashboard (zero build, vanilla JS modules)
├── css/dashboard.css     # 9 themes + robot animations + all styles
└── js/
    ├── app.js            # Bootstrap, WS wiring, approval alarm logic
    ├── robotManager.js   # CSS robot lifecycle
    ├── sessionPanel.js   # Cards, detail panel, controls
    ├── soundManager.js   # Web Audio synthesized tones
    ├── settingsManager.js # Settings persistence + theme/font application
    ├── statsPanel.js     # Global stats header
    ├── wsClient.js       # WebSocket client with auto-reconnect
    ├── navController.js  # View navigation
    ├── historyPanel.js   # Session history search/filter
    ├── timelinePanel.js  # Timeline visualization
    ├── analyticsPanel.js # Analytics charts
    └── chartUtils.js     # Shared chart utilities

hooks/
├── dashboard-hook.sh     # Bash: reads stdin, POSTs to localhost:3333
└── install-hooks.js      # Merges hooks into ~/.claude/settings.json
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js (ESM) + Express 5 |
| WebSocket | ws 8 |
| Database | better-sqlite3 (WAL mode) |
| Frontend | Vanilla JS modules (zero build) |
| Characters | Pure CSS animated robots |
| Sounds | Web Audio API (oscillator synthesis) |
| Font | JetBrains Mono (Google Fonts CDN) |
| Hooks | Bash script (curl POST) |
| Port | 3333 |

---

## API Endpoints

### Hooks
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/hooks` | Receive hook events from Claude Code |

### Sessions
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | List all active sessions |
| GET | `/api/sessions/search` | Search/filter session history |
| GET | `/api/sessions/:id/detail` | Full session detail with history |
| GET | `/api/sessions/:id/export` | Download session as JSON |
| POST | `/api/sessions/:id/kill` | Kill session process (requires `{confirm:true}`) |
| POST | `/api/sessions/:id/archive` | Toggle archive status |
| PUT | `/api/sessions/:id/title` | Update session title |

### Notes
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions/:id/notes` | List session notes |
| POST | `/api/sessions/:id/notes` | Add a note |
| DELETE | `/api/sessions/:id/notes/:noteId` | Delete a note |

### Alerts
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions/:id/alerts` | Get alert config |
| POST | `/api/sessions/:id/alerts` | Set duration alert |
| DELETE | `/api/sessions/:id/alerts/:alertId` | Remove alert |

### Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/analytics/summary` | Summary stats |
| GET | `/api/analytics/tool-usage` | Tool usage breakdown |
| GET | `/api/analytics/duration-trends` | Duration over time |
| GET | `/api/analytics/active-projects` | Project activity ranking |
| GET | `/api/analytics/daily-heatmap` | Hour-by-day heatmap |

### Settings
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings` | Get all settings |
| PUT | `/api/settings` | Update a setting |

---

## Database

SQLite auto-created at `data/sessions.db` (WAL mode). Schema migrations run on startup.

Tables: `sessions`, `prompts`, `tool_calls`, `responses`, `events`, `session_notes`, `duration_alerts`, `settings`, `import_meta`

---

## License

MIT
