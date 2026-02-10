# Claude Command Center

See all your Claude Code sessions at a glance. Get screamed at when one needs your approval.

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
- The character starts **bouncing** with a floating **"!"** above its head
- A **3-burst alarm** plays and **repeats every 10 seconds** until you act
- No false alarms — auto-approved tools (Read, Grep, etc.) resolve instantly and never trigger it

Detection works by timing: if `PreToolUse` fires and `PostToolUse` doesn't arrive within 3 seconds, the tool is blocked waiting for you.

---

## Live Session Dashboard

Every active Claude Code session appears as an animated character card. At a glance you can see:

- **What each session is doing** — idle, prompting, working, waiting, or needing approval
- **Project name and working directory** for each session
- **Live duration timer** counting up since session start
- **Prompt count and tool call count** updating in real time
- **Activity feed** at the bottom showing events as they happen

### Status Colors

| Status | What it means | Visual |
|--------|---------------|--------|
| **Idle** | No activity | Green border, calm character |
| **Prompting** | You just sent a prompt | Cyan pulse, antenna blink |
| **Working** | Claude is calling tools | Orange pulse, typing dots |
| **Waiting** | Claude finished, your turn | Soft blue, gentle pulse |
| **Approval** | Tool blocked, needs your yes/no | Yellow screaming, alarm sound |
| **Ended** | Session closed | Red, faded, auto-removed |

---

## 20 Character Models

Pick a character for your sessions — globally or per-session. Each one has unique animations that react to session status.

**Robot** / **Cat** / **Alien** / **Ghost** / **Orb** / **Dragon** / **Penguin** / **Octopus** / **Mushroom** / **Fox** / **Unicorn** / **Jellyfish** / **Owl** / **Bat** / **Cactus** / **Slime** / **Pumpkin** / **Yeti** / **Crystal** / **Bee**

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
| **ALERT** | Get notified when a session exceeds a duration (e.g. 30 min) |

You can also **send prompts** directly to a session from the detail panel.

---

## Session Groups

Organize sessions into named groups. Drag-and-drop or assign from the detail panel. Useful when running many sessions across different projects.

Create groups with the **+ NEW GROUP** button in the nav bar.

---

## Team Detection

When Claude Code spawns agent teams (via the Agent SDK), the dashboard detects team relationships and shows them together. Click the team badge to see all members in a modal.

---

## Sound System

16 synthesized tones (no audio files needed) mapped to 19 configurable actions:

- **Session events** — start, end, prompt, response
- **Tool events** — tool use, approval needed, approval cleared
- **System events** — connection, error, alert

The `urgentAlarm` tone is the approval screamer — a loud 3-burst alarm that repeats every 10 seconds.

Configure in **Settings > Sounds**: pick which tone plays for each action, adjust master volume, or mute individual sessions.

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

Switch in **Settings > Appearance**. Every element respects the active theme.

---

## Session History

All sessions are persisted to a local SQLite database. The **History** tab gives you:

- Full-text search across all sessions
- Filter by project, status, or date range
- Sort by date, duration, prompt count, or tool calls
- Pagination for large histories

Historical sessions from `~/.claude/projects/` are auto-imported on startup.

---

## Timeline View

Visual timeline showing when sessions were active. Switch between hourly, daily, or weekly granularity. Filter by project and date range.

---

## Analytics

The **Analytics** tab shows usage patterns:

- **Tool Usage** — bar chart of which tools Claude uses most
- **Duration Trends** — how long your sessions run over time
- **Active Projects** — ranked by activity
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

**Appearance** — theme, font size (10–20px), card size (small/compact/normal/large), scanline effect, animation intensity and speed, character model

**Sounds** — enable/disable, master volume, per-action tone selection with live preview

**Advanced** — summary prompt template editor, import/export settings as JSON, reset to defaults, activity feed toggle

---

## How It Works

```
Claude Code ──(hooks)──> Express Server ──(WebSocket)──> Browser Dashboard
                              │
                         SQLite DB
```

1. Claude Code fires hook events (session start, prompt, tool use, stop, etc.)
2. A bash hook script POSTs the event JSON to `localhost:3333`
3. The server processes events, updates state + database
4. WebSocket pushes updates to all connected browsers
5. The dashboard renders everything in real time

All hooks run with `async: true` — they never slow down Claude.

---

## License

MIT
