# SQLite Persistence

## Function
Provides persistent storage for sessions, prompts, responses, tool calls, events, notes, and agenda tasks using better-sqlite3 with WAL mode.

## Purpose
Server-side persistence that survives restarts. IndexedDB on frontend is the mirror; SQLite is the source of truth for history.

## Source Files
| File | Role |
|------|------|
| `server/db.ts` (556 lines) | Schema definition, prepared statements, upsert/query functions |

## Implementation

### Storage
- Location: `data/sessions.db` (or `APP_USER_DATA/data/sessions.db` in packaged Electron, where `APP_USER_DATA = app.getPath('userData')`), WAL mode for concurrent reads/writes

### Schema
- 7 tables: sessions (20 cols, 4 indexes), prompts (unique session_id+timestamp), responses (unique session_id+timestamp), tool_calls (unique session_id+timestamp+tool_name, additional tool_name index), events, notes, agenda_tasks (priority + completed indexes)
- The `remark` column on `sessions` holds the user's hand-written progress note for a session
  (added by migration, nullable, no default — an existing row simply has no remark). Written by
  `updateSessionRemark(id, remark)` (empty string stored as `NULL`) and by `upsertSession`, which
  preserves the in-memory session's own value so a hook upsert re-writes the same remark rather than
  blanking it. Capped at 200 chars by the API layer, not the schema.
- The `label` column on `sessions` is vestigial: it still exists in the schema for backward compatibility, but `upsertSession` no longer writes it and there is no `updateSessionLabel` export (removed). Do not rely on it.

### Upsert Strategy
- INSERT OR IGNORE for child records (dedup)
- INSERT ON CONFLICT DO UPDATE for sessions
- All wrapped in db.transaction()

### Persist-on-Events
- Only SessionStart, UserPromptSubmit, Stop, SessionEnd trigger DB writes (not every hook)

### Cascade Delete
- deleteSessionCascade() removes from prompts -> responses -> tool_calls -> events -> notes -> sessions in transaction

### Session ID Migration
- migrateSessionId(old, new) updates session_id in all child tables (prompts, responses, tool_calls, events, notes) AND resolves the parent `sessions` row in one transaction: if the new-id row already exists (the normal upsert-then-migrate path on SESSION_START re-key) the old row is DELETEd; otherwise the old row is renamed (`UPDATE sessions SET id=new`). No-ops when old===new.
- Why this matters: without resolving the parent row, every `claude --resume` / terminal→UUID re-key left the old `sessions` row orphaned — stuck at its last transient status (e.g. `connecting`), `ended_at` NULL (so its History duration grew forever), and 0 prompts/0 tools (children migrated away). These orphans surfaced as duplicate, wrong-status rows in the History view.

### Startup Heal
- markStaleSessionsEnded() runs once on server boot (in `index.ts`, before `loadSnapshot()`): any `sessions` row whose status is not `ended` is from a process that died on the previous run, so it is set to `status='ended'` with `ended_at = COALESCE(ended_at, last_activity_at, started_at)`. Without this, such rows show a frozen live status (idle/working/…) and a History duration that grows forever (`now − started_at`). Idempotent; logs the healed count. Sessions that genuinely resume this run re-persist with their real live status afterward.
- Model-ID sanitize migration runs once on module load (db.ts:145-162): any `sessions` row whose `model` contains `[`, ESC (char 27), or a newline is rewritten via `sanitizeModelId()` (config.ts) inside a transaction, logging `Sanitized N contaminated session model id(s)`. Older sessions (and the forks/popups that inherited from them) stored a model polluted with a stripped ANSI bold escape, e.g. `claude-opus-4-8[1m]`; that value broke the unquoted `--model` launch flag because zsh treats `[1m]` as a glob ("no matches found"), so popup/fork spawning failed. Best-effort — a failure is logged as a warning and skipped.

### Search
- Text via prompts subquery with LIKE
- Project/status/date filters
- Sort by started_at/last_activity_at/project_name/status
- Pagination

### Full-Text Search
- searchSessions() + fullTextSearch() across prompts.text and responses.text_excerpt

### Projects
- getDistinctProjects() — list all distinct project_path/project_name pairs

### Agenda Tasks
- getAllAgendaTasks(completed?) — list tasks with optional filter
- getAgendaTaskById(id) — single task lookup
- upsertAgendaTask(task) — create or update
- deleteAgendaTask(id) — remove task

### Detail & Restore Queries
- getSessionDetail(id) — single session row + all child records (prompts, responses, tool_calls, events, notes); backs the History/detail view
- getPromptsForSession(id) — persisted prompts (text + timestamp) for one session; used by `sessionStore` to restore in-memory `promptHistory` after a server clear-all

### Notes CRUD
- getNotes(sessionId) — notes for a session (newest first)
- addNote(sessionId, text) — insert a note, returns the new row
- deleteNote(id) — remove a single note by row id

### Additional Exports
- closeDb() — graceful shutdown
- getAllPersistedSessions() — all sessions ordered by last_activity_at
- getSessionsByProjectPath(path) — filter by project
- updateSessionTitle/Summary/Archived — individual field updates (no `updateSessionLabel` — removed)
- fullTextSearch() — cross-table search across prompts.text and responses.text_excerpt

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
