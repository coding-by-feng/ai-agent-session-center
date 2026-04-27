# REST API Router

## Function
Provides all HTTP REST API endpoints for session management, terminal creation, file browsing, analytics, notes, hooks, and admin operations.

## Purpose
The HTTP interface for the React frontend and external integrations. Handles all CRUD operations not covered by WebSocket.

## Source Files
| File | Role |
|------|------|
| `server/apiRouter.ts` (~78KB, ~2064 lines, largest server file) | All REST endpoints |

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
- GET /api/sessions/history (paginated session history with status filter)
- PUT /api/sessions/:id/title|label|accent-color|character-model|pinned|muted|alerted
- POST /api/sessions/:id/kill|resume|summarize|fork
- POST /api/sessions/:id/reconnect-terminal|reconnect-ops-terminal
- POST /api/sessions/clear-all (removes all sessions, captures terminal output for replay)
- DELETE /api/sessions/:id

### Terminal Endpoints
- POST /api/terminals (create, max 50)
- POST /api/terminals/register (Electron PTY registration)
- POST /api/terminals/:id/prefill-output (base64-encoded output replay)
- POST /api/terminals/:id/write (write string to PTY)
- GET /api/terminals (list all active terminals)
- DELETE /api/terminals/:id

### File Browser
- GET /api/files/list|read|stream|search|grep
- POST /api/files/write|mkdir|delete
- POST /api/files/search/invalidate (clear search cache)
- POST /api/files/reveal (open in system file manager)

### Team Endpoints
- GET /api/teams/:id/config
- POST /api/teams/:id/members/:sid/terminal

### Hook Management
- GET /api/hooks/status
- POST /api/hooks/install
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
- POST /api/workspace/save (save workspace snapshot)
- GET /api/workspace/load (load workspace snapshot)

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

### Known Projects
- GET /api/known-projects decodes ~/.claude/projects/ directory names with greedy filesystem probing

### Rate Limiting
- In-memory sliding window (100/sec hooks, 2 concurrent summarize, 50 max terminals, 5/sec TTS)

### str() Helper
- Normalizes Express 5 query/param ambiguity (string | string[] | undefined)

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
- Largest server file (~2064 lines) -- consider splitting if it grows further
- Changes to endpoint contracts break frontend
- Zod schema changes affect request validation
- Rate limit changes affect hook ingestion
- File browser changes risk directory traversal if resolveProjectPath() is bypassed
