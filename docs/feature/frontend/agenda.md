# Agenda / Task System

## Function
Personal todo list with title, description, priority (low/medium/high/urgent), tags, optional due date, and completion tracking. Full-page view with filter bar, add form, and priority-colored task cards.

## Purpose
Lets the user track tasks alongside AI coding sessions without leaving the dashboard. Server-persisted (SQLite) so tasks survive reloads and are shared across browser/Electron clients.

## Source Files
| File | Role |
|------|------|
| `src/stores/agendaStore.ts` | Zustand store — tasks Map, filter, fetch/create/update/delete/toggle actions (optimistic updates) |
| `src/routes/AgendaView.tsx` | Full-page route — grid of task cards, filter bar, add form |
| `src/components/agenda/AgendaFilterBar.tsx` | Search, priority filter, tag filter, showCompleted toggle, sortBy |
| `src/components/agenda/AgendaTaskCard.tsx` | Task card: title, description, priority chip, tags, due date, toggle/edit/delete |
| `src/components/agenda/AddTaskForm.tsx` | Inline new-task form |
| `src/types/agenda.ts` | `AgendaTask`, `AgendaPriority`, `AgendaFilter` types |
| `server/apiRouter.ts` (lines 1952-2062) | 5 REST endpoints |
| `server/db.ts` | `agenda_tasks` table + `getAllAgendaTasks`, `upsertAgendaTask`, `deleteAgendaTask`, `getAgendaTaskById` |

## Implementation
- **Endpoints**:
  - `GET /api/agenda?completed=true|false` — list tasks (optional filter by completion)
  - `POST /api/agenda` — create task (server generates UUID + timestamps)
  - `PUT /api/agenda/:id` — update task (preserves `completedAt` logic)
  - `DELETE /api/agenda/:id` — delete task
  - `PATCH /api/agenda/:id/toggle` — flip completed flag, set/clear `completedAt`
- **Validation**: `agendaCreateSchema` / `agendaUpdateSchema` Zod schemas in apiRouter.ts (line 171).
- **Priority order**: urgent > high > medium > low (used by `sortBy: 'priority'`).
- **Optimistic updates**: createTask inserts a `temp-{timestamp}` entry, swaps to real id on success; failures roll back.
- **Filter state**: lives in store, not URL — lost on reload.
- **Default filter**: `showCompleted: false`, `sortBy: 'priority'`, `tag: 'all'`.
- **Filter bar controls** (`AgendaFilterBar.tsx`):
  - Search input (200ms debounce) — matches title + description.
  - Priority `<select>` — `all | urgent | high | medium | low`.
  - Tag `<select>` — `all` plus every distinct tag collected from loaded tasks (sorted alphabetically, rendered as `#tag`). Disabled when no task has any tag. A task passes the tag filter when its `tags` array includes the selected tag (`task.tags.includes(tag)` in `AgendaView.matchesFilter`).
  - Sort `<select>` — `priority | dueDate | createdAt`.
  - Show completed checkbox — reveals the collapsible Completed group.

## Dependencies & Connections

### Depends On
- [API Endpoints](../server/api-endpoints.md) — `/api/agenda` CRUD
- [Database](../server/database.md) — `agenda_tasks` SQLite table
- [State Management](./state-management.md) — agendaStore is a Zustand store
- [Views / Routing](./views-routing.md) — AgendaView is mounted as a route

### Depended On By
- [Keyboard Shortcuts](./keyboard-shortcuts.md) — nav shortcut to open agenda view

### Shared Resources
- `AgendaTask` type shared between server and client via `src/types/agenda.ts`

## Change Risks
- Renaming Zod schemas in apiRouter.ts without updating client request bodies will 400 every write
- `completedAt` logic in PUT only flips when `completed` transitions — removing that branch loses completion timestamps
- `agendaStore.fetchTasks` replaces the whole Map — concurrent writes during a fetch can be clobbered
