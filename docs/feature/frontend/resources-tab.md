# RESOURCES Tab — Agent Resources (Phase B, read-only)

> **Function** One nav tab that lists every Claude Code and Codex resource on
> this machine — skills, commands/prompts, rules, CLAUDE.md/AGENTS.md
> instructions, memory, agents, hooks, MCP servers, plugins and settings,
> global and per project — with previews, package files, and a read-only
> comparison against the `agent-skills` repo copy and against the other
> agent's variant.

## Purpose

Skills, commands, rules and memory are scattered across `~/.claude`,
`~/.codex`, `~/.agents` and dozens of project folders, copied between agents by
hand, and drift silently from the `agent-skills` backup repo. The tab answers
"what do I have, where does it live, and which copies disagree" without opening
a terminal. **Phase B is read-only:** nothing here writes to disk. Sync into the
repo is Phase C; editing, session/history data and watchers are Phase D.

The server half (scan, masking, the `/api/resources` routes) is
[Agent Resources Catalog](../server/agent-resources.md).

## Source Files

| File | Role |
|------|------|
| `src/routes/ResourcesView.tsx` | The tab. Title row with **Library · Sources · Checks** sub-tabs and **Rescan**, filter bar, counts line, the three-pane Library, scan polling, URL state. `lazy()`-loaded from `App.tsx`. |
| `src/components/resources/ResourceTypeRail.tsx` | TYPE rail: all ten types in `RESOURCE_TYPES` order with live counts; zero rows kept. |
| `src/components/resources/ResourceList.tsx` | Middle list: one type's rows with agent/scope/origin/repo/variant/orphaned badges; scroll reset per type/filter; reveals an externally selected row. |
| `src/components/resources/ResourceDetail.tsx` | Right pane: header, **Also in** variant chips, **Preview / Files / Compare**, the resource's findings. |
| `src/components/resources/ResourceMarkdown.tsx` | Markdown preview + frontmatter card. **Only reachable through `React.lazy`** — carries react-markdown, remark-gfm and rehype-highlight. |
| `src/components/resources/ConfigDetail.tsx` | Field table for settings / MCP / hooks / plugins; a masked field always renders `******`. |
| `src/components/resources/ResourceCompare.tsx` | Compare target select, per-file status list, unified patch with add/del colouring. |
| `src/components/resources/SourcesPanel.tsx` | Roots, projects table, coverage tables, **Add folder**. |
| `src/components/resources/ChecksPanel.tsx` | Findings grouped by severity, then check, linking back to the Library. |
| `src/lib/resourcesApi.ts` | `fetch` wrappers for every `/api/resources` route, the envelope check, `ResourcesUnavailableError`, and the guarded `localStorage` helpers for added folders. |
| `src/lib/resourceFilters.ts` | Pure logic: URL params, filters, rail counts, labels, summary line, project ordering, finding/coverage grouping, compare targets, patch classification, frontmatter rows, `isExternalHref`, added-folder validation. |
| `src/styles/modules/Resources.module.css` | All tab styles (≤ 800 lines). |
| `src/components/layout/NavBar.tsx` | `RESOURCES` item, `localOnly: true`. |
| `src/stores/presenceStore.ts` | `isLocalDevice(devices, clientId)` / `thisDeviceIsLocal()` — the gate for `localOnly` nav items. |
| `src/App.tsx` | `const ResourcesView = lazy(() => import('@/routes/ResourcesView'))` + `<Route path="/resources">` inside `AppLayout`. |
| `src/types/resources.ts` | Shared contract with the server (re-exported from `src/types/index.ts`). |
| Tests | `src/lib/resourceFilters.test.ts`, `src/lib/resourcesApi.test.ts`, `src/routes/ResourcesView.test.tsx` (Library, URL state), `ResourcesView.states.test.tsx` (loading/scanning/errors/polling), `ResourcesView.panels.test.tsx` (Sources, Checks), `src/components/resources/ResourceCompare.test.tsx`, `src/components/layout/NavBar.test.tsx`, `src/stores/presenceStore.test.ts`; shared fixture `src/__tests__/fixtures/resourceCatalog.ts` (not a suite). |

## Implementation

### Where the tab appears

- `NAV_ITEMS` gains `{ to: '/resources', label: 'RESOURCES', localOnly: true }`, last in the row.
- `NavBar` filters `localOnly` items with
  `usePresenceStore((s) => isLocalDevice(s.devices, getClientId()))`. The
  server marks each WebSocket device `isLocal` (loopback); the client finds
  itself by `getClientId()` (the WS URL carries `?clientId=`).
  **Before presence arrives the tab is hidden** — the absent state is the safe
  state. A desktop browser on the LAN is remote too, so neither
  `useIsMobile()` nor `electronAPI` is used.
- Hiding the tab does not remove the route: a deep-linked `/resources` on a
  remote device renders the *unavailable* state because every API call 404s.

### URL state (`readResourceParams` / `withParams`)

| Param | Values | Default |
|---|---|---|
| `section` | `library` · `sources` · `checks` | `library` |
| `type` | one of `RESOURCE_TYPES` | first type with results |
| `agent` | `all` · `claude` · `codex` · `shared` | `all` |
| `scope` | `all` · `global` · `project` | `all` (`project` when only `project` is given) |
| `project` | a project id (only under `scope=project`) | — |
| `q` | search text | — |
| `id` | selected resource id | — |
| `plugins` | `1` = show plugin & system items | off |

Unknown values fall back to defaults. The search box keeps a local draft and
writes `q` with `replace`; every other change pushes. URL writes build on the
last *requested* params (`pending` ref) so two writes in one tick compose, and
the ref is cleared in a layout effect on **every** committed URL change — else
returning to an earlier URL (the RESOURCES nav link, browser Back) resurrected
a stale sub-tab or a closed resource on the next filter change.

### Scanning and polling

- `GET /api/resources` on mount. While `state === 'scanning'` the view polls
  again **750 ms after each response** (`POLL_MS`, a chained `setTimeout`, so
  requests never overlap); polling stops on `ready`, `error` or any failure;
  every request is aborted on unmount.
- **Rescan** → `POST /api/resources/scan { extraRoots }`, shows the returned
  state at once, then polls.
- Once per mount, if added folders are saved and no project in the catalog has
  evidence `added`, the view POSTs `/scan` with them — a fresh server's first
  scan is started by `GET /` and cannot carry them.
- The "scanned 2m ago" label re-renders every 30 s (`AGE_TICK_MS`).

### Library

- Grid `184px | minmax(240px, 336px) | minmax(0, 1fr)` — the detail pane takes
  the spare width.
- **TYPE rail**: Skills, Commands, Rules, Instructions, Memory, Agents, Hooks,
  MCP, Plugins, Settings — counts under the current agent/scope/project/search/
  plugin filters (`countByType`). **Zero rows stay visible** (dimmed with
  `--text-secondary`, which keeps 4.5:1): "Instructions 0" under Claude · Global
  says there is no `~/.claude/CLAUDE.md`.
- **Scope**: Claude memory is filed per project but stored under
  `~/.claude/projects/*/memory`, so it matches both **Global** and its own
  project (`inScope` in `resourceFilters.ts`). Nothing else is dual-listed.
- **Show plugin & system** is off by default: `origin` `plugin`/`system` items
  are neither listed nor counted (also not in the counts line) until it is on.
- **Counts line** (`catalogSummaryLine`): per-agent totals · projects that
  still exist · scan age; during a first scan only the progress; a rescan
  keeps the totals.
- **List rows**: name; badges for agent, scope or project, origin
  (`plugin`/`system`/`synced`/`linked`), repo status (`same`/`differs`/
  `not in repo` — none for `not-tracked`), `≠ variant`, `orphaned`; then the
  description or path. The list scrolls back to the top when the type or any
  filter changes (`scrollResetKey`).
- **Detail**: name · type, `agent · scope · origin`, path (→ link target),
  size and repo status, **Also in** chips that jump to a variant, then:
  - **Preview** — markdown through `ResourceMarkdown` (lazy): frontmatter as a
    card of rows (never `<hr>` + `key: value` text); the body renders with
    GFM + highlight.js, **no rehype-raw**; images become `[image: alt]`
    placeholders and never load; only `mailto:` and http(s) links to a
    **non-loopback, other-origin** host are clickable (`isExternalHref` treats
    every loopback form — `localhost`, `127.x`, `[::1]`, `0.0.0.0`, decimal/hex/
    octal/IPv4-mapped — as internal, because under Electron an app-origin URL
    opens an in-app window such as the Project Browser, which can edit files).
    Scripts, text and Codex `policy` rules render in a `<pre>`; config
    resources render `ConfigDetail`.
  - **Files** — package listing; a text file opens read-only via
    `/item/:id/file`.
  - **Compare** — only when the repo status is `same`/`differs` or a variant
    exists in the catalog; per-file status list and the unified patch. A patch
    with no `@@` hunk (identical pair: the `diff` header only) shows
    **No differences.**
- The body is rendered as the server sent it — the client never strips
  frontmatter itself (the server already did; a second strip would eat a
  document's own leading `---` rule).

### Sources

- **Roots**: Claude, Codex, Shared, Repo (or "no agent-skills repo detected").
- **Projects** (`orderProjects`): projects that exist first, then missing ones,
  each A→Z; the heading reads e.g. `68 projects · 31 missing`. Flags: `home`,
  `missing`, `worktree of …`, and `duplicate name` only when two **existing**
  projects share a basename (`sharedProjectNames`). Evidence chips: Claude
  projects dir, Claude config, Codex config, AASC session, added. **Show** links
  to `?section=library&scope=project&project=<id>` (no `type`: the view opens
  the first type the project has).
- **Coverage**: per root, per category — `scanned`, `empty`, `not-found`,
  `not-scanned` (with size, e.g. sessions "Phase D — size only"), `excluded`
  (credentials, "names only, never read"), `inaccessible`, `failed`.
- **Add folder**: an absolute path (≥ 2 segments, no NUL, no `~`, max 50,
  de-duplicated) saved under `localStorage['aasc.resources.extraRoots']`
  (every access in `try/catch`) and sent with the next scan.

### Checks

Findings grouped by severity (errors and warnings open, info collapsed), then
by check with counts. Clicking one selects its resource and clears any filter
that would hide it (adds `plugins=1` for plugin/system items). `repo-only`
findings show their repo path as text.

### States

Loading · scanning (progress) · error with **Retry** · *unavailable* (any 404
from the catalog or scan route → "Resources are available only on this machine
— open AASC on the Mac that runs it.", no Retry) · empty · "the last scan failed
before it found anything". Item-level 404s say the resource/file/compare target
is gone — rescan.

### Layout

- ≤ 900px: the rail becomes a row of chips above list | detail that **wraps**
  (never scrolls sideways — a scrolling strip clipped Plugins and Settings off
  the edge).
- ≤ 480px: one pane at a time; an open resource replaces rail and list, with a
  **Back** button; tables scroll sideways inside their own box.
- Code, diff and `<pre>` panes redefine `--font-mono` (the `windows-xp` theme
  forces it on every element). Every control has hover/active/
  `:focus-visible`/disabled states; list rows use an **inset** focus ring
  (`.listPane` has no side padding). 44px targets on coarse pointers; motion
  only under `prefers-reduced-motion: no-preference`.

## Dependencies & Connections

### Depends On
- [Agent Resources Catalog](../server/agent-resources.md) — every byte shown comes from `/api/resources`.
- [Multi-Device Presence](../server/multi-device-presence.md) — `DevicePresence.isLocal` decides whether the nav item exists.
- [Views & Routing](./views-routing.md) — lazy route inside `AppLayout`; `NAV_ITEMS`.

### Depended On By
- None yet. Phase C (sync) and Phase D (editing, session data) extend this tab.

### Shared Resources
- `localStorage['aasc.resources.extraRoots']` (per viewer).
- The markdown/highlight lazy chunk shared with the PROJECT tab and notes.

## Change Risks

- **Bundle**: `ResourcesView` must stay a `lazy()` route and `ResourceMarkdown`
  must stay behind `React.lazy` — a static import moves react-markdown +
  highlight.js into the eager entry (a source-text test in
  `ResourcesView.test.tsx` fails if anything imports them statically).
- **Read-only**: never call `/api/files/*` and never import `ProjectTab` here —
  that path can write files and is not local-gated.
- **Link safety**: `isExternalHref` must keep rejecting every loopback form, or
  skill/memory text can open in-app windows under Electron.
- **Masking**: `ConfigDetail` renders `******` for any `masked: true` field
  regardless of `value` — keep that belt-and-braces check.
- **Presence gate**: `localOnly` must stay fail-closed (hidden while presence is
  unknown).
- **URL state**: removing the `pending` reset re-introduces resurrected
  sub-tabs/ids; removing `pending` entirely drops keystrokes/`q` on fast clicks.
- **Auto-scan on mount** depends on the server tagging added folders with
  evidence `added`; if it stops, every visit starts a scan.
- **Memory dual-listing** lives in `inScope` — changing Claude memory's scope
  on the server without updating it hides memory from Global again.
