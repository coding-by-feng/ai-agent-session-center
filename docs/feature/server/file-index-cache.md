# File Index Cache

## Function
Per-project cached file index used for fast fuzzy file search. Walks the project directory once, caches `{path, name, pathLower, nameLower, type}` entries, keeps the cache fresh via `fs.watch`, and serves `searchFiles(query)` with a scored fuzzy matcher.

## Purpose
Fuzzy search over large repos via `readdir` on every keystroke is too slow. A cached + debounced-watched index keeps typeahead under a few ms even on repos with tens of thousands of files.

## Source Files
| File | Role |
|------|------|
| `server/fileIndexCache.ts` | Cache, watcher, fuzzy scorer, public API (`searchFiles`, `preloadIndex`, `invalidateCache`) |
| `server/apiRouter.ts` | File search endpoint that consumes `searchFiles` |

## Implementation
- **Constants**:
  - `CACHE_TTL_MS = 30_000` — 30s TTL; watcher refreshes in practice so the TTL is a safety net
  - `MAX_ENTRIES = 50_000` — hard cap on entries per project
  - `MAX_DEPTH = 10` — directory recursion limit
  - `WATCHER_DEBOUNCE_MS = 300` — coalesces fs.watch events before rebuilding
- **Skip dirs** (`SKIP_DIRS`): `node_modules`, `.git`, `.next`, `.nuxt`, `__pycache__`, `.venv`, `venv`, `dist`, `build`, `.cache`, `.turbo`, `coverage`, `.svelte-kit`. Also skips any directory starting with `.`.
- **API**:
  - `searchFiles(root: string, query: string, maxResults = 50) → { results: SearchResult[]; indexing: boolean }` — sync lookup using cached entries; triggers `ensureIndex` if missing. Returns `{ results: [], indexing: true }` when the cache is cold (still building)
  - `preloadIndex(root)` — warms the cache without blocking
  - `invalidateCache(root)` — drops the cached entries (watcher rebuilds on next query)
- **Fuzzy scorer** (`fuzzyScore`): matches on both filename and full path (lowercase), with bonuses for contiguous matches, word boundaries, and filename vs. path hits.
- **Watcher**: one `fs.watch` per root with a 300ms debounce timer (`debounceTimers` Map) before rebuilding.
- **In-flight guard**: `building` Set prevents concurrent rebuilds of the same root.

## Dependencies & Connections

### Depends On
- Node `fs/promises` + `fs.watch`

### Depended On By
- [API Endpoints](./api-endpoints.md) — file search route
- [File Browser](../frontend/file-browser.md) — UI that drives fuzzy search
- [Session Detail Panel](../frontend/session-detail-panel.md) — project tab file finder

### Shared Resources
- In-memory `cache` Map keyed by absolute project root
- `watchers` Map keyed by root — one watcher per project

## Caller Contract
- `searchFiles` returns `{ results, indexing }`. Callers MUST check `indexing: true` (cold-cache signal) and surface a "still indexing" UI state — `apiRouter.ts:1922` (`/api/files/search`) already forwards this flag. Treating an empty `results` as "no matches" while `indexing` is true would hide files during the initial walk.

## Change Risks
- Adding a new skip dir without regenerating existing caches keeps stale entries until TTL
- `MAX_ENTRIES` truncation is silent — repos exceeding the cap lose tail files from search
- `fs.watch` is platform-inconsistent; relying solely on it (and removing the TTL fallback) would drop changes on filesystems where watch fires inconsistently
- Scorer tweaks shift ranking across all fuzzy-search callers — spot-check typeahead after edits
