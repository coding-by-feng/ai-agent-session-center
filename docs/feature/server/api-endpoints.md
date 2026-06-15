# REST API Router

## Function
Provides all HTTP REST API endpoints for session management, terminal creation, file browsing, analytics, notes, hooks, and admin operations.

## Purpose
The HTTP interface for the React frontend and external integrations. Handles all CRUD operations not covered by WebSocket.

## Source Files
| File | Role |
|------|------|
| `server/apiRouter.ts` (~2609 lines, largest server file) | All REST endpoints |
| `server/constants.ts` | Hook event/density constants (`ALL_CLAUDE_HOOK_EVENTS`, `CODEX_HOOK_EVENTS`, `DENSITY_EVENTS`, `CODEX_DENSITY_EVENTS`, `SESSION_STATUS`, `WS_TYPES`) used by hook status/install and broadcast endpoints |
| `server/index.ts` | Auth endpoints (`/api/auth/*`) and middleware wiring (localhost-only for hooks, authMiddleware for everything else under /api) |
| `server/hookRouter.ts` | POST /api/hooks (HTTP-fallback hook ingestion) — delegates to `processHookEvent` |
| `server/floatingSessionSpawner.ts` | Implementation of POST /api/sessions/spawn-floating (fork/translate/explain spawn); prompt synthesis + labels live in `server/floatingPrompt.ts` |
| `server/extractPreviousAnswer.ts` | Helpers `readClaudeTranscript` (CONVERSATION tab) and `readClaudeLastAssistant` (translate-answer mode) |
| `server/commandIndex.ts` | Slash-command/skill enumeration behind GET /api/commands (30s cache per cli+projectPath) |
| `src/types/api.ts` | Shared API response/request types, including per-CLI hook status and `enabledClis` install body |

## Implementation

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
- PUT /api/sessions/:id/title|accent-color|character-model|pinned|muted|alerted
- POST /api/sessions/:id/kill|resume|summarize|fork|clone
  - `clone` creates a new terminal that re-runs the source session's `startupCommand` with session-specific flags stripped (`--resume`/`--continue`/`--fork-session` removed via `stripClaudeSessionFlags`), name stripped, then permission flags + model/effort re-applied. Distinct from `fork` — clone starts a fresh CLI session, fork resumes the existing one. Both run via `createTerminalSession({ isFork: true, originSessionId })` — `isFork` only (kill-guard), NOT `isFloating`, so clone/fork sessions appear in the session lists like any other agent (only floating PiP popups set `isFloating` and are hidden).
  - `resume` rebuilds the launch command via `buildResumeCommand`: Claude uses `claude --resume '<SESSION_ID>' || claude --continue`; Codex uses `codex resume '<SESSION_ID>' || codex resume --last`. Non-UUID IDs (synthetic `term-*` etc.) use the fallback form only.
  - `fork` rebuilds the launch command via `buildForkCommand`: Claude uses `claude --resume '<SESSION_ID>' --fork-session` (or `--continue --fork-session`); Codex uses `codex fork '<SESSION_ID>'` (or `codex fork --last`). Permission mode + model/effort are preserved via `reconstructPermissionFlags` + `applyClaudeLaunchFlags`; the new fork gets its own `-n "<newTitle>"`.
  - `summarize` pipes the transcript to `claude -p --model haiku` (60s timeout, 1MB buffer); rate-limited to `MAX_CONCURRENT_SUMMARIZE = 2`. Prompt precedence: `custom_prompt` > `promptTemplate` > default. See [Summary Tab](../frontend/summary-tab.md).
  - `kill` cascade: SIGTERM, then SIGKILL after 3s if the PID is still alive. Fork sessions skip the `process.kill` cascade (`mem.isFork` check) — they share the origin's `projectPath`, so cwd-based PID lookup would target the wrong claude PID. Forks rely on per-PTY `pty.kill` (group SIGHUP) via `closeTerminal` instead.
- POST /api/sessions/spawn-floating — spawn a forked/floating session (`isFork: true` + `isFloating: true` — hidden from session lists, rendered as a PiP panel) pre-loaded with a synthesized translate / explain / vocab / custom prompt; see [Floating Session Spawner](./floating-session-spawner.md).
  - Body schema: required `originSessionId` (1–200), `mode` (one of 8: `explain-learning`, `explain-native`, `vocab-native`, `translate-selection-learning`, `translate-selection-native`, `translate-answer`, `translate-file`, `custom`), `nativeLanguage` (1–64), `learningLanguage` (1–64). Optional `spawnTerminalId` (≤200, enables recursive fork from a floating terminal), `selection` (≤64KB), `contextLine` (≤2KB), `fileContent` (≤256KB), `filePath` (≤2KB), `customPrompt` (≤64KB, for `custom` mode), `inheritContext: boolean` (default true — fork inherits parent context only when the parent already has a conversation).
- POST /api/sessions/:id/reconnect-terminal|reconnect-ops-terminal
- POST /api/sessions/clear-all (removes all sessions, captures terminal output for replay; accepts JSON body `{ suppressBroadcast?: boolean }` — when `true`, skips the `clearBrowserDb` ws-broadcast so the workspace-import flow can rebuild without racing against the wipe). Registered before parameterized `/sessions/:id` routes so "clear-all" isn't matched as a session ID.
- GET /api/sessions/resume-command?path=<projectPath> — returns `{ sessionId, resumeCommand }` for the most recent non-ended session at a path (prefers live in-memory session, falls back to DB). Server-side fallback for the `claude-last` shell function. 404s on `term-*` IDs / no resumable session.
- DELETE /api/sessions/:id

### Terminal Endpoints
- POST /api/terminals (create, max 50). `model` accepts an alias (`fable`/`opus`/`sonnet`/`haiku`) or a full model ID (e.g. `claude-fable-5`, `claude-opus-4-8`) — validated by regex `^[a-zA-Z0-9._-]+$` (max 100, shell-safe because the value is interpolated unquoted into the `--model` launch flag), no longer a fixed enum.
- POST /api/terminals/register (Electron PTY registration)
- POST /api/terminals/:id/prefill-output (base64-encoded output replay — restores scrollback during workspace import)
- POST /api/terminals/:id/write (write string to PTY; max 50MB per call)
- GET /api/terminals (list all active terminals)
- GET /api/terminals/:id/output — snapshots the PTY ring buffer as base64 (via `getTerminalOutputBuffer`). Consumed by the REVIEW tab to capture floating-session output at close.
- DELETE /api/terminals/:id

### File Browser
- GET /api/files/list|read|stream|search|grep
- GET /api/files/resolve — expands `~`, resolves to an absolute path, classifies as file/dir, and returns suggested project root + relative path so the client can open it in the file browser. See [File Browser](../frontend/file-browser.md).
- POST /api/files/write|mkdir|delete
- POST /api/files/search/invalidate (clear search cache)
- POST /api/files/reveal (open in system file manager — `open -R` / `explorer /select,` / `xdg-open`)
- POST /api/files/open-external (open file with the OS default application — `open` / `cmd /c start "" <path>` / `xdg-open`; same `{ root, path }` body and validation as reveal, fire-and-forget `execFile`, errors only logged). Consumed by the [File-Open Chooser](../frontend/file-open-chooser.md).
- **Limits**: `MAX_FILE_SIZE = 10MB` (read/write JSON), `MAX_STREAMABLE_SIZE = 100MB` (PDF/image/video/audio streaming, with HTTP Range support for media). Grep capped at `MAX_RESULTS = 500` (ripgrep, falling back to grep). All file paths validated via `isAllowedProjectRoot()` + `resolveProjectPath()` to block traversal.

### Slash Commands
- GET /api/commands?cli=<claude|codex|gemini>&projectPath=<absolute> — enumerates slash commands + skills (project + global + plugin sources) for the CLI, cached 30s per (cli, projectPath). Backs slash-command autocomplete in prompt inputs; see [Command Autocomplete](../frontend/command-autocomplete.md).

### Team Endpoints
- GET /api/teams/:id/config
- POST /api/teams/:id/members/:sid/terminal

### Hook Management
- GET /api/hooks/status — returns aggregate install state plus per-CLI detail under `clis.claude` and `clis.codex`. Codex status is read from `~/.codex/config.toml` lifecycle hook blocks and reports `legacyNotify: true` when an old dashboard `notify` line is still present.
- POST /api/hooks/install — accepts `{ density: 'high'|'medium'|'low', enabledClis?: ('claude'|'gemini'|'codex')[] }`, runs `hooks/install-hooks.js --density <density> --clis <enabledClis>`, and preserves the configured CLI set (`readEnabledClis()`) when the settings page reinstalls hooks.
- POST /api/hooks/uninstall

### DB/History
- GET /api/db/sessions (search/filter/paginate)
- GET /api/db/sessions/:id (full detail)
- GET /api/db/projects (distinct project list)
- GET /api/db/search (full-text search across prompts/responses)
- DELETE /api/db/sessions/:id

### Notes
- GET/POST /api/db/sessions/:id/notes
- DELETE /api/db/notes/:id

### SSH/Tmux Helpers
- GET /api/ssh-keys (list available SSH keys)
- POST /api/tmux-sessions (list tmux sessions on a host)

### Workspace
- POST /api/workspace/save (save workspace snapshot — server-side dedup key uses 8 fields joined with `\0`: `[title, sshConfig.host, sshConfig.port, sshConfig.username, sshConfig.workingDir, sshConfig.command, startupCommand, originalSessionId]`. Including `originalSessionId` ensures sessions sharing the same SSH config but with distinct snapshot IDs are not collapsed.)
- GET /api/workspace/load (load workspace snapshot)
- POST /api/terminals with `resumeSessionId` shares the same resume builder as `/api/sessions/:id/resume`, so workspace restore resumes Claude with `claude --resume/--continue` and Codex with `codex resume <SESSION_ID>/--last` instead of blindly re-running the saved command.

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
- GET /api/config (server configuration)

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

### Known Projects
- GET /api/known-projects decodes ~/.claude/projects/ directory names with greedy filesystem probing

### Rate Limiting
- In-memory sliding window (`isRateLimited` per-key per-second): 100/sec hooks, 5/sec DB full-text search, 20/sec file fuzzy-search, 5/sec TTS synthesize.
- Concurrency/count caps: `MAX_CONCURRENT_SUMMARIZE = 2`, `MAX_TERMINALS = 50` (also enforced on team-member terminal attach).

### str() Helper
- Normalizes Express 5 query/param ambiguity (string | string[] | undefined)

### CLI Command Helpers
- `commandStartsWithCli()` detects Claude/Codex command ownership from direct binaries or path-qualified binaries.
- `stripClaudeSessionFlags()` removes stale `--resume`, `--continue`, and `--fork-session` flags before rebuilding Claude resume/fork commands.
- `stripCodexSessionSubcommand()` removes stale `resume`/`fork` subcommands before rebuilding Codex resume/fork commands.
- `buildResumeCommand()` and `buildForkCommand()` centralize the Claude/Codex launch logic used by manual resume, workspace restore, fork, and `resume-command` endpoints. Both re-apply the session's permission mode, model, and effort via `reconstructPermissionFlags` + `applyClaudeLaunchFlags` (`ultracode` effort is menu-only, injected separately, not a launch flag).
- `findCodexHookEvents()` scans `~/.codex/config.toml` for dashboard-owned `[[hooks.Event]]` command hook blocks; `inferHookDensity()` classifies Claude/Codex hook status as high/medium/low/custom/off.

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — reads/writes session data
- [Terminal/SSH](./terminal-ssh.md) — creates/manages terminals
- [Database](./database.md) — queries SQLite for history/analytics
- [Authentication](./authentication.md) — auth middleware protects routes
- [Hook System](./hook-system.md) — hook ingestion endpoint
- [Floating Session Spawner](./floating-session-spawner.md) — POST /api/sessions/spawn-floating delegates here
- [File Index Cache](./file-index-cache.md) — backs /api/files/search
- [TTS Voice Output](../multimedia/tts-voice-output.md) — `ttsManager.ts` wrapped by `/api/tts/*` endpoints

### Depended On By
- ALL frontend components that make HTTP requests
- Electron PTY host (POST /api/terminals/register)
- [Conversation View](../frontend/conversation-view.md) — GET /api/sessions/:id/transcript
- [Summary Tab](../frontend/summary-tab.md) — POST /api/sessions/:id/summarize
- [Command Autocomplete](../frontend/command-autocomplete.md) — GET /api/commands
- [Queue Scheduler](../frontend/queue-scheduler.md) / [Prompt Queue](../frontend/prompt-queue.md) — /api/terminals/:id/write + /api/queue-images
- [File Browser](../frontend/file-browser.md) — /api/files/*

### Shared Resources
- Express Router
- Session store
- SSH manager
- DB

## Change Risks
- Largest server file (~2609 lines) -- consider splitting if it grows further
- Changes to endpoint contracts break frontend
- Zod schema changes affect request validation
- Rate limit changes affect hook ingestion
- File browser changes risk directory traversal if resolveProjectPath() is bypassed
