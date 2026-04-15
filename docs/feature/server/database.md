# SQLite Persistence

## Function
Provides persistent storage for sessions, prompts, responses, tool calls, events, notes, and agenda tasks using better-sqlite3 with WAL mode.

## Purpose
Server-side persistence that survives restarts. IndexedDB on frontend is the mirror; SQLite is the source of truth for history and analytics.

## Source Files
| File | Role |
|------|------|
| `server/db.ts` (~20KB) | Schema definition, prepared statements, upsert/query functions |

## Implementation

### Storage
- Location: data/sessions.db (or APP_USER_DATA/data/sessions.db in Electron), WAL mode for concurrent reads/writes

### Schema
- 7 tables: sessions (19 cols, 4 indexes), prompts (unique session_id+timestamp), responses (unique session_id+timestamp), tool_calls (unique session_id+timestamp+tool_name, additional tool_name index), events, notes, agenda_tasks (priority + completed indexes)

### Upsert Strategy
- INSERT OR IGNORE for child records (dedup)
- INSERT ON CONFLICT DO UPDATE for sessions
- All wrapped in db.transaction()

### Persist-on-Events
- Only SessionStart, UserPromptSubmit, Stop, SessionEnd trigger DB writes (not every hook)

### Cascade Delete
- deleteSessionCascade() removes from prompts -> responses -> tool_calls -> events -> notes -> sessions in transaction

### Session ID Migration
- migrateSessionId(old, new) updates session_id in all child tables in one transaction

### Search
- Text via prompts subquery with LIKE
- Project/status/date filters
- Sort by started_at/last_activity_at/project_name/status
- Pagination

### Full-Text Search
- searchSessions() + fullTextSearch() across prompts.text and responses.text_excerpt

### Analytics
- getDistinctProjects() — list all distinct project_path/project_name pairs
- (Summary stats, tool breakdown, active projects, and heatmap are computed at the API layer from raw queries)

### Agenda Tasks
- getAllAgendaTasks(completed?) — list tasks with optional filter
- getAgendaTaskById(id) — single task lookup
- upsertAgendaTask(task) — create or update
- deleteAgendaTask(id) — remove task

### Additional Exports
- closeDb() — graceful shutdown
- getAllPersistedSessions() — all sessions ordered by last_activity_at
- getSessionsByProjectPath(path) — filter by project
- updateSessionTitle/Label/Summary/Archived — individual field updates
- fullTextSearch() — cross-table search across prompts.text and responses.text_excerpt

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — receives session data to persist on key events

### Depended On By
- [API Endpoints](./api-endpoints.md) — all /api/db/* endpoints query the database
- Frontend client persistence — IndexedDB mirrors server DB data

### Shared Resources
- SQLite file
- Prepared statements

## Change Risks
- Schema changes require migration
- Unique index changes can cause dedup failures or constraint violations
- WAL mode required for performance -- switching to DELETE mode would cause write locks
- Breaking cascade delete leaves orphan records
