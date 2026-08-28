# Project File Browser

## Function
VS Code-style file browser for a session's project directory: a lazy-loading tree on the left and a multi-file-tab viewer on the right, with fuzzy file search, grep-across-project content search, inline find-in-file, file/folder create/delete/upload, markdown editing, LaTeX preview, an interactive image viewer, and a fullscreen mode.

## Purpose
Lets users browse and inspect code/media files in the project directory without leaving the dashboard. Integrates with the terminal via clickable file paths and with the translate/review pipeline via in-place select-to-translate and saved-selection highlights.

## Source Files
| File | Role |
|------|------|
| `src/components/session/ProjectTabContainer.tsx` | Sub-tab management — each sub-tab is an independent `ProjectTab` instance; opens new sub-tabs, renames (double-click), closes (last tab recreates a root sub-tab), persists per session |
| `src/components/session/ProjectTab.tsx` | Main browser: tree + viewer split, file tabs, toolbar, preview renderers, and embedded subcomponents (`ImageViewer`, `ExcelViewer`, `WordViewer`, `VirtualCodeViewer`, `SearchOverlay`, `InlineInput`, `DeleteConfirmOverlay`). Accepts `originSessionId` to enable in-place translate/explain |
| `src/components/session/FileTree.tsx` | react-arborist tree with lazy loading (`forwardRef<FileTreeHandle>`), per-project state persistence, auto-refresh, auto-reveal, per-row delete |
| `src/lib/fileTypeIcon.ts` | `resolveFileIconKind(name, isDir)` — the single extension → icon-kind map, shared by every file/dir row (see "File-type icons" below) |
| `src/components/ui/FileTypeIcon.tsx` | 9 small `currentColor` SVG glyphs (folder/doc/code/config/style/shell/database/image/lock), selected by `resolveFileIconKind` |
| `src/components/session/FindInFileBar.tsx` | Inline find-in-file bar (Cmd/Ctrl+F); exports `highlightFindMatches()` |
| `src/lib/searchNormalize.ts` | Length-preserving text normalization for find-in-file (`normalizeForSearch`/`foldDashes`/`DASH_RE`) — folds dash/hyphen variants to `-` and case-folds so match offsets stay aligned |
| `src/components/session/ContentSearchModal.tsx` | Grep-across-project content-search modal (Cmd/Ctrl+Shift+F) |
| `src/styles/modules/ContentSearch.module.css` | Search + glob-pattern input styling for `ContentSearchModal` |
| `src/components/session/imageViewport.ts` | Pure helpers: zoom/pan clamping, fit-to-screen, cursor-anchored zoom, persistence (de)serialization |
| `src/lib/projectEditGuard.ts` | Where `ProjectTab` reports unsaved `mdDraft` / `newFileContent` state, so `DetailPanel`'s LRU cannot unmount it mid-edit |
| `src/components/session/LinkifiedText.tsx` | Clickable file paths in rendered text |
| `src/components/session/TexViewer.tsx` | LaTeX (`.tex`) renderer (lazy-loaded `latex.js`) used by ProjectTab's preview pane |
| `src/styles/modules/TexViewer.module.css` | Faux-paper card styling for the rendered `.tex` document |
| `src/lib/fileSystemProvider.ts` | File system abstraction — `ApiFileSystemProvider` (default, fetches `/api/files/*`) and `LocalFileSystemProvider` (File System Access API, Chromium/localhost) |
| `src/lib/filePathLink.ts` | Shared Unicode-aware file-path regex (`createFilePathRegex`) + xterm buffer column mapping (`mapLineColumns`) — used by both LinkifiedText and the terminal link provider so the two stay in sync |
| `src/components/translate/SelectionPopup.tsx` | Selection→popup with translate/explain modes (rendered above the markdown / fullscreen viewers) |
| `src/hooks/useSelectionPopup.ts` | Selection capture + popup placement logic |
| `src/lib/scrollWithinContainer.ts` | `scrollIntoContainer(scroller, target, opts)` — scrolls a target into view within ONE named container, unlike `Element.scrollIntoView()` which walks and scrolls *every* scrollable ancestor (an `overflow: hidden` box is still programmatically scrollable). Wired into the Markdown outline's click handler: `scrollIntoContainer(markdownRef.current, el, { block: 'start' })`, scoped to `.markdown` (`overflow-y: auto`) — **not** `.mdContainer`, its parent, which is `overflow: hidden` and never scrolls itself; passing the wrong one silently no-ops |
| `src/lib/scrollWithinContainer.test.ts` | 15 tests for `computeScrollTop`/`scrollIntoContainer`, all passing. The `scrollIntoView` non-call assertion assigns a mock directly (`target.scrollIntoView = vi.fn()`) rather than `vi.spyOn` — jsdom does not implement `scrollIntoView` on `Element`, so `spyOn` (which requires the property to already exist) threw before the assertion ever ran |
| `src/lib/markdownHeadings.ts` | The OTHER half of the outline-click chain: `extractHeadings(content)` (raw markdown → `{level, text, slug}[]` for the OUTLINE panel list), `headingSlug(text)`, and `childrenToText(children)` (flattens a rendered heading's React children to plain text — see "Markdown extras" below). Extracted from `ProjectTab.tsx` (one of the largest files in the codebase) for standalone testability, matching this file's own `fileTypeIcon.ts` precedent |
| `src/lib/markdownHeadings.test.ts` | 13 tests: `headingSlug`/`extractHeadings` basics, `childrenToText` flattening (string/number/array/nested elements), and two "agrees with extractHeadings" tests that build the actual React children shape by hand and assert the two independently-computed slugs match — plus a named regression test for the two-separate-underscored-filenames false-positive caught while writing `stripInlineMarkdown` (see Change Risks) |
| `src/lib/markdownHeadings.render.test.tsx` | 3 tests that render real markdown through the actual `ReactMarkdown` + `remarkGfm` pipeline (not hand-built children) and drive the exact `querySelector([id="${slug}"])` lookup the outline's click handler performs — closes the one assumption the pure-function tests can't cover: that react-markdown actually shapes `children` the way `childrenToText` expects |

## Implementation

### Layout & tabs
- VS Code split (`vscodeSplit`): collapsible tree panel on the left (drag divider, width 140–600px persisted), viewer panel with file-tab bar on the right.
- `ProjectTabContainer` manages sub-tabs; the sub-tab bar only appears when >1 sub-tab exists. Labels auto-derive from the deepest path segment and disambiguate against conflicts by prepending the parent dir.
- `ProjectTab` manages file tabs (one per opened file): clicking a tab restores cached content instantly; closing the active tab falls back to the last tab (or the welcome screen). File content is cached in a ref `Map` for instant tab switching; cached blob URLs are revoked on close/unmount.
- The cache (`fileCacheRef`) is an **LRU capped at `MAX_CACHED_FILES = 12`** per project tab. `cacheFile()` inserts and evicts; `touchCachedFile()` marks a cache hit most-recently-used (called on tab click and on the tab-close fallback) so Map iteration order stays least- → most-recently-used. Evicting revokes the entry's blob URL. Entries hold the file's full decoded content plus parsed Excel sheets, mammoth-rendered Word HTML, and PDF/image blob URLs, so an uncapped cache retained tens of MB per mounted tab. **Two entries are never evicted:** the file just loaded, and the one currently rendered (tracked by `activeFilePathRef`) — revoking either one's blob URL would blank the viewer.
- `ProjectTab` reports unsaved editor state (`mdDraft`, `newFileContent`) to [`src/lib/projectEditGuard.ts`](../../../src/lib/projectEditGuard.ts), keyed `originSessionId` → `persistId`, so `DetailPanel`'s LRU never unmounts a container mid-edit. Neither draft is persisted, so eviction would discard them. See [Session Detail Panel](./session-detail-panel.md) "Visited projects".
- `originSessionId` prop (optional): when set, enables in-pane translate/explain controls — `SelectionPopup` instances on the markdown and fullscreen viewers. Hidden entirely when `originSessionId` is undefined (e.g. standalone Project Browser route with no matching session). (The former **Translate file** toolbar button was removed.)

### File-type icons (`FileTypeIcon`)
- Every file/directory row across three surfaces — the tab bar, the `FileTree` panel, and the "search files by name" modal — renders a small `currentColor` SVG via `<FileTypeIcon name isDir className>` (`src/components/ui/FileTypeIcon.tsx`), sized/colored entirely by the caller's own CSS class (`.fileTabIcon`, `.icon`, `.fileIcon` respectively — each sets `width`/`height`/`color`, no default size on the component itself).
- `resolveFileIconKind(name, isDir)` (`src/lib/fileTypeIcon.ts`) is the single source of truth for extension → icon: 17 extensions collapse into 9 `FileIconKind`s (`folder`/`doc`/`code`/`config`/`style`/`shell`/`database`/`image`/`lock`) — `ts/tsx/js/jsx/py/go/rs/java/html` all resolve to `code` rather than each getting a distinct shape. Unmapped extensions fall back to `doc`.
- **Replaced a raw platform emoji, and a duplicated one at that.** Both `ProjectTab.tsx` and `FileTree.tsx` used to carry their own byte-identical local `fileIcon()` returning a Unicode emoji (📝/🐍/🔵/…) — inconsistent with every other icon in the app (hand-drawn SVG, `stroke="currentColor"`, recolors per theme) since emoji render in the OS font's own fixed color/style regardless of CSS `color`. Both locals are gone; `FileTypeIcon` is the only implementation now.
- **`FileTree`'s per-row delete button got the same treatment, but stayed separate.** Its 🗑 emoji is now a local `TrashIcon` SVG (`FileTree.tsx`, right above `makeNodeRenderer`) — deliberately **not** folded into `FileTypeIcon`/`resolveFileIconKind`, since it's an *action* icon (delete) rather than a *file-type* one, and the two shouldn't share one API. It inherits `.deleteBtn`'s own `color` (dim by default, `var(--accent-red)` on hover) via `currentColor` rather than setting its own.

### Collapse/expand pane
- A chevron toggle (`collapseToggleBtn`) is rendered as the leftmost control in the breadcrumb row (only present when a file is open). It sets `paneCollapsed`; `collapsed = paneCollapsed && !!file`.
- When `collapsed`, the whole pane folds to a single breadcrumb strip (`toolbar collapsedStrip`): the icon toolbar (`iconBar`) and the entire `vscodeSplit` (tree + tabs + content) are both gated behind `{!collapsed && (…)}`. The strip carries the chevron (now an expand glyph), the reusable `breadcrumbNode`, and the copy-path button so the expand affordance survives the collapse.
- The breadcrumb render is extracted into a `breadcrumbNode` element reused by both the normal toolbar and the collapsed strip; `collapseToggleBtn` swaps its chevron path on `collapsed`.
- Per-session persistence: `localStorage['agent-manager:project-collapsed:${persistId}']` (only when `persistId` is provided), mirroring the `treePanelCollapsed` pattern. State restores on mount and writes on change.

### Toolbar
Search files, content search, find-in-file (toggle), new file, new folder, open project in new tab, **open external path** (prompts for an absolute or `~/`-prefixed path; resolves via `GET /api/files/resolve` and opens the file/folder in a fresh sub-tab — useful for files outside the session project, e.g. `~/.config/gcloud/application_default_credentials.json`), reveal in Finder, **format** (in-browser JSON pretty-print / XML/SVG/HTML re-indent via `formatXml` — not Prettier), toggle markdown outline, markdown **edit** mode, word wrap, fullscreen, then a separator and **Collapse all folders** + **Refresh** (re-fetches file, preserving scroll, and dispatches `filetree:refresh`).
  - The translate-file, TₑX preview/source toggle, bookmarks, collection, and recent-files toolbar buttons were removed to declutter the bar (along with their panels, handlers, per-project `localStorage` persistence, and tooltip entries). `.tex` files now render unconditionally via `TexViewer` (the former default), and the cross-cutting `fileBrowserToggleBookmark` shortcut definition + the separate TerminalContainer bookmark portal were left intact.
- Reveal-in-Finder / open-external / copy-path failures show a red toast (`showToast`) with the server error message instead of silently swallowing.

### File preview renderers
Dispatched by extension/streamable flags inside `fileViewer`:
- **Excel** (`.xlsx`/`.xls`) — parsed in-browser with `xlsx` (SheetJS) into `ExcelViewer` (sheet tabs, padded columns).
- **Word** (`.docx`/`.doc`) — converted to HTML in-browser by `mammoth` (lazy-loaded ~500KB chunk via dynamic `import('mammoth/mammoth.browser')`) in `loadFile`, sanitized with `DOMPurify` (`USE_PROFILES: { html: true }`), and rendered by `WordViewer` on a centred light "paper" sheet (`.wordDoc`, responsive `clamp()` padding). Legacy binary `.doc` cannot be parsed by mammoth → `WordViewer` shows a "convert to .docx" message (`data.docError`). Both `.docx`/`.doc` are in the server **and** client `STREAMABLE_EXTENSIONS` (with stream MIME types) so the bytes are fetched (API stream URL or local blob URL) rather than treated as an opaque binary placeholder.
- **PDF** — `<iframe>` over a blob URL.
- **Image** — interactive `ImageViewer` (keyed by `file.path`).
- **Video / Audio** — native `<video>`/`<audio>` over the stream URL.
- **Binary** — "Binary file (size)" placeholder.
- **LaTeX** (`.tex`) — `TexViewer` (rendered preview; the source/preview toggle was removed).
- **Markdown** (`.md`/`.mdx`) — `ReactMarkdown` (GFM + `rehypeHighlight` + saved-selection plugin) when not in edit mode; a `<textarea>` editor when `mdEdit` is on (Cmd/Ctrl+S saves via `writeFile`, Esc cancels).
- **Code** — line-numbered viewer. Files with more than `VIRTUALIZE_THRESHOLD` (10,000) lines use `VirtualCodeViewer` (absolute-positioned rows, `LINE_HEIGHT_PX=20`, `OVERSCAN=30`); smaller files render every line.
- A portaled **fullscreen** overlay re-runs the same dispatch (Escape closes).

### Markdown extras
- Relative `.md`/`.mdx` links open the target in-app (resolved against the current dir); relative `<img>` srcs are rewritten to `provider.streamUrl(...)`; external links open in a new tab.
- Headings get slug `id`s (`headingSlug(childrenToText(children))`, from `markdownHeadings.ts`) matching the **outline** side panel (draggable divider, width 120–400px, further capped at 45% of the container width during drag (`Math.min(400, containerWidth * 0.45)`), persisted under `outline-panel-width`). The outline list itself comes from `extractHeadings(file.content)`, parsed independently from the raw markdown source — see Change Risks for why these two slug computations have to be kept in agreement by hand.
- **Saved-selection highlights**: favorited selections for the open file (`listFavoritedByFile`) are injected as `<mark data-saved-uuid>` via `makeSavedSelectionsPlugin`; clicking one navigates to `/review?uuid=…` (see [Review Tab](./review-tab.md)).

### Find-in-file (`FindInFileBar`)
Real-time search, case toggle (Aa), match counter ("X of Y" / "No results"), navigation via `Enter`/`Shift+Enter`, `ArrowDown`/`ArrowUp`, and document-level `F3`/`Shift+F3` while the bar is mounted; the counter pulses via `.countWrapped` (600ms) when the index wraps. Exposes `onTermChange`, `onActiveMatchChange({line,col})`, and `onActiveIdxChange(idx,total)`. Exports `highlightFindMatches(text, term, caseSensitive, activeLineMatch?, currentLine?)` for the code viewers.
- Code/virtualized views highlight via line-anchored `<mark>`s (`fv-line-N`); the currently-focused match gets `.find-match-active`, others `.find-match`.
- Rendered markdown has no line anchors, so ProjectTab walks the DOM text nodes, wraps matches in `<mark class="find-match">`, and scrolls the active one (by flat `findActiveIdx`) into view.
- Matching is **dash/hyphen-insensitive and case-fold-aware** via `normalizeForSearch` (`src/lib/searchNormalize.ts`, added v2.10.31): `foldDashes`/`DASH_RE` map en/em dash, minus sign, fullwidth hyphen, and the rest of U+2010..U+2015 / U+2212 / U+FE58 / U+FE63 / U+FF0D to plain `-` (U+002D). The fold is length-preserving (every variant is a single UTF-16 code unit) so match offsets stay aligned. `FindInFileBar.tsx` applies it to both the term and the searched text; `ProjectTab.tsx` reuses it for markdown/code highlighting.

### Image viewer (`ImageViewer` + `imageViewport.ts`)
- Zoom range `ZOOM_MIN=0.1`–`ZOOM_MAX=8` (0.1x–8x). Toolbar +/- and the `+`/`=` / `-`/`_` keys step by `ZOOM_STEP=0.25`; the mouse wheel zooms multiplicatively (`zoom * Math.exp(-deltaY * 0.001)`, cursor-anchored via `zoomAroundCursor`). Ctrl/Meta+wheel always zooms; plain wheel zooms only when the container is focused.
- `0` resets to 100%, `f`/`F` fits to the container via `fitToScreenRatio`, double-click resets.
- When `zoom > 1` the image is pannable: mouse drag (window-level listeners; `grab`/`grabbing` cursor) or arrow keys in `PAN_STEP` (30px) increments, clamped by `clampPan`.
- Per-file view persisted in `localStorage['agent-manager:image-view:${filePath}']` as `{ zoom, panX, panY, v: 1 }`, debounced `PERSIST_DEBOUNCE_MS` (200ms); `serializeView`/`parseView` guard malformed/legacy payloads.

### FileTree (`FileTree.tsx`)
- Lazy loads children on expand; `loadingDirs` Set prevents duplicate requests; empty results are not cached (retry on next expand).
- Self-sizing via an internal `ResizeObserver` (measures its own container height for react-arborist virtualization — no external `height` prop required).
- **Auto-reveal**: when `activeFilePath` changes, sequentially loads ancestor dirs then opens them and `scrollTo`s the file (double rAF).
- **Refresh** (`filetree:refresh` event or `FileTreeHandle.refresh()`): captures open node IDs via `TreeApi.get().isOpen`, clears `loadedDirs`, reloads root + all previously-loaded dirs in parallel, rebuilds depth-first (parents before children so `updateNodeInTree` can find parents), then re-opens via `requestAnimationFrame`.
- **Auto-refresh**: `silentRefresh` polls all loaded directories every 5s (no loading flash, no `loadedDirs` clear, guarded by `refreshingRef`; open-state snapshot taken *after* the awaits to respect concurrent collapses).
- **Per-row delete**: trash button (`TrashIcon` SVG — see "File-type icons" above) + Cmd/Ctrl+Delete (or Backspace) on the focused row call `onRequestDelete(relPath, name, isDir)`; the parent confirms via `DeleteConfirmOverlay` and deletes via `provider.deleteEntry` → `POST /api/files/delete`.
- **`FileTreeHandle`** (via `forwardRef`): `collapseAll()` closes every open internal node via `TreeApi.close` then schedules a persist write (react-arborist does not fire `onToggle` on programmatic close), and `refresh()` awaits the refresh routine. ProjectTab wires both to toolbar buttons via `fileTreeRef`.

### File operations
- **Create**: inline `InlineInput` for new file (opens a textarea editor that saves via `writeFile`) / new folder (`mkdir`, then `filetree:refresh`).
- **Upload**: paste or drag-drop files onto the tree panel → `provider.uploadFile` per file (text via `text()`, binary via base64), then `filetree:refresh` + a success/warning toast.
- **Context menu** on directory entries: Open, Open in new browser tab, Delete.

> Bookmarks, Collections, and Recent-files history were removed from the file browser (toolbar buttons, panels, and their `localStorage['agent-manager:{bookmarks,collections,recent-files}:${projectPath}']` persistence). The separate terminal-selection bookmark portal (TerminalContainer / `DetailPanel.bookmarkPortalTarget`) is unrelated and remains.

### Scroll position persistence
Markdown + code viewers save/restore `scrollTop` per file under `localStorage['file-browser:scroll:${projectPath}:${filePath}']` across tab switches, app restarts, refresh (re-fired via `refreshNonce`), and tab-visibility changes (a root `ResizeObserver` restores on `display:none → flex`).

### Search overlays
- **Fuzzy file search** (`SearchOverlay`): debounced (80ms) `provider.searchFiles`; invalidates + preloads the index on open; retries up to 5× while the server reports `indexing`.
- **Content search** (`ContentSearchModal`): grep across project files; selecting a result loads the file and queues a pending scroll line.

### Keyboard / event wiring
Listens for global custom events on `document` (only acts when this instance is visible via `offsetParent`): `projectTab:contentSearch`, `projectTab:findInFile`, and `fileBrowser:action` (dispatched by the shortcut system with `actionId` ∈ `fileBrowserSearch` / `fileBrowserContentSearch` / `fileBrowserNewFile` / `fileBrowserNewFolder` / `fileBrowserRefresh` / `fileBrowserOpenNewTab` / `fileBrowserFormat` / `fileBrowserToggleOutline` / `fileBrowserToggleWordWrap` / `fileBrowserFullscreen`). Note: `fileBrowserToggleBookmark` is still *defined* in `shortcutKeys.ts` (unbound, `combo: null`) but ProjectTab has no handler for it since bookmarks were removed — it is inert.

### LinkifiedText
A shared Unicode-aware regex from [`filePathLink.ts`](../../../src/lib/filePathLink.ts) (`createFilePathRegex()` → `(?:\.{0,2}/)?(?:[\p{L}\p{N}\p{M}@.+_-]+/)+[\p{L}\p{N}\p{M}@.+_-]+\.[\w]+` with the `gu` flags) detects file paths in plain text — non-ASCII segments (CJK, Cyrillic, accented Latin) match, but the extension stays ASCII (`\w`) so a match can't greedily swallow CJK prose that follows a filename with no space. A fresh instance is returned per call because the `g` flag carries mutable `lastIndex`. Clicking calls `uiStore.openFileChooser(clean, projectPath, { x, y })`, which shows the [File-Open Chooser](./file-open-chooser.md) popover. Its "Open in app" action then routes through `uiStore.openFileInProject(clean, projectPath)` (the pre-existing PROJECT-tab flow).

### TexViewer
Lazy-imports `latex.js` (~5MB) and renders a `DocumentFragment` into a host div. On parse failure it retries with `buildFallbackSource` — strips the preamble + `UNSUPPORTED_CMDS` (page/layout, counters, macro defs, fonts, hooks, bibliography, etc.), drops external `\input`/`\include`, converts `\cite` to bracketed text, de-stars sectioning — wraps the body in a minimal `article` scaffold, and shows a warning that custom packages/macros were dropped. Recomputes when `source` or `fileKey` changes.

`.paper` and `.paper :global(.katex)` set their serif families by **redefining `--font-mono`** on themselves rather than declaring `font-family` outright. The `windows-xp` theme forces `font-family: var(--font-mono) !important` on every element (see [Settings System](./settings-system.md)); a plain declaration would lose to it and render the LaTeX paper in Tahoma.

### Tree state persistence (per project)
- `localStorage['agent-manager:tree-state:${projectPath}']` holds `{ openIds: string[], scrollTop: number, v: 1 }` (`TREE_STATE_VERSION = 1`). On mount, persisted open dirs (minus `/`) load in parallel shallow-first, then open via `requestAnimationFrame`; `scrollTop` restores on the next rAF via `TreeApi.list.current.scrollTo`. Stale openIds that no longer resolve are skipped. Writes debounce 200ms from both `onToggle` and `onScroll`, with a flush-on-unmount cleanup.
- Tree panel width/collapsed state persist under `file-browser:tree-panel-width` and `file-browser:tree-panel-collapsed`.
- Whole-pane collapse state persists per session under `agent-manager:project-collapsed:${persistId}`.

## Dependencies & Connections

### Depends On
- [Server API](../server/api-endpoints.md) — GET `/api/files/list|read|stream|search|grep|resolve`, POST `/api/files/write|mkdir|delete|reveal|open-external|search/invalidate`, POST `/api/sessions/spawn-floating`
- [State Management](./state-management.md) — `uiStore.pendingFileOpen`/`openFileInProject` for terminal→project-tab navigation
- [Session Detail Panel](./session-detail-panel.md) — rendered inside the PROJECT tab
- [Floating Terminal Fork](./floating-terminal-fork.md) — selection-popup (translate/explain) forks spawn floating PIP terminals
- [Review Tab](./review-tab.md) — saved-selection highlights deep-link to `/review?uuid=…`

### Depended On By
- [Terminal UI](./terminal-ui.md) — clickable file paths open in the project tab
- [Session Detail Panel](./session-detail-panel.md) — split/stacked view with terminal; the PROJECT pop-out window renders `ProjectBrowserView` via `PopoutProjectView`
- [Project Browser](./project-browser.md) — standalone `/project-browser` route reuses `ProjectTab`

### Shared Resources
- localStorage: sub-tab state (`agent-manager:project-tabs:*`), file-tab state (`agent-manager:file-tabs:*`), tree state (`agent-manager:tree-state:*`), image-view (`agent-manager:image-view:*`), scroll positions (`file-browser:scroll:*`), tree panel width/collapsed, whole-pane collapse (`agent-manager:project-collapsed:*`), outline width
- `uiStore.pendingFileOpen`
- Toast container (`showToast`)
- `document` custom events: `filetree:refresh`, `projectTab:contentSearch`, `projectTab:findInFile`, `fileBrowser:action`

## Change Risks
- **`resolveFileIconKind` is the only extension → icon map — don't re-duplicate it.** `ProjectTab.tsx` and `FileTree.tsx` used to each hand-roll an identical `fileIcon()` emoji map; that's exactly the kind of drift risk this codebase already has one documented case of (`CommandEntry`, [Command Autocomplete](./command-autocomplete.md)). Adding a new file-row surface should call `<FileTypeIcon>`, not write a third copy of the extension table. `FileTypeIcon`'s glyphs are sized by the CALLER's CSS class (`width`/`height` on the class, not the component) — a class that still sets `font-size` for it is a no-op left over from the emoji era.
- Breaking fileSystemProvider API calls blocks all file operations.
- `STREAMABLE_EXTENSIONS` is duplicated in the server (`apiRouter.ts`, plus a stream MIME-type map) and the client (`fileSystemProvider.ts` `LocalFileSystemProvider`) — adding a previewable binary type (e.g. Word) requires updating **both** or the file falls back to the "Binary file" placeholder. The Word conversion in `loadFile` is provider-agnostic: it fetches `data.blobUrl || provider.streamUrl(...)`, so it works for both the API and local providers.
- `mammoth` is dynamically imported (`import('mammoth/mammoth.browser')`) and has no bundled types — `src/types/mammoth.d.ts` declares the `convertToHtml`/`extractRawText` surface. Mammoth output is injected via `dangerouslySetInnerHTML`, so it **must** stay wrapped in `DOMPurify.sanitize`; removing the sanitizer reintroduces an XSS path from document hyperlinks.
- Changing the shared path regex in `filePathLink.ts` affects clickable-path detection in **both** LinkifiedText (conversation/notes) and the xterm terminal link provider (`useTerminal`) — they intentionally share one pattern, so test both surfaces.
- `loadingDirs` dedup prevents duplicate requests — removing it causes API spam.
- Auto-reveal must load ancestor dirs sequentially before opening/scrolling.
- FileTree refresh reload order must apply children depth-first (parents before children) so `updateNodeInTree` can find parent nodes.
- FileTree self-sizing `ResizeObserver` must stay on the container div — removing it renders the tree with stale/incorrect height.
- `.input`/`.globInput` in `ContentSearch.module.css` referenced `var(--bg-input)` — undefined in every theme file — so the content-search fields always rendered the same hardcoded fallback regardless of theme. Fixed to `var(--bg-card)`.
- **The Markdown outline click scrolls `.markdown`, never `.mdContainer`.** They're parent/child (`.mdContainer` wraps `.outlinePanel` + `.markdown` as a flex row) and `.mdContainer` is `overflow: hidden` — passing it as the `scroller` to `scrollIntoContainer` computes against an element whose `scrollTop`/`scrollHeight`/`clientHeight` never change, so the call silently does nothing. This is exactly the class of mistake the whole utility exists to prevent, just one container up — get the ref right at the call site, since nothing else catches it.
- **The outline's slug and the rendered heading's `id` are computed from two different inputs and must be kept in agreement by hand — they silently weren't, for any heading with inline markdown.** `extractHeadings()` parses the raw markdown *source* text; the h1-h6 renderers compute their `id` from React's rendered `children` *prop*. For a plain-text heading these happen to be the same string, but any inline markdown — a code span, a link, bold — makes `children` an array mixing strings and elements (a code span's text sits inside its own `<code>` child), and the old `headingSlug(String(children))` stringified the array/elements themselves ("[object Object]"-style garbage), not their visible text. The two slugs never matched, so `markdownRef.current?.querySelector([id="${h.slug}"])` found nothing and the outline entry did nothing on click — for the actual reported document, on every heading (`EDIT N — \`file.md\``-style). Fixed via `childrenToText()` (`markdownHeadings.ts`), which walks the real children tree instead of stringifying it, **and** a matching `stripInlineMarkdown()` pass on `extractHeadings()`'s side so both slugs are computed from equivalently-cleaned text rather than relying on `headingSlug`'s punctuation-strip regex to accidentally erase the delta (which it does for backticks/`**bold**`, both non-word delimiter chars, but not for a link's URL text or `_italic_`'s literal underscores). `stripInlineMarkdown()` deliberately does **not** strip single-underscore `_italic_` — a naive `/_([^_]+)_/` has no word-boundary awareness, so on a heading with two separate underscored filenames (exactly this bug's own reported document) it spans from the first filename's underscore to the second's, swallowing everything between as "italic content"; CommonMark itself excludes intraword underscores from emphasis for the same reason. Covered end-to-end by `markdownHeadings.test.ts` (13 tests, pure-function) and `markdownHeadings.render.test.tsx` (3 tests, real `ReactMarkdown` + `remarkGfm` render + the exact `querySelector` lookup the click handler performs).
- `silentRefresh` must snapshot open state *after* its awaits, or a concurrent collapse will be re-opened.
- `FileTreeHandle` contract (`collapseAll`/`refresh`) is consumed by the ProjectTab toolbar — renaming/removing a method breaks the buttons.
- localStorage payload shapes: any change to `agent-manager:tree-state:*` or `agent-manager:image-view:*` must bump the embedded `v` field (currently `1` / `TREE_STATE_VERSION` / `PERSIST_VERSION`) so stale entries are discarded rather than misapplied.
- Image viewer pan clamp depends on container dimensions at transform time — reflowing the preview pane without re-running `clampPan` can land the image off-screen until the next interaction.
- `VIRTUALIZE_THRESHOLD`/`LINE_HEIGHT_PX` must stay in sync with the CSS line height, or virtual scroll math drifts.
