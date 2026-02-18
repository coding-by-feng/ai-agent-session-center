# Prompt: Write Comprehensive Platform Features Document

## Context

You are documenting a full-featured **AI Agent Session Center** — a localhost dashboard (port 3333) that monitors all active AI coding agent sessions (Claude Code, Gemini CLI, Codex) in real-time via hook scripts. The platform has both a **legacy vanilla JS + CSS animations frontend** and a **React Three Fiber 3D Cyberdrome scene** built with TypeScript + Vite. The document must serve as a complete specification for rebuilding the platform from scratch.

## Deliverable

Write a single Markdown file `docs/PLATFORM_FEATURES.md` that exhaustively documents every feature. The document must be detailed enough that a developer who has never seen the codebase can rebuild the entire platform feature-for-feature.

## Required Sections

### 1. Platform Overview
- Purpose, target users, supported AI CLIs (Claude Code, Gemini CLI, Codex, OpenClaw)
- Tech stack: Node.js 18+ ESM, Express 5, ws 8, node-pty, better-sqlite3, React 19 + TypeScript + Vite, React Three Fiber, Zustand, IndexedDB, xterm.js
- Architecture diagram (ASCII): Hook script → File MQ → Server → WebSocket → Browser
- Latency expectations per stage (jq 2-5ms, file append 0.1ms, fs.watch 0-10ms, processing 0.5ms, total 3-17ms)

### 2. Hook Delivery Pipeline
- **Primary path**: bash hook script → jq enrichment (PID, TTY, terminal detection, tab_id, tmux, agent metadata) → atomic POSIX append to `/tmp/claude-session-center/queue.jsonl` → background subshell + disown
- **Fallback**: curl HTTP POST to `localhost:PORT/api/hooks` (1s connect, 3s total timeout)
- **MQ Reader**: fs.watch() + 10ms debounce, 500ms fallback poll, 5s health check, byte-offset tracking, partial line handling, 1MB truncation threshold
- **Hook validation**: session_id required (max 256), event name in known set, optional claude_pid/timestamp validation
- **Enriched fields**: claude_pid, hook_sent_at, tty_path, term_program/version, vscode_pid, tab_id (iTerm/kitty/Warp/WezTerm/Apple Terminal), tmux session/pane, terminal env vars, agent metadata (parent_session_id, team_name, agent_name/type/id/color)
- **TTY detection cache**: per-PPID in `/tmp/claude-tty-cache/` to avoid repeated ps calls
- **Tab title management**: escape sequences to terminal for state-changing events

### 3. Hook Events and Density Levels
- All 14 Claude events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Stop, Notification, SubagentStart, SubagentStop, TeammateIdle, TaskCompleted, PreCompact, SessionEnd
- 7 Gemini events: SessionStart, BeforeAgent, BeforeTool, AfterTool, AfterAgent, SessionEnd, Notification
- 1 Codex event: agent-turn-complete
- 3 density levels (high=all 14, medium=12 excl TeammateIdle/PreCompact, low=5 Start/Prompt/Permission/Stop/End)
- Hook installation: copies scripts to `~/.claude/hooks/`, atomic JSON merge into `~/.claude/settings.json`, Gemini `~/.gemini/settings.json`, Codex `~/.codex/config.toml`, Windows PowerShell variant

### 4. Session State Machine
- Full state diagram: idle → prompting → working → approval/input → waiting → idle → ended
- All transitions with trigger events
- Session object: 50+ fields (sessionId, projectPath, projectName, label, title, status, animationState, emote, timestamps, promptHistory[50], toolUsage Map, totalToolCalls, model, subagentCount, toolLog[200], responseLog[50], events[50], archived, source, pendingTool, waitingDetail, cachedPid, queueCount, terminalId, sshHost/Command/Config, teamId/Role, agentName/Type/Color, characterModel, accentColor, summary, previousSessions[5], tmuxPaneId, backendType)
- Event ring buffer (500 events) for WebSocket replay on reconnect
- Snapshot persistence: atomic write every 10s to `/tmp/claude-session-center/sessions-snapshot.json`, loaded on restart
- Debounced broadcast: 50ms window per sessionId

### 5. Session Matching (5-Priority System)
- Priority 0: pendingResume + terminal ID or workDir match
- Priority 0.5: auto-link to snapshot-restored ended session by projectPath (within 30 min, single candidate)
- Priority 1: agent_terminal_id env var direct match → re-key session
- Priority 2: tryLinkByWorkDir() pending link from sshManager
- Priority 3: scan CONNECTING sessions by normalized path (exactly 1 match)
- Priority 4: PID parent check via getTerminalByPtyChild()
- Fallback: display-only card with detected terminal source (VS Code, JetBrains IDEs, iTerm, Warp, Kitty, Ghostty, Alacritty, WezTerm, Hyper, Apple Terminal, tmux)
- Session re-keying: transfers old→new sessionId, resets state, preserves previousSessions chain, migrates SQLite FK

### 6. Approval Detection
- Tool category timeouts: fast(3s: Read/Write/Edit/Grep/Glob/NotebookEdit), userInput(3s: AskUser/EnterPlan/ExitPlan), medium(15s: WebFetch/WebSearch), slow(8s: Bash/Task)
- hasChildProcesses check for slow tools (pgrep -P)
- PermissionRequest event as reliable signal (medium+ density)
- Auto-idle timeouts: prompting→30s→waiting, waiting→120s→idle, working→180s→idle, approval/input→600s→idle

### 7. Team and Subagent Tracking
- Auto-detection by matching cwd paths (parent/child within 10s window)
- Explicit via CLAUDE_CODE_PARENT_SESSION_ID env var
- Team config reader: `~/.claude/teams/{name}/config.json` with member metadata
- Team terminal: attach to member's tmux pane
- Cleanup: 15s delay after parent ends if all children also ended
- Parent tracks subagentCount

### 8. SSH/PTY Terminal Management
- 4 creation modes: direct SSH, tmux attach, tmux wrap, resume with fallback (`claude --resume ID || claude --continue`)
- node-pty for PTY multiplexing, max 10 concurrent
- Shell ready detection: watches for prompt patterns ($/%/#/>), 100ms settle, 5s/15s timeouts
- 128KB ring buffer per terminal, replayed on (re)subscribe
- Pending workDir links for session matching (60s expiry)
- API key injection via PTY env vars
- AGENT_MANAGER_TERMINAL_ID env var exported on remote shell
- Input validation: rejects shell metacharacters

### 9. WebSocket Protocol
- Server→Client: snapshot, session_update, session_removed, team_update, hook_stats, terminal_output (base64), terminal_ready, terminal_closed, clearBrowserDb, replay
- Client→Server: terminal_input, terminal_resize, terminal_disconnect, terminal_subscribe, update_queue_count, replay (sinceSeq)
- Heartbeat: ping 30s, pong timeout 10s
- Backpressure: skip non-critical if send buffer >1MB
- hook_stats throttled to 1/s

### 10. REST API (All Endpoints)
- Hook/Stats: GET/POST hook-stats, GET mq-stats
- Sessions: GET source, POST resume, POST kill, DELETE, PUT title, PUT label, PUT accent-color, POST summarize (rate limited 2 concurrent)
- Terminals: POST create (max 10), GET list, DELETE close
- SSH: GET ssh-keys, POST tmux-sessions
- Teams: GET config, POST member terminal
- SQLite DB: GET/DELETE sessions (search/filter/paginate), GET projects, GET search (full-text), GET/POST/DELETE notes
- Analytics: GET summary, tools, projects, heatmap (7×24)
- Admin: POST reset, GET/POST/POST hooks status/install/uninstall
- Auth: GET status, POST login, POST logout

### 11. Authentication
- Optional password protection via server-config.json passwordHash
- scrypt-based hashing with timing-safe comparison
- 24-hour in-memory tokens, hourly cleanup
- Token sources: HTTP cookie, Authorization Bearer header, ?token= query (for WS)
- Hook endpoints bypass auth

### 12. SQLite Persistence
- better-sqlite3, WAL mode, `data/sessions.db`
- Tables: sessions, prompts, responses, tool_calls, events, notes (all with UNIQUE constraints)
- Upsert pattern, batch insert transactions, cascade delete
- Session ID migration for resume re-keying
- Full-text LIKE search across prompts/responses
- Analytics: prepared statements for summary, tools, projects, heatmap

### 13. IndexedDB Client Persistence
- Database: claude-dashboard v2
- 12 object stores: sessions, prompts, responses, toolCalls, events, notes, promptQueue, alerts, sshProfiles, settings, summaryPrompts, teams
- Batched writes: 200ms flush or 20-item threshold
- Session dedup by timestamp on persist
- Queue CRUD with reorder/move-between-sessions
- Full-text search with `<mark>` highlighting
- Timeline queries with granularity (hour/day/week/month)
- Default seeding: 6 settings + 5 summary prompt templates

### 14. CSS Character System (2D View)
- 20 pure-CSS characters: robot, cat, alien, ghost, orb, dragon, penguin, octopus, mushroom, fox, unicorn, jellyfish, owl, bat, cactus, slime, pumpkin, yeti, crystal, bee
- 8-color accent palette, round-robin assignment
- Per-session character override + global setting
- Status→animation mapping: idle→Idle, prompting→Wave+Walking, working→Running, approval/input→Waiting, waiting→ThumbsUp+Waiting, ended→Death
- Character lifecycle: create, update (data-status attr), switch, markChecked, remove

### 15. 3D Cyberdrome Scene
- React Three Fiber + Three.js, zero useState inside Canvas (all refs), zero Zustand subscriptions inside Canvas
- CustomEvent pattern: robot click → window.dispatchEvent('robot-select') → DOM handler → Zustand update
- Canvas: PCFSoftShadowMap, ACESFilmicToneMapping, FOV 50, OrbitControls with damping
- Map controls overlay: zoom in/out, top-down, reset view
- Dynamic room system: 4 rooms/row, ROOM_SIZE=12, ROOM_GAP=5, 8 desks/room (3 north + 2 west + 3 east)
- Two doors per room (north + south, DOOR_GAP=4)
- Corridor workstations: 10 desks south of rooms
- Casual areas north: Coffee Lounge (6 seats, zone -2), Gym (10 stations, zone -3)
- Wall collision rects for navigation
- Door waypoints with inside/outside vectors, nearest-door pathfinding
- Robot navigation AI: 4 modes (WALK/GOTO/SIT/IDLE), status-based desk seeking, cross-room pathfinding via doors, position persistence to sessionStorage
- Robot dialogue bubbles: status-persistent + tool-transient, zero useState (ref-based)
- Robot labels: Billboard+Text WebGL rendering, fontSize from settings, title+status dot+alert banner
- Status particles per robot
- Subagent connection beams between parent/child robots
- Scene themes synced from UI themeName setting
- Camera controller: flyTo with smooth interpolation
- Room labels in 3D space
- RobotListSidebar: DOM overlay with close button, status sorting, fly-to-robot on click

### 16. Session Cards (2D View)
- Card creation with 100ms debounce
- Pinned sessions (localStorage), muted sessions (per-session + global)
- Top-5 tool bars with proportional fill
- Toast notifications (error always, info configurable)
- Label badge, team indicator, editable title
- Status border glow pulsing
- Drag-and-drop reorder within groups

### 17. Session Detail Panel
- Slide-in right overlay, resizable (min 320px, max 95vw), width persisted
- Header: project name, status, model, duration, character selector, title input, label input with chips
- 6 tabs: Conversation (prompts numbered + timestamped + COPY, previous sessions collapsible), Activity (merged events+tools+responses color-coded), Terminal (xterm.js + reconnect + theme), Notes (CRUD), Queue (per-session), Summary (AI-generated + re-summarize)
- Tab/selection persistence in localStorage
- Auto-attach terminal on tab switch
- History view mode: loads from SQLite for ended sessions
- Search integration with highlight

### 18. Session Controls
- Resume (ended sessions → terminal + `claude --resume`)
- Kill (SIGTERM → 3s → SIGKILL, confirm modal)
- Archive (marks archived, removes from live, plays sound)
- Delete (permanent, cascade SQLite delete, confirm dialog)
- Summarize (prompt template selector modal with CRUD, calls Claude haiku, rate limited)
- Alert (timed notification modal)
- Notes CRUD
- Label system: 3 built-in (ONEOFF/HEAVY/IMPORTANT) + custom, chip quick-select, autocomplete history (30 max)
- Title system: free-text, saves on blur/Enter

### 19. Quick Actions
- + NEW SESSION: full SSH modal (host/port/user/auth/key/workdir/command/tmux mode/API key/theme/title/label)
- QUICK SESSION: minimal modal reusing last SSH config
- ONEOFF/HEAVY/IMPORTANT: quick-launch with label pre-filled (HEAVY/IMPORTANT auto-pin)
- MUTE ALL toggle, ARCHIVE ENDED bulk action
- Working directory history (20 max, dropdown with delete), label history (30 max MRU)
- Mobile FAB with slide-up panel
- Shortcuts panel (? key)

### 20. Prompt Queue
- Per-session numbered list with SEND/expand/EDIT/MOVE/DEL per item
- Drag-to-reorder (HTML5 drag)
- Move mode: multi-select + choose destination session
- Global queue view: all sessions grouped with headers
- Auto-send: when autoSendQueue on + session→waiting, pop first item to terminal
- IndexedDB persistence with orderIndex

### 21. Session Groups
- Default 4 groups: Priority, Active, Background, Review
- CSS Grid 12-column layout, configurable colSpan per group
- 5 layout presets: 1-col, 2-col, 3-col, 1/3+2/3, 2/3+1/3
- Group CRUD, drag-reorder, resize handles
- Session-to-group assignment via detail panel dropdown
- Persistence in localStorage

### 22. Sound System
- 16 synthesized Web Audio API sounds: chirp, ping, chime, ding, blip, swoosh, click, beep, warble, buzz, cascade, fanfare, alarm, thud, urgentAlarm, none
- 20 action-sound mappings (configurable per-action)
- Per-CLI sound profiles (claude/gemini/codex/openclaw) with default overrides
- Volume 0-1, global enable/disable
- AudioContext unlock on first interaction
- Ambient presets with room sounds option

### 23. Movement Effects
- 18 CSS effects: none, sweat, energy-ring, sparks, steam, eye-cycle, think-pulse, head-tilt, float, breathe, sway, sparkle, bounce, flash, shake, fade, shrink, dissolve, questions
- Applied via data-movement attribute, auto-clear after 3.5s
- Per-action configurable mappings

### 24. Alarm System
- Approval alarm: urgentAlarm + shake, repeats every 10s while in approval
- Input notification: single sound on entering input state
- Event-based: maps hook events to configured sounds/movements
- Label completion alerts: per-label sound + movement + frame effect (fire/electric/chains/liquid/plasma)
- Duration alerts: timed, stored in IndexedDB, checked periodically

### 25. Settings
- Appearance: 9 themes (command-center/cyberpunk/warm/dracula/solarized/nord/monokai/light/blonde), font size, card size, scanlines, activity feed, toasts
- Sound: global enable/volume, per-action sound grid, per-CLI profiles
- Animation: character model, intensity %, speed %, per-action movement grid
- Hooks: density selector, install/uninstall buttons with status
- API Keys: Anthropic/OpenAI/Gemini with show/hide
- Label settings: per-label frame effect + sound + movement
- Summary prompts: CRUD templates, star default, 5 built-in templates
- Import/Export: JSON download/upload, reset to defaults
- All settings persisted to IndexedDB with 200ms batching

### 26. Terminal Manager (Frontend)
- xterm.js with Canvas renderer, FitAddon, Unicode11Addon, WebLinksAddon
- 10000 line scrollback, JetBrains Mono font, responsive font size
- 8 terminal themes + auto theme (reads CSS variables)
- Canvas repaint workaround (resize cols-1 → restore in 2 frames)
- Fullscreen mode with Alt+F11
- WS reconnect: clear + re-subscribe (128KB replay)
- Pending output buffer (500 chunks max)
- Per-terminal theme persistence
- Resize observer with 50ms debounce
- Team member terminal: attach to tmux pane

### 27. History Panel
- Server-side SQLite queries (not IndexedDB)
- Filters: search (300ms debounce), project dropdown, status, date range, archived flag
- Sort: date/duration/prompts/tools + direction toggle
- Pagination: 50/page with numbered buttons
- Row click → detail panel from SQLite
- Delete with cascade fade-out

### 28. Analytics Panel
- Custom SVG charts (no library)
- 5 sections: summary stats (6 cards), tool usage bar chart (top 15), duration trends area chart, active projects bar chart, daily heatmap (7×24 Mon-first)
- All data from server SQLite analytics endpoints

### 29. Timeline Panel
- Grouped bar chart: sessions/prompts/tool calls per time bucket
- Filters: granularity (hour/day/week/month), project, date range (default 30 days)
- Data from IndexedDB getTimeline()

### 30. Keyboard Shortcuts
- `/` focus search, Escape close/deselect, `?` shortcuts panel, `S` settings, `K` kill, `A` archive, `T` new terminal, `M` mute all

### 31. Server Infrastructure
- Port conflict auto-resolution (kills occupying process)
- Graceful shutdown (SIGTERM/SIGINT → save snapshot → close SQLite → server.close → 5s force exit)
- Process monitor: PID liveness check every 15s
- Auto-idle manager: per-session timers
- Hook stats: per-event counts + latency/processing histograms
- Rate limiting: in-memory sliding window
- Logger: debug-aware with pretty JSON
- Server config: port, enabledClis, hookDensity, debug, sessionHistoryHours, passwordHash

### 32. CLI and Setup
- `npx` entry: auto-setup wizard on first run, `--setup` flag to re-run
- 6-step wizard: port, CLIs, density, debug, retention, password
- Saves to `data/server-config.json`
- Auto-install hooks on every server startup (quiet mode)

### 33. Testing
- Vitest unit tests (407+ tests)
- Playwright E2E tests: groups, kill-session, navigation, session-lifecycle, settings, smoke, terminal

## Instructions for Agent Team

Split the work across agents:

1. **Agent 1 (Server Features)**: Sections 1-12, 31-32 — everything server-side
2. **Agent 2 (Frontend Features)**: Sections 13-21, 27-30 — UI components, panels, views
3. **Agent 3 (3D Scene + Multimedia)**: Sections 15, 22-26, 33 — Cyberdrome, sound, animations, settings, testing

Each agent should read the actual source files to verify details and add any missing specifics. The final document should be merged into a single `docs/PLATFORM_FEATURES.md` file.

Write in precise technical language. Include exact values (timeouts, buffer sizes, limits). Use tables for mappings and enums. Use code blocks for data structures. Use ASCII diagrams for architecture flows.
