# Project File Browser

## Function
Multi-tab file browser for exploring session project directories with find-in-file search, file bookmarks, split view, and code preview.

## Purpose
Lets users browse and inspect code files in the project directory without leaving the dashboard. Integrates with terminal via clickable file paths.

## Source Files
| File | Role |
|------|------|
| `src/components/session/ProjectTabContainer.tsx` | Tab management (multi-file tabs) |
| `src/components/session/ProjectTab.tsx` | Directory listing, file preview, toolbar |
| `src/components/session/FileTree.tsx` | Hierarchical file tree with lazy loading |
| `src/components/session/FindInFileBar.tsx` | Inline find-in-file search (Cmd/Ctrl+F) |
| `src/components/session/LinkifiedText.tsx` | Clickable file paths in rendered text |
| `src/lib/fileSystemProvider.ts` (~14KB) | File system API client |

## Implementation
- Tab management: default tab at project root, open in new tab, double-click to rename, x to close (last tab recreates root), auto-label from deepest path segment
- Toolbar: search, find-in-file, new file/folder, open in new tab, format (Prettier), toggle outline/bookmarks/word wrap/fullscreen/hidden/datetime, sort by name/date
- File preview: Markdown (GFM + syntax highlight), Excel (XLSX with sheet tabs), code (line numbers + syntax), PDF (blob URL), binary (unsupported indicator)
- Find-in-file: real-time search, case toggle (Aa), match counter ("X of Y"), Previous/Next (Shift+Enter/Enter), exports highlightFindMatches() for code viewer
- LinkifiedText: regex `/(?:\.{0,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.[\w]+/g`, click opens file via uiStore.openFileInProject()
- FileTree: lazy loading on expand, loadingDirs Set prevents duplicate API requests, empty results not cached (retry on next expand), auto-reveal scrolls to activeFilePath, self-sizing via internal ResizeObserver (measures own container height for react-arborist virtualization — no external height prop required), refresh preserves expanded directories (captures open node IDs via TreeApi.get().isOpen before clearing, reloads all previously-loaded dirs in parallel, rebuilds tree depth-first, then re-opens nodes via requestAnimationFrame), auto-refresh polls all loaded directories every 5s via silentRefresh (no loading state flash, no loadedDirs clearing, guarded against overlapping refreshes)
- Per-session tab state persisted in localStorage
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
- localStorage for tab state + bookmarks, uiStore.pendingFileOpen

## Change Risks
- Breaking fileSystemProvider API calls blocks all file operations
- Changing file path regex affects linkified text detection
- loadingDirs dedup prevents duplicate requests — removing it causes API spam
- Auto-reveal must handle async directory loading sequentially
- FileTree refresh reload order: must apply children depth-first (parents before children) so updateNodeInTree can find parent nodes in the tree
- FileTree self-sizing ResizeObserver must stay on the container div — removing it causes tree to render with stale/incorrect height
