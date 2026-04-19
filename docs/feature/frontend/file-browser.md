# Project File Browser

## Function
Multi-tab file browser for exploring session project directories with find-in-file search, file bookmarks, split view, code preview, and an interactive image viewer.

## Purpose
Lets users browse and inspect code/media files in the project directory without leaving the dashboard. Integrates with terminal via clickable file paths.

## Source Files
| File | Role |
|------|------|
| `src/components/session/ProjectTabContainer.tsx` | Tab management (multi-file tabs) |
| `src/components/session/ProjectTab.tsx` | Directory listing, file preview, toolbar, embedded `ImageViewer` subcomponent |
| `src/components/session/FileTree.tsx` | Hierarchical file tree with lazy loading (`forwardRef<FileTreeHandle>`) |
| `src/components/session/FindInFileBar.tsx` | Inline find-in-file search (Cmd/Ctrl+F) |
| `src/components/session/imageViewport.ts` | Pure helpers: zoom/pan clamping, fit-to-screen, cursor-anchored zoom, persistence (de)serialization |
| `src/components/session/LinkifiedText.tsx` | Clickable file paths in rendered text |
| `src/lib/fileSystemProvider.ts` (~14KB) | File system API client |

## Implementation
- Tab management: default tab at project root, open in new tab, double-click to rename, x to close (last tab recreates root), auto-label from deepest path segment
- Toolbar: search, find-in-file, new file/folder, open in new tab, format (Prettier), toggle outline/bookmarks/word wrap/fullscreen/hidden/datetime, sort by name/date, **Collapse all folders**, **Refresh file tree**
- Reveal-in-Finder: on failure shows a red toast (`showToast`) with the server error message instead of silently swallowing
- File preview: Markdown (GFM + syntax highlight), Excel (XLSX with sheet tabs), code (line numbers + syntax), PDF (blob URL), image (interactive `ImageViewer`), binary (unsupported indicator)
- Find-in-file: real-time search, case toggle (Aa), match counter ("X of Y"), Previous/Next bindings — `Enter`/`Shift+Enter`, `ArrowDown`/`ArrowUp`, and document-level `F3`/`Shift+F3` while the bar is mounted; the counter pulses via `.countWrapped` whenever the index wraps past first/last; exports highlightFindMatches() for code viewer
- Image viewer (`ImageViewer` subcomponent in `ProjectTab.tsx`, pure helpers in `imageViewport.ts`):
  - Zoom `0.25x`–`5x` via the toolbar (+/-), the `+`/`=` and `-`/`_` keys, and mouse wheel (cursor-anchored via `zoomAroundCursor`)
  - `0` resets to 100%, `f` fits to the container via `fitToScreenRatio`, double-click on the image also resets
  - When `zoom > 1` the image is pannable: mouse drag (`.dragging` class for cursor feedback) or arrow keys in `PAN_STEP` increments, clamped by `clampPan`
  - Dedicated fit-to-screen toolbar button next to zoom controls
  - Per-file view state persisted in `localStorage['agent-manager:image-view:${filePath}']` as `{ zoom, panX, panY, v: 1 }` with `PERSIST_DEBOUNCE_MS` (200ms) debouncing; serialization via `serializeView`/`parseView` guards malformed/legacy payloads
- LinkifiedText: regex `/(?:\.{0,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.[\w]+/g`, click opens file via uiStore.openFileInProject()
- FileTree: lazy loading on expand, loadingDirs Set prevents duplicate API requests, empty results not cached (retry on next expand), auto-reveal scrolls to activeFilePath, self-sizing via internal ResizeObserver (measures own container height for react-arborist virtualization — no external height prop required), refresh preserves expanded directories (captures open node IDs via TreeApi.get().isOpen before clearing, reloads all previously-loaded dirs in parallel, rebuilds tree depth-first, then re-opens nodes via requestAnimationFrame), auto-refresh polls all loaded directories every 5s via silentRefresh (no loading state flash, no loadedDirs clearing, guarded against overlapping refreshes)
  - Now exported as `forwardRef<FileTreeHandle>`. `FileTreeHandle` exposes `collapseAll()` (closes every open internal node via `TreeApi.close`, then schedules a persist write since react-arborist does not fire `onToggle` on programmatic close) and `refresh()` (awaits the existing refresh routine). ProjectTab wires these to the new toolbar icons via `fileTreeRef`.
- Tree state persistence (per project):
  - `localStorage['agent-manager:tree-state:${projectPath}']` holds `{ openIds: string[], scrollTop: number, v: 1 }`. On mount, persisted open dirs (minus `/`) are loaded in parallel — shallow-first so parents apply before children — then opened via `requestAnimationFrame`; `scrollTop` is restored on the next rAF using `TreeApi.list.current.scrollTo`. Stale openIds that no longer resolve to a dir are skipped silently. Writes are debounced 200ms and scheduled from both `onToggle` and `onScroll`; a flush-on-unmount timer cleanup avoids dangling writes.
  - `localStorage['agent-manager:tree-sort:${projectPath}']` persists `{ field: 'name' | 'date', dir: 'asc' | 'desc' }` and is initialized lazily from storage so the toolbar reflects the last choice per project.
- Per-session tab state persisted in localStorage (separate from tree state)
- File bookmarks: per-project in localStorage['agent-manager:bookmarks:{projectPath}'], records file path, line range, selected text, note

## Dependencies & Connections

### Depends On
- [Server API](../server/api-endpoints.md) — GET /api/files/list|read|stream|search, POST /api/files/write|mkdir
- [State Management](./state-management.md) — uiStore.pendingFileOpen for terminal->project tab navigation
- [Session Detail Panel](./session-detail-panel.md) — rendered inside PROJECT tab

### Depended On By
- [Terminal UI](./terminal-ui.md) — clickable file paths open in project tab
- [Session Detail Panel](./session-detail-panel.md) — split view with terminal

### Shared Resources
- localStorage for tab state, bookmarks, tree state (`agent-manager:tree-state:*`), tree sort (`agent-manager:tree-sort:*`), image viewer state (`agent-manager:image-view:*`)
- uiStore.pendingFileOpen
- Toast container (`showToast`) for Reveal-in-Finder errors

## Change Risks
- Breaking fileSystemProvider API calls blocks all file operations
- Changing file path regex affects linkified text detection
- loadingDirs dedup prevents duplicate requests — removing it causes API spam
- Auto-reveal must handle async directory loading sequentially
- FileTree refresh reload order: must apply children depth-first (parents before children) so updateNodeInTree can find parent nodes in the tree
- FileTree self-sizing ResizeObserver must stay on the container div — removing it causes tree to render with stale/incorrect height
- `FileTreeHandle` contract (collapseAll/refresh) is consumed by ProjectTab toolbar — renaming or removing a method breaks the toolbar buttons
- localStorage payload shape: any change to `agent-manager:tree-state:*`, `agent-manager:tree-sort:*`, or `agent-manager:image-view:*` must bump the embedded `v` field (currently `1`) so stale entries are discarded instead of silently misapplied
- Image viewer pan clamp depends on the container dimensions at transform time — if ProjectTab reflows the preview pane without re-running `clampPan`, the image can land off-screen until the next interaction
