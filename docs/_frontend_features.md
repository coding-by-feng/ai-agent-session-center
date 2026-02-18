# Frontend Features — AI Agent Session Center

> Sections 13–14, 16–21, 27–30. Generated from source files in `public/js/` and `public/css/`.

---

## 13. IndexedDB Client Persistence (`browserDb.js`)

### Database Identity

| Property | Value |
|----------|-------|
| Database name | `claude-dashboard` |
| Schema version | `2` |
| API | `window.indexedDB` (browser-native) |
| Initialization | `openDB()` — idempotent singleton |

### Object Stores (12 total)

| Store | Key Path | Auto-Increment | Purpose |
|-------|----------|----------------|---------|
| `sessions` | `id` | No | Session snapshots, one record per session |
| `prompts` | `id` | Yes | User prompt history entries |
| `responses` | `id` | Yes | Claude response excerpts |
| `toolCalls` | `id` | Yes | Tool invocation records |
| `events` | `id` | Yes | Raw hook event log |
| `notes` | `id` | Yes | Per-session user notes |
| `promptQueue` | `id` | Yes | Queued prompts awaiting dispatch |
| `alerts` | `id` | Yes | Duration alert rules |
| `sshProfiles` | `id` | Yes | SSH connection profiles |
| `settings` | `key` | No | Key-value settings store |
| `summaryPrompts` | `id` | Yes | AI summarization prompt templates |
| `teams` | `id` | No | Subagent team definitions |

### Indexes

| Store | Index Name | Key Path | Notes |
|-------|-----------|----------|-------|
| `sessions` | `status` | `status` | Filter by status |
| `sessions` | `projectPath` | `projectPath` | Filter by project |
| `sessions` | `startedAt` | `startedAt` | Sort by time |
| `sessions` | `lastActivityAt` | `lastActivityAt` | Sort by activity |
| `sessions` | `archived` | `archived` | Archived flag (0/1) |
| `prompts` | `sessionId` | `sessionId` | Lookup by session |
| `prompts` | `sessionId_timestamp` | `[sessionId, timestamp]` | Compound for sorted lookup |
| `responses` | `sessionId` | `sessionId` | Lookup by session |
| `toolCalls` | `sessionId` | `sessionId` | Lookup by session |
| `toolCalls` | `toolName` | `toolName` | Filter by tool |
| `events` | `sessionId` | `sessionId` | Lookup by session |
| `promptQueue` | `sessionId_position` | `[sessionId, position]` | Ordered queue items |
| `notes` | `sessionId` | `sessionId` | Lookup notes per session |
| `summaryPrompts` | `isDefault` | `isDefault` | Find default template |

### Batched Write Queue

Writes are coalesced per store to minimize IndexedDB transaction overhead:

| Parameter | Value |
|-----------|-------|
| Flush interval | `200 ms` |
| Max queue depth before immediate flush | `20 items` |

`putBatched(storeName, data)` schedules writes; `flushWriteQueue()` executes them in a single transaction. `flushAllWriteQueues()` is called on page unload.

### Session Persistence (`persistSessionUpdate`)

When a `session_update` WebSocket message arrives, the following records are upserted/appended:

- **sessions** store: full session record (status, projectPath, title, model, label, teamId, queueCount, etc.)
- **prompts**: new entries deduplicated by `timestamp`
- **toolCalls**: new entries deduplicated by `timestamp`; maps `tool` → `toolName`, `input` → `toolInputSummary`
- **responses**: new entries deduplicated by `timestamp`; maps `text` → `textExcerpt`
- **events**: new entries deduplicated by `timestamp`

### Query API (`searchSessions`)

Supported filter parameters with defaults:

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `query` | string | — | Substring match on prompt text |
| `project` | string | — | Exact match on `projectPath` |
| `status` | string | — | Exact match on `status` |
| `dateFrom` | number (ms) | — | `startedAt >= dateFrom` |
| `dateTo` | number (ms) | — | `startedAt <= dateTo` |
| `archived` | boolean/`'all'` | excludes archived | `archived === 'all'` returns everything |
| `sortBy` | string | `'startedAt'` | Any session field |
| `sortDir` | `'asc'`/`'desc'` | `'desc'` | — |
| `page` | number | `1` | 1-based |
| `pageSize` | number | `50` | — |

Returns `{ sessions, total, page, pageSize }`.

### Full-Text Search (`fullTextSearch`)

Searches `prompts` and `responses` stores with case-insensitive substring matching. Returns results with `<mark>`-wrapped snippets (context window: 60 chars before/after match). Supports `type` filter: `'all'`, `'prompts'`, `'responses'`.

### Analytics Queries

| Function | Data source | Output |
|---------|-------------|--------|
| `getSummaryStats()` | sessions + toolCalls + prompts | total sessions, prompts, tools, active count, avg duration, most-used tool, busiest project |
| `getToolBreakdown()` | toolCalls | per-tool count + % of total |
| `getDurationTrends({ period })` | sessions with `endedAt` | avg duration + session count per bucket |
| `getActiveProjects()` | sessions + prompts + toolCalls | per-project: session count, total prompts, total tools, last activity |
| `getHeatmap()` | events | 7×24 grid of event counts (Monday-first, 0–6) |
| `getTimeline({ dateFrom, dateTo, granularity, project })` | sessions + prompts + toolCalls | per-period: session_count, prompt_count, tool_call_count |

Timeline granularity options: `'hour'`, `'day'` (default), `'week'`, `'month'`. Period key format: `YYYY-MM-DD` (day), `YYYY-MM-DD HH:00` (hour), `YYYY-Www` (week), `YYYY-MM` (month).

### Prompt Queue CRUD

| Operation | Function |
|-----------|----------|
| List (ordered) | `getQueue(sessionId)` — sorted by `position` |
| Add | `addToQueue(sessionId, text)` — appends at max position + 1 |
| Remove first (dequeue) | `popQueue(sessionId)` |
| Reorder | `reorderQueue(sessionId, orderedIds)` — reassigns position by array index |
| Move items | `moveQueueItems(itemIds, targetSessionId)` |
| Move all | `moveAllQueue(sourceSessionId, targetSessionId)` |

### Notes Helpers

- `getNotes(sessionId)` — sorted newest-first by `createdAt`
- `addNote(sessionId, text)` — sets `createdAt` and `updatedAt` to `Date.now()`

### Settings Helpers

- `getSetting(key)` / `setSetting(key, value)` — single key-value
- `getAllSettings()` — returns plain object
- `setManySettings(obj)` — batch upsert

### Default Seed Data

On first DB open (`settingsCount === 0`), the following defaults are inserted:

| Key | Default Value |
|-----|--------------|
| `theme` | `'command-center'` |
| `fontSize` | `'13'` |
| `modelUrl` | `'https://threejs.org/examples/models/gltf/Xbot.glb'` |
| `modelName` | `'Xbot'` |
| `soundEnabled` | `'true'` |
| `soundVolume` | `'0.5'` |
| `soundPack` | `'default'` |

Five summary prompt templates are seeded on first use: **Detailed Technical Summary** (default), **Quick Bullet Points**, **Changelog Entry**, **Handoff Notes**, **PR Description**.

### Session ID Migration

`migrateSessionId(oldSessionId, newSessionId)` re-keys all child store records across 7 stores: `prompts`, `responses`, `toolCalls`, `events`, `notes`, `promptQueue`, `alerts`. Used when `claude --resume` creates a new session UUID.

### Delete Cascade

`deleteSession(sessionId)` removes the session record and all related records from 7 child stores.

---

## 14. CSS Character System (`robotManager.js` + `public/css/characters/`)

### Character Models (20 total)

| Model key | CSS class | Description |
|-----------|-----------|-------------|
| `robot` | `char-robot` | Classic robot with antenna, chest light, typing dots |
| `cat` | `char-cat` | Cat with ears, whiskers, tail |
| `alien` | `char-alien` | Dome-headed alien with 3 eyes and tentacles |
| `ghost` | `char-ghost` | Ghost with blush marks |
| `orb` | `char-orb` | Energy orb with 2 rings and particles |
| `dragon` | `char-dragon` | Dragon with horns, wings, fire breath |
| `penguin` | `char-penguin` | Penguin with beak and flippers |
| `octopus` | `char-octopus` | Octopus with 4 tentacles |
| `mushroom` | `char-mushroom` | Mushroom with spots and stem |
| `fox` | `char-fox` | Fox with ears, snout, tail |
| `unicorn` | `char-unicorn` | Unicorn with horn and mane |
| `jellyfish` | `char-jellyfish` | Jellyfish with 5 tentacles |
| `owl` | `char-owl` | Owl with tufts, pupils, wings |
| `bat` | `char-bat` | Bat with large wings and fangs |
| `cactus` | `char-cactus` | Cactus with flower, arms |
| `slime` | `char-slime` | Blob with shine |
| `pumpkin` | `char-pumpkin` | Pumpkin with grooves |
| `yeti` | `char-yeti` | Yeti with fur and belly |
| `crystal` | `char-crystal` | Faceted crystal with glowing core |
| `bee` | `char-bee` | Bee with stripes, wings, stinger |

### Color Palette (8 colors, round-robin assignment)

| Index | Hex Value | Associated Status |
|-------|-----------|-----------------|
| 0 | `#00e5ff` | cyan — prompting |
| 1 | `#ff9100` | orange — working |
| 2 | `#00ff88` | green — idle |
| 3 | `#ff3355` | red — ended |
| 4 | `#aa66ff` | purple — input |
| 5 | `#ffdd00` | yellow — approval |
| 6 | `#ff66aa` | pink |
| 7 | `#66ffdd` | teal |

Colors are assigned sequentially on character creation and persisted to the server via `PUT /api/sessions/:id/accent-color`.

### Status → CSS Animation Mapping

The `data-status` attribute on `.css-robot` drives all animations via CSS:

| Status | `data-status` | Visual Behaviour |
|--------|--------------|-----------------|
| Idle | `idle` | Float up/down (or breathe/sway/sparkle per effect setting) |
| Prompting | `prompting` | Eye-cycle movement, wave animation |
| Working | `working` | Running/bobbing animation |
| Waiting (approval/input) | `waiting` | Bounce animation; stops when `data-checked="true"` |
| Ended | `ended` | Death animation then fade |

### Lifecycle

1. `createRobot(sessionId, sessionCharModel, sessionColor)` — finds `.robot-viewport` inside the card, builds HTML from the character template, sets `--robot-color` CSS variable, stores in `Map<sessionId, robotData>`.
2. `updateRobot(session)` — updates `data-status`, optionally switches character model, triggers emote animations (`robot.classList.add('robot-emote')` for 600 ms).
3. `switchSessionCharacter(sessionId, modelName)` — replaces inner HTML with new template, sets `perSession: true` flag to skip global model switches.
4. `switchAllCharacters(modelName)` — updates all characters without per-session overrides (called when global setting changes).
5. `markChecked(sessionId)` — sets `data-checked="true"` to stop the waiting bounce.
6. `removeRobot(sessionId)` — removes DOM element and map entry.

### Per-Session Override

Each session card has a character model selector in the detail panel header (`#detail-char-model`). Choosing a model sets `perSession: true` on the robot data object and persists the choice to both IndexedDB (`sessions` store, `characterModel` field) and the server.

---

## 16. Session Cards (`sessionCard.js`)

### Card DOM Structure

```html
<div class="session-card" data-session-id="..." data-status="..." draggable="true">
  <button class="close-btn">×</button>
  <button class="pin-btn">▲</button>
  <button class="summarize-card-btn">↓AI</button>
  <button class="mute-btn">♫</button>
  <button class="resume-card-btn hidden">▶ RESUME</button>
  <div class="robot-viewport"><!-- CSS character injected here --></div>
  <div class="card-info">
    <div class="card-title"><!-- editable title --></div>
    <div class="card-header">
      <span class="project-name"></span>
      <span class="card-label-badge"></span>
      <span class="card-group-badge">+</span>
      <span class="source-badge"></span>
      <span class="status-badge"></span>
    </div>
    <div class="waiting-banner">NEEDS YOUR INPUT</div>
    <div class="card-prompt"></div>
    <div class="card-stats">
      <span class="duration"></span>
      <span class="tool-count"></span>
      <span class="subagent-count"></span>
      <span class="queue-count"></span>
    </div>
    <div class="tool-bars"><!-- top-5 tool bars --></div>
  </div>
</div>
```

### Debounced DOM Updates

| Parameter | Value |
|-----------|-------|
| Debounce delay for subsequent updates | `100 ms` |
| Initial card creation | No debounce (immediate) |

`pendingCardUpdates` map tracks pending timers. Only the latest update within the window is applied.

### Status Display

| Session Status | Badge Text | CSS class |
|---------------|-----------|-----------|
| `idle` | `IDLE` | `.idle` |
| `prompting` | `PROMPTING` | `.prompting` |
| `working` | `WORKING` | `.working` |
| `approval` | `APPROVAL NEEDED` | `.approval` |
| `input` | `WAITING FOR INPUT` | `.input` |
| `waiting` | `WAITING` | `.waiting` |
| `ended` | `DISCONNECTED` | `.disconnected` |

Active-status cards (`working`, `prompting`, `approval`, `input`) automatically float to the top of their grid section (ahead of unpinned cards) when their status transitions.

### Pinned Sessions

- Persisted in `localStorage['pinned-sessions']` (JSON array of session IDs).
- `pinSession(sessionId)` / unpin toggle on pin button click.
- `reorderPinnedCards()` re-inserts pinned cards at the start of their containing grid.
- CSS class `pinned` applied to card; pin button gets class `active`.

### Muted Sessions

- Persisted in `localStorage['muted-sessions']` (JSON array).
- Global mute via `toggleMuteAll()` — sets `globalMuted` flag; affects sound playback.
- Per-session mute toggle on the `♫` button: adds/removes `muted` class, updates icon to `M`.
- `isMuted(sessionId)` returns `true` if globally muted or session is individually muted.

### Tool Bars

Top 5 tools rendered as horizontal fill bars:
- Bar width: `(count / maxCount) * 100%`
- Bars sorted by count descending
- Maximum bars shown: `5`

### Toast Notifications

`showToast(title, message)`:
- Auto-dismiss after `5000 ms`
- Fade-out animation: `300 ms`
- Error/failed toasts (matching `/error|failed/i`) always shown regardless of `toastEnabled` setting
- Close button dismisses immediately

### Label Badges

| Label Value | CSS modifier on card |
|-------------|---------------------|
| `HEAVY` | `.heavy-session` |
| `ONEOFF` | `.oneoff-session` |
| `IMPORTANT` | `.important-session` |

Label-specific decorative frames are applied via `data-frame` attribute if configured in label settings.

### Source Badges

Displayed when session source is not `ssh`:

| Source key | Display text |
|-----------|-------------|
| `vscode` | VS Code |
| `jetbrains` | JetBrains |
| `iterm` | iTerm |
| `warp` | Warp |
| `kitty` | Kitty |
| `ghostty` | Ghostty |
| `alacritty` | Alacritty |
| `wezterm` | WezTerm |
| `hyper` | Hyper |
| `terminal` | Terminal |
| `tmux` | tmux |

### Prompt Preview

Truncated at `120 characters` with `...` suffix. Shows `currentPrompt` or latest prompt history entry.

### Drag-and-Drop Reordering

- Cards are `draggable="true"` (except display-only source cards).
- During drag, card gets class `dragging`.
- Drop target shows `drag-over-left` or `drag-over-right` class based on mouse X position relative to card midpoint.
- Dropping onto a group grid auto-assigns the session to that group.

### Inline Title Rename

Clicking `.card-title` makes it `contentEditable`. Saving: `blur` or `Enter`. Cancelling: `Escape` restores original. Title saved to server via `PUT /api/sessions/:id/title` and persisted to IndexedDB.

### Card-Level Summarize & Archive

The `↓AI` button on each card:
1. Fetches session detail from IndexedDB.
2. Builds prompt context (prompts, tool calls, responses).
3. Loads default summary template from `summaryPrompts` store.
4. POSTs to `POST /api/sessions/:id/summarize`.
5. On success: marks session `archived: 1`, updates IndexedDB, shows toast.

### Resume Button

Visible only when `status === 'ended'`. Calls `POST /api/sessions/:id/resume`. On success, opens detail panel Terminal tab.

---

## 17. Session Detail Panel (`detailPanel.js`)

### Panel Structure

The panel slides in from the right, overlaid on top of the main grid. Triggered by clicking a session card.

**Header fields:**
- Project name (`#detail-project-name`)
- Status badge (`#detail-status-badge`) — same text mapping as card badges
- Model name (`#detail-model`)
- Duration (`#detail-duration`)
- Character mini-preview (`#detail-char-preview`) — live CSS character at current status
- Character model selector (`#detail-char-model`) — dropdown with all 20 models
- Session title input (`#detail-title`)
- Session label input (`#detail-label`) with datalist suggestions

### Tabs (6 total)

| Tab `data-tab` | Content | Container ID |
|----------------|---------|-------------|
| `conversation` | Prompt history (newest first), previous sessions (collapsible) | `#detail-conversation` |
| `activity` | Merged tool calls + events + responses (newest first) | `#detail-activity-log` |
| `terminal` | xterm.js terminal embed | `#tab-terminal` |
| `notes` | Session notes with timestamps | `#tab-notes` |
| `queue` | Prompt queue with compose textarea | `#tab-queue` |
| `summary` | AI-generated summary text | `#tab-summary` |

Tab state persisted in `localStorage['active-tab']` and restored on page refresh.

### Conversation Tab Features

- Each prompt entry: numbered `#N`, timestamp, COPY button
- COPY button writes prompt text to clipboard; temporarily shows `COPIED` for `1500 ms`
- Previous session sections (from `session.previousSessions[]`) rendered as collapsible accordions with headers showing session number, time range, and prompt count
- Toggle: click `.prev-session-header` to expand/collapse `.prev-session-section.collapsed`

### Activity Tab

Entries merged from `session.events[]`, `session.toolLog[]`, `session.responseLog[]`, sorted newest-first:

| Entry kind | CSS class | Badge text |
|-----------|-----------|------------|
| Tool call | `.activity-tool` | Tool name |
| Response | `.activity-response` | `RESPONSE` |
| Event | `.activity-event` | Event type |

### Terminal Tab

- Auto-attaches to `session.terminalId` when Terminal tab is selected.
- `refitTerminal()` called on tab switch to recalculate xterm dimensions.
- RECONNECT button (`#terminal-reconnect-btn`): visible when `session.terminalId || session.lastTerminalId || session.status === 'ended'`.
  - If active terminal: sends `claude --resume <id> || claude --continue` via WebSocket.
  - If no active terminal: calls `POST /api/sessions/:id/resume` to create new PTY.

### Panel Resize

Drag handle (`#detail-resize-handle`) on the left edge:
- Min width: `320 px`
- Max width: `95 vw`
- Width persisted in `localStorage['detail-panel-width']`
- Adds `.resizing` class to panel during drag

### Selection Persistence

- Selection saved to `localStorage['selected-session']` on select.
- `restoreSelection()` called after WebSocket snapshot arrives: restores both selected session and active tab.

### History View Mode (`openSessionDetailFromHistory`)

Opens the detail panel from the History panel using IndexedDB data (not live session state). Renders all conversation types (user, tool, claude) and activity log. Does not show Queue or Notes tabs controls that require a live session.

### Live Search Integration

`/` key or clicking the search bar (`#live-search`) filters visible cards:
- Cards not matching query get class `filtered` (hidden via CSS).
- Match criteria: `projectName`, `cardTitle`, `promptHistory[].text`, `responseLog[].text`.
- When a session is selected, matching entries in Conversation and Activity tabs get class `search-highlight` (CSS highlight), and the tab containing the first match is automatically activated; the matching entry is scrolled into view.

---

## 18. Session Controls (`sessionControls.js`)

All control buttons are in the detail panel header/footer area. Button IDs prefixed `ctrl-`.

### Resume (`#ctrl-resume`)

- Visible only when `session.status === 'ended'`.
- Calls `POST /api/sessions/:id/resume`.
- On success: shows toast, switches to Terminal tab.
- Button text cycles: `RESUME` → `RESUMING...` → `RESUME`.

### Kill (`#ctrl-kill`)

- Opens confirmation modal (`#kill-modal`).
- Modal message: `Kill session for "<projectName>"? This will terminate the Claude process (SIGTERM → SIGKILL).`
- Confirmed: `POST /api/sessions/:id/kill` with body `{ confirm: true }`.
- On success: deletes associated terminal via `DELETE /api/terminals/:terminalId`, deselects session, plays `kill` sound.
- Reports `data.pid` in success toast.

### Archive (`#ctrl-archive`)

- Sets `status: 'ended'`, `archived: 1`, `endedAt: Date.now()` in IndexedDB.
- Calls `DELETE /api/sessions/:id` to remove from server.
- Deselects session, removes card, dispatches `card-dismissed` event.
- Toast: `ARCHIVED — Session moved to history`.

### Permanent Delete (`#ctrl-delete`)

- Shows `confirm()` dialog: `Permanently delete session "<label>"? This cannot be undone.`
- Calls `DELETE /api/sessions/:id` + `db.del('sessions', id)`.
- No cascade delete via IndexedDB `deleteSession()` (only the top-level session record is explicitly deleted here).

### Summarize (`#ctrl-summarize`)

Opens the summarize modal with a 5-template list. Workflow:

1. User selects a template (default auto-selected).
2. Clicks **RUN SUMMARIZE**.
3. System assembles context: project info + prompts (ISO timestamps) + tool calls + responses.
4. `POST /api/sessions/:id/summarize` with `{ context, promptTemplate }`.
5. On success: updates Summary tab, auto-switches to Summary tab, marks session `archived: 1`.
6. Button text: `SUMMARIZE` → `SUMMARIZING...` → `RE-SUMMARIZE`.

#### Summary Template CRUD

| Action | UI element |
|--------|------------|
| Select | Click template row (highlighted selected) |
| Set default | Star (★) button; clears previous default |
| Edit | Pencil (✎) button; fills form below list |
| Delete | × button; removes from IndexedDB |
| Create new | **+ CUSTOM PROMPT** button; shows name + textarea form |
| Save template | **SAVE AS TEMPLATE** button |
| Use once | **USE ONCE** button; runs without saving |

Template preview shows first `150 characters` of the prompt text.

### Alert (`#ctrl-alert`)

Sets a duration alert for the selected session:
- Input: minutes (integer ≥ 1)
- Stored in `alerts` store: `{ sessionId, thresholdMs: minutes * 60000, triggerAt: now + thresholdMs }`
- Toast: `ALERT SET — Will alert after N minutes`

### Notes (`#tab-notes`)

- **Save Note** button (`#save-note`): POSTs to `POST /api/db/sessions/:id/notes`.
- Notes list refreshed via `GET /api/db/sessions/:id/notes` on every panel open.
- Each note shows timestamp + DELETE button.
- DELETE: `DELETE /api/db/notes/:noteId` then refreshes list.

### Title (`#detail-title`)

- Saves on `blur` or `Enter`.
- Syncs to server via `PUT /api/sessions/:id/title`.
- Persists to IndexedDB `sessions` store.
- Mirrors update to card `.card-title` in DOM.

### Label (`#detail-label`)

- Text input with datalist suggestions from `localStorage['sessionLabels']` (up to 30 recent labels).
- Saves on `blur` or `Enter` via `PUT /api/sessions/:id/label`.
- Persists to IndexedDB.
- Mirrors update to `.card-label-badge` on card.
- Saved labels are stored MRU in `localStorage['sessionLabels']` (max 30).

#### Label Quick-Select Chips

Three built-in label chips always visible:

| Label | Icon | Color |
|-------|------|-------|
| `ONEOFF` | 🔥 | `#ff9100` |
| `HEAVY` | ★ | `#ff3355` |
| `IMPORTANT` | ⚠ | `#aa66ff` |

Plus up to 5 custom labels from `localStorage['sessionLabels']`. Clicking a chip toggles the label (click same chip again to clear). Active chip shows colored border + background.

### Group Select (`#detail-group-select`)

Dropdown with all defined groups + `No group` + `+ New Group` option. `+ New Group` triggers `prompt()` for name, creates group, and immediately moves session card into it.

---

## 19. Quick Actions (`quickActions.js`)

### Action Bar Buttons

| Element ID | Label | Behavior |
|-----------|-------|----------|
| `#qa-new-session` | + NEW SESSION | Opens full New Session modal |
| `#qa-quick-session` | QUICK SESSION | Opens Quick Session modal with no preset label |
| `#qa-oneoff` | ONEOFF | Opens Quick Session modal with label `ONEOFF` |
| `#qa-heavy` | HEAVY | Opens Quick Session modal with label `HEAVY` |
| `#qa-important` | IMPORTANT | Opens Quick Session modal with label `IMPORTANT` |
| `#qa-mute-all` | MUTE ALL | Toggles global mute; button text toggles |
| `#qa-archive-ended` | ARCHIVE ENDED | Archives all ended sessions |
| `#qa-new-group` | NEW GROUP | Creates a new session group |

### New Session Modal (`#new-session-modal`)

Full SSH connection form:

| Field | Default | Notes |
|-------|---------|-------|
| Host | `window.location.hostname` | Pre-filled from browser URL |
| Port | `22` | — |
| Username | — | — |
| Auth method | `key` | Options: `key`, `password` |
| Private key | — | Loaded from `GET /api/ssh-keys` (lists `~/.ssh/` keys) |
| Password | — | Shown only when auth method = `password` |
| Working directory | — | Text input with history dropdown |
| Command preset | — | Options: `claude`, `codex`, `gemini`, `custom` |
| Custom command | — | Shown only when preset = `custom` |
| API key | — | Auto-filled from settings for chosen CLI |
| Terminal theme | `auto` (from settings) | — |
| Session title | — | Optional |
| Session label | — | Datalist with saved labels |

**Session mode buttons:**

| Mode | Behavior |
|------|----------|
| New Session | Default; starts a fresh shell |
| tmux-wrap | Wraps command in a new tmux window |
| tmux-attach | Lists existing tmux sessions; allows attach |

tmux session list shows: name, window count, attached/detached state, age (e.g., `5m ago`).

**Connect & Launch** button calls `POST /api/terminals`. On success: saves session config to `localStorage['lastSession']`, saves working directory to history, sets terminal theme, shows toast.

**Special label behaviors:**
- `HEAVY` or `IMPORTANT` sessions: auto-pinned via `pinSession()` after 500 ms.
- Toast messages differ per label: `HEAVY SESSION — High-priority session launched & pinned`, `ONEOFF SESSION — One-off session launched`.

### Quick Session Modal (`#quick-session-modal`)

Abbreviated form that reuses `localStorage['lastSession']` connection config:

| Field | Notes |
|-------|-------|
| Label | Pre-filled from button (ONEOFF/HEAVY/IMPORTANT) or empty |
| Session title | Optional custom title |
| Working directory | Defaults to last-used working dir |

Requires saved session config (from previous New Session). Shows error toast if no config saved.

### Working Directory History

- Stored in `localStorage['workdir-history']` (max `20` entries, MRU order).
- Dropdown toggle button shows history items, each with a delete (×) icon.
- Closed by clicking outside `.workdir-input-wrapper`.

### Session Labels History

- Stored in `localStorage['sessionLabels']` (max `30` entries, MRU order).
- Label chips in Quick Session modal show saved labels with delete icons.
- Clicking a chip pre-fills the label input.

### Mobile FAB (`#mobile-qa-fab`)

A floating action button visible on small screens. Tapping opens `#mobile-qa-panel` with all quick action items mirroring desktop buttons. Overlay (`#mobile-qa-overlay`) dismisses the panel on click.

---

## 20. Prompt Queue (`promptQueue.js`)

### Per-Session Queue (in Detail Panel Queue Tab)

The queue tab (`#tab-queue`) shows prompts staged for the selected session.

**Queue item DOM:**
```html
<div class="queue-item" draggable="true" data-queue-id="...">
  <span class="queue-pos">1</span>
  <div class="queue-text">prompt text</div>
  <div class="queue-actions">
    <button class="queue-send">SEND</button>
    <button class="queue-expand">⤢</button>
    <button class="queue-edit">EDIT</button>
    <button class="queue-move">MOVE</button>
    <button class="queue-delete">DEL</button>
  </div>
</div>
```

Count badge (`#terminal-queue-count`) shows `(N)` when queue is non-empty.

### Item Actions

| Button | Behavior |
|--------|----------|
| SEND | Sends text to active terminal via WebSocket (`terminal_input`), deletes from IndexedDB, refreshes queue |
| EXPAND (⤢) | Opens full-screen edit modal (`#queue-expand-modal`) for multi-line editing |
| EDIT | Replaces `.queue-text` with inline `<textarea>`; SAVE / Enter/Escape |
| MOVE | Enters **Move Mode** (see below) |
| DEL | Removes item from IndexedDB, refreshes queue |

### Drag-to-Reorder

Queue items are draggable within the list. On `dragend`, all visible item IDs are collected in DOM order and `reorderQueue(sessionId, orderedIds)` is called to persist positions.

**Drag-to-Terminal:** Queue items can be dragged and dropped onto `#terminal-container`. On drop, sends text to terminal and removes item from queue.

### Add to Queue

`#queue-add-btn` reads `#queue-textarea`, trims text, calls `db.addToQueue(sessionId, text)`, refreshes queue, syncs count to server via WebSocket `update_queue_count`.

### Auto-Send

When `autoSendQueue` setting is `'true'`, `tryAutoSend(sessionId, terminalId)` sends the first queue item to the terminal automatically when the terminal tab is focused with an active connection.

### Keyboard Shortcut

`Ctrl+Enter` (or `Cmd+Enter`): sends the first queued prompt to the terminal and removes it from the queue.

### Move Mode

`enterQueueMoveMode(itemIds, sourceSessionId)`:
- Deselects current session.
- Shows `#move-mode-banner` with text: `Click a session to move N prompt(s)`.
- Adds `.move-mode` class to `<body>`.
- Cards: source gets `.move-source`, all others get `.move-target`.
- Clicking a target card calls `completeQueueMove(targetSessionId)` → `db.moveQueueItems(itemIds, targetSessionId)`.
- Move mode cancelled via **CANCEL** button (`#move-mode-cancel`).
- **MOVE ALL** button (`#queue-move-all-btn`) moves all items at once.

### Global Queue View (Queue Panel / separate route)

`renderQueueView()`:
- Loads all `promptQueue` store records.
- Groups by `sessionId`, displays in a table per session.
- Columns: `#`, `ID`, `Text`, `Position`, `Created`, Delete button.
- Stats bar: `N items across M sessions`.
- **EXPORT** button downloads all items as `prompt-queue-<timestamp>.json`.
- **REFRESH** button reloads from IndexedDB.

---

## 21. Session Groups (`sessionGroups.js`)

### Default Groups (seeded on first launch)

| Name | Order |
|------|-------|
| Priority | 0 |
| Active | 1 |
| Background | 2 |
| Review | 3 |

Seeding is guarded by `localStorage['groups-seeded']` flag. Groups are persisted in `localStorage['session-groups']` as JSON array.

### Group Record Schema

```json
{
  "id": "grp-<timestamp>",
  "name": "Active",
  "sessionIds": ["session-id-1", "session-id-2"],
  "order": 1,
  "colSpan": 6
}
```

### CSS Grid Layout (12-Column System)

Groups container (`#groups-container`) uses CSS Grid with 12 equal columns. Each group occupies `colSpan` columns (1–12, min `3`). The `gridColumn: 'span N'` style is applied to each group element.

### Layout Presets (5 options)

| Preset key | Label | Column spans |
|------------|-------|-------------|
| `1-col` | 1 Column | `[12]` |
| `2-col` | 2 Columns | `[6, 6]` |
| `3-col` | 3 Columns | `[4, 4, 4]` |
| `1-3-2-3` | 1/3 + 2/3 | `[4, 8]` |
| `2-3-1-3` | 2/3 + 1/3 | `[8, 4]` |

Each preset button in the layout bar shows an SVG icon visualizing the column proportions. Active preset is highlighted. Saved to `localStorage['dashboard-layout']` as `{ preset, columns: 12 }`.

### Group Resize Handles

Each group element has a `.group-resize-handle` div at the right edge. Mouse drag:
- `startColSpan` captured on mousedown.
- `deltaColSpan = Math.round(dx / (containerWidth / 12))`.
- New span clamped to `[3, 12]`.
- On mouseup: saves to `localStorage`, sets preset to `'custom'`.

### Group CRUD

| Operation | Trigger |
|-----------|---------|
| Create | `#qa-new-group` button; `createGroup(name)` |
| Rename | Double-click `.group-name` → contentEditable |
| Delete | × button → `deleteGroup(groupId)` → cards moved to `#sessions-grid` |
| Reorder | Drag `.group-header` to another group |

Group drag uses MIME type `application/group-id` to distinguish from card drags. Drop shows `group-drop-left` / `group-drop-right` indicator.

### Session Assignment

- **Drag card into group grid**: calls `addSessionToGroup(groupId, sessionId)`.
- **Drag card to `#sessions-grid`**: calls `removeSessionFromGroup(sessionId)`.
- **Group badge on card**: click → context dropdown with all groups + `Remove from group` + `+ New Group`.
- **Detail panel group select**: `#detail-group-select` dropdown.
- **Auto-assign**: new cards are placed in `localStorage['last-used-group']` automatically.

### Group Badge on Cards

`updateCardGroupBadge(sessionId)`:
- Shows group name (truncated to 10 chars + `..` if longer) with class `.has-group`.
- Shows `+` with no group class if session is ungrouped.
- Click opens context dropdown.

### Group Assign Toast

Shown for new sessions (max 3 simultaneous, no duplicates):
- Session title + group select dropdown + `+ New Group` option + `SKIP` button.
- Auto-dismisses after `15000 ms`.

### Auto-Scroll During Drag

When dragging near the top/bottom of `#view-live`, the panel scrolls at up to `12 px/frame` (proportional to distance from edge zone of `60 px`).

### Collapse/Expand

Clicking `.group-collapse` toggles `.collapsed` class on the group element and updates the icon `▼` / `▶`.

---

## 27. History Panel (`historyPanel.js`)

### Data Source

History panel fetches from the **server-side SQLite database** (not IndexedDB) via REST API:
- `GET /api/db/projects` — distinct projects for filter dropdown
- `GET /api/db/sessions?...` — paginated session list
- `GET /api/db/sessions/:id` — full session detail
- `DELETE /api/db/sessions/:id` — permanent delete

### Filter Controls

| Control | Type | Notes |
|---------|------|-------|
| Search input (`#search-input`) | Text | Debounced `300 ms`; filters on prompt text |
| Project filter (`#history-project-filter`) | Select | Populated from `GET /api/db/projects` |
| Status filter (`#history-status-filter`) | Select | Options include `archived` as special value |
| Date from (`#history-date-from`) | Date | Converted to ms timestamp; start of day |
| Date to (`#history-date-to`) | Date | Converted to ms timestamp; end of day (`23:59:59`) |
| Sort by (`#history-sort-by`) | Select | Maps: `date → started_at`, `duration → last_activity_at` |
| Sort direction (`#history-sort-dir`) | Toggle button | `DESC` / `ASC`; click to toggle |

Filter changes reset `currentPage` to `1`.

### Session Row Columns

| Column | Field |
|--------|-------|
| Title | `title` (empty if none) |
| Project | `project_name` |
| Date | `started_at` formatted as `MMM D, YYYY HH:MM` (24h) |
| Duration | `ended_at - started_at` or `now - started_at` |
| Status | Color-coded badge |
| Prompts | `total_prompts` count |
| Tools | `total_tool_calls` count |
| Branch | `git_branch` (currently empty) |
| Delete | × button |

### Pagination

- Page size: `50` records per page.
- Shows `Prev` / `Next` buttons and page numbers.
- Ellipsis (`...`) for gaps in page range (shows pages within ±2 of current).
- Page buttons disabled when at first/last page.

### Row Click → Detail View

Clicking a row (not the delete button) calls `openHistoryDetail(sessionId)`:
1. Fetches `GET /api/db/sessions/:id` for full data.
2. Populates the same detail panel overlay used for live sessions.
3. Conversation tab shows interleaved prompts + responses sorted by timestamp.
4. Activity tab shows merged tool calls + events.

### Delete

Calls `DELETE /api/db/sessions/:id`, fades row out over `300 ms`, removes from DOM. Re-queries if page becomes empty.

---

## 28. Analytics Panel (`analyticsPanel.js`)

### Data Sources

All analytics loaded in parallel via `Promise.all`:

| API endpoint | Section |
|-------------|---------|
| `GET /api/db/analytics/summary` | Summary stats |
| `GET /api/db/analytics/tools` | Tool usage |
| `GET /api/db/analytics/projects` | Active projects |
| `GET /api/db/analytics/heatmap` | Activity heatmap |

Duration trends section currently receives an empty array (server endpoint not yet implemented); shows "No duration data" placeholder.

### Section 1: Summary Stats Cards

Six summary stat cards rendered into `#analytics-summary`:

| Label | Field | Detail |
|-------|-------|--------|
| Total Sessions | `total_sessions` | "all time" |
| Total Prompts | `total_prompts` | "all time" |
| Total Tool Calls | `total_tool_calls` | "all time" |
| Avg Duration | `avg_duration` (ms) | "per session" |
| Most Used Tool | `most_used_tool.tool_name` | count calls |
| Busiest Project | `busiest_project.name` | N sessions |

### Section 2: Tool Usage Chart (horizontal bar chart, SVG)

Container: `#tool-usage-chart`. Custom SVG chart:

| Property | Value |
|----------|-------|
| Max tools shown | `15` |
| Bar height | `20 px` |
| Gap between bars | `4 px` |
| Label column width | `120 px` |
| Value column width | `90 px` |
| Bar color | `#00e5ff` (cyan), opacity `0.85` → `1.0` on hover |
| Value display | `count (percentage%)` |

Hover tooltip shows: `ToolName: N (X%)`.

### Section 3: Duration Trends (line chart, SVG)

Container: `#duration-trends-chart`. Line chart with area fill:

| Property | Value |
|----------|-------|
| Chart height | `250 px` |
| Padding left | `55 px` |
| Padding bottom | `30 px` |
| Y-axis ticks | 5 (every 25% of max) |
| Y-axis labels | Formatted as `Xh Ym` / `Xm Ys` / `Xs` |
| X-axis label density | Every `max(1, floor(N/10))` buckets |
| Line color | `#00e5ff` |
| Area opacity | `0.1` |
| Dot radius | `3 px` |
| Date label format | `MMM D` (from `YYYY-MM-DD` buckets) |

Hover on dots shows: `Period: Duration`.

### Section 4: Active Projects (horizontal bar chart, SVG)

Container: `#active-projects-chart`:

| Property | Value |
|----------|-------|
| Bar height | `22 px` |
| Label column width | `130 px` |
| Value column width | `160 px` |
| Sort order | `session_count` descending |
| Bar color | `#00e5ff`, opacity `0.85` → `1.0` on hover |
| Value format | `N sessions | MMM D` (last active date) |

Hover tooltip shows: `ProjectName: N sessions, M prompts, P tools`.

### Section 5: Daily Activity Heatmap (CSS Grid)

Container: `#daily-heatmap-chart`. 7 rows (Mon–Sun) × 24 columns (hours):

| Property | Value |
|----------|-------|
| Cell size | `14 × 14 px` |
| Cell gap | `2 px` |
| Day label column | `40 px` |
| Color min (no activity) | `#12122a` |
| Color max (peak activity) | `#00ff88` |
| Day order | Monday-first (`0=Mon`, `6=Sun`) |
| Hour labels | `0`–`23` across top row |

Color interpolation: linear RGB blend between min and max by `value / maxValue`. Hover shows: `DayName HH:00 - N events`.

---

## 29. Timeline Panel (`timelinePanel.js`)

### Data Source

Timeline uses **IndexedDB** via `getTimeline()` from `browserDb.js` (not server API). Project filter dropdown is populated from server (`GET /api/db/projects`).

### Controls

| Control ID | Type | Default | Notes |
|-----------|------|---------|-------|
| `#timeline-granularity` | Select | `'day'` | Options: `hour`, `day`, `week`, `month` |
| `#timeline-project-filter` | Select | All projects | — |
| `#timeline-date-from` | Date | 30 days ago | Set on `init()` |
| `#timeline-date-to` | Date | Today | Set on `init()` |

All control changes trigger `loadTimeline()`.

### Chart: Grouped Bar Chart (SVG)

Container: `#timeline-chart`. Three bars per time bucket (grouped, not stacked):

| Series | Color |
|--------|-------|
| Sessions | `#00e5ff` (cyan) |
| Prompts | `#00ff88` (green) |
| Tool Calls | `#ff9800` (orange) |

| Property | Value |
|----------|-------|
| SVG height | `300 px` (320 px for hourly) |
| Padding left | `50 px` |
| Padding bottom | `50 px` (70 px for hourly) |
| Y-axis ticks | 5 (0%, 25%, 50%, 75%, 100% of max) |
| Y-axis labels | `formatNumber()` values |
| Bar min width | `2 px` |
| Bar gap within group | `1 px` |
| Bar opacity | `0.85` → `1.0` on hover |
| Corner radius | `2 px` |

X-axis label density:
- Hourly: max `12` labels
- Weekly: max `12` labels
- Daily: max `15` labels
- Rotation: applied when `groupCount > 10` or granularity = `hour`; labels rotated `-40°`

X-axis labels are formatted by `formatTimeLabel()`:
| Granularity | Format example |
|------------|---------------|
| `hour` | `Feb 10 14:00` |
| `day` | `Feb 10` |
| `week` | `Feb 10` (week start date) |
| `month` | `Feb` |

Legend: three colored squares at bottom (`Sessions`, `Prompts`, `Tool Calls`), spaced `100 px` apart.

Hover on any bar shows tooltip: `Series: value\nSessions: X | Prompts: Y | Tools: Z`.

---

## 30. Keyboard Shortcuts (`keyboardShortcuts.js`)

### All Shortcuts

| Key | Context | Action |
|-----|---------|--------|
| `/` | Any (not in input) | Focus `#live-search` |
| `?` | Any (not in input) | Toggle shortcuts help modal (`#shortcuts-modal`) |
| `S` / `s` | Any (not in input) | Toggle settings modal (`#settings-modal`) |
| `K` / `k` | Session selected | Click `#ctrl-kill` (open kill confirmation modal) |
| `A` / `a` | Session selected | Click `#ctrl-archive` |
| `T` / `t` | Any (not in input) | Show `#new-session-modal` |
| `M` / `m` | Any (not in input) | Click `#qa-mute-all` (toggle global mute) |
| `Escape` | Terminal tab active | Send escape character `\x1b` to SSH terminal (capture phase) |
| `Ctrl+Enter` / `Cmd+Enter` | Any | Send first queued prompt to terminal; remove from queue |

### Implementation Notes

- All shortcuts skip when `e.target` is `INPUT`, `TEXTAREA`, `SELECT`, or `contentEditable`.
- xterm textarea (`e.target.classList.contains('xterm-helper-textarea')`) is always bypassed.
- Modifier keys (`ctrlKey`, `metaKey`, `altKey`) suppress most shortcuts (except `Ctrl+Enter`/`Cmd+Enter`).
- Escape runs in **capture phase** (third `addEventListener` argument `true`) to intercept before xterm can handle it, ensuring single-Escape reliably sends `\x1b` to the remote shell.

### localStorage Keys Reference

All keys used across frontend modules:

| Key | Module | Contents |
|-----|--------|----------|
| `muted-sessions` | sessionCard | JSON array of muted session IDs |
| `pinned-sessions` | sessionCard | JSON array of pinned session IDs |
| `session-groups` | sessionGroups | JSON array of group objects |
| `sessionLabels` | sessionControls/quickActions | JSON array of recent labels (max 30) |
| `lastSession` | quickActions | JSON object with SSH connection config |
| `selected-session` | detailPanel | Session ID string |
| `active-tab` | detailPanel | Tab name string |
| `detail-panel-width` | detailPanel | CSS width string (e.g., `420px`) |
| `dashboard-layout` | sessionGroups | `{ preset, columns: 12 }` |
| `groups-seeded` | sessionGroups | `'1'` flag |
| `workdir-history` | quickActions | JSON array of working dirs (max 20) |
| `last-used-group` | sessionGroups | Group ID string |
| `debug` | utils | `'true'` to enable debug logging |
