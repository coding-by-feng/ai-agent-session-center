# REST API Router

## Function
Provides all HTTP REST API endpoints for session management, terminal creation, file browsing, analytics, notes, hooks, and admin operations.

## Purpose
The HTTP interface for the React frontend and external integrations. Handles all CRUD operations not covered by WebSocket.

## Source Files
| File | Role |
|------|------|
| `server/apiRouter.ts` (~96KB, ~2407 lines, largest server file) | All REST endpoints |
| `server/constants.ts` | Hook event/density constants used by hook status and install endpoints |
| `server/index.ts` | Auth endpoints (`/api/auth/*`) and middleware wiring (localhost-only for hooks, authMiddleware for everything else under /api) |
| `server/hookRouter.ts` | POST /api/hooks (HTTP-fallback hook ingestion) |
| `server/floatingSessionSpawner.ts` | Implementation of POST /api/sessions/spawn-floating (translate / explain prompt synthesis) |
| `server/extractPreviousAnswer.ts` | Helper used by floating-session spawner to lift the most recent answer for `translate-answer` mode |
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
- GET /api/sessions/:id/transcript — full interleaved Claude JSONL transcript (user/assistant/tool_use/tool_result entries) for the CONVERSATION tab. Never 500s: returns `{ success: true, data: [] }` on a missing session/transcript so the client falls back to in-memory logs.
- GET /api/sessions/history (paginated session history with status filter)
- PUT /api/sessions/:id/title|label|accent-color|character-model|pinned|muted|alerted
- POST /api/sessions/:id/kill|resume|summarize|fork|clone
  - `clone` (apiRouter.ts:652) creates a new terminal that re-runs the source session's `startupCommand` with reconstructed permission flags. Distinct from `fork` — clone starts a fresh CLI session, fork resumes the existing one.
  - `resume` rebuilds the launch command by CLI: Claude uses `claude --resume '<SESSION_ID>' || claude --continue`; Codex uses `codex resume '<SESSION_ID>' || codex resume --last`; synthetic `term-*` sessions use the fallback form only.
  - `fork` rebuilds the launch command by CLI: Claude uses `claude --resume '<SESSION_ID>' --fork-session` (or `--continue --fork-session`); Codex uses `codex fork '<SESSION_ID>'` (or `codex fork --last`). Claude permission mode flags are preserved via `reconstructPermissionFlags`.
  - `kill` cascade: SIGTERM, then SIGKILL after 3s if the PID is still alive (apiRouter.ts:792-799). Fork sessions skip the `process.kill` cascade (`mem.isFork` check, apiRouter.ts:788) — they share the origin's `projectPath`, so cwd-based PID lookup would target the wrong claude PID. Forks rely on per-PTY `pty.kill` (group SIGHUP) via `closeTerminal` instead.
- POST /api/sessions/spawn-floating — spawn a forked session pre-loaded with a translate / explain prompt; see [Floating Session Spawner](./floating-session-spawner.md).
  - Body schema (apiRouter.ts:710-728): required `originSessionId` (≤200), `mode` (one of 6: `explain-learning`, `explain-native`, `translate-selection-learning`, `translate-selection-native`, `translate-answer`, `translate-file`), `nativeLanguage` (≤64), `learningLanguage` (≤64). Optional `selection` (≤64KB), `contextLine` (≤2KB), `fileContent` (≤256KB), `filePath` (≤2KB), `inheritContext: boolean`.
- POST /api/sessions/:id/reconnect-terminal|reconnect-ops-terminal
- POST /api/sessions/clear-all (removes all sessions, captures terminal output for replay; accepts JSON body `{ suppressBroadcast?: boolean }` — when `true`, skips the `clearBrowserDb` ws-broadcast so the workspace-import flow can rebuild without racing against the wipe)
- DELETE /api/sessions/:id

### Terminal Endpoints
- POST /api/terminals (create, max 50)
- POST /api/terminals/register (Electron PTY registration)
- POST /api/terminals/:id/prefill-output (base64-encoded output replay)
- POST /api/terminals/:id/write (write string to PTY; max 50MB per call, apiRouter.ts:1331-1334)
- GET /api/terminals (list all active terminals)
- GET /api/terminals/:id/output (apiRouter.ts:1237) — snapshots the PTY ring buffer as base64. Consumed by the REVIEW tab to capture floating-session output at close.
- DELETE /api/terminals/:id

### File Browser
- GET /api/files/list|read|stream|search|grep
- GET /api/files/resolve (apiRouter.ts:2086) — expands `~`, resolves to an absolute path, classifies as file/dir, and returns suggested project root + relative path so the client can open it in the file browser.
- POST /api/files/write|mkdir|delete
- POST /api/files/search/invalidate (clear search cache)
- POST /api/files/reveal (open in system file manager)
- **Limits**: `MAX_FILE_SIZE = 10MB` (read/write JSON), `MAX_STREAMABLE_SIZE = 100MB` (PDF/image streaming) — apiRouter.ts:1580-1581. Grep capped at `MAX_RESULTS = 500` (apiRouter.ts:1959).

### Team Endpoints
- GET /api/teams/:id/config
- POST /api/teams/:id/members/:sid/terminal

### Hook Management
- GET /api/hooks/status — returns aggregate install state plus per-CLI detail under `clis.claude` and `clis.codex`. Codex status is read from `~/.codex/config.toml` lifecycle hook blocks and reports `legacyNotify: true` when an old dashboard `notify` line is still present.
- POST /api/hooks/install — accepts `{ density, enabledClis? }`, runs `hooks/install-hooks.js --density <density> --clis <enabledClis>`, and preserves the configured CLI set when the settings page reinstalls hooks.
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

### Auth Middleware Wiring (server/index.ts:180-184)
- `/api/hooks` uses `localhostOnlyMiddleware` (no auth token; restricts to loopback) — does NOT go through `authMiddleware`.
- All other routes mounted under `/api` via `apiRouter` are gated by `authMiddleware`.

### Known Projects
- GET /api/known-projects decodes ~/.claude/projects/ directory names with greedy filesystem probing

### Rate Limiting
- In-memory sliding window (100/sec hooks, 2 concurrent summarize, 50 max terminals, 5/sec TTS)

### str() Helper
- Normalizes Express 5 query/param ambiguity (string | string[] | undefined)

### CLI Command Helpers
- `commandStartsWithCli()` detects Claude/Codex command ownership from direct binaries or path-qualified binaries.
- `stripClaudeSessionFlags()` removes stale `--resume`, `--continue`, and `--fork-session` flags before rebuilding Claude resume/fork commands.
- `stripCodexSessionSubcommand()` removes stale `resume`/`fork` subcommands before rebuilding Codex resume/fork commands.
- `buildResumeCommand()` and `buildForkCommand()` centralize the Claude/Codex launch logic used by manual resume, workspace restore, and fork endpoints.
- `findCodexHookEvents()` scans `~/.codex/config.toml` for dashboard-owned `[[hooks.Event]]` command hook blocks; `inferHookDensity()` classifies Claude/Codex hook status as high/medium/low/custom/off.

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — reads/writes session data
- [Terminal/SSH](./terminal-ssh.md) — creates/manages terminals
- [Database](./database.md) — queries SQLite for history/analytics
- [Authentication](./authentication.md) — auth middleware protects routes
- [Hook System](./hook-system.md) — hook ingestion endpoint
- [TTS Voice Output](../multimedia/tts-voice-output.md) — `ttsManager.ts` wrapped by `/api/tts/*` endpoints

### Depended On By
- ALL frontend components that make HTTP requests
- Electron PTY host (POST /api/terminals/register)

### Shared Resources
- Express Router
- Session store
- SSH manager
- DB

## Change Risks
- Largest server file (~2407 lines) -- consider splitting if it grows further
- Changes to endpoint contracts break frontend
- Zod schema changes affect request validation
- Rate limit changes affect hook ingestion
- File browser changes risk directory traversal if resolveProjectPath() is bypassed
