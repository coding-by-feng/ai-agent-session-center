# Project Browser View (Standalone Route)

## Function
Standalone full-page file browser mounted at `/project-browser?path=<projectPath>&file=<optionalFile>`. Reuses the in-session `ProjectTab` component outside the Detail Panel so the browser can live in its own window/tab. This doc also covers `useKnownProjects` — the hook that surfaces known Claude Code project paths (from `~/.claude/projects/`) inside every working-directory dropdown.

## Purpose
Users often want to explore a project's file tree without keeping the whole session Detail Panel open. The "open in new tab" button in the session project tab routes here. Separately, `useKnownProjects` makes it easy to (re)open any project the user has previously worked in by seeding the workdir comboboxes with auto-discovered project paths.

## Source Files
| File | Role |
|------|------|
| `src/routes/ProjectBrowserView.tsx` | Route component — parses query params, resolves origin session, renders header + `ProjectTab` |
| `src/hooks/useKnownProjects.ts` | Hook merging localStorage `workdir-history` with server-discovered project paths from `/api/known-projects` |
| `src/components/session/ProjectTab.tsx` | Shared file browser component (also used inside Detail Panel) — see [File Browser](./file-browser.md) for the full feature surface |
| `src/components/session/PopoutProjectView.tsx` | Electron popped-out PROJECT window renderer (`/?popout=project&path=…`) — wraps `ProjectBrowserView` and supplies the `useSettingsInit` (theme) + `useWebSocket(null)` (populates the sessions store for the origin-session resolver) context a fresh `<App>` boot would otherwise provide, plus its own `<FileOpenChooser/>` |
| `src/styles/modules/ProjectTab.module.css` | `.standalone`, `.standaloneHeader`, `.standaloneTitle`, `.standalonePath`, `.standaloneContent`, `.standaloneEmpty` classes; `.markdown ::selection` cyan highlight for SelectionPopup support |

## Implementation

### Standalone route (`ProjectBrowserView.tsx`)
- **Query params**:
  - `path` (required) — absolute project path. Missing path renders a "No project path specified" hint (uses `.standaloneEmpty`, with a `?path=/your/project` example)
  - `file` (optional) — initial file to open; passed to `ProjectTab` as `initialPath` with `initialIsFile` set true. Its only in-app producer is the file-tree **context menu → "Open in new tab"** (`handleContextOpenNewTab`), which builds `/project-browser?path=<projectPath>&file=<entryPath>` for a file entry (a directory entry opens the bare `?path=` form). Note `initialPath`/`initialIsFile` only win when localStorage has no prior tab state for this `persistId` — a restored active file tab takes precedence
- **Derived title** (`projectName`): last non-empty path segment (`path.split('/').filter(Boolean).pop()`), falling back to the full path
- **Rendering**: header bar (`standaloneTitle` + `standalonePath`) + `standaloneContent` wrapper around `ProjectTab` body
- **Origin-session resolution**: reads `useSessionStore` and picks a session whose normalized `projectPath` (trailing slash stripped) matches the requested path. A non-`ended` session is preferred (`live`); otherwise the first match of any status (`any`) is used. The resolved id is passed to `ProjectTab` as `originSessionId`, enabling the SelectionPopup (translate/explain) in the standalone view
- **Props passed to `ProjectTab`**: `projectPath`, `initialPath`/`initialIsFile` (from `?file=`), `persistId={`browser-${projectPath}`}` (namespaces tab/tree localStorage keys: `agent-manager:file-tabs:browser-<path>` for the open-tab set + active tab, `agent-manager:project-collapsed:browser-<path>` for the collapsed pane state), `originSessionId` (or `undefined` if no matching session)
- **Route registration**: declared in `App.tsx` **outside** `AppLayout` (no nav/header chrome) and lazy-loaded behind a `Suspense` fallback
- **Navigation sources**:
  - The "open in new tab" button inside a session's project tab. When `ProjectTab` runs inside the Detail Panel it prefers the `onOpenBrowserTab` callback (opens an in-app sub-tab); only when that callback is absent does it `window.open('/project-browser?path=...', '_blank')` — which is the path that lands on this standalone route
  - The right-click **Open in New Tab** context action (`handleContextOpenNewTab`) — an **unconditional** `window.open(..., '_blank')`, with no `onOpenBrowserTab` preference. Under Electron this used to escape into the user's default browser; it now lands in a native window because [`attachWindowOpenPolicy`](../electron/app-lifecycle.md#windowopen-policy-attachwindowopenpolicy) recognises our own origin. The route itself is unchanged — the fix is in the shell, so this and any future bare `window.open` of an in-app route are covered without touching the call site
  - **Popped-out PROJECT tab** (`openProjectWindow` in `DetailTabs.tsx`, reached from the PROJECT tab's **detach** icon): under Electron calls `window.electronAPI.openProjectWindow({ path, label: 'Project' })` → native window rendering `PopoutProjectView` (de-duped by path — a second click focuses the existing window); in a plain browser falls back to `window.open('/project-browser?path=…', name)`, landing on this standalone route. It deliberately does **not** take that fallback under Electron with a stale preload — see [Session Detail Panel](./session-detail-panel.md). Covered by `DetailTabs.test.tsx` (Electron call, browser fallback, stale-preload guard, no-call when unavailable)

### Popped-out window (`PopoutProjectView.tsx`)
- Rendered as the *entire* renderer when the window is loaded as `/?popout=project&path=…` (dispatched in `src/main.tsx`; the window is created in `electron/main.ts` via `new URLSearchParams({ popout: 'project', path: projectPath })`). It replaces the old `⧉` behaviour of opening `/project-browser` inside a fresh `<App>` boot ("another chrome instance")
- Wraps `ProjectBrowserView` (which still reads `?path=` / `?file=` itself) and adds `useSettingsInit()` for the theme and `useWebSocket(null)` to populate the sessions store the origin-session resolver needs
- **Gotcha**: auth tokens are *not* carried into the popout (`useWebSocket(null)` — localhost Electron runs without auth). A password-protected setup would need token plumbing here
- **Placement & geometry**: `registerProjectWindowHandler` (`electron/main.ts`) places the window via `computePopoutBounds('project')` (second monitor when one exists, else the display under the cursor; default `1400×900` — its own default, not shared with the terminal popout's smaller `820×560`), `minWidth: 480, minHeight: 320`, `backgroundColor: '#ece9d8'` (matches the default theme). `moved`/`resized` both call `savePopoutBounds('project', …)`, persisting to `popout-bounds.json` under its OWN `'project'` key (fixed Aug 2026 — previously one bounds slot was shared across all popout kinds, so resizing this window leaked its size onto the next terminal float too) and restored on the next open (validated against connected displays). `attachWindowOpenPolicy(w)` is attached so any in-app link clicked inside stays native rather than escaping to the system browser. Same machinery the terminal popout uses, distinct bounds slot — see `electron/popoutBounds.ts`, [Floating Terminal Fork → Pop-out to a native window](./floating-terminal-fork.md#pop-out-to-a-native-window), and [App lifecycle](../electron/app-lifecycle.md)

### Known projects hook (`useKnownProjects.ts`)
- Returns a deduplicated `string[]` of working directories, ordered **history first, then known projects** (`mergeDirectories` preserves history order and appends only unseen known paths)
- **Initial value**: synchronous read of `localStorage['workdir-history']` (`WORKDIR_HISTORY_KEY = 'workdir-history'`), parsed as a JSON array; malformed JSON falls back to `[]`
- **Effect**: on mount, fetches `GET /api/known-projects` → `{ paths: string[] }`, re-reads history, and merges. A `cancelled` flag guards against setState after unmount; fetch failure silently keeps the history-only list
- **Server endpoint** (`GET /api/known-projects`, in `apiRouter.ts`): reads `~/.claude/projects/`, skips non-directories and any entry whose name contains `worktrees`, decodes each dir name back to a real path (`decodeProjectDir`), drops `/`, sorts ascending, and returns `{ paths }`. Errors return `{ paths: [] }`
- **Consumers**: `NewSessionModal`, `QuickSessionModal`, and `WorkdirLauncher` all call `useKnownProjects()` to populate their working-directory comboboxes. Each of those components owns its own `workdir-history` *writes* (appending the chosen dir on launch); the hook is read-only

## Dependencies & Connections

### Depends On
- [File Browser](./file-browser.md) — embeds `ProjectTab` (tree, file tabs, viewers, search)
- [Views / Routing](./views-routing.md) — `/project-browser` registered with react-router in `App.tsx`
- [API Endpoints](../server/api-endpoints.md) — `GET /api/known-projects` plus the file list/read/stream endpoints consumed by `ProjectTab`
- [State Management](./state-management.md) — `useSessionStore` lookup for origin-session resolution
- [Floating Terminal Fork](./floating-terminal-fork.md) — translate/explain popup forks from the resolved `originSessionId`

### Depended On By
- Session-level project tab "open in new tab" button (standalone route)
- `PopoutProjectView` — the Electron popout window renders this route's component directly (not via react-router)
- [Session Creation Modals](./session-creation-modals.md) — `NewSessionModal` / `QuickSessionModal` workdir pickers consume `useKnownProjects`
- `WorkdirLauncher` (header quick-launch) workdir picker consumes `useKnownProjects`

### Shared Resources
- `useSessionStore` — read-only lookup to find a matching session for translate/explain integration
- `localStorage['workdir-history']` — shared MRU list; read by `useKnownProjects`, written by the launch flows
- `localStorage` file-browser keys are namespaced via `persistId={browser-${projectPath}}`, isolating standalone tab state from in-Detail-Panel state

## Change Risks
- Changing the `?path=` contract breaks every in-app deep link to the browser
- `ProjectTab` expects a session context in some paths — regressions there can surface as empty-state bugs here
- Removing the empty-state branch would render a broken `ProjectTab` when `path` is missing
- The origin-session resolver picks the first matching non-ended session — if multiple sessions share a project, *which* one the popup forks from is non-deterministic
- Changing the `{ paths }` shape of `/api/known-projects`, or renaming the `workdir-history` localStorage key, breaks the workdir dropdowns in all three consumers — keep the key and response shape stable across hook and writers
- `decodeProjectDir` must mirror Claude Code's project-dir encoding; if it drifts, known-project paths come back malformed and dropdowns show wrong directories
- **`.standalone`'s background used to be theme-invariant.** `ProjectTab.module.css`'s `.standalone` wrapper (the popped-out window's root element) referenced `var(--bg-base, #0a0a1a)` — `--bg-base` is not defined in any of the 10 theme files, so every theme rendered the identical dark-navy fallback regardless of selection, while `.standaloneHeader`/`.standaloneTitle`/etc. right below it correctly tracked the theme. Fixed to `var(--bg-primary, #0a0a1a)`, matching `base.css`'s own `body { background: var(--bg-primary) }` (`.standalone` is the popup's body-equivalent). **The lesson for any future standalone-window CSS**: a fake variable name compiles fine, lints clean, and only shows up as a bug when someone actually switches themes — grep `var(--name` usages against the real token set in `src/styles/themes/*.css` before trusting a rule "looks themed."
- **`.treePanel`'s background was theme-invariant too, but a plainer version of the same mistake — no `var()` at all.** It was a literal `rgba(10, 10, 26, 0.5)`, the *dark* theme's own navy read straight off the swatch, so under a light theme (windows-xp, blonde, warm, light) it painted a dark, semi-transparent layer over whatever the panel actually renders underneath — reported as the file tree "looking not fresh," which is what a muddy dark-over-light overlay looks like. Fixed to `var(--bg-panel)` (defined in all 10 themes; the dark-theme default in `base.css`, `#0e0e24`, is close enough to the old literal that dark themes look unchanged). Between this and the `--bg-base` case above, `ProjectTab.module.css` has now produced two of the *same* category of bug — a real reason to grep the whole file for `rgba(10, 10, 26` / `rgba(255, 255, 255` literals and fake `var(--name` tokens together next time it's touched, rather than trusting a third instance won't exist.

## Floating Terminal Fork
ProjectTab's markdown viewer hosts the SelectionPopup (DOM extractor via
`extractDomSelection`). There is **no** "Translate file" toolbar button any more —
the popup is the only trigger here (the `translate-file` mode survives server-side
only; see [Floating Terminal Fork](./floating-terminal-fork.md)).

Two `useSelectionPopup` instances are mounted, one per viewer surface, and they are
mutually exclusive on `showFullscreen`:
- `popup` — `enabled: translationEnabled && !!originSessionId && !mdEdit && !showFullscreen && isMarkdownFile`, `containerRef: markdownRef`
- `popupFs` — `enabled: translationEnabled && !!originSessionId && showFullscreen && isMarkdownFile`, `containerRef: markdownFsRef`

`isMarkdownFile` is `file?.ext === 'md' || file?.ext === 'mdx'`; `!mdEdit` means the
popup is suppressed while the markdown editor is open. Both render `<SelectionPopup>`
only when `popup.active && originSessionId`, passing `currentFilePath={activeTabPath || undefined}`
(no `spawnTerminalId`, so the fork parent is the origin session itself). When the
standalone route resolves a matching session via `useSessionStore` the popup IS
available; when no matching session exists, `originSessionId` is undefined and the
whole surface is disabled.
