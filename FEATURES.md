# AI Agent Session Center — Comprehensive Feature Guide

> A real-time localhost dashboard (port 3333) that monitors all active AI coding agent sessions (Claude Code, Gemini CLI, Codex) via lifecycle hooks. Each session is represented by an animated CSS character. Full prompt history, tool logs, terminal integration, team tracking, prompt queuing, and session analytics.

---

## Table of Contents

1. [Multi-CLI Monitoring](#1-multi-cli-monitoring)
2. [Hook Delivery Pipeline](#2-hook-delivery-pipeline)
3. [Session State Machine](#3-session-state-machine)
4. [Session Matching & Auto-Linking](#4-session-matching--auto-linking)
5. [Approval & Input Detection](#5-approval--input-detection)
6. [Animated CSS Character System](#6-animated-css-character-system)
7. [Session Cards & Dashboard Grid](#7-session-cards--dashboard-grid)
8. [Session Groups & Layout Presets](#8-session-groups--layout-presets)
9. [Detail Panel](#9-detail-panel)
10. [SSH Terminal Integration](#10-ssh-terminal-integration)
11. [Prompt Queue System](#11-prompt-queue-system)
12. [Team & Subagent Tracking](#12-team--subagent-tracking)
13. [Session Labels & Quick Launch](#13-session-labels--quick-launch)
14. [AI Summarization](#14-ai-summarization)
15. [Notes System](#15-notes-system)
16. [Sound & Movement Effects](#16-sound--movement-effects)
17. [Alarm System](#17-alarm-system)
18. [History & Search](#18-history--search)
19. [Analytics Dashboard](#19-analytics-dashboard)
20. [Timeline Visualization](#20-timeline-visualization)
21. [Theming & Appearance](#21-theming--appearance)
22. [Keyboard Shortcuts](#22-keyboard-shortcuts)
23. [WebSocket Real-Time Communication](#23-websocket-real-time-communication)
24. [IndexedDB Persistence](#24-indexeddb-persistence)
25. [Snapshot Persistence & Auto-Revive](#25-snapshot-persistence--auto-revive)
26. [Session Resume & Reconnect](#26-session-resume--reconnect)
27. [Process Monitoring & Auto-Cleanup](#27-process-monitoring--auto-cleanup)
28. [Hook Installation & Density Levels](#28-hook-installation--density-levels)
29. [Security Hardening](#29-security-hardening)
30. [Performance Optimizations](#30-performance-optimizations)
31. [Setup, Configuration & Reset](#31-setup-configuration--reset)
32. [Architecture Overview](#32-architecture-overview)

---

## 1. Multi-CLI Monitoring

The dashboard monitors three AI coding CLIs simultaneously through platform-specific hook adapters:

### Claude Code
- **Hook Script:** `dashboard-hook.sh` (bash) / `dashboard-hook.ps1` (PowerShell)
- **Config Location:** `~/.claude/settings.json`
- **Events (up to 14):** SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop, SubagentStart, SubagentEnd, Notification, TeammateNotification, TeammateIdle, PreCompact, PostCompact
- **Enrichment:** PID, TTY path, terminal program (VS Code, iTerm, Warp, Kitty, Ghostty, etc.), team env vars, `AGENT_MANAGER_TERMINAL_ID`

### Gemini CLI
- **Hook Script:** `dashboard-hook-gemini.sh`
- **Config Location:** `~/.gemini/settings.json`
- **Event Mapping:** Gemini events are translated to the dashboard's internal format:
  - `BeforeAgent` → `UserPromptSubmit`
  - `BeforeTool` → `PreToolUse`
  - `AfterTool` → `PostToolUse`
  - `AfterAgent` → `Stop`
- **Special Handling:** Gemini hooks are blocking — the script immediately echoes `{"decision":"allow"}` to stdout before processing in the background

### Codex CLI
- **Hook Script:** `dashboard-hook-codex.sh`
- **Config Location:** `~/.codex/config.toml`
- **Events:** Only `agent-turn-complete` (mapped to `Stop`)
- **Input Format:** JSON as CLI argument (`$1`) instead of stdin
- **Fields:** `thread-id` → session_id, `cwd`, `last-assistant-message`, `input-messages`

All three adapters converge on the same delivery pipeline (file-based MQ or HTTP fallback) and produce a unified session format in the dashboard.

---

## 2. Hook Delivery Pipeline

Every hook event travels through a two-stage delivery pipeline optimized for minimal latency (3-17ms end-to-end).

### Stage 1: Hook Script (Client-Side)

The bash hook script performs a single `jq` pass (~2-5ms) to enrich the raw hook JSON with:

| Field | Source | Purpose |
|-------|--------|---------|
| `claude_pid` | `$PPID` | Process monitoring, liveness checks |
| `hook_sent_at` | `date +%s%3N` | Delivery latency measurement |
| `tty_path` | Cached `ps -o tty= -p $PPID` | Terminal identification |
| `term_program` | `$TERM_PROGRAM` | Source detection (iTerm, Warp, etc.) |
| `vscode_pid` | `$VSCODE_PID` | VS Code detection |
| `agent_terminal_id` | `$AGENT_MANAGER_TERMINAL_ID` | Direct SSH terminal linking |
| Team env vars | `$CLAUDE_CODE_PARENT_SESSION_ID`, etc. | Team/subagent tracking |

**Primary Delivery — File-Based Message Queue:**
```
echo "$ENRICHED_JSON" >> /tmp/claude-session-center/queue.jsonl
```
- POSIX atomic append (~0.1ms for writes < 4096 bytes)
- Runs in a background subshell with `disown` (non-blocking to Claude)
- No process spawn overhead (no curl, no HTTP)

**Fallback — HTTP POST:**
```
curl -s --connect-timeout 1 -m 3 -X POST \
  http://localhost:3333/api/hooks --data-binary @-
```
Used only when the MQ directory `/tmp/claude-session-center/` doesn't exist (server not running).

### Stage 2: Server Processing

**mqReader.js** watches the JSONL queue file with triple-redundant notification:

1. **`fs.watch()`** — Instant notification on macOS/Linux (~0-10ms latency)
2. **500ms fallback poll** — Catches events if `fs.watch` silently fails
3. **5s health check** — Detects stale watch (file grew but no event fired)

The reader uses byte-offset tracking to read only new data since the last read. It handles partial lines (when a write is split across reads) and truncates the file at 1MB to prevent unbounded growth.

Each complete JSON line passes through **hookProcessor.js** which:
1. Validates required fields (`session_id`, `hook_event_name`)
2. Calls `sessionStore.handleEvent()` to update session state
3. Records performance stats (delivery latency, processing time)
4. Broadcasts the update to all WebSocket clients

### Latency Budget

| Stage | Typical | Notes |
|-------|---------|-------|
| jq enrichment | 2-5ms | Single jq invocation |
| File append | ~0.1ms | POSIX atomic |
| fs.watch + debounce | 0-10ms | 10ms debounce coalesces rapid events |
| Server processing | ~0.5ms | handleEvent + broadcast |
| **Total** | **3-17ms** | Hook fired → browser updated |

---

## 3. Session State Machine

Every session follows a deterministic state machine driven by hook events. Each state maps to a visual status (card border color) and character animation.

```
SessionStart       → idle       (Green border, Idle animation)
UserPromptSubmit   → prompting  (Cyan border, Walking + Wave emote)
PreToolUse         → working    (Orange border, Running animation)
PostToolUse        → working    (stays Running)
[timeout expires]  → approval   (Yellow border, Waiting + pulsing glow)
[timeout expires]  → input      (Purple border, Waiting + soft glow)
PermissionRequest  → approval   (Yellow border, immediately — bypasses timeout)
Stop               → waiting    (Blue border, ThumbsUp or Dance emote)
[2min idle]        → idle       (Green border, Idle)
SessionEnd         → ended      (Red border, Death animation)
```

### Status Details

| Status | Meaning | Border Color | Animation |
|--------|---------|-------------|-----------|
| **idle** | Session alive but not actively working | Green | Idle (float/breathe/sway) |
| **prompting** | User just submitted a prompt, Claude is thinking | Cyan | Walking + Wave |
| **working** | Claude is executing a tool (Read, Bash, Edit, etc.) | Orange | Running + Sweat |
| **approval** | Claude is waiting for the user to approve a tool | Yellow | Waiting + Bounce + pulsing "NEEDS YOUR APPROVAL" banner |
| **input** | Claude is waiting for user to answer a question | Purple | Waiting + "NEEDS YOUR INPUT" banner |
| **waiting** | Claude finished responding, waiting for next prompt | Blue | ThumbsUp (light work) or Dance (heavy work, >10 tools) |
| **ended** | Session terminated | Red | Death animation, then card archived |
| **connecting** | SSH terminal created, waiting for Claude to start | Dim | Connecting indicator |

### Auto-Idle Transitions

The `autoIdleManager` runs a 10-second check interval to handle stale states:

| From Status | Timeout | Transitions To |
|------------|---------|---------------|
| prompting | 30s | waiting |
| waiting | 120s (2min) | idle |
| working | 180s (3min) | idle |
| approval/input | 600s (10min) | idle (safety net) |

---

## 4. Session Matching & Auto-Linking

When a hook event arrives with an unknown `session_id`, the dashboard must determine which terminal/card it belongs to. This is especially important for SSH terminals where Claude starts inside a PTY managed by the dashboard.

The **sessionMatcher** uses a 5-priority fallback system:

### Priority 0 — Pending Resume
When a user resumes a session, the old session ID is stored in `pendingResume`. If a new `SessionStart` arrives from the same terminal or working directory, the matcher re-keys the old session to the new session ID, preserving all history.

### Priority 0.5 — Snapshot-Restored Session
After a server restart, sessions from the snapshot are marked with a `ServerRestart` event. If a new hook arrives with a matching `projectPath` from a recently ended session, it's linked as a continuation (auto-revive).

### Priority 1 — Terminal ID Environment Variable
SSH terminals inject `AGENT_MANAGER_TERMINAL_ID` into the PTY environment. The hook script reads this and sends it with every event, providing a direct, unambiguous link. This is the most reliable method.

### Priority 2 — Working Directory Link
When an SSH terminal is created, the dashboard stores a `pendingLink` mapping `workingDir → terminalId`. If a new session starts in the same directory within 60 seconds, it's linked to that terminal. Risk: two sessions in the same directory could collide.

### Priority 3 — Path Scan (Connecting Sessions)
Scans all sessions in `connecting` status and matches by normalized path. Used when a terminal is waiting for Claude to start and a hook arrives from that directory.

### Priority 4 — PID Parent Check
Checks if the hook's `claude_pid` is a child process of a known PTY process using `ps -o ppid=`. This is the least reliable method (unreliable across shell layers) and used as a last resort.

### Unmatched Sessions
If no match is found, a **display-only card** is created showing the detected source (VS Code, iTerm, Warp, Ghostty, etc.) based on terminal environment variables.

### Source Detection
The matcher identifies 11 terminal sources:
- `vscode` (via `VSCODE_PID`)
- `iterm` (via `TERM_PROGRAM=iTerm.app`)
- `warp` (via `WARP_SESSION_ID`)
- `kitty` (via `KITTY_PID`)
- `ghostty` (via `GHOSTTY_RESOURCES_DIR`)
- `alacritty`, `wezterm`, `hyper`, `tmux`, `terminal` (generic), `ssh`

---

## 5. Approval & Input Detection

The dashboard detects when Claude is waiting for user approval (to run a tool) or waiting for user input (answering a question). This is critical for notifications and alarms.

### Heuristic-Based Detection

When `PreToolUse` fires, an approval timer starts based on the tool's category:

| Category | Tools | Timeout | Resulting Status |
|----------|-------|---------|-----------------|
| **fast** | Read, Write, Edit, Grep, Glob, NotebookEdit | 3s | approval |
| **userInput** | AskUserQuestion, EnterPlanMode, ExitPlanMode | 3s | input |
| **medium** | WebFetch, WebSearch | 15s | approval |
| **slow** | Bash, Task | 8s | approval |

If `PostToolUse` doesn't arrive within the timeout, the session transitions to `approval` or `input` status.

### Child Process Check
For **slow** tools (Bash, Task), before declaring "approval needed," the system runs `pgrep -P <pid>` to check if the command still has child processes running. If it does, the tool is still executing (e.g., `npm install`) and the timeout is skipped.

### PermissionRequest Event (Reliable Signal)
At medium+ hook density, Claude sends a `PermissionRequest` hook event which is a **reliable, explicit signal** that approval is needed. This immediately:
1. Clears the heuristic timeout
2. Sets the session to `approval` status
3. Triggers the alarm system

### Known Limitation
Auto-approved long-running commands (like `npm install` or build scripts) will briefly show as "approval" for ~8 seconds until `PostToolUse` clears it. The child process check mitigates this but can't catch all cases.

---

## 6. Animated CSS Character System

Every session is represented by an animated CSS character rendered directly on its card. The system includes **20 unique character models**, all animated with pure CSS (no JavaScript animation loops).

### Character Models

| # | Model | # | Model | # | Model | # | Model |
|---|-------|---|-------|---|-------|---|-------|
| 1 | Robot | 6 | Dragon | 11 | Unicorn | 16 | Slime |
| 2 | Cat | 7 | Penguin | 12 | Jellyfish | 17 | Pumpkin |
| 3 | Alien | 8 | Octopus | 13 | Owl | 18 | Yeti |
| 4 | Ghost | 9 | Mushroom | 14 | Bat | 19 | Crystal |
| 5 | Orb | 10 | Fox | 15 | Cactus | 20 | Bee |

Characters are auto-assigned based on session index with an 8-color palette. Users can override the character model per-session via the detail panel dropdown.

### Animation States

Each character supports these animation states, driven by session status:

| Animation | Triggered By | Visual |
|-----------|-------------|--------|
| **Idle** | Session alive, no activity | Gentle floating/breathing/swaying |
| **Wave** | User submits a prompt | Character waves (emote overlay) |
| **Walking** | Prompting state | Character walks in place |
| **Running** | Tool execution (working) | Character runs + sweat drops |
| **Waiting** | Approval or input needed | Character bounces/flashes |
| **ThumbsUp** | Stop event (light work) | Thumbs up emote |
| **Dance** | Stop event (heavy work, >10 tools) | Dance animation |
| **Death** | Session ended | Death animation, then fade |
| **Jump** | Subagent spawned | Jump emote |

### Status Visual Effects

Each status has configurable visual effects applied to the character:

- **Idle:** float (default), breathe, sway, sparkle, or none
- **Prompting:** eye-cycle (default), think-pulse, head-tilt
- **Working:** sweat (always, 40 animated drops), energy-ring, sparks, steam
- **Approval:** bounce (default), flash, shake
- **Ended:** fade (default), shrink, dissolve

All effects respect `--anim-intensity` (0-200%) and `--anim-speed` (30-200%) CSS variables, and are automatically disabled for users with `prefers-reduced-motion`.

---

## 7. Session Cards & Dashboard Grid

The main dashboard view displays session cards in a responsive CSS Grid.

### Card Anatomy

Each card contains:
- **Character viewport** — Animated CSS character (click to select)
- **Project name** — Auto-detected from working directory, editable via double-click
- **Status badge** — Color-coded status indicator
- **Duration** — Live-updating elapsed time since session start
- **Queue count** — Number of queued prompts (if any)
- **Label badge** — ONEOFF (orange), HEAVY (red), IMPORTANT (purple)
- **Pin/Mute/Close buttons** — Hover-revealed action buttons
- **Group assignment** — Dropdown to assign to a group

### Card Interactions

| Action | Trigger | Effect |
|--------|---------|--------|
| Select session | Click card | Detail panel slides in, card highlights |
| Edit title | Double-click project name | Inline text editing |
| Pin to top | Click pin icon | Card stays at top of its group |
| Mute session | Click mute icon | Suppresses sounds/alarms for this session |
| Dismiss/archive | Click X icon | Card removed with animation |
| Drag reorder | Drag card | Reorder within group |
| Drag to group | Drag card to group header | Assigns session to that group |

### Status Border Effects

Cards have glowing animated borders that change based on status:
- **Idle:** Green subtle glow
- **Prompting:** Cyan pulsing glow
- **Working:** Orange pulsing glow
- **Approval:** Yellow intense pulsing glow + "NEEDS YOUR APPROVAL" banner with animated stripe
- **Input:** Purple soft glow + "NEEDS YOUR INPUT" banner
- **Waiting:** Blue subtle glow
- **Ended:** Red dim glow

### Card Frames

Five animated border frame effects can be assigned to labeled sessions:
1. **Fire** — Animated fire border
2. **Electric** — Crackling electric border
3. **Chains** — Chain-link border
4. **Liquid** — Flowing liquid border
5. **Plasma** — Plasma energy border

Frames use CSS `@property --frame-angle` with `conic-gradient` for smooth rotation animation.

### Team Member Cards

When a session has subagents (team members), small child cards appear nested within the parent card. These can be collapsed/expanded and show the subagent's status, type, and name.

---

## 8. Session Groups & Layout Presets

Sessions can be organized into named groups displayed as columns in a 12-column CSS Grid.

### Default Groups
On first launch, four default groups are created:
1. **Priority** — High-priority sessions
2. **Active** — Currently active work
3. **Background** — Background/long-running tasks
4. **Review** — Sessions pending review

### Group Operations

| Action | Description |
|--------|-------------|
| Create group | Click "New Group" in nav bar |
| Rename group | Click group name to edit inline |
| Delete group | Click delete icon on group header |
| Collapse/expand | Click collapse icon on group header |
| Resize width | Drag right-edge resize handle |
| Reorder groups | Drag group header to reorder |
| Assign session | Drag card to group, or use dropdown in card |

### Layout Presets

Predefined column arrangements:
- **1-column** — Single full-width column
- **2-column** — Two equal columns (6+6)
- **3-column** — Three equal columns (4+4+4)
- **1/3 + 2/3** — Narrow left, wide right (4+8)
- **2/3 + 1/3** — Wide left, narrow right (8+4)

Groups and layouts are persisted in `localStorage` and restored on page refresh.

---

## 9. Detail Panel

Clicking a session card opens a slide-in panel from the right side with comprehensive session details.

### Panel Header
- **Character preview** — Miniature animated character (42% scale)
- **Project name** — Editable
- **Title** — Auto-generated or user-set
- **Character model dropdown** — Switch between 20 character models
- **Status badge** — Current status with color
- **Duration** — Elapsed time
- **Label chips** — Click to assign ONEOFF/HEAVY/IMPORTANT

### Control Bar
- **Resume** — Re-attach to SSH terminal (SSH sessions only)
- **Kill** — Send SIGTERM (with confirmation modal), escalates to SIGKILL after 3s
- **Archive** — Soft-delete (moves to history)
- **Summarize** — Generate AI summary (opens template selector)
- **Delete** — Hard-delete from IndexedDB
- **Alert** — Set duration alert
- **Group** — Assign to group dropdown

### Tabs

#### Conversation Tab
Unified chronological view of:
- **User prompts** — Cyan left border, full text
- **Tool calls** — Orange left border, tool name + input summary
- **Claude responses** — Green left border, response excerpts

Each entry has a copy button (hover-revealed). Supports search with yellow highlight.

If the session was resumed, **Previous Sessions** sections appear showing conversation from prior sessions in the same working directory.

#### Activity Tab
Timeline of all events:
- Tool calls with input/output summaries
- Session events (start, stop, end)
- Status transitions
- Error events

#### Terminal Tab
Embedded xterm.js terminal (if SSH session) with:
- Live bidirectional I/O
- 7 color themes + auto theme
- Fullscreen mode (Alt+F11)
- Reconnect button
- Queue panel below terminal

#### Notes Tab
- Create/edit/delete notes per session
- Notes stored in IndexedDB with timestamps
- Search within notes

#### Queue Tab
- Session-specific prompt queue
- Compose new prompts
- Drag to reorder
- Send, edit, delete queued items

#### Summary Tab
- AI-generated session summary
- Custom summary prompts
- Regenerate with different templates

### Panel Features
- **Resizable** — Drag left edge (320px min, 95vw max)
- **Panel width persisted** — Remembered across refreshes
- **Active tab persisted** — Remembered across refreshes
- **Selected session persisted** — Reopens on page refresh
- **Mobile** — Full-screen (100vw) on mobile devices

---

## 10. SSH Terminal Integration

The dashboard can create and manage SSH terminals, providing a complete remote development environment.

### Terminal Creation

The "New Session" modal offers three modes:

1. **New SSH Session** — Connect to a remote host via SSH
   - Host, port, username
   - Auth method: SSH key, SSH agent, or password
   - Working directory on remote
   - Optional custom command
   - API key injection (Anthropic/OpenAI/Google)

2. **Attach to tmux pane** — Attach to an existing tmux session
   - Lists available tmux sessions with refresh
   - Select pane to attach

3. **Local terminal** — Spawn a local PTY session

### SSH Implementation

The server uses **native `ssh` binary** (not a JavaScript SSH library) spawned via **node-pty**:
- Inherits system SSH config (`~/.ssh/config`), agent, and known_hosts
- PTY allocation (`-t` flag) for proper terminal emulation
- Injects `AGENT_MANAGER_TERMINAL_ID` as environment variable for session linking
- API keys injected as environment variables (never in shell command strings)

### Terminal Features

| Feature | Description |
|---------|-------------|
| **Canvas renderer** | xterm.js with WebGL canvas for performance |
| **Unicode support** | Unicode11 addon for full character support |
| **Clickable links** | WebLinks addon detects URLs in terminal output |
| **Auto-fit** | FitAddon resizes terminal to container |
| **7 themes** | default, dark, monokai, dracula, solarized, nord, github-dark |
| **Auto theme** | Syncs terminal colors with website CSS variables |
| **Fullscreen** | Full-viewport terminal overlay (Alt+F11) |
| **Output buffer** | 128KB ring buffer per terminal for replay on reconnect |
| **Responsive font** | 11-14px based on viewport width |

### Bidirectional WebSocket Relay

Terminal I/O flows through WebSocket:
```
Browser (xterm.js) → TERMINAL_INPUT → server → pty.write()
pty.onData() → server → TERMINAL_OUTPUT → Browser (xterm.js)
```

Clients subscribe to specific terminals. On (re)subscribe, the full output buffer is replayed.

### Session Linking

When Claude starts inside an SSH terminal, the session matcher links the hook events to the terminal session. This enables:
- Terminal tab in the detail panel
- Queue auto-send (paste prompt into terminal)
- Resume/reconnect after disconnect
- Process monitoring via the PTY

---

## 11. Prompt Queue System

Each session has a queue of prompts that can be auto-sent when the session is ready.

### Queue Operations

| Action | Description |
|--------|-------------|
| **Compose** | Type a prompt in the compose textarea |
| **Enqueue** | Click send or press Enter to add to queue |
| **Auto-send** | First queued prompt auto-sends when session transitions to `waiting` status |
| **Reorder** | Drag prompts to change order |
| **Edit** | Click edit icon to modify queued prompt |
| **Delete** | Click delete icon to remove |
| **Move between sessions** | Click move icon, then click target session card |
| **Drag to terminal** | Drag a prompt onto the terminal tab to paste it |

### Auto-Send Behavior

When a session's status changes to `waiting` (Claude finished and is ready for the next prompt):
1. The queue checks for pending prompts
2. If found, the first prompt is typed into the terminal character-by-character
3. Enter is sent to submit the prompt
4. The prompt is removed from the queue

### Move Between Sessions

The "move mode" workflow:
1. Click the move icon on a queued prompt
2. A banner appears: "Click a session card to move the prompt"
3. Click any session card in the dashboard
4. The prompt moves to that session's queue
5. Move mode exits automatically

### Global Queue View

The "Queue" navigation tab shows all queued prompts across all sessions in a single table, grouped by session. This provides a bird's-eye view of pending work.

### Persistence

Queues are stored in IndexedDB (`promptQueue` store) with auto-incrementing IDs for ordering. Queue counts are synced to the server for card badge display.

---

## 12. Team & Subagent Tracking

The dashboard automatically detects and visualizes Claude Code teams (parent + subagent hierarchies).

### Auto-Detection

Teams are detected through two mechanisms:

1. **`CLAUDE_CODE_PARENT_SESSION_ID` env var** (Priority 0) — When a subagent starts, Claude Code sets this env var. The hook script captures it and sends it with every event, providing a direct parent link.

2. **SubagentStart hook + path matching** — When a `SubagentStart` event fires, the dashboard stores the parent's session ID and working directory. When a new `SessionStart` arrives from a matching directory, it's linked as a child.

### Team Structure

```
Parent Session (team lead)
├── Child Session 1 (subagent - researcher)
├── Child Session 2 (subagent - coder)
└── Child Session 3 (subagent - tester)
```

Teams are identified by `team-{parentSessionId}` and can optionally read from Claude Code's team config at `~/.claude/teams/{teamName}/config.json` for metadata like tmux pane IDs, colors, and agent types.

### Team Visualization

- Parent card shows nested child cards (collapsible)
- Each child shows agent type, name, and status
- Team updates are broadcast as separate `team_update` WebSocket messages
- When parent ends + all children ended, team auto-deletes after 15s delay

### Team Terminal Attach

For teams using tmux, the dashboard can attach to specific tmux panes:
- Reads `tmuxPaneId` from team config
- Spawns a local PTY that attaches to the specified pane
- Enables terminal tab for team members

---

## 13. Session Labels & Quick Launch

Sessions can be labeled with three priority levels, each with distinct visual treatment.

### Labels

| Label | Color | Badge Style | Purpose |
|-------|-------|-------------|---------|
| **ONEOFF** | Orange | Normal weight | Quick one-off tasks |
| **HEAVY** | Red | Bold | Long-running, resource-intensive tasks |
| **IMPORTANT** | Purple | Bold | Critical tasks requiring attention |

### Label Features

- **Card badges** — Colored badges on session cards
- **Detail panel chips** — Click to assign/remove in detail panel
- **Configurable alerts** — Per-label sound, movement effect, and frame effect
- **Completion alerts** — ONEOFF sessions show a review toast when they reach `waiting` status
- **Frame effects** — Each label can have a unique animated border (fire, electric, chains, liquid, plasma)

### Quick Launch

The nav bar has quick launch buttons:
- **Quick** — Launch a new session (opens New Session modal)
- **Oneoff** — Launch with ONEOFF label pre-assigned
- **Heavy** — Launch with HEAVY label pre-assigned
- **Important** — Launch with IMPORTANT label pre-assigned

Quick launch remembers the last-used working directory and auto-assigns to the last-used group.

### Working Directory History

The New Session modal maintains a dropdown of recently used working directories (stored in localStorage). Entries can be deleted individually.

---

## 14. AI Summarization

Sessions can be summarized using Claude (Haiku model) with customizable prompt templates.

### Summarization Flow

1. User clicks "Summarize" in the detail panel
2. **Summarize modal** opens with template selector
3. User selects a template or writes a custom prompt
4. Frontend prepares context from IndexedDB:
   - Session metadata (project, duration, status)
   - Prompt history
   - Tool call log
   - Response excerpts
5. Backend runs: `claude -p --model haiku` with the prompt via stdin
6. Summary is stored on the session and displayed in the Summary tab
7. Session is optionally archived

### Default Summary Templates

| Template | Purpose |
|----------|---------|
| **Detailed Technical** | Comprehensive technical breakdown of what was done |
| **Quick Bullets** | Short bullet-point summary |
| **Changelog** | Formatted as a changelog entry |
| **Handoff Notes** | Summary for handing off to another developer |
| **PR Description** | Formatted as a pull request description |

### Custom Templates

Users can create, edit, and delete custom summary prompt templates. Templates are stored in IndexedDB (`summaryPrompts` store). One template can be starred as the default.

### Rate Limiting

The backend limits summarization to 2 concurrent requests to prevent abuse.

---

## 15. Notes System

Each session has a persistent notes system for ad-hoc annotations.

### Note Operations
- **Create** — Type in the compose area in the Notes tab
- **Edit** — Click edit icon on existing note
- **Delete** — Click delete icon
- **Search** — Filter notes by content
- **Timestamps** — Each note shows creation time
- **Persistence** — Stored in IndexedDB (`notes` store), survives page refresh

---

## 16. Sound & Movement Effects

### Sound System

The dashboard uses the **Web Audio API** to synthesize sounds in real-time (no external audio files).

**15 available sounds:** chirp, ping, chime, ding, blip, swoosh, click, beep, warble, buzz, cascade, fanfare, alarm, thud, urgentAlarm

Each session event can be mapped to a sound:

| Event | Default Sound |
|-------|--------------|
| Session start | chirp |
| Prompt submitted | ping |
| Tool use | blip |
| Stop (complete) | chime |
| Session end | thud |
| Approval needed | alarm |
| Input needed | warble |

Sounds are configurable per-action in Settings > Sounds. A master volume slider (0-100%) and enable/disable toggle are provided.

### Movement Effects

**18 one-shot movement effects** can be triggered on session events:
- sweat, energy-ring, sparks, steam, eye-cycle, think-pulse, head-tilt
- float, breathe, sway, sparkle, bounce, flash, shake
- questions, fade, shrink, dissolve

Effects are CSS animations overlaid on the character card, auto-clearing after 3.5 seconds. Each event can be mapped to a movement effect in Settings > Sounds.

### Effect Configuration

Both sounds and movements are configured in the Settings panel:
- **Per-action mapping** — Choose which sound/movement for each event
- **Per-label effects** — ONEOFF, HEAVY, IMPORTANT each have custom effects
- **Preview** — Movement preview viewport in Settings
- **Intensity/speed** — Global `--anim-intensity` and `--anim-speed` CSS variables

---

## 17. Alarm System

The alarm system ensures users don't miss important session events.

### Approval/Input Alarms

When a session enters `approval` or `input` status:
1. **Sound alarm** — Plays every 10 seconds (repeating)
2. **Browser notification** — System notification with session name (requires permission)
3. **Card visual** — Pulsing glow + status banner
4. **Tab title** — Updates browser tab to show alert count

Alarms are suppressed for muted sessions.

### Label-Based Alerts

When a labeled session (especially ONEOFF) reaches `waiting` status:
- **Toast notification** — "Session X completed — click to review"
- **Sound** — Configured per-label in Settings

### Alarm Clearing

Alarms clear when:
- The session transitions away from `approval`/`input`
- The user clicks the session card
- The user mutes the session

---

## 18. History & Search

### Session History

The **History** tab provides a searchable, filterable view of all past sessions stored in IndexedDB.

**Filters:**
- **Project** — Filter by project name
- **Status** — Filter by final status
- **Date range** — Start and end date pickers
- **Sort** — By date, duration, or project name

**Pagination:** 50 sessions per page with page navigation.

**Click to expand:** Clicking a history row opens the full detail panel with all stored data (prompts, tools, responses, notes, summary).

### Full-Text Search

The search system queries across multiple IndexedDB stores:
- Session titles and project names
- Prompt text
- Response text
- Tool call details
- Notes content

Results are highlighted with yellow background markers.

### Live Search

The search bar in the header filters live session cards by project name or session ID in real-time.

---

## 19. Analytics Dashboard

The **Analytics** tab provides visual insights into session usage patterns.

### Summary Statistics
- Total sessions
- Total prompts sent
- Total tool calls
- Average session duration

### Charts

1. **Tool Usage Breakdown** — Horizontal bar chart showing most-used tools (Read, Edit, Bash, etc.)
2. **Duration Trends** — Line chart showing average session duration over 30 days
3. **Active Projects** — Horizontal bar chart of top 10 projects by session count
4. **Daily Heatmap** — 7x24 grid showing session activity by day-of-week and hour, color-coded by intensity

All charts are rendered as SVG with interactive tooltips. Data is sourced from IndexedDB analytics functions:
- `getSessionCountsByDay()`
- `getToolUsageStats()`
- `getProjectStats()`
- `getDurationTrends()`

---

## 20. Timeline Visualization

The **Timeline** tab shows a grouped bar chart of session activity over time.

### Granularity Options
- **Hour** — Activity per hour
- **Day** — Activity per day
- **Week** — Activity per week
- **Month** — Activity per month

### Metrics Per Bucket
Three bars per time bucket:
1. **Sessions** — Number of sessions started
2. **Prompts** — Total prompts sent
3. **Tools** — Total tool calls made

Rendered as SVG bar chart with tooltips showing exact counts.

---

## 21. Theming & Appearance

### Site Themes

9 visual themes, each defining a complete color palette:

| Theme | Description |
|-------|-------------|
| **Navy** (default) | Dark navy background (#0a0a1a) with neon accents |
| **Dark** | Pure dark theme |
| **Cyberpunk** | Neon pink/cyan cyberpunk aesthetic |
| **Dracula** | Dracula color scheme |
| **Solarized** | Solarized dark palette |
| **Nord** | Nord color palette |
| **Monokai** | Monokai editor colors |
| **Light** | Light background theme |
| **Warm/Blonde** | Warm toned theme |

### Terminal Themes

8 xterm.js color schemes:
- Auto (syncs with site theme), Default, Dark, Monokai, Dracula, Solarized, Nord, GitHub Dark

### Appearance Controls (Settings > Appearance)

| Control | Range | Effect |
|---------|-------|--------|
| Font size | 10-20px | Global text size |
| Animation intensity | 0-200% | Movement distance of effects |
| Animation speed | 30-200% | Animation duration |
| Scanline overlay | On/Off | Retro scanline effect on viewport |
| Character model | 20 options | Default character for new sessions |

### Accessibility

- Respects `prefers-reduced-motion` — All animations disabled
- Touch-friendly — 44px minimum touch targets on mobile
- Responsive — Breakpoints at 480px, 640px, 768px, 960px, 1024px, 1280px
- Dynamic viewport height — `100dvh` on mobile for proper toolbar handling

---

## 22. Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search bar |
| `?` | Toggle keyboard shortcuts panel |
| `Escape` | Close modal / deselect session |
| `S` | Toggle settings panel |
| `K` | Kill selected session (with confirmation) |
| `A` | Archive selected session |
| `T` | Open new terminal session modal |
| `M` | Mute/unmute all sessions |

Shortcuts are suppressed when typing in inputs, textareas, or the xterm.js terminal.

---

## 23. WebSocket Real-Time Communication

All real-time updates flow through a single WebSocket connection.

### Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `snapshot` | Server → Client | Full session state on connect |
| `session_update` | Server → Client | Session state change |
| `session_removed` | Server → Client | Session deleted |
| `team_update` | Server → Client | Team hierarchy change |
| `hook_stats` | Server → Client | Performance metrics |
| `duration_alert` | Server → Client | Duration threshold alert |
| `terminal_output` | Server → Client | Terminal PTY output (base64) |
| `terminal_ready` | Server → Client | Terminal created successfully |
| `terminal_closed` | Server → Client | Terminal ended |
| `clearBrowserDb` | Server → Client | Reset browser database |
| `TERMINAL_INPUT` | Client → Server | Keyboard input for terminal |
| `TERMINAL_RESIZE` | Client → Server | Terminal dimension change |
| `TERMINAL_SUBSCRIBE` | Client → Server | Subscribe to terminal output |

### Reconnect & Replay

The WebSocket client uses exponential backoff (1s base, 10s max) for auto-reconnect. On reconnect:
1. Client sends `sinceSeq` (last received event sequence number)
2. Server replays missed events from a 500-event ring buffer
3. Client also receives a fresh snapshot for baseline state

### Performance Controls

- **Heartbeat:** 30s ping interval, 10s pong timeout for dead connection detection
- **Backpressure:** Skips non-critical updates (hook_stats) if `client.bufferedAmount > 1MB`
- **Hook stats throttle:** Max 1 broadcast per second, defers extras
- **Lazy heartbeat:** Only runs when clients are connected

---

## 24. IndexedDB Persistence

The browser uses IndexedDB as the primary persistence layer for all session data, history, and settings.

### Database Schema (11 Object Stores)

| Store | Key | Purpose |
|-------|-----|---------|
| `sessions` | `sessionId` | Session metadata, status, timestamps |
| `prompts` | Auto-increment | User prompts with `sessionId` index |
| `responses` | Auto-increment | Claude responses with `sessionId` index |
| `toolCalls` | Auto-increment | Tool call details with `sessionId` index |
| `events` | Auto-increment | Session events with `sessionId` index |
| `notes` | Auto-increment | User notes with `sessionId` index |
| `promptQueue` | Auto-increment | Queued prompts with `sessionId` index |
| `alerts` | Auto-increment | Duration alerts |
| `sshProfiles` | Auto-increment | Saved SSH connection profiles |
| `settings` | `key` | Key-value settings store |
| `summaryPrompts` | Auto-increment | Summary prompt templates |

### Write Batching

To avoid IndexedDB write storms during rapid WebSocket updates, `browserDb.js` batches writes:
- **200ms flush timer** — Writes are queued and flushed every 200ms
- **20-item threshold** — Queue also flushes when it reaches 20 items
- **Deduplication** — Multiple updates to the same session within a batch are merged

### Session ID Migration

When a session is resumed (old session ID → new session ID), all child records across all stores are migrated to the new ID using `migrateSessionId()`.

---

## 25. Snapshot Persistence & Auto-Revive

### Server-Side Snapshots

The server periodically saves session state to disk (`data/sessions-snapshot.json`) for crash recovery.

**Snapshot contents:**
- Version number
- Save timestamp
- Event sequence counter
- MQ byte offset (for reader resume)
- All sessions with full state
- Project session counters
- PID-to-session mappings

**Atomic writes:** Snapshot is written to a temp file first, then atomically renamed.

**Periodic save:** Every 30 seconds (configurable).

### Load & Recovery

On server startup:
1. Load snapshot from disk
2. For each session, check PID liveness via `process.kill(pid, 0)`
3. Mark dead sessions as `ended` with `ServerRestart` event
4. Clear stale terminal IDs (PTYs don't survive restart)
5. Detect zombie SSH sessions (no PID, non-ended) and end them
6. Resume MQ reader from saved byte offset

### Auto-Revive

Sessions marked ended by `ServerRestart` can be **auto-revived** when they send new hooks. This handles the case where Claude is running in a tmux session that survives a server restart:

1. New hook arrives with session ID that matches an ended session
2. Session has a `ServerRestart` event (not a genuine end)
3. Session is revived: `endedAt` cleared, status reset, `isHistorical` set to false

---

## 26. Session Resume & Reconnect

### Resume (Terminal Still Alive)

When an SSH terminal is still alive but the Claude session was lost:
1. User clicks "Resume" in the detail panel
2. Server registers a `pendingResume` entry mapping the terminal to the old session
3. Server types `claude --resume {sessionId} || claude --continue` into the terminal
4. When the new session starts and sends a `SessionStart` hook, the matcher links it via `pendingResume`
5. The old session is re-keyed to the new session ID, preserving all history

### Reconnect (Terminal Dead)

When the SSH terminal has died:
1. A new terminal is created with the same SSH config
2. The old session is updated with the new terminal ID
3. A `pendingResume` entry is registered
4. The resume command is typed into the new terminal

### Previous Sessions

When a session is resumed, the old session data is archived in `previousSessions[]` (capped at 5). The Conversation tab in the detail panel shows collapsible "Previous Sessions" sections with the old conversation history.

---

## 27. Process Monitoring & Auto-Cleanup

### PID Liveness Checking

The `processMonitor` runs every 15 seconds and checks each session's cached PID:
- Uses `process.kill(pid, 0)` — Signal 0 checks existence without killing
- SSH sessions with active terminals are skipped (PTY is source of truth)
- Dead sessions are transitioned to `ended` status with Death animation

### Process Discovery

When a session needs its PID found (e.g., for kill), the system uses a 4-fallback chain:

1. **Cached PID** — Check `session.cachedPid`, validate with signal 0
2. **pgrep scan** — `pgrep -f claude`, exclude server PID and claimed PIDs
3. **CWD match** — macOS: `lsof -d cwd -a -p {pid}`, Linux: `readlink /proc/{pid}/cwd`
4. **TTY fallback** — Return first unclaimed PID with a TTY

**Platform support:** Windows uses PowerShell WMI queries (`Get-CimInstance Win32_Process`) instead of pgrep/lsof.

### Auto-Cleanup

- **Dead PID** → Session marked as `ended`, archived as historical
- **Team cleanup** → When parent + all children ended, team deleted after 15s
- **Non-SSH ended sessions** → Removed from memory after 5 minutes (allows auto-link time)
- **Pending links** → SSH terminal pending links cleaned after 60 seconds
- **Pending subagents** → Cleaned after 10-30 seconds

---

## 28. Hook Installation & Density Levels

### Density Levels

Three levels control which hook events are registered:

| Level | Events | Count | Use Case |
|-------|--------|-------|----------|
| **high** | All events including TeammateIdle, PreCompact | 14 | Full monitoring, complete data |
| **medium** | Excludes TeammateIdle, PreCompact | 12 | Default, good balance |
| **low** | SessionStart, UserPromptSubmit, PermissionRequest, Stop, SessionEnd | 5 | Minimal overhead |

### Installation Methods

1. **Auto-install on startup** — `hookInstaller.js` runs on every server start
2. **CLI command** — `npm run install-hooks`
3. **Setup wizard** — `npm run setup` (interactive)
4. **Settings UI** — Settings > Advanced > Hook Density selector

### Installation Process

For each enabled CLI:
1. Copy hook script to config directory (e.g., `~/.claude/hooks/dashboard-hook.sh`)
2. Set executable permissions (`chmod 755`)
3. Read existing settings JSON
4. For each density event, check if hook already registered
5. If missing, append to the event's hook array
6. **Atomic write** — Write to temp file + `renameSync()` to prevent corruption

### Source Tagging

All installed hooks are tagged with `_source: "ai-agent-session-center"` for clean uninstallation. The uninstaller only removes hooks with this tag, preserving user-installed hooks.

### Uninstallation

- `npm run uninstall-hooks` — Removes all dashboard hooks
- `npm run reset` — Full reset with backup

---

## 29. Security Hardening

### Input Validation

- **Shell metacharacter rejection** — All user-controlled paths reject `` ;|&$`\!><()\n\r{}[] `` to prevent command injection
- **Username validation** — Alphanumeric + `_.-` only
- **Tmux session names** — Alphanumeric only
- **Team name sanitization** — `teamName.replace(/[^a-zA-Z0-9_\-. ]/g, '')` prevents path traversal
- **API key injection** — Keys passed as environment variables, never interpolated into shell strings

### Rate Limiting

| Endpoint | Limit | Method |
|----------|-------|--------|
| Hook endpoint | 100 req/sec per IP | Sliding window (in-memory) |
| Summarize | Max 2 concurrent | Counter |
| Terminals | Max 10 total | Counter |

### XSS Prevention

- `escapeHtml()` and `escapeAttr()` utilities sanitize all user content before DOM insertion
- `sanitizeColor()` validates CSS color values

### Atomic Operations

- **Settings.json writes** — Write to temp file + rename (prevents corruption on crash)
- **Snapshot saves** — Same atomic write pattern
- **MQ file appends** — POSIX atomic for writes < 4096 bytes

### Process Isolation

- PID validation rejects non-positive integers
- Child process checks use 2-second timeouts
- Signal 0 for liveness (doesn't actually kill)

---

## 30. Performance Optimizations

### Caching

| Cache | Purpose |
|-------|---------|
| Session serialization | `getAllSessions()` caches until state mutation |
| Tool category lookup | Precomputed Map at import (O(1) vs O(N) scan) |
| PID cache per session | Avoids re-running pgrep on every hook |
| TTY path cache | Hook script caches TTY per PID in `/tmp/` |

### Throttling & Debouncing

| Mechanism | Interval | Purpose |
|-----------|----------|---------|
| Card update debounce | 100ms | Coalesces rapid WebSocket updates |
| Broadcast debounce | 50ms | Deduplicates by sessionId |
| Hook stats broadcast | 1/sec max | Prevents stats flooding |
| MQ fs.watch debounce | 10ms | Coalesces rapid file events |
| IndexedDB write batch | 200ms / 20 items | Reduces write operations |

### Memory Management

| Resource | Limit | Purpose |
|----------|-------|---------|
| Hook stats samples | 200 per event type | Rolling window |
| Event replay buffer | 500 events | Ring buffer for reconnect |
| Tool call log | 200 per session | Prevents unbounded growth |
| Prompt/response/event logs | 50 per session | Trimmed on each update |
| Terminal output buffer | 128KB per terminal | Ring buffer for replay |
| MQ file | Truncated at 1MB | Prevents disk growth |

### File I/O

- **Byte offset tracking** — MQ reader only reads new data
- **No re-reading** — Processed lines are never re-read
- **Background hook execution** — `disown` ensures hooks don't block Claude

---

## 31. Setup, Configuration & Reset

### First-Time Setup

```bash
npm run setup
```

Interactive wizard prompts for:
1. **Port** (default: 3333)
2. **AI CLIs** — Claude only / Claude + Gemini / Claude + Codex / All
3. **Hook density** — high / medium / low
4. **Debug mode** — on / off
5. **Session history retention** — 12h / 24h / 48h / 7d

Saves config to `data/server-config.json` and installs hooks.

### Configuration File

`data/server-config.json`:
```json
{
  "port": 3333,
  "enabledClis": ["claude"],
  "hookDensity": "high",
  "debug": false,
  "sessionHistoryHours": 168
}
```

### Port Configuration

Priority order:
1. `--port` CLI flag
2. `PORT` environment variable
3. `config.port` from server-config.json
4. Default: 3333

Port conflicts are auto-resolved (existing process on the port is killed).

### Full Reset

```bash
npm run reset
```

1. Creates timestamped backup in `data/backups/`
2. Removes hooks from all CLI configs
3. Deletes deployed hook scripts
4. Cleans server config and database
5. Sends `clearBrowserDb` to connected browsers
6. Lists preserved non-dashboard hooks

---

## 32. Architecture Overview

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js 18+ (ESM) + Express 5 + ws 8 |
| Frontend | Vanilla JS + CSS animations (import maps, zero build) |
| Terminal | node-pty for SSH/local PTY sessions |
| Hooks | Bash script (file-based MQ primary, HTTP fallback) |
| Server Persistence | In-memory + JSON snapshot |
| Browser Persistence | IndexedDB (11 object stores) |
| Charts | SVG rendering (no chart library) |
| Sounds | Web Audio API synthesis (no audio files) |
| Characters | Pure CSS animations (no canvas/WebGL) |

### Design Principles

1. **Zero build step** — Import maps for dependencies, vanilla JS modules, no webpack/vite
2. **File-based MQ over HTTP** — Eliminates process spawn overhead in hooks
3. **Coordinator pattern** — `sessionStore.js` delegates to focused sub-modules
4. **In-memory first** — No database on server; IndexedDB is the browser persistence layer
5. **Atomic operations** — All file writes use temp + rename pattern
6. **Graceful degradation** — Each subsystem has fallbacks (MQ → HTTP, fs.watch → poll, cached PID → pgrep)

### Server Module Map

```
server/index.js (thin orchestrator)
  ├── hookInstaller.js    — auto-install hooks on startup
  ├── portManager.js      — resolve port, kill conflicts
  ├── hookRouter.js       — POST /api/hooks (HTTP fallback)
  ├── apiRouter.js        — 20 REST API endpoints
  ├── mqReader.js         — file-based JSONL queue reader
  ├── hookProcessor.js    — validation + processing pipeline
  ├── sessionStore.js     — coordinator (delegates below)
  │   ├── sessionMatcher.js    — 5-priority session matching
  │   ├── approvalDetector.js  — tool approval timeout logic
  │   ├── teamManager.js       — team/subagent tracking
  │   ├── processMonitor.js    — PID liveness checking
  │   └── autoIdleManager.js   — idle transition timers
  ├── wsManager.js        — WebSocket broadcast + terminal relay
  ├── sshManager.js       — SSH/PTY terminal management
  ├── hookStats.js        — performance metrics
  ├── config.js           — tool categories, timeouts
  ├── constants.js        — all magic strings
  ├── serverConfig.js     — loads user config
  └── logger.js           — debug-aware logging
```

### Frontend Module Map

```
public/js/app.js (bootstrap + WS dispatcher)
  ├── wsClient.js          — WebSocket with auto-reconnect + replay
  ├── sessionPanel.js      — facade wiring sub-modules
  │   ├── sessionCard.js       — card rendering, drag/drop
  │   ├── detailPanel.js       — detail panel, tabs, search
  │   ├── promptQueue.js       — queue management, auto-send
  │   ├── sessionGroups.js     — group management, layout presets
  │   ├── sessionControls.js   — kill, archive, resume, labels, notes
  │   ├── keyboardShortcuts.js — keyboard shortcuts
  │   ├── alarmManager.js      — approval/input alarms
  │   └── quickActions.js      — new session, quick launch
  ├── robotManager.js      — 20 CSS character models
  ├── movementManager.js   — 18 movement effects
  ├── soundManager.js      — 15 Web Audio sounds
  ├── terminalManager.js   — xterm.js terminals
  ├── statsPanel.js        — hook performance stats
  ├── navController.js     — view navigation
  ├── historyPanel.js      — session history browser
  ├── analyticsPanel.js    — analytics charts
  ├── timelinePanel.js     — timeline visualization
  ├── settingsManager.js   — settings UI
  ├── browserDb.js         — IndexedDB (11 stores)
  ├── chartUtils.js        — SVG chart rendering
  ├── constants.js         — frontend constants
  └── utils.js             — shared utilities
```

### API Endpoints (20 total)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/hook-stats` | Hook performance metrics |
| POST | `/api/hook-stats/reset` | Reset performance counters |
| POST | `/api/reset` | Clear browser DB + server state |
| GET | `/api/mq-stats` | Message queue statistics |
| GET | `/api/hooks/status` | Installed hook density |
| POST | `/api/hooks/install` | Install hooks at density |
| POST | `/api/hooks/uninstall` | Remove all hooks |
| POST | `/api/sessions/:id/resume` | Resume a session |
| POST | `/api/sessions/:id/kill` | Kill session process |
| DELETE | `/api/sessions/:id` | Delete session |
| GET | `/api/sessions/:id/source` | Detect session source |
| PUT | `/api/sessions/:id/title` | Set session title |
| PUT | `/api/sessions/:id/label` | Set session label |
| POST | `/api/sessions/:id/summarize` | Generate AI summary |
| GET | `/api/ssh-keys` | List SSH keys |
| POST | `/api/tmux-sessions` | List tmux sessions |
| POST | `/api/terminals` | Create new terminal |
| GET | `/api/terminals` | List active terminals |
| DELETE | `/api/terminals/:id` | Close terminal |
| GET | `/api/teams/:id/config` | Get team config |
| POST | `/api/teams/:id/members/:sid/terminal` | Attach team member terminal |

---

## Summary Statistics

| Metric | Count |
|--------|-------|
| Server modules | 20 |
| Frontend modules | 26 |
| Hook scripts | 4 (bash/PowerShell/Gemini/Codex) |
| CSS stylesheets | 10+ (base, layout, card, detail, modals, terminal, settings, animations, themes, characters) |
| API endpoints | 20 |
| WebSocket message types | 13 |
| Hook event types | 32 (14 Claude, 5 Gemini, 1 Codex, mapped) |
| Session statuses | 8 |
| Character models | 20 |
| Sound effects | 15 |
| Movement effects | 18 |
| Site themes | 9 |
| Terminal themes | 8 |
| IndexedDB stores | 11 |
| Keyboard shortcuts | 8 |
| Layout presets | 5 |
| Summary templates | 5 (default) |
| Card frame effects | 5 |
| Terminal sources detected | 11 |
