# Claude Command Center

A real-time dashboard for monitoring all active Claude Code sessions. Each session is represented by an animated CSS robot character whose behavior reflects the session's current state — idle, receiving prompts, working, or ended.

Built with zero build tools. Pure vanilla JS, Express, and WebSocket.

![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![Express](https://img.shields.io/badge/Express-5.0-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

---

## Features

### Live Session Monitoring
- Real-time WebSocket updates from all active Claude Code sessions
- Animated CSS robot characters per session with status-dependent behavior
- Session cards showing project name, current prompt, tool usage, and duration
- Live activity feed with timestamped events

### Session Detail Panel
- Click any session card to open a full detail panel
- Tabbed view: **Prompts** | **Responses** | **Tool Log** | **Events** | **Notes**
- Editable session title with auto-save
- Session duration timer

### Session Controls
| Button | Action |
|--------|--------|
| **KILL** | Send SIGTERM to the Claude process (with confirmation) |
| **ARCHIVE** | Toggle session archive status |
| **EXPORT** | Download full session data as JSON |
| **NOTES** | Add persistent notes to any session |
| **ALERT** | Set duration alerts (e.g., alert after 30 minutes) |

### Per-Session Mute
- Mute icon button on each session card
- Mutes sound notifications for individual sessions
- Visual indicator when a session is muted

### Analytics Dashboard
- **Tool Usage Breakdown** — horizontal bar chart of all tool types
- **Duration Trends** — session duration over time
- **Active Projects** — ranked project activity
- **Daily Heatmap** — hour-by-day activity visualization
- Summary stats: total sessions, avg duration, busiest project, most-used tool

### Session History
- Searchable, filterable history of all sessions
- Filter by project, status, date range
- Sort by date, duration, prompts, or tool calls
- Pagination support

### Timeline View
- Visual timeline of session activity
- Granularity: hourly, daily, or weekly
- Filter by project and date range

### Themes
9 built-in themes including 3 light themes:

| Dark Themes | Light Themes |
|-------------|-------------|
| Command Center (default) | Light |
| Cyberpunk | Warm |
| Dracula | Blonde |
| Nord | |
| Monokai | |
| Solarized | |

### Sound System
- 15 synthesized tones (no audio files needed)
- 18 configurable actions across 3 categories
- Per-action sound selection with preview
- Master volume and enable/disable toggle
- Per-session mute support

### Settings
- Theme selection with live preview
- Font size adjustment (10px–20px)
- Card size: Tiny, Small, Compact, Normal, Large
- Scanline effect toggle
- Activity feed visibility
- Import/Export settings as JSON
- Reset to defaults

---

## Quick Start

### Prerequisites
- Node.js 18+
- Active Claude Code sessions (the dashboard monitors them via hooks)

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd claude-command-center

# Install dependencies
npm install

# Install hooks into ~/.claude/settings.json
npm run install-hooks

# Start the dashboard
npm start
```

The dashboard runs at **http://localhost:3333**.

### How It Works

```
Claude Code Sessions ──(hooks POST)──> Express Server ──(WebSocket)──> Browser
                                            │
                                       SQLite DB
                                    (session history)
```

1. Claude Code fires hook events (session start, prompt, tool use, stop, etc.)
2. The hook script (`dashboard-hook.sh`) POSTs event JSON to `localhost:3333`
3. The Express server processes events, updates in-memory state + SQLite
4. WebSocket broadcasts changes to all connected browsers
5. The dashboard renders animated robots and live session data

---

## Architecture

### Project Structure

```
server/
├── index.js              # Express + WebSocket server entry point
├── db.js                 # SQLite schema, migrations, prepared statements
├── sessionStore.js       # In-memory session state machine with DB dual-write
├── hookRouter.js         # POST /api/hooks endpoint
├── apiRouter.js          # REST API (sessions, notes, alerts, settings, export)
├── analytics.js          # Analytics query engine (tool usage, trends, heatmap)
├── queryEngine.js        # Session search/filter/pagination queries
├── importer.js           # JSONL transcript import from ~/.claude/projects/
└── wsManager.js          # WebSocket broadcast to connected browsers

public/
├── index.html            # Dashboard HTML (zero build, vanilla JS modules)
├── css/
│   └── dashboard.css     # Dark command-center theme + 8 variants + robot animations
└── js/
    ├── app.js            # Bootstrap: init settings, connect WS, wire everything
    ├── robotManager.js   # CSS animated robot character lifecycle
    ├── sceneManager.js   # Stub (Three.js removed)
    ├── sessionPanel.js   # Session cards, detail panel, controls, mute
    ├── settingsManager.js # Settings persistence, theme/font/sound application
    ├── soundManager.js   # Web Audio API synthesized tones
    ├── statsPanel.js     # Global stats header bar
    ├── wsClient.js       # WebSocket client with auto-reconnect
    ├── navController.js  # View navigation (Live, History, Timeline, Analytics)
    ├── historyPanel.js   # Session history search/filter/pagination
    ├── timelinePanel.js  # Timeline visualization
    ├── analyticsPanel.js # Analytics charts and heatmap
    └── chartUtils.js     # Shared chart rendering utilities

hooks/
├── dashboard-hook.sh     # Bash: reads stdin JSON, POSTs to localhost:3333
└── install-hooks.js      # Merges hook config into ~/.claude/settings.json
```

### Session State Machine

```
SessionStart  →  idle       (Robot: gentle float, green glow)
UserPromptSubmit  →  prompting  (Robot: antenna pulse, cyan glow)
PreToolUse    →  working    (Robot: eyes scanning, typing dots, orange glow)
PostToolUse   →  working    (stays working)
Stop          →  idle       (Robot: returns to float)
SessionEnd    →  ended      (Robot: eyes dim, grey, fade out after 60s)
```

### CSS Robot Character

Each session gets an animated robot character built entirely with CSS:

- **Head** with LED eyes and mouth
- **Antenna** with glowing ball
- **Torso** with chest light and typing dots
- **Ground shadow** that responds to floating animation

Status-dependent animations:
- **Idle** — gentle floating, slow eye blink, soft green glow
- **Prompting** — antenna pulsing, eyes widen, head tilts, cyan glow
- **Working** — eyes scan side-to-side, body bounces, typing dots animate, orange glow
- **Ended** — eyes become dashes, grey tones, no animation

Each robot gets a unique accent color from an 8-color palette.

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js (ESM) + Express 5 |
| WebSocket | ws 8 |
| Database | better-sqlite3 (WAL mode) |
| Frontend | Vanilla JS modules (zero build) |
| Character | Pure CSS animated robot |
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
| POST | `/api/sessions/:id/kill` | Kill session process (requires confirm) |
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
| `?` | Show keyboard shortcuts |

---

## Configuration

### Hook Installation

The install script adds hooks to `~/.claude/settings.json`:

```bash
npm run install-hooks
```

This registers the dashboard hook for all Claude Code events:
- `SessionStart`, `SessionEnd`
- `UserPromptSubmit`
- `PreToolUse`, `PostToolUse`
- `Stop`, `SubagentStart`, `SubagentStop`
- `Notification`

All hooks run asynchronously (`async: true`) so they never block Claude.

### Database

SQLite database is auto-created at `data/sessions.db` with WAL mode for concurrent reads. Schema migrations run automatically on startup.

Tables: `sessions`, `prompts`, `tool_calls`, `responses`, `events`, `session_notes`, `duration_alerts`, `settings`

---

## Development

```bash
# Start with auto-restart (if using nodemon)
npx nodemon server/index.js

# Or just run directly
node server/index.js
```

No build step required. All frontend code uses native ES modules with import maps.

---

## License

MIT
