# SQLite Persistence

## Function
Provides persistent storage for sessions, prompts, responses, tool calls, events, notes, and agenda tasks using better-sqlite3 with WAL mode.

## Purpose
Server-side persistence that survives restarts. IndexedDB on frontend is the mirror; SQLite is the source of truth for history.

## Source Files
| File | Role |
|------|------|
| `server/db.ts` (880 lines) | Schema definition, prepared statements, upsert/query functions |

## Implementation

### Storage
- Location: `data/sessions.db` (or `APP_USER_DATA/data/sessions.db` in packaged Electron, where `APP_USER_DATA = app.getPath('userData')`), WAL mode for concurrent reads/writes

### Schema
- 9 tables: sessions (22 cols, 4 indexes), prompts (unique session_id+timestamp), responses (unique session_id+timestamp), tool_calls (unique session_id+timestamp+tool_name, additional tool_name index), events, notes, note_media (session_id + created_at indexes; metadata only — see Note media below), agenda_tasks (priority + completed indexes), session_queues (see Shared prompt queue below)
- The `remark` column on `sessions` holds the user's hand-written progress note for a session
  (added by migration, nullable, no default — an existing row simply has no remark). Written by
  `updateSessionRemark(id, remark)` (empty string stored as `NULL`) and by `upsertSession`, which
  preserves the in-memory session's own value so a hook upsert re-writes the same remark rather than
  blanking it. Capped at 200 chars by the API layer, not the schema.
- The `label` column on `sessions` is vestigial: it still exists in the schema for backward compatibility, but `upsertSession` no longer writes it and there is no `updateSessionLabel` export (removed). Do not rely on it.
- Two more columns are added by the same idempotent `ALTER TABLE` migration block as `remark` (`PRAGMA table_info` gates each, so it is safe to run every boot): `remote_visible INTEGER DEFAULT 0` (opt-in for remote/non-loopback devices — see [Authentication → Per-session remote visibility](./authentication.md) for the full rule) and `ai_popup_enabled INTEGER DEFAULT 1` (select-to-explain popup toggle; defaults to enabled because the feature already shipped on for every existing session — a `DEFAULT 0` would have silently switched it off for all of them). The two defaults are deliberately opposite polarity for the same reason: a brand-new capability must default deny, a pre-existing one must default to what already shipped.

### Upsert Strategy
- INSERT OR IGNORE for child records (dedup)
- INSERT ON CONFLICT DO UPDATE for sessions
- All wrapped in db.transaction()

### Persist-on-Events
- Only SessionStart, UserPromptSubmit, Stop, SessionEnd trigger DB writes (not every hook)

### Cascade Delete
- deleteSessionCascade() removes from prompts -> responses -> tool_calls -> events -> notes -> session_queues -> sessions in transaction. The queue delete has no FK to `sessions` (see Shared prompt queue below) so it needs an explicit step here or it would outlive the session it belonged to.

### Session ID Migration
- migrateSessionId(old, new) updates session_id in all child tables (prompts, responses, tool_calls, events, notes) AND resolves the parent `sessions` row in one transaction: if the new-id row already exists (the normal upsert-then-migrate path on SESSION_START re-key) the old row is DELETEd; otherwise the old row is renamed (`UPDATE sessions SET id=new`). No-ops when old===new.
- **Does NOT migrate `session_queues`.** A re-key (e.g. `claude --resume`) leaves a session's queue row keyed under its old id unless the caller separately re-keys it — the server performs no logic on queue contents, so this migration only touches the tables it already owned before the shared queue existed.
- Why this matters: without resolving the parent row, every `claude --resume` / terminal→UUID re-key left the old `sessions` row orphaned — stuck at its last transient status (e.g. `connecting`), `ended_at` NULL (so its History duration grew forever), and 0 prompts/0 tools (children migrated away). These orphans surfaced as duplicate, wrong-status rows in the History view.

### Startup Heal
- markStaleSessionsEnded() runs once on server boot (in `index.ts`, before `loadSnapshot()`): any `sessions` row whose status is not `ended` is from a process that died on the previous run, so it is set to `status='ended'` with `ended_at = COALESCE(ended_at, last_activity_at, started_at)`. Without this, such rows show a frozen live status (idle/working/…) and a History duration that grows forever (`now − started_at`). Idempotent; logs the healed count. Sessions that genuinely resume this run re-persist with their real live status afterward.
- Model-ID sanitize migration runs once on module load: any `sessions` row whose `model` contains `[`, ESC (char 27), a newline, **a space, or a `/`** is rewritten inside a transaction, logging `Sanitized N contaminated session model id(s)`. Two contamination shapes are cleaned, and the row's shape picks the cleaner (`/[\s/]/` → `extractModelFromCommand`, else `sanitizeModelId` — both in config.ts):
  1. **ANSI leftovers** — older sessions (and the forks/popups that inherited from them) stored a model polluted with a stripped ANSI bold escape, e.g. `claude-opus-4-8[1m]`; that value broke the unquoted `--model` launch flag because zsh treats `[1m]` as a glob ("no matches found"), so popup/fork spawning failed. Recovered to `claude-opus-4-8`.
  2. **A whole launch command** — the old connecting→idle shortcut for hookless CLIs stamped the command into `model`, e.g. `/opt/homebrew/…/bin/codex --dangerously-bypass-approvals-and-sandbox`. Reduced to the command's real `--model` id, or **cleared** when it pins none. Deliberately not reduced to the binary name: a stored `codex` would come back as an invalid `--model codex` on the next fork/resume. Writer fixed in `sessionStore.ts` (see [Session management](./session-management.md)).

  Best-effort — a failure is logged as a warning and skipped.

### Search
- Text via prompts subquery with LIKE
- Project/status/date filters
- Sort by started_at/last_activity_at/project_name/status
- Pagination

### Full-Text Search
- searchSessions() + fullTextSearch() across prompts.text and responses.text_excerpt
- **Both join `sessions` INNER**, so a prompt whose session row is missing is invisible to them. `searchPrompts()` below deliberately does not.

### Prompt Trace Search — `searchPrompts(params)`
Backs `GET /api/db/prompts` and the [PROMPTS view](../frontend/prompt-trace.md). Returns `{ prompts, total, page, pageSize }`.

- `FROM prompts p LEFT JOIN sessions s ON p.session_id = s.id`, selecting `s.project_name`, `s.project_path`, `s.title AS session_title` — **all nullable**. LEFT because this is the one query whose contract is never to lose a prompt; an inner join turns "session row gone" into "prompt never existed".
- `ORDER BY p.timestamp <dir>, p.id <dir>` — `p.id` (AUTOINCREMENT) is the tiebreak that makes pagination a total order; many prompts share a millisecond.
- Filters: `query` (LIKE), `project` (`s.project_path`), `session` (`p.session_id`), `dateFrom`/`dateTo` (`p.timestamp`), `kind`.
- **LIKE wildcards in `query` are escaped** (`\`, `%`, `_`) with `ESCAPE '\'`. Measured on real data: `100%` unescaped matches 852 rows vs. 144 genuine ones. `searchSessions`/`fullTextSearch` do **not** do this.
- Source facets (`PromptKind`): `mine` (default) = `NOT agent AND non-blank`; `cmd` = `mine AND (starts '/' or '$')`; `agent` = text starts with `<`; `all` = unfiltered. ~10% of rows are harness-injected (`<task-notification>`, `<observed_from_primary_session>`, `<system-reminder>`, `<agent-message>`, `<<autonomous-loop-dynamic>>`), which is what `agent` isolates.
- **All trims pass an explicit charset** — `ltrim(p.text, ' ' || char(9) || char(10) || char(13))`. SQLite's bare `ltrim(X)`/`trim(X)` strip **spaces only**, so a tag behind a leading newline was classified as user-typed.
- Errors are caught → empty page + `log.warn`, never a throw.
- Covered by `test/searchPrompts.test.ts`.

### Projects
- getDistinctProjects() — list all distinct project_path/project_name pairs

### Agenda Tasks
- getAllAgendaTasks(completed?) — list tasks with optional filter
- getAgendaTaskById(id) — single task lookup
- upsertAgendaTask(task) — create or update
- deleteAgendaTask(id) — remove task

### Detail & Restore Queries
- getSessionDetail(id) — single session row + all child records (prompts, responses, tool_calls, events, notes); backs the History/detail view
- getPromptsForSession(id) — persisted prompts (text + timestamp) for one session; used by `sessionStore` to restore in-memory `promptHistory` after a server clear-all. Rows are **full length**, so the restore replays them through `pushPrompt` to re-apply the in-memory caps
- insertFullPrompt(sessionId, text, timestamp) — writes one prompt at FULL length, called *before* the capped copy is pushed to `promptHistory`. `upsertSession` later re-inserts from that capped copy, but `insertPrompt` is `INSERT OR IGNORE` against `UNIQUE(session_id, timestamp)`, so this row wins. **Must share the in-memory entry's timestamp** or the dedup key misses and both rows persist. See [Session Management → In-memory text caps](./session-management.md)

### Notes CRUD
- getNotes(sessionId) — notes for a session (newest first)
- addNote(sessionId, text) — insert a note, returns the new row
- updateNote(id, text) — update text + `updated_at`, returns the row or null if the id is unknown
- deleteNote(id) — remove a single note by row id

### Note media
`note_media` holds **metadata only** — id (128-bit hex, server-generated), session_id, name, mime, ext, bytes, created_at. The bytes live at `<data dir>/note-media/<id>.<ext>`, managed by [`server/noteMedia.ts`](../../../server/noteMedia.ts). Keeping a 40 MB screen recording out of a TEXT row is the whole point: a note's text stores only `/api/note-media/<id>`.
- addNoteMedia(row) / getNoteMedia(id) / getNoteMediaBySession(sessionId) / deleteNoteMediaRow(id)
- getNoteMediaOlderThan(cutoff) + isNoteMediaReferenced(id) — the pair backing the hourly orphan sweep. `isNoteMediaReferenced` does a `LIKE` over **all** notes, not just the owning session's: note text is copy-pasteable between sessions, and deleting media that is still displayed somewhere is worse than retaining a few stale bytes.
- `deleteSessionCascade` does **not** touch `note_media` — the API route calls `deleteNoteMediaForSession` first, since the cascade removes the very notes the reference check depends on.

### Shared prompt queue
`session_queues` (`session_id TEXT PRIMARY KEY, items TEXT NOT NULL, automation TEXT, updated_at INTEGER NOT NULL`) is the server-side source of truth for each session's prompt queue — added Aug 2026 so a phone and the desktop app looking at the same session see the same queue instead of two private IndexedDB copies that never sync. See [Prompt Queue](../frontend/prompt-queue.md) for the client side.
- `items` and `automation` are stored as **opaque JSON** via `encodeQueue`/`decodeQueueRow` (`server/sessionQueueCodec.ts`), not normalized columns — deliberately, since the server runs no logic on queue contents (the scheduler is entirely client-side) and a JSON blob carries new client-side fields for free instead of needing this table kept in lockstep with the ~18-field `QueueItem` type forever.
- `getSessionQueue(sessionId)` / `getAllSessionQueues()` (the latter backs a client's one-shot boot hydration) / `upsertSessionQueue(sessionId, items, automation)` / `deleteSessionQueue(sessionId)`.
- No `FOREIGN KEY` to `sessions` — a queue can be written before its session row exists — so `deleteSessionCascade` deletes it explicitly (see Cascade Delete above), and `migrateSessionId` does **not** carry it across a re-key (see Session ID Migration above).

### Additional Exports
- closeDb() — graceful shutdown
- getAllPersistedSessions() — all sessions ordered by last_activity_at
- getSessionsByProjectPath(path) — filter by project
- updateSessionTitle/Summary/Archived — individual field updates (no `updateSessionLabel` — removed)
- fullTextSearch() — cross-table search across prompts.text and responses.text_excerpt
- searchPrompts() — paginated, faceted prompt trace (see above)

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — receives session data to persist on key events

### Depended On By
- [API Endpoints](./api-endpoints.md) — all /api/db/* endpoints query the database
- [Session Management](./session-management.md) — calls `upsertSession`, `migrateSessionId`, `getPromptsForSession` on key events / re-key / restore
- [Client Persistence](../frontend/client-persistence.md) — IndexedDB mirrors server DB data

### Shared Resources
- SQLite file
- Prepared statements

## Change Risks
- Schema changes require migration
- Unique index changes can cause dedup failures or constraint violations
- WAL mode required for performance -- switching to DELETE mode would cause write locks
- Breaking cascade delete leaves orphan records
