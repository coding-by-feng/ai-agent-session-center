# Prompt Trace (PROMPTS view)

## Function

The `/prompts` route is a global, searchable record of **every prompt ever sent to any agent**, across all sessions and projects — day-grouped, filterable by text/project/date/source, paginated, and exportable. Rows offer copy, save-to-snippet-library, and (for sessions still in memory) jump-to-session.

## Purpose

Every `UserPromptSubmit` has always been written to SQLite at full length by [`db.insertFullPrompt()`](../server/database.md), but nothing surfaced it: the only ways to read a prompt back were the per-session Conversation tab, the History view's per-session overlay, or the Cmd+Shift+F modal over *in-memory* sessions only. Prompts from sessions that ended weeks ago were recorded and unreachable.

This view is a **read surface over data that already exists** — there is no new recording path. It answers "what did I ask, when, and in which project" across the whole history (~24 k prompts / ~1 k sessions on a working install), which is what makes it usable as a prompt journal and as a source for the [saved-prompt library](./saved-prompts.md).

## Source Files

| File | Role |
|------|------|
| `src/routes/PromptsView.tsx` | The view: filter bar, source-facet pills, day grouping, `PromptRow` (clamp/expand, copy, 🔖 save, ↗ open), export, pagination. |
| `src/styles/modules/Prompts.module.css` | All view styles, including the `mark` rule and the `max-width: 720px` narrow-window block. |
| `src/lib/textHighlight.ts` | Shared, dependency-free matching/highlighting helpers (`normalizeQuery`, `matchesQuery`, `splitHighlight`, `clipToMatch`) — the same rule the [Conversation View](./conversation-view.md) search uses. |
| `src/lib/textHighlight.test.ts` | `normalizeQuery` case-fold/trim/all-whitespace-collapses-to-empty; the shared match/highlight/clip contract both this view and Conversation View depend on |
| `server/db.ts` | `searchPrompts()` — the paginated `prompts LEFT JOIN sessions` query plus the source-facet SQL. |
| `server/apiRouter.ts` | `GET /api/db/prompts` — rate-limited, clamped, facet-validated wrapper over `searchPrompts`. |
| `src/types/api.ts` | `PromptKind`, `PromptTraceRow`, `PromptSearchParams`, `PromptSearchResponse` (re-exported from `src/types/index.ts`). |
| `src/App.tsx` | `lazy()` route registration at `/prompts`. |
| `src/components/layout/NavBar.tsx` | `PROMPTS` nav item, placed after `HISTORY`. |
| `test/searchPrompts.test.ts` | Facet SQL, LIKE escaping, LEFT JOIN retention, filters, paging. |

## Implementation

### Source facets — why they exist

About **10% of the rows in the `prompts` table were never typed by a human.** The harness posts its own turns through the same `UserPromptSubmit` hook. Measured on a real install (24,358 rows):

| Facet | Rows | Rule |
|-------|------|------|
| `mine` (default) | 21,844 | `NOT agent AND non-blank` — prose **and** commands |
| `cmd` | 3,220 | `NOT agent AND (starts with '/' OR '$') AND non-blank` |
| `agent` | 2,502 | starts with `<` |
| `all` | 24,358 | no filter, blanks included (13 blank rows) |

The `agent` predicate is deliberately generic (`starts with <`) rather than a list of known tags. Every observed form is covered by it — `<task-notification>` (2,190), `<observed_from_primary_session>` (289), `<<autonomous-loop-dynamic>>` (13), `<system-reminder>` (7), `<agent-message …>` (2) — and a list would silently rot the first time the harness adds a tag. `cmd` includes Codex's `$SkillName` form, not just `/slash` (see `entryPrefix` in [command-autocomplete.md](./command-autocomplete.md)).

**SQLite's bare `ltrim(X)`/`trim(X)` strip spaces only** — a leading newline is left in place. All three predicates therefore pass an explicit charset (`' ' || char(9) || char(10) || char(13)`); without it, `"\n  <observed_from_primary_session>"` was classified as something the user typed.

### Server query — `searchPrompts(params)` (`server/db.ts`)

```sql
SELECT p.id, p.session_id, p.text, p.timestamp,
       s.project_name, s.project_path, s.title AS session_title
FROM prompts p LEFT JOIN sessions s ON p.session_id = s.id
[WHERE <facet> AND p.text LIKE ? ESCAPE '\' AND s.project_path = ?
       AND p.session_id = ? AND p.timestamp >= ? AND p.timestamp <= ?]
ORDER BY p.timestamp <dir>, p.id <dir>
LIMIT ? OFFSET ?
```

- **`LEFT JOIN`, deliberately.** better-sqlite3 enables `PRAGMA foreign_keys` by default, so `prompts.session_id` always resolves today and an inner join would behave identically — but this is the one view whose job is to never lose a prompt, and an inner join makes "the session row went missing" mean "the prompt never existed". (The older `fullTextSearch` joins inner and *does* drop them.) Consumers must treat `project_name` / `project_path` / `session_title` as nullable.
- **`p.id` is the sort tiebreak** so pagination is a total order — many prompts share a timestamp to the millisecond.
- **LIKE wildcards in user input are escaped** (`\`, `%`, `_`, via `ESCAPE '\'`). This is not cosmetic: on real data, searching `100%` unescaped returns **852** rows against **144** genuine ones.
- Wrapped in `try/catch` → returns an empty page and `log.warn`s rather than throwing.

### Remote-visibility gate

`router.use('/db/prompts', requireLocalForHistory)` sits in front of the endpoint. History is a SECOND store — hiding a live session from the session list does nothing for its recorded prompt *text*, which this endpoint returns in full — so a remote (non-loopback) client is blocked outright unless the request names one session (`session` query param) that is currently visible to it (`canSeeSession(false, getSession(id))`); localhost is unaffected. An archived session has no in-memory record to carry a visibility flag and therefore resolves to hidden for a remote caller — deliberate fail-closed, since a session that has ended can no longer be opted back in through the UI. See [Multi-Device Presence](../server/multi-device-presence.md) / [Authentication](../server/authentication.md).

### Endpoint — `GET /api/db/prompts`

| Param | Type | Default | Clamp |
|-------|------|---------|-------|
| `query` | string | — | — |
| `project` | string (`project_path`) | — | — |
| `session` | string (`session_id`) | — | — |
| `kind` | `mine`\|`cmd`\|`agent`\|`all` | `mine` | invalid → `mine` |
| `dateFrom` / `dateTo` | epoch ms | — | — |
| `sortDir` | `asc`\|`desc` | `desc` | — |
| `page` | int | 1 | 1…1000 |
| `pageSize` | int | 50 | 1…200 |

Response: `{ prompts: PromptTraceRow[], total, page, pageSize }`.

Rate-limited at **10 requests/second per IP** (`db-prompts:<ip>`) — one notch above `/db/search`'s 5, because the debounced search box plus paging makes this a browse endpoint rather than a one-shot. The text filter is a `LIKE '%…%'` scan that no index can serve.

### View state & constants (`PromptsView.tsx`)

- `PAGE_SIZE = 50`, `CLAMP_CHARS = 320` (hard display cap `CLAMP_CHARS + 160 = 480`).
- `filters: { query, project, kind, dateFrom, dateTo, page }`, seeded from `INITIAL_FILTERS` (`kind: 'mine'`). Any filter change resets `page` to 1.
- TanStack Query keys: `['db-prompts', filters]` (with `placeholderData: (prev) => prev`, so paging doesn't blank the list) and `['db-projects']` (`staleTime: 60_000`, shared with [HistoryView](./views-routing.md)).
- `groupByDay()` groups **consecutive** rows by `toLocaleDateString('en-US', {weekday,day,month,year})`, preserving server order.

### Row rendering

**Clamping windows around the match, not the start.** A 22,510-character prompt whose hit sits at character ~5,000 would otherwise render a row that claims to match and shows no evidence of it. When a query is active the row uses `clipToMatch(text, query, { leading: 100, trailing: CLAMP_CHARS })`, then applies the hard cap regardless — the belt-and-braces cap matters because the client's case-folding can in principle disagree with SQLite's `LIKE`, in which case `clipToMatch` returns the text unchanged.

| Element | Content | Behavior |
|---------|---------|----------|
| `rowTime` | `HH:MM:SS` (`hour12: false`) | static |
| `rowProject` | `project_name` or `unknown project` | static |
| `rowSession` | `sessionDisplayTitle({title, projectName})` | ellipsized, `max-width: 260px` (140px under 720px) |
| `rowLive` | `live` chip | only when `sessionStore.sessions.has(session_id)` |
| `⧉` | copy | `navigator.clipboard.writeText(text)` + toast |
| `🔖` | save to library | `promptSnippetStore.save(text)`; toasts "Already in your saved prompts" on duplicate |
| `↗` | open session | **rendered only when the session is live** — `selectSession(id)` then `navigate('/')` |
| `rowExpand` | `⌄ show all (N chars)` / `⌃ show less` | toggles `expanded`; shown whenever anything is hidden |

Row actions sit at `opacity: 0.4` at rest and `1` on hover/focus-within. They are **not** hidden at `opacity: 0`: they are the only affordances on the row, and at zero nobody discovers them.

`↗` is hidden rather than disabled for dead sessions — most of the 1,000+ sessions in the DB are not in memory, and a rendered-but-dead button is worse than none.

### Toolbar

`↻ Refresh` re-runs the query (disabled while `isFetching`); the list does **not** auto-poll. `Export` downloads the **current page** as JSON (`{schema: 'aasc-prompt-trace', version: 1, exportedAt, filters, count, totalMatching, prompts}`) — `count` is the page, `totalMatching` the full result set, named apart so the file can't be mistaken for a complete export. `Clear filters` appears only when some filter is non-default.

### Summary line & day counts

The header reads `N prompts · showing A–B`. Day-group headers read `N shown`, **not** `N prompts`: a day straddling a page boundary only has part of its rows on screen, so a bare count would be wrong.

## Dependencies & Connections

### Depends On

- [server/database.md](../server/database.md) — `prompts` table, `insertFullPrompt`, `searchPrompts`, `deleteSessionCascade`.
- [server/api-endpoints.md](../server/api-endpoints.md) — hosts `GET /api/db/prompts` and `GET /api/db/projects`.
- [state-management.md](./state-management.md) — `sessionStore` (live-session lookup + `selectSession`).
- [saved-prompts.md](./saved-prompts.md) — `promptSnippetStore.save()` behind the 🔖 action.
- [conversation-view.md](./conversation-view.md) — shares `src/lib/textHighlight.ts`.
- [ui-primitives.md](./ui-primitives.md) — `SearchInput`, `Select`, `Tooltip`, `showToast`.
- [views-routing.md](./views-routing.md) — route registration, `AppLayout` chrome, NavBar entry.
- [session-management.md](../server/session-management.md) — `sessionDisplayTitle()` for row labels.
- [multi-device-presence.md](../server/multi-device-presence.md) — `requireLocalForHistory`/`canSeeSession` gate a remote client's access to `GET /api/db/prompts`.

### Depended On By

- [views-routing.md](./views-routing.md) — renders this view at `/prompts`.

### Shared Resources

- **`prompts` SQLite table** — written by [session-management.md](../server/session-management.md) on every `UserPromptSubmit`; read here and by `fullTextSearch` / `getSessionDetail`.
- **`src/lib/textHighlight.ts`** — shared with the Conversation View search. One definition of "does this text match", so a count can never disagree with what is highlighted.
- **`['db-projects']` query key** — shared cache with HistoryView.
- **`promptSnippets` (Dexie v7)** — the curated library; only an explicit 🔖 writes to it.

## Change Risks

- **Widening the `agent` facet** (e.g. matching any `<` anywhere, not just at the start) would start hiding genuine prompts that merely contain markup. Narrowing it to a fixed tag list makes the default `mine` view fill with harness noise as soon as the harness adds a tag.
- **Dropping the explicit trim charset** from the facet SQL silently reclassifies any prompt behind a leading newline (`ltrim(X)` strips spaces only). Covered by `test/searchPrompts.test.ts`.
- **Removing the LIKE escaping** turns `%` and `_` in a user's query back into wildcards — a search for `100%` quietly returns ~6× the rows.
- **Switching the `LEFT JOIN` to an inner join** makes a prompt vanish whenever its session row is absent, in the one view that exists to guarantee the opposite.
- **Raising `pageSize` past 200** (or removing the clamp) makes a single request serialize an unbounded number of multi-KB prompts; several thousand rows in a real DB exceed 4 KB each.
- **Head-truncating instead of `clipToMatch`** re-introduces rows that match invisibly.
- **Static-importing this view in `App.tsx`** (instead of `lazy()`) would move it, its CSS, and its store imports into the eager entry chunk — see the zero-static-imports rule in [views-routing.md](./views-routing.md).
- **Widening `requireLocalForHistory`'s single-session escape hatch** (e.g. letting a remote client pass an arbitrary `session` param without the `canSeeSession` check) reopens the exact leak the gate exists to close — this endpoint returns full prompt *text*, not just metadata, so it can defeat per-session remote-visibility even while the session list itself stays correctly hidden.
- **No retention policy exists** for the `prompts` table. This view makes the volume visible (a working install is already ~370 MB of `sessions.db`) but does not prune; adding pruning would silently destroy the record this feature exists to present.
