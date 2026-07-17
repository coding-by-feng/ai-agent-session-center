# Agenda / Task System

## Function
Personal todo list with title, description, priority (low/medium/high/urgent), tags, optional due date, and completion tracking. Full-page view that groups incomplete tasks by priority into collapsible sections, with a filter bar, an inline add form, and a collapsible Completed group at the bottom.

## Purpose
Lets the user track tasks alongside AI coding sessions without leaving the dashboard. Server-persisted (SQLite) so tasks survive reloads and are shared across browser/Electron clients.

## Source Files
| File | Role |
|------|------|
| `src/stores/agendaStore.ts` | Zustand store — tasks Map, filter, fetch/create/update/delete/toggle actions (optimistic updates with revert on failure) |
| `src/routes/AgendaView.tsx` | Full-page route — filter + group + sort, priority-grouped collapsible sections, stats row, add form |
| `src/components/agenda/AgendaFilterBar.tsx` | Search, priority filter, tag filter, sortBy, showCompleted toggle |
| `src/components/agenda/AgendaTaskCard.tsx` | Task card: checkbox, inline title editing, priority dropdown, due date, inline tag editing, expandable description, delete with confirm |
| `src/components/agenda/AddTaskForm.tsx` | Inline new-task form (title required, priority defaults medium, optional due date + tags) |
| `src/types/agenda.ts` | `AgendaTask`, `AgendaPriority`, `AgendaFilter` types (shared server + client) |
| `src/components/layout/NavBar.tsx` | `/agenda` nav link + incomplete-count badge |
| `server/apiRouter.ts` | `agendaCreateSchema` / `agendaUpdateSchema` Zod schemas (lines 314 / 322) + 5 REST endpoints (lines 2523-2633) |
| `server/db.ts` | `agenda_tasks` table + `getAllAgendaTasks`, `getAgendaTaskById`, `upsertAgendaTask`, `deleteAgendaTask` |

## Implementation

### Endpoints
All agenda routes return a non-standard success envelope `{ ok: true, data }` (errors still use `{ success: false, error }`); the store checks `json.ok`.
- `GET /api/agenda?completed=true|false` — list tasks, optionally filtered by completion (omit param for all); ordered `created_at DESC`.
- `POST /api/agenda` — create task (server generates `crypto.randomUUID()` + `createdAt`/`updatedAt`, forces `completed: false`).
- `PUT /api/agenda/:id` — update task; 404 if missing. Accepts partial `title/description/priority/tags/dueDate/completed` (`dueDate` is nullable here). `completedAt` is set to `now` when `completed===true && !existing.completed`, cleared to `undefined` when `completed===false`, otherwise preserved.
- `DELETE /api/agenda/:id` — delete task; 404 if missing; returns `{ ok: true }` (no data).
- `PATCH /api/agenda/:id/toggle` — flip `completed`, set `completedAt=now` when becoming complete / clear when becoming incomplete; 404 if missing.

### Validation
- `agendaCreateSchema` (apiRouter.ts:314): `title` 1-500 chars (required), `description` ≤5000 optional, `priority` enum default `medium`, `tags` array (≤20 items, each ≤100 chars) default `[]`, `dueDate` optional string.
- `agendaUpdateSchema` (apiRouter.ts:322): same fields all optional, plus `completed` boolean; `dueDate` is `string().nullable().optional()`.

### Store (`agendaStore.ts`)
- `fetchTasks` — GET, replaces the whole `tasks` Map (keyed by id).
- `createTask` — optimistic: inserts a `temp-${Date.now()}` entry, swaps to the real server id on success; deletes the temp entry on failure/error.
- `updateTask` / `deleteTask` / `toggleTask` — all optimistic with rollback to the prior task object (or re-insert on delete) if the request fails.
- `setFilter(partial)` — merges into `filter`; no persistence (lost on reload).
- `DEFAULT_FILTER`: `search: ''`, `priority: 'all'`, `tag: 'all'`, `showCompleted: false`, `sortBy: 'priority'`.

### View (`AgendaView.tsx`)
- Lazy-loaded (`App.tsx`) and mounted at route `/agenda`; calls `fetchTasks()` on mount.
- `PRIORITY_ORDER = ['urgent','high','medium','low']`; `PRIORITY_WEIGHT` urgent=0 → low=3 drives `sortBy: 'priority'` (ties broken by newest `createdAt`).
- Incomplete tasks are filtered (`matchesFilter`), sorted, then grouped by priority into collapsible sections (`GroupHeader` with chevron + count); only non-empty groups render.
- Completed tasks appear in a separate collapsible "Completed" group (group id `__completed__`) only when `filter.showCompleted` is on.
- `matchesFilter`: priority equality, `task.tags.includes(tag)`, and case-insensitive substring match on title OR description.
- `sortTasks` for `dueDate` puts dateless tasks last and compares ISO strings; `createdAt` is newest-first.
- Stats row shows `{n} task(s)` incomplete and `{n} completed`; empty states differ for "no tasks yet" vs "no tasks match the current filter". `data-testid="agenda-view"`.

### Filter bar (`AgendaFilterBar.tsx`)
- Search input (`SearchInput`, 200ms debounce) — matches title + description.
- Priority `<select>` — `all | urgent | high | medium | low`.
- Tag `<select>` — `all` plus every distinct non-empty tag across loaded tasks (alphabetically sorted, rendered `#tag`); disabled when no task has tags.
- Sort `<select>` — `priority | dueDate | createdAt`.
- "Show completed" checkbox — reveals the collapsible Completed group.

### Task card (`AgendaTaskCard.tsx`)
- Checkbox toggles completion (calls `toggleTask`).
- Inline title editing (click to edit, Enter/blur commit, Escape cancel — pattern mirrors `RobotListSidebar`).
- Priority `<select>` badge (`PRIORITY_CYCLE = ['low','medium','high','urgent']`) recolors via `PRIORITY_CLASS`.
- Due date shows `getDueDateStatus` → `overdue`/`today`/`future`, prefixing "Overdue: " / "Today: " and adding `overdue`/`dueToday` card classes.
- Inline tag editing (comma-separated input) and a `+` button to add tags.
- Expandable description ("+ Show details" / "- Hide details").
- Delete uses an inline confirm overlay ("Delete?" Yes/No).

### NavBar
- `/agenda` link labeled `AGENDA`; shows a red `badge` with the incomplete-task count (`tasks` filtered by `!completed`) when > 0.

## Dependencies & Connections

### Depends On
- [API Endpoints](../server/api-endpoints.md) — `/api/agenda` CRUD
- [Database](../server/database.md) — `agenda_tasks` SQLite table
- [State Management](./state-management.md) — agendaStore is a Zustand store
- [Views / Routing](./views-routing.md) — AgendaView is lazy-mounted at `/agenda`
- [UI Primitives](./ui-primitives.md) — uses the shared `SearchInput` component

### Depended On By
- [Views / Routing](./views-routing.md) — NavBar renders the `/agenda` link and incomplete-count badge

### Shared Resources
- `AgendaTask` / `AgendaPriority` / `AgendaFilter` types shared between server and client via `src/types/agenda.ts`

## Change Risks
- Agenda endpoints use a `{ ok: true }` success envelope (not `{ success: true }`); changing it without updating `agendaStore`'s `json.ok` checks silently breaks every read/write.
- Renaming the Zod schemas (`agendaCreateSchema` / `agendaUpdateSchema`) without updating client request bodies will 400 every write.
- The `completedAt` branch in PUT only sets/clears on a `completed` transition — removing it loses completion timestamps.
- `agendaStore.fetchTasks` replaces the whole Map — concurrent writes during a fetch can be clobbered.
- The incomplete-count badge in NavBar subscribes to the agenda `tasks` Map, so the store must stay loaded for the badge to be accurate across views.
