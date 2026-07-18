# File Index Cache

## Function
Per-project cached file index used for fast fuzzy file search. Walks the project directory once, caches `{path, name, pathLower, nameLower, type}` entries, keeps the cache fresh via `fs.watch`, and serves `searchFiles(query)` with a scored fuzzy matcher.

## Purpose
Fuzzy search over large repos via `readdir` on every keystroke is too slow. A cached + debounced-watched index keeps typeahead under a few ms even on repos with tens of thousands of files.

## Source Files
| File | Role |
|------|------|
| `server/fileIndexCache.ts` | Cache, watcher, fuzzy scorer, public API (`searchFiles`, `listTopEntries`, `preloadIndex`, `invalidateCache`) |
| `server/apiRouter.ts` | `GET /api/files/search` (non-empty query → `searchFiles`; empty query → `listTopEntries`), `POST /api/files/search/invalidate` (consumes `invalidateCache`), and proactive `invalidateCache` calls in the write/mkdir/delete file endpoints |

## Implementation
- **Constants**:
  - `CACHE_TTL_MS = 30_000` — 30s TTL; watcher refreshes in practice so the TTL is a safety net
  - `MAX_ENTRIES = 50_000` — hard cap on entries per project
  - `MAX_DEPTH = 10` — directory recursion limit
  - `WATCHER_DEBOUNCE_MS = 300` — coalesces fs.watch events before rebuilding
- **Skip dirs** (`SKIP_DIRS`): `node_modules`, `.git`, `.next`, `.nuxt`, `__pycache__`, `.venv`, `venv`, `dist`, `build`, `.cache`, `.turbo`, `coverage`, `.svelte-kit`. Also skips any directory starting with `.`.
- **API**:
  - `searchFiles(root: string, query: string, maxResults = 50) → { results: SearchResult[]; indexing: boolean }` — sync lookup using cached entries; triggers `ensureIndex` if missing. Returns `{ results: [], indexing: true }` when the cache is cold (still building)
  - `listTopEntries(root: string, maxResults = 20) → { results: SearchResult[]; indexing: boolean }` — no-query variant that powers the initial `@`-mention dropdown before the user types anything. Calls `ensureIndex(root)`; returns `{ results: [], indexing: true }` when the cache is cold (client retries). Otherwise returns the **shallowest** entries: precomputes depth by counting `/` characters via `charCodeAt` (not `split()`, which would allocate an array on every one of O(n log n) comparisons), then sorts by depth ascending, **directories before files** at equal depth, then `name.localeCompare` — sliced to `maxResults`. Each result is mapped to `{ path: '/' + path, name, type, score: 0 }`, mirroring the `{ results, indexing }` shape of `searchFiles`
  - `preloadIndex(root)` — warms the cache without blocking
  - `invalidateCache(root)` — drops the cached entries (watcher rebuilds on next query)
- **Fuzzy scorer** (`fuzzyScore`): tiered scoring on the lowercased name then path — exact name (1000), name prefix (800+), name substring (600+), path substring (400+), in-order fuzzy on name (200+ with a +10/char contiguity bonus), in-order fuzzy on path (50+ with a +5/char contiguity bonus); `-1` if no match. Results are sorted by score desc, then `name.localeCompare`, and sliced to `maxResults`. Returned `path` is prefixed with `/` (e.g. `/src/utils/format.ts`).
- **Watcher**: one recursive `fs.watch` per root (`watchers` Map). The callback skips events whose filename includes `node_modules` or `/.git/`, then debounces 300ms (`debounceTimers` Map) and **deletes** the cache for that root (a lazy rebuild on next `searchFiles`). Watch errors and unsupported recursive-watch platforms are swallowed silently. `ensureIndex` starts/refreshes the watcher whenever it runs.
- **In-flight guard**: `building` Set prevents concurrent rebuilds of the same root.
- **Endpoint behavior** (`GET /api/files/search?root=&q=`): per-IP rate limited (20 req/window, `429` over cap), validates `root` via `isAllowedProjectRoot` (`400` if invalid). For an **empty/whitespace query** it forwards `{ results, indexing }` from `listTopEntries(root)` — the shallowest entries that seed the initial `@`-mention dropdown (`preloadIndex` is implicit via `ensureIndex` inside `listTopEntries`; a cold cache returns `indexing: true` and the client retries). Non-empty queries forward `{ results, indexing }` from `searchFiles`.
- **Proactive invalidation**: `POST /api/files/search/invalidate` (`{ root }`) calls `invalidateCache`, and the write/mkdir/delete file endpoints call `invalidateCache(root)` after a successful mutation so dashboard-initiated edits drop the stale index immediately rather than waiting on `fs.watch`.

## Dependencies & Connections

### Depends On
- Node `fs/promises` + `fs.watch`

### Depended On By
- [API Endpoints](./api-endpoints.md) — file search route (`searchFiles` for typed queries, `listTopEntries` for the empty-query seed)
- [Command Autocomplete](../frontend/command-autocomplete.md) — the `AutocompleteTextarea` `@`-mention picker calls `GET /api/files/search` with an empty query on open, which serves `listTopEntries`
- [File Browser](../frontend/file-browser.md) — UI that drives fuzzy search
- [Session Detail Panel](../frontend/session-detail-panel.md) — project tab file finder

### Shared Resources
- In-memory `cache` Map keyed by absolute project root
- `watchers` Map keyed by root — one watcher per project

## Caller Contract
- `searchFiles` returns `{ results, indexing }`. Callers MUST check `indexing: true` (cold-cache signal) and surface a "still indexing" UI state — `GET /api/files/search` in `apiRouter.ts` already forwards this flag. Treating an empty `results` as "no matches" while `indexing` is true would hide files during the initial walk.

## Change Risks
- Adding a new skip dir without regenerating existing caches keeps stale entries until TTL
- `MAX_ENTRIES` truncation is silent — repos exceeding the cap lose tail files from search
- `fs.watch` is platform-inconsistent; relying solely on it (and removing the TTL fallback) would drop changes on filesystems where watch fires inconsistently
- Scorer tweaks shift ranking across all fuzzy-search callers — spot-check typeahead after edits
- The empty-query path now returns `{ results, indexing }` from `listTopEntries` (previously `{ results: [] }` with no `indexing` key); callers that ignore `indexing` may show an empty `@`-picker on a cold cache instead of retrying
- Changing `listTopEntries`' sort order or the `charCodeAt` slash-count reorders the initial `@`-mention dropdown; swapping in `split('/')` would reintroduce the per-comparison array allocation the depth precompute avoids
