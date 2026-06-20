# File-Open Chooser

## Function
Anchored popover that appears when a file-path link is clicked (in the conversation view or in terminal output) and lets the user choose how to open the file: in the in-app viewer, with the OS default application, or revealed in the OS file manager.

## Purpose
Assistant output and terminal logs often list document files (PDFs, spreadsheets, images). Before this feature, clicking a path silently opened the in-app viewer. The chooser gives an explicit per-click decision — e.g. a PDF can go straight to macOS Preview, or be highlighted in Finder for drag-and-drop — without losing the in-app preview path.

## Source Files
| File | Role |
|------|------|
| `src/components/session/FileOpenChooser.tsx` | The popover component: portaled `position: fixed` menu at the click anchor, three actions + Cancel, Esc / click-outside dismissal. |
| `src/styles/modules/FileOpenChooser.module.css` | Popover styling (dark navy card, cyan accents, 240px wide, fade-in animation). |
| `src/stores/uiStore.ts` | `pendingFileChooser` state + `openFileChooser(filePath, projectPath, anchor)` / `clearFileChooser()` actions. |
| `src/lib/filePathLink.ts` | Shared path detector: `createFilePathRegex()` (Unicode-aware `/gu` regex — matches non-ASCII segments like `客户版-业务流程确认.md`) and `mapLineColumns(line)` (maps string code-unit offsets → terminal columns, accounting for double-width CJK cells). Used by both triggers so they never drift. |
| `src/components/session/LinkifiedText.tsx` | Conversation-side trigger: click/Enter on a detected file path (via `createFilePathRegex()`) opens the chooser. |
| `src/hooks/useTerminal.ts` | Terminal-side trigger: the file-path `registerLinkProvider`'s `activate(event)` opens the chooser at the mouse position. Detection uses `createFilePathRegex()`; link column ranges come from `mapLineColumns()` so wide (CJK) characters stay aligned. |
| `src/lib/fileSystemProvider.ts` | `openExternal(projectRoot, relPath)` on the provider interface — POST `/api/files/open-external` (LocalFileSystemProvider delegates to the API provider). |
| `server/apiRouter.ts` | `POST /api/files/open-external` — validates root/path, then `execFile` of the platform open command. |

## Implementation
- **Path detection**: both triggers detect paths with the shared `createFilePathRegex()` (`src/lib/filePathLink.ts`). It is Unicode-aware — path segments accept any `\p{L}\p{N}\p{M}` plus `@.+_-`, while the extension stays ASCII (`\w`) so a filename immediately followed by CJK prose (e.g. `客户版.md文件`) still resolves to `客户版.md`. At least one `/` is required (bare `word.doc` in prose is not linkified). The terminal trigger additionally runs `mapLineColumns(line)` to convert the regex's UTF-16 match offsets into true terminal columns, because double-width CJK cells make `match.index`/`length` arithmetic mis-locate the link range.
- **State flow**: link click → `uiStore.openFileChooser(cleanPath, projectPath, { x, y })` → `<FileOpenChooser>` (subscribed to `pendingFileChooser`) renders. Every action and dismissal ends with `clearFileChooser()`.
- **Anchor**: viewport coordinates from the click event (`clientX/clientY`); keyboard Enter in LinkifiedText anchors to the link's `getBoundingClientRect()` bottom-left. Position is clamped to the viewport with `POPUP_W = 240`, `POPUP_H = 196`, `VIEWPORT_MARGIN = 12` (same clamp pattern as SelectionPopup), offset +6px below the anchor.
- **Rendering**: `createPortal` to `document.body` (escapes transformed/scrolling ancestors), `z-index: 9000`, `role="menu"` with `role="menuitem"` buttons, first button focused on open.
- **Actions**:
  - **Open in app** — `uiStore.openFileInProject(filePath, projectPath)`; the pre-existing `pendingFileOpen` flow switches the detail panel to the PROJECT tab and loads the file ([File Browser](./file-browser.md)).
  - **Open with default app** — `getFileSystemProvider().openExternal(projectPath, filePath)` → `POST /api/files/open-external`.
  - **Reveal in Finder** (label "Reveal in file explorer" off-macOS, detected via `navigator.platform`) — `getFileSystemProvider().reveal(projectPath, filePath)` → existing `POST /api/files/reveal`.
  - **Cancel** — dismiss only. Esc (capture-phase keydown) and click-outside (`useClickOutside`, mousedown) also dismiss.
- **No-project guard**: when `projectPath` is empty (e.g. a popout terminal without session context), the two external actions are `disabled` with an explanatory tooltip; "Open in app" stays enabled.
- **Mount points**: once in `AppLayout` ([Views & Routing](./views-routing.md)) and once in `PopoutTerminalView` (separate React root — see [Floating Terminal Fork](./floating-terminal-fork.md)).
- **Server endpoint** `POST /api/files/open-external` (body `{ root, path }`): validation identical to `/api/files/reveal` (`isAllowedProjectRoot` → `filePathSchema` (max 1024 chars) → `resolveProjectPath` traversal check → `existsSync`). Platform commands: macOS `open <path>`, Windows `cmd /c start "" <path>`, Linux `xdg-open <path>`. Fire-and-forget `execFile`; errors logged as `files-open-external`, response is `{ ok: true }`.

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — `uiStore.pendingFileChooser` + `pendingFileOpen`
- [File Browser](./file-browser.md) — `fileSystemProvider.openExternal/reveal`, in-app open flow
- [Server API](../server/api-endpoints.md) — `POST /api/files/open-external`, `POST /api/files/reveal`

### Depended On By
- [Conversation View](./conversation-view.md) — LinkifiedText file-path clicks open the chooser
- [Terminal UI](./terminal-ui.md) — terminal file-path link provider opens the chooser
- [Floating Terminal Fork](./floating-terminal-fork.md) — PopoutTerminalView mounts its own chooser instance

### Shared Resources
- `pendingFileOpen` uiStore flow (chooser's "Open in app" feeds the same consumer chain: DetailPanel → ProjectTabContainer → ProjectTab.loadFile)
- Viewport-clamp popup pattern shared stylistically with `SelectionPopup` (constants duplicated per component, not imported)

## Change Risks
- **Anchor contract**: both triggers must pass viewport (client) coordinates. Passing page or cell coordinates renders the popover off-position — the terminal trigger relies on xterm's `ILink.activate(event)` receiving the real MouseEvent.
- **Relative-path semantics**: paths resolve against the session's `projectPath` (not the terminal's live cwd, which is untracked). If path cleaning in the triggers (`replace(/^\.\//, '')`) diverges from `resolveProjectPath` on the server, external open and in-app open can disagree about which file they target.
- **Unicode/regex contract**: `createFilePathRegex()` must keep the `u` flag and the ASCII-only extension. Narrowing segment classes back to `\w` re-breaks non-English paths (the original bug); widening the extension to `\p{L}` makes it greedily swallow trailing CJK text. The terminal trigger must keep using `mapLineColumns()` — reverting to `match.index + 1` columns mis-aligns links on any line containing wide characters.
- **OS-execution surface**: `open`/`start`/`xdg-open` launch the file's default handler — for executable types (`.sh`, `.command`, `.app`) that can mean *running* it. Path validation confines this to files inside an allowed project root; loosening `isAllowedProjectRoot`/`resolveProjectPath` widens this directly.
- **Both mounts must survive refactors**: removing the `PopoutTerminalView` mount silently breaks the chooser in popped-out terminals (separate React root — the AppLayout instance can't render there).
- **z-index 9000** sits alongside SelectionPopup (9000) and below TitleBar (99999); raising fullscreen-viewer overlays above 9000 would bury the chooser.
