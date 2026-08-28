# REST API Router

## Function
Provides all HTTP REST API endpoints for session management, terminal creation, file browsing, notes, hooks, and admin operations.

## Purpose
The HTTP interface for the React frontend and external integrations. Handles all CRUD operations not covered by WebSocket.

## Source Files
| File | Role |
|------|------|
| `server/apiRouter.ts` (~3168 lines, largest server file) | All REST endpoints |
| `server/constants.ts` | Hook event/density constants (`ALL_CLAUDE_HOOK_EVENTS`, `CODEX_HOOK_EVENTS`, `DENSITY_EVENTS`, `CODEX_DENSITY_EVENTS`, `SESSION_STATUS`, `WS_TYPES`) used by hook status/install and broadcast endpoints |
| `server/index.ts` | Auth endpoints (`/api/auth/*`) and middleware wiring (localhost-only for hooks, authMiddleware for everything else under /api) |
| `server/hookRouter.ts` | POST /api/hooks (HTTP-fallback hook ingestion) — delegates to `processHookEvent` |
| `server/presenceManager.ts` | Device registry, workspace-restore claim, per-session control batons, workspace-writer election — the source of the `clear-all` / `workspace/save` guards and of every `/presence/*` route. See [Multi-Device Presence](./multi-device-presence.md) |
| `test/workspaceRestoreClaim.test.ts` | Endpoint-level coverage for the restore claim (grant/deny/release, unidentified caller) and the `clear-all` 409 guard (anonymous caller, known-but-not-holder, owner, cold start) |
| `server/floatingSessionSpawner.ts` | Implementation of POST /api/sessions/spawn-floating (fork/translate/explain spawn); prompt synthesis + labels live in `server/floatingPrompt.ts` |
| `server/sessionKillPolicy.ts`, `test/sessionKillPolicy.test.ts` | Pure Codex shared-host PID detection used by per-card kill, with regression coverage |
| `server/extractPreviousAnswer.ts` | Helpers `readClaudeTranscript` (CONVERSATION tab) and `readClaudeLastAssistant` (translate-answer mode) |
| `server/commandIndex.ts` | Slash-command/skill enumeration behind GET /api/commands (30s cache per cli+projectPath); Codex skills resolved via `$CODEX_HOME` |
| `server/codexModelCatalog.ts`, `test/codexModelCatalog.test.ts` | Official Codex app-server `model/list` client, normalization, cache/fallback, and regression coverage for GET /api/codex/models |
| `src/types/api.ts` | Shared API response/request types, including per-CLI hook status and `enabledClis` install body |
| `test/buildResumeCommand.test.ts` | Pure Claude/Codex resume-command and model/effort persistence coverage (database mocked to avoid native-ABI coupling) |

## Implementation

### Device Identity (multi-device)
Three helpers near the top of the router answer "who is asking?" for every guarded route — see [Multi-Device Presence](./multi-device-presence.md):

- `clientIdFromRequest(req)` — reads the `x-aasc-client-id` header, sliced to **128 chars**. The browser stamps it on every same-origin `fetch` via a single global patch, so no call site has to remember it.
- `clientLabelFromRequest(req)` — reads `x-aasc-client-label` through `presence.sanitizeDeviceLabel()` (control characters stripped, whitespace collapsed, 60-char cap), because the label is attacker-controlled text that gets logged and rendered.
- `liveSessionCount()` — `Object.keys(getAllSessions()).length`, i.e. what a destructive call would destroy.

**An unstamped request reads as `''` — anonymous, not trusted.** curl, an older client, or a hook still works: an anonymous caller may act on a **free** session (`canControl` allows an unclaimed one), but it can never take a session from a named device and can never be granted the workspace restore (`/workspace/restore-claim` 400s without an id).

### Auth Endpoints (no auth required, defined in `server/index.ts`, not apiRouter.ts)
- GET /api/auth/status
- POST /api/auth/login
- POST /api/auth/refresh (token refresh, returns new token)
- POST /api/auth/logout

### Hook Ingestion (no auth, rate limited 100/sec)
- POST /api/hooks

### Session Endpoints
- GET /api/sessions
- GET /api/sessions/:id/source
- GET /api/sessions/:id/transcript — full interleaved Claude JSONL transcript (user/assistant/tool_use/tool_result entries) via `readClaudeTranscript`, for the [Conversation tab](../frontend/conversation-view.md). Never 500s: returns `{ success: true, data: [] }` on a missing session/transcript so the client falls back to in-memory logs.
- GET /api/sessions/history (paginated session history with status filter)
- PUT /api/sessions/:id/title|remark|accent-color|character-model|pinned|muted|alerted
- POST /api/sessions/:id/kill|resume|summarize|fork|clone
  - `clone` creates a new terminal that re-runs the source session's `startupCommand` with session-specific flags stripped (`--resume`/`--continue`/`--fork-session` removed via `stripClaudeSessionFlags`), name stripped, then permission flags + model/effort re-applied. Distinct from `fork` — clone starts a fresh CLI session, fork resumes the existing one. Both run via `createTerminalSession({ isFork: true, originSessionId })` — `isFork` only (kill-guard), NOT `isFloating`, so clone/fork sessions appear in the session lists like any other agent (only floating PiP popups set `isFloating` and are hidden).
  - `resume` rebuilds the launch command via `buildResumeCommand`: Claude uses `claude --resume '<SESSION_ID>' || <fresh claude>`; Codex uses `codex resume '<SESSION_ID>' || <fresh codex>`. Non-UUID IDs (synthetic `term-*` etc.) use only the fresh form. Both CLIs reapply the stored model; Claude also reapplies effort. The fallback deliberately never resumes an unrelated "last" conversation.
    - **The `|| <baseCmd>` fallback duplicates the ENTIRE launch command**, which is what makes resume commands so long: a realistic `claude --model opus --effort max --dangerously-skip-permissions -n "…" --resume '<uuid>' || …` is **216 characters, 38% of it a verbatim copy**. The PTY is 120 columns, so it wraps onto a second line and renders as garbled, seemingly-duplicated text in the terminal.
    - `resumeIsCertain(session, sessionId)` (Claude branch only) drops the fallback when it is provably unreachable — i.e. `resolveResumableClaudeSessionId` finds the transcript on local disk. It is deliberately one-directional: **remote sessions are excluded** (a local `existsSync` says nothing about another host's transcript) and a **negative** answer KEEPS the fallback, because the encoded-project-dir lookup could be wrong and silently losing a resumable session is the worse error. Only a positive, file-on-disk answer shortens the command (216 → 134 chars, one line). Covered by `test/buildResumeCommand.test.ts`.
  - `fork` rebuilds the launch command via `buildForkCommand`: Claude uses `claude --resume '<SESSION_ID>' --fork-session` (or `--continue --fork-session`); Codex uses `codex fork '<SESSION_ID>'` (or `codex fork --last`). Claude permission/model/effort and the Codex model are preserved via `reconstructPermissionFlags` + `applyClaudeLaunchFlags`; the new Claude fork gets its own `-n "<newTitle>"`.
  - `summarize` pipes the transcript to `claude -p --model haiku` (60s timeout, 1MB buffer); rate-limited to `MAX_CONCURRENT_SUMMARIZE = 2`. Prompt precedence: `custom_prompt` > `promptTemplate` > default. See [Summary Tab](../frontend/summary-tab.md).
  - `kill` cascade: resolves the requested ID through the full session-alias chain, validates the cached PID, then SIGTERMs/SIGKILLs only an isolated process. Forks bypass cwd PID lookup, and Codex refuses ambiguous process scans when no live cached PID exists. If other live Codex cards share the selected PID, the endpoint never signals that host: it closes the selected managed PTY instead (`processShared: true`), or returns 409 with `sharedProcessPid`/`sharedSessionIds` when the card has no managed terminal and therefore cannot be killed individually. The success response includes canonical `sessionId` and pre-kill `terminalId`; the renderer uses that terminal rather than a stale card's old ID, and Electron `pty-*` ownership is closed through IPC. A stale-ID request also broadcasts the ended canonical session with `replacesId` so every browser removes the ghost card.
- POST /api/sessions/spawn-floating — spawn a forked/floating session (`isFork: true` + `isFloating: true` — hidden from session lists, rendered as a PiP panel) pre-loaded with a synthesized translate / explain / vocab / custom prompt; see [Floating Session Spawner](./floating-session-spawner.md).
  - Body schema: required `originSessionId` (1–200), `mode` (one of 8: `explain-learning`, `explain-native`, `vocab-native`, `translate-selection-learning`, `translate-selection-native`, `translate-answer`, `translate-file`, `custom`), `nativeLanguage` (1–64), `learningLanguage` (1–64). Optional `spawnTerminalId` (≤200, enables recursive fork from a floating terminal), `selection` (≤64KB), `contextLine` (≤2KB), `fileContent` (≤256KB), `filePath` (≤2KB), `customPrompt` (≤64KB, for `custom` mode), `inheritContext: boolean` (default true — fork inherits parent context only when the parent already has a conversation), `model` (≤200, SelectionPopup's quick-settings override — blank/absent inherits the origin session's own model), `effortLevel` (≤32, Claude-only override — blank/absent inherits the origin's own effort). Real allow-list validation for both happens downstream in `sanitizeModelId`/`FLAG_EFFORT_LEVELS` (`config.ts`), not in the Zod schema.
- POST /api/sessions/:id/reconnect-terminal|reconnect-ops-terminal
- POST /api/sessions/clear-all (removes all sessions, captures terminal output for replay; accepts JSON body `{ suppressBroadcast?: boolean }` — when `true`, skips the `clearBrowserDb` ws-broadcast so the workspace-import flow can rebuild without racing against the wipe). Registered before parameterized `/sessions/:id` routes so "clear-all" isn't matched as a session ID.
  - **Guarded: 409 `{ ok: false, error: 'workspace-in-use', liveSessions, by }`** unless the caller holds the workspace-restore claim, or zero sessions are live (a cold server has nothing to lose). `by` is the owning device's label, or `null` when nobody holds the claim.
  - Its **only production caller is `importSnapshot`** — the opening move of a workspace restore. Any *other* caller reaching it while sessions are live is the bug this guard exists for: a second device running `useWorkspaceAutoLoad` kills every PTY and rebuilds the workspace the first device is actively using.
  - **The check keys off the CLAIM, not "is this device known"** — a stale or hostile client only has to send *a* client-id to be known. Only the single device the server granted the restore to may destroy state. See [Multi-Device Presence](./multi-device-presence.md).
- GET /api/sessions/resume-command?path=<projectPath> — returns `{ sessionId, resumeCommand }` for the most recent non-ended session at a path (prefers live in-memory session, falls back to DB). Server-side fallback for the `claude-last` shell function. 404s on `term-*` IDs / no resumable session.
- DELETE /api/sessions/:id — closes BOTH `session.terminalId` and `session.opsTerminalId` before removing the card; the ops shell is a login shell that never exits on its own, so skipping it leaks a live PTY that keeps consuming terminal budget.

### Terminal Endpoints
- POST /api/terminals (create; capacity-checked via `checkTerminalCapacity` — see Rate Limiting below. Body is validated FIRST so the check can reserve the ops shell too when `enableOpsTerminal` is set). `model` accepts a Claude alias/full ID or a Codex model ID — validated by regex `^[a-zA-Z0-9._-]+$` (max 100, shell-safe because the value is interpolated unquoted into `--model`). Claude receives model + effort; Codex receives model only.
  - **Claims the control baton for the creating device**: immediately after `createTerminalSession(...)` the handler calls `presence.noteControlActivity(terminalId, creatorClientId)` (skipped for an anonymous caller). `noteControlActivity` implicitly claims a *free* session, so **the device that launches a session controls it** with no extra round-trip, and a phone that connects later finds every session taken and is a spectator by default. The baton is keyed on `terminalId` because that IS the session id at creation; `migrateControl` carries it across the `term-*` → UUID re-key moments later, without which the launching device would be silently demoted on its own new session. See [Multi-Device Presence](./multi-device-presence.md).
  - **The raw `startupCommand` launch path normalizes `-n` too.** Workspace import may deliberately send `command: ''` plus `startupCommand: '<cmd>'` for launch strings carrying shell metacharacters; that string is then written verbatim into the PTY. It now goes through `buildStartupLaunchCommand(startupCommand, sessionTitle)` → `appendSessionName`, the same self-heal every other relaunch path already had (`buildResumeCommand`, and `createTerminal` for `config.command`). Without it this was the **one** path that could not repair a malformed stored name: a snapshot carrying a legacy unquoted `-n KTS Video` re-spawned it unrepaired on *every* restore, and `claude` parsed `Video` as a stray positional argument — i.e. an initial prompt nobody typed (26 live sessions were found in exactly that state, each with a `promptHistory` of `['Video']`). `appendSessionName` bails on non-`claude` commands, so the raw-shell case this branch exists to serve passes through untouched. Covered by `test/startupLaunchCommand.test.ts`.
- POST /api/terminals/register (Electron PTY registration). If a hook arrived first and already created a session owning that terminal ID, registration enriches/reuses the canonical session, returns its `sessionId`, and broadcasts `replacesId: terminalId` instead of creating a duplicate `pty-*` card.
- POST /api/terminals/:id/prefill-output (base64-encoded output replay — restores scrollback during workspace import)
- POST /api/terminals/:id/write (write string to PTY; max 50MB per call)
- GET /api/terminals (list all active terminals)
- GET /api/terminals/:id/output — snapshots the PTY ring buffer as base64 (via `getTerminalOutputBuffer`). Consumed by the REVIEW tab to capture floating-session output at close.
- DELETE /api/terminals/:id
- POST /api/config/terminal-buffer — sets the scrollback replay buffer size for newly created (WS/SSH) terminals. Body `{ bytes: number }` (Zod `z.number().finite()`); calls `setReplayBufferBytes()` which clamps to `[0.25 MB, 32 MB]` and returns `{ success: true, data: { bytes: <applied> } }`. Pushed by the browser from the `terminalReplayBufferBytes` setting (Settings ▸ ADVANCED ▸ Terminal, see [Settings System](../frontend/settings-system.md)); the Electron PTY host is configured separately over the `pty:set-replay-buffer` IPC channel. See [Terminal/SSH](./terminal-ssh.md).

### File Browser
- GET /api/files/list|read|stream|search|grep
- GET /api/files/search?root=<projectPath>&q=<query> — fuzzy file-name search backed by the cached fuzzy index (see [File Index Cache](./file-index-cache.md)). Rate limited to 20 requests/window/IP; `root` is required and validated via `isAllowedProjectRoot()`. Response shape `{ results: [{ path, name, type, score }], indexing }`. When `q` is empty/blank the endpoint returns `listTopEntries(root)` — the shallowest files/folders (directories first) plus the `indexing` flag — so the `@`-mention picker is useful before the user types (while the cache is still cold it returns `{ results: [], indexing: true }` and the client retries). A non-empty `q` runs `searchFiles(root, q.trim())` and returns the same shape.
- GET /api/files/resolve — expands `~`, resolves to an absolute path, classifies as file/dir, and returns suggested project root + relative path so the client can open it in the file browser. See [File Browser](../frontend/file-browser.md).
- POST /api/files/write|mkdir|delete
- POST /api/files/search/invalidate (clear search cache)
- POST /api/files/reveal (open in system file manager — `open -R` / `explorer /select,` / `xdg-open`)
- POST /api/files/open-external (open file with the OS default application — `open` / `cmd /c start "" <path>` / `xdg-open`; same `{ root, path }` body and validation as reveal, fire-and-forget `execFile`, errors only logged). Consumed by the [File-Open Chooser](../frontend/file-open-chooser.md).
- **Limits**: `MAX_FILE_SIZE = 10MB` (read/write JSON), `MAX_STREAMABLE_SIZE = 100MB` (PDF/Word/spreadsheet/image/video/audio streaming, with HTTP Range support for media; `STREAMABLE_EXTENSIONS` includes `.docx`/`.doc`, streamed as bytes for client-side mammoth rendering, plus `.xlsx`/`.xls`). Grep capped at `MAX_RESULTS = 500` (ripgrep, falling back to grep). All file paths validated via `isAllowedProjectRoot()` + `resolveProjectPath()` to block traversal.

### Slash Commands
- GET /api/commands?cli=<claude|codex>&projectPath=<absolute> — enumerates slash commands + skills (project + global + plugin sources) for the CLI, cached 30s per (cli, projectPath). Codex additionally reports skills from `$CODEX_HOME/skills`, `<project>/.codex/skills` and the preinstalled `.system/` tier; those are `$name`-invocable, not `/name`. Backs slash-command autocomplete in prompt inputs; see [Command Autocomplete](../frontend/command-autocomplete.md).

### Codex Model Catalog
- GET /api/codex/models — starts the locally installed `codex app-server` over JSONL stdio, performs the required `initialize`/`initialized` handshake, then calls stable `model/list` with `{ includeHidden: false, limit: 100 }`. The response is `{ models: [{ id, displayName, description, isDefault }], refreshedAt, source, stale }`; model order comes directly from Codex and IDs are filtered through `^[a-zA-Z0-9._-]+$` before reaching the renderer.
- The successful catalog is cached in memory for `CODEX_MODEL_CACHE_TTL_MS = 300000` (5 minutes), and concurrent refreshes are coalesced. Refresh timeout is `CODEX_MODEL_QUERY_TIMEOUT_MS = 8000`. If a refresh fails after a previous success, the route returns the last catalog with `source: 'stale-memory-cache'` and `stale: true`; with no cache it returns 503 `{ error: 'Codex model catalog unavailable' }`. `Cache-Control: no-store` prevents browser/proxy caching.
- On macOS/Linux the subprocess runs through the user's login shell so packaged Electron builds resolve the same Codex binary as an interactive terminal; Windows uses shell resolution for npm `.cmd` shims. No model names are hard-coded in the dashboard.

### Team Endpoints
- GET /api/teams/:id/config
- POST /api/teams/:id/members/:sid/terminal

### Hook Management
- GET /api/hooks/status — returns aggregate install state plus per-CLI detail under `clis.claude` and `clis.codex`. Codex status is read from `~/.codex/config.toml` lifecycle hook blocks and reports `legacyNotify: true` when an old dashboard `notify` line is still present.
- POST /api/hooks/install — accepts `{ density: 'high'|'medium'|'low', enabledClis?: ('claude'|'codex')[] }`, runs `hooks/install-hooks.js --density <density> --clis <enabledClis>`, and preserves the configured CLI set (`readEnabledClis()`) when the settings page reinstalls hooks.
- POST /api/hooks/uninstall

### DB/History
- GET /api/db/sessions (search/filter/paginate)
- GET /api/db/sessions/:id (full detail)
- GET /api/db/projects (distinct project list)
- GET /api/db/search (full-text search across prompts/responses)
- GET /api/db/prompts (global prompt trace — see below)
- DELETE /api/db/sessions/:id

### Prompt trace — GET /api/db/prompts
Global, paginated record of every prompt ever recorded. Backs the [PROMPTS view](../frontend/prompt-trace.md); a pure read over the `prompts` table `insertFullPrompt` already fills on every `UserPromptSubmit`.

| Param | Default | Clamp / validation |
|-------|---------|--------------------|
| `query` | — | LIKE `%…%`; `\ % _` escaped server-side (`ESCAPE '\'`) |
| `project` | — | matched against `sessions.project_path` |
| `session` | — | matched against `prompts.session_id` |
| `kind` | `mine` | one of `mine` / `cmd` / `agent` / `all`; anything else falls back to `mine` |
| `dateFrom`, `dateTo` | — | epoch ms |
| `sortDir` | `desc` | `asc` \| `desc` |
| `page` | 1 | 1…1000 |
| `pageSize` | 50 | 1…200 |

Response: `{ prompts: PromptTraceRow[], total, page, pageSize }` where the session columns (`project_name`, `project_path`, `session_title`) are **nullable** (LEFT JOIN). Rate-limited to **10 req/s per IP** (`db-prompts:<ip>`) — one notch above `/db/search`'s 5 because it is a browse endpoint (debounced typing + paging), and the text filter is an unindexable `LIKE '%…%'` scan. See [database.md](./database.md) for the facet SQL.

### Notes
- GET /api/db/sessions/:id/notes — returns a **bare array** of snake_case rows (`res.json(db.getNotes(id))`), *not* `{ notes: [...] }`. A client reading `data.notes` gets `undefined` and silently shows an empty list.
- POST /api/db/sessions/:id/notes — `{ text }`, capped at 50 000 chars (raised from 10 000 when notes became Markdown documents carrying media URLs). Echoes the inserted row.
- PUT /api/db/notes/:id — `{ text }`; bumps `updated_at`, returns the updated row, 404 when the id is unknown.
- DELETE /api/db/notes/:id — **by row id, not nested under the session.** A session-nested URL 404s.

### Note media
- POST /api/db/sessions/:id/note-media — `{ name, dataUrl }` → `{ id, url, mime, bytes }`. Base64 data URL only; MIME allowlist (PNG/JPEG/GIF/WebP/AVIF, MP4/WebM/MOV/OGV — **SVG deliberately excluded**, it can carry script and is served same-origin); decoded size capped at `MAX_MEDIA_BYTES` (25 MB). Bytes are written to `<data dir>/note-media/`, never into SQLite. See [Session Detail Panel → Note media](../frontend/session-detail-panel.md).
- GET /api/note-media/:id — serves the file via `res.sendFile` (Range support is what makes `<video>` seekable), with `X-Content-Type-Options: nosniff`. The `:id` is re-validated against `/^[a-f0-9]{32}$/` before any path is built.
- DELETE /api/db/sessions/:id now calls `deleteNoteMediaForSession` **before** `deleteSessionCascade` — once the notes are gone, the orphan sweep can't distinguish that media from a live upload.

### SSH/Tmux Helpers
- GET /api/ssh-keys (list available SSH keys)
- POST /api/tmux-sessions (list tmux sessions on a host)

### Workspace
- POST /api/workspace/save (save workspace snapshot — server-side dedup key uses 8 fields joined with `\0`: `[title, sshConfig.host, sshConfig.port, sshConfig.username, sshConfig.workingDir, sshConfig.command, startupCommand, originalSessionId]`. Including `originalSessionId` ensures sessions sharing the same SSH config but with distinct snapshot IDs are not collapsed.)
  - **Guarded: 409 `{ ok: false, error: 'not-workspace-writer' }`** unless `presence.canWriteWorkspace(clientId)` — checked *before* the body is even validated. Auto-save is mounted on every client, and the snapshot carries the **room layout**, which lives in each client's own localStorage rather than on the server. A phone that has never seen the desktop's rooms would therefore overwrite them with its own empty set. The pre-existing "never save an empty snapshot" guard **cannot** catch this: the session list is fully populated from the WS snapshot, so the file looks healthy and only the rooms are wrong.
  - The writer is *derived*, not claimed — `getWorkspaceWriter()` prefers a **local** device over a remote one, then the oldest connection, so the machine running the server keeps the authoritative room layout even if a phone has been connected longer. With no registered devices at all (tests, curl, a client whose socket hasn't landed) `canWriteWorkspace` returns true rather than locking everyone out. The client also skips the request client-side via `canWriteWorkspace()`; the 409 is the backstop.
- GET /api/workspace/load (load workspace snapshot)
- POST /api/terminals with `resumeSessionId` shares the same resume builder as `/api/sessions/:id/resume`, so workspace restore resumes the exact Claude/Codex conversation when its ID is valid and otherwise starts that CLI fresh instead of hijacking an unrelated latest conversation. Stored model flags are reapplied to both CLIs; Claude effort is reapplied separately.

### Restore Claim & Presence (multi-device)
Ownership routes for [Multi-Device Presence](./multi-device-presence.md). All bodies are Zod-validated (`ControlActionSchema = { sessionId: 1–200 chars, force?: boolean }`; `grant` extends it with `toClientId`, 1–128). Every mutating route ends in the router's **own private** `broadcastPresence()` helper, which `await import('./wsManager.js')`s `broadcast` lazily — apiRouter cannot statically import wsManager without a cycle, so this duplicates wsManager's exported helper by necessity.

| Route | Success | Failure |
|-------|---------|---------|
| POST /api/workspace/restore-claim | `{ granted, claimedAt, liveSessions }`, or `{ granted: false, reason: 'already-restored', by, claimedAt, liveSessions }` — both **200** | **400** `{ granted: false, error: 'missing-client-id' }` |
| POST /api/workspace/restore-claim/release | `{ ok: true, released }` (`released: false` when the caller isn't the holder) | — |
| GET /api/presence | `{ ok: true, data: { devices, controllers, restoreOwner, workspaceWriter } }` — the same payload the `presence_update` WS message carries | — |
| POST /api/presence/control/claim | **200** `{ ok: true, controller }` | **409** `{ ok: false, controller, reason: 'held-by-other' \| 'not-idle-enough', idleMs, retryInMs }`; **400** on an invalid body or a missing client id |
| POST /api/presence/control/release | `{ ok: true, released }` (only the holder may release) | — |
| POST /api/presence/control/release-all | `{ ok: true, released: sessionId[] }` — every baton this device held | — |
| POST /api/presence/control/request | `{ ok: true, holder }` plus a broadcast `control_requested` `{ sessionId, fromClientId, fromLabel, toClientId }` | `{ ok: false, error: 'session-is-free' }` (**200** — nothing to ask for) |
| POST /api/presence/control/grant | `{ ok: true, controller }` — releases the caller's hold, then claims for `toClientId` | **403** `{ ok: false, error: 'not-holder' }` when the caller is not the current holder |

- **`restore-claim` refuses an unidentified caller** rather than defaulting to "granted": the restore is destructive, global and once-per-boot, and there is no way to tell one anonymous caller from the next. `claim` refuses one for the same reason.
- **`claim` returns 200/409 by outcome**, so the browser can branch on the status alone; the denial body carries `retryInMs`, which is what `SessionControlLock`'s countdown mirrors.
- **`grant` is holder-only** — anyone being able to grant would be a way to hand a session to a third device you don't control. The 403 fires only when a holder *exists* and is not the caller; an unheld session has nothing to take, so the same call simply claims it for `toClientId`.
- `restore-claim/release` bypasses the `CLAIM_GRACE_MS` window entirely, so a genuinely failed import can retry immediately; `useWorkspaceAutoLoad` releases on every failure and every no-op path.
- `force: true` on `claim` only succeeds once the holder has been idle ≥ `IDLE_TAKEOVER_MS` (60 s), so an unattended desktop can never lock a user out from their phone.

### Agenda
- GET /api/agenda (list tasks, optional ?completed filter)
- POST /api/agenda (create task)
- PUT /api/agenda/:id (update task)
- DELETE /api/agenda/:id (delete task)
- PATCH /api/agenda/:id/toggle (toggle completed)

### Queue
Prompt delivery itself rides POST /api/terminals/:id/write; the scheduling/automation logic lives client-side — see [Queue Scheduler](../frontend/queue-scheduler.md) and [Prompt Queue](../frontend/prompt-queue.md). The only queue-specific server endpoint is the paste-image staging route:
- POST /api/queue-images — accepts `{ images: [{ name, dataUrl }, ...] }` (max 10), decodes `data:image/*;base64,...`, writes each to `/tmp/claude-queue-images/queue-img-{ts}-{rand}.{ext}`, returns `{ ok, paths }`.
- **Cleanup**: `cleanupQueueImages()` deletes files matching `queue-img-*` older than `QUEUE_IMAGE_TTL_MS` (24 h). Runs (a) once on module load, (b) every 60 min via `setInterval(...).unref()`, (c) opportunistically inside each POST. Best-effort — errors are swallowed. Without this the directory accumulated ~17 MB of stale paste-images over a few days.

### Stats/Admin
- GET /api/hook-stats|mq-stats
- POST /api/hook-stats/reset
- POST /api/reset
- GET /api/health-check
- GET /api/config (server configuration — `port`/`hookDensity`/`debug`/`enabledClis` plus `localIP`, this machine's LAN-reachable IPv4 from `getLocalIP()`/`server/networkInfo.ts`, `null` if none found. Consumed by `DevicePresenceChip`'s "connect a phone at …" line — see [Multi-Device Presence](./multi-device-presence.md))

### TTS (Google Cloud Text-to-Speech — per-user API key)
- POST /api/tts/synthesize — body `{ apiKey, text, voiceEn?, voiceZh?, speakingRate?, lang? }`, returns `audio/mpeg` MP3 (concatenated segments for bilingual text). Rate limit: 5/sec per client; server-wide concurrency cap of 3 (see `server/ttsManager.ts`). The `apiKey` is forwarded as `?key=` to Google and redacted from any logged error.
- POST /api/tts/status — body `{ apiKey }`, returns `{ ok, error? }`; probes the Google `voices.list` endpoint to validate the supplied key.
- **No ambient identity** — gcloud/ADC is deliberately NOT used. Each user supplies their own API key stored client-side; the server never has an implicit credential.

### Input Validation
- Zod schemas for ALL request bodies
- Shell metacharacter regex for SSH fields

### Auth Middleware Wiring (server/index.ts)
- `/api/hooks` uses `localhostOnlyMiddleware` + `hookRateLimitMiddleware` (no auth token; restricts to loopback) — does NOT go through `authMiddleware`.
- All other routes mounted under `/api` via `apiRouter` are gated by `authMiddleware`.
- `/api/auth/*` endpoints are defined directly in `index.ts` (before the protected mount) and require no auth.

Registration order in `startServer()` (order is load-bearing — the first match wins):
1. `express.json({ limit: '50mb' })` — the global request-body cap behind `POST /api/terminals/:id/write`.
2. Security-header middleware: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`, HSTS when `req.secure`/`x-forwarded-proto: https`, and the CSP. The CSP allow-lists `script-src 'self' blob: 'wasm-unsafe-eval'` and Hugging Face + jsDelivr hosts in `connect-src`/`font-src` — required by [TTS Voice Output](../multimedia/tts-voice-output.md) (local Kokoro voice) and the 3D scene's font resolver.
3. `/api/auth/*` (unauthenticated).
4. `express.static(dist/client)` — the built SPA.
5. `/api/hooks` (localhost-only + rate limited).
6. `/api` → `authMiddleware` + `apiRouter`. A second `app.get('/api/sessions', authMiddleware, …)` is registered after this mount, so it is shadowed by `apiRouter`'s own `GET /sessions`.
7. Debug request logger (only when `log.isDebug`; strips `token=` from logged URLs).
8. SPA fallback `app.get('/{*splat}')` → `index.html`.

### Known Projects
- GET /api/known-projects decodes ~/.claude/projects/ directory names with greedy filesystem probing

### Rate Limiting
- In-memory fixed 1s window (`isRateLimited` per-key per-second — the bucket resets wholesale once the window elapses): 100/sec hooks, 5/sec DB full-text search, 20/sec file fuzzy-search, 5/sec TTS synthesize.
- Concurrency/count caps: `MAX_CONCURRENT_SUMMARIZE = 2`, plus the two terminal budgets in `server/terminalCapacity.ts` — `MAX_SESSIONS = 50` (agent terminals only) and `MAX_TERMINALS = 130` (absolute PTY ceiling incl. ops shells). `checkTerminalCapacity(getTerminals(), { sessions, ops })` reserves every PTY the request will spawn and returns the message quoted in the 429 (`Session limit reached (N/50 active) …` vs `Terminal limit reached (N/130 shells) …`). Enforced on POST /api/terminals, POST /api/sessions/:id/reconnect-ops-terminal (`{ sessions: 0, ops: 1 }`), and team-member terminal attach. **Not** enforced on floating-session spawn.
  - Ops shells are excluded from the session budget on purpose: a session created with "Commands Terminal" ticked spawns two PTYs, and the previous single `MAX_TERMINALS = 50` PTY cap therefore refused new sessions at ~25 while reporting "max 50". The old check also read `current >= MAX` and then spawned up to two PTYs, so the map could settle one over the cap.

### str() Helper
- Normalizes Express 5 query/param ambiguity (string | string[] | undefined)

### CLI Command Helpers
- `commandStartsWithCli()` detects Claude/Codex command ownership from direct binaries or path-qualified binaries.
- `stripClaudeSessionFlags()` removes stale `--resume`, `--continue`, and `--fork-session` flags before rebuilding Claude resume/fork commands.
- `stripCodexSessionSubcommand()` removes stale `resume`/`fork` subcommands before rebuilding Codex resume/fork commands.
- `buildResumeCommand()` and `buildForkCommand()` centralize the Claude/Codex launch logic used by manual resume, workspace restore, fork, and `resume-command` endpoints. `applyClaudeLaunchFlags` is historically named: it now adds `--model` to Claude or Codex, while `--effort` and permission reconstruction remain Claude-only (`ultracode` launches as `--effort xhigh` and is upgraded via `/effort ultracode`). Codex flags are inserted before `resume`/`fork`, matching the CLI's global-option form.
- `findCodexHookEvents()` scans `~/.codex/config.toml` for dashboard-owned `[[hooks.Event]]` command hook blocks; `inferHookDensity()` classifies Claude/Codex hook status as high/medium/low/custom/off.

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — reads/writes session data
- [Terminal/SSH](./terminal-ssh.md) — creates/manages terminals
- [Database](./database.md) — queries SQLite for history
- [Authentication](./authentication.md) — auth middleware protects routes
- [Hook System](./hook-system.md) — hook ingestion endpoint
- [Floating Session Spawner](./floating-session-spawner.md) — POST /api/sessions/spawn-floating delegates here
- [File Index Cache](./file-index-cache.md) — backs /api/files/search
- [TTS Voice Output](../multimedia/tts-voice-output.md) — `ttsManager.ts` wrapped by `/api/tts/*` endpoints
- [Multi-Device Presence](./multi-device-presence.md) — `holdsRestoreClaim`/`canWriteWorkspace`/`claimWorkspaceRestore`/`claimControl`/`noteControlActivity`/`presenceSnapshot` behind the `clear-all`, `workspace/save`, `/presence/*` and `POST /api/terminals` handlers

### Depended On By
- ALL frontend components that make HTTP requests
- Electron PTY host (POST /api/terminals/register)
- [Conversation View](../frontend/conversation-view.md) — GET /api/sessions/:id/transcript
- [Summary Tab](../frontend/summary-tab.md) — POST /api/sessions/:id/summarize
- [Command Autocomplete](../frontend/command-autocomplete.md) — GET /api/commands
- [Queue Scheduler](../frontend/queue-scheduler.md) / [Prompt Queue](../frontend/prompt-queue.md) — /api/terminals/:id/write + /api/queue-images
- [File Browser](../frontend/file-browser.md) — /api/files/*
- [Workspace Snapshot](../frontend/workspace-snapshot.md) — `/workspace/save|load`, the restore claim, and the guarded `/sessions/clear-all`
- [Session Detail Panel](../frontend/session-detail-panel.md) — `SessionControlLock` drives `/presence/control/*`

### Shared Resources
- Express Router
- Session store
- SSH manager
- DB

## Change Risks
- Largest server file (~3168 lines) -- consider splitting if it grows further
- Changes to endpoint contracts break frontend
- Zod schema changes affect request validation
- Rate limit changes affect hook ingestion
- File browser changes risk directory traversal if resolveProjectPath() is bypassed
- **Relaxing the `clear-all` guard to "any identified device" re-arms the workspace-destruction bug.** Being known is not the same as holding the claim; a stale or hostile client sends a client-id too. Covered by `test/workspaceRestoreClaim.test.ts` (anonymous caller, known-but-not-holder, owner, cold start).
- **Granting the restore claim to an unidentified caller** makes two anonymous callers indistinguishable — the endpoint 400s instead. Never "default to granted" server-side; the *client* wrapper degrades to granted only for a 404/network failure against an older server.
- **Dropping the `workspace/save` 409 lets a second device overwrite the room layout with an empty set**, and the "never save an empty snapshot" guard will not catch it (the session list is fully populated; only the rooms are wrong).
- **Removing `noteControlActivity` from `POST /api/terminals`** makes every new session start unowned, so the first device to type — not the one that launched it — takes the baton.
