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
| `src/styles/modules/ProjectTab.module.css` | `.standalone`, `.standaloneHeader`, `.standaloneTitle`, `.standalonePath`, `.standaloneContent`, `.standaloneEmpty` classes; `.markdown ::selection` cyan highlight for SelectionPopup support |

## Implementation

### Standalone route (`ProjectBrowserView.tsx`)
- **Query params**:
  - `path` (required) — absolute project path. Missing path renders a "No project path specified" hint (uses `.standaloneEmpty`, with a `?path=/your/project` example)
  - `file` (optional) — initial file to open; passed to `ProjectTab` as `initialPath` with `initialIsFile` set true
- **Derived title** (`projectName`): last non-empty path segment (`path.split('/').filter(Boolean).pop()`), falling back to the full path
- **Rendering**: header bar (`standaloneTitle` + `standalonePath`) + `standaloneContent` wrapper around `ProjectTab` body
- **Origin-session resolution**: reads `useSessionStore` and picks a session whose normalized `projectPath` (trailing slash stripped) matches the requested path. A non-`ended` session is preferred (`live`); otherwise the first match of any status (`any`) is used. The resolved id is passed to `ProjectTab` as `originSessionId`, enabling the SelectionPopup (translate/explain) and "Translate file" controls in the standalone view
- **Props passed to `ProjectTab`**: `projectPath`, `initialPath`/`initialIsFile` (from `?file=`), `persistId={`browser-${projectPath}`}` (namespaces tab/tree localStorage keys, e.g. `agent-manager:file-tabs:browser-<path>`), `originSessionId` (or `undefined` if no matching session)
- **Route registration**: declared in `App.tsx` **outside** `AppLayout` (no nav/header chrome) and lazy-loaded behind a `Suspense` fallback
- **Navigation source**: the "open in new tab" button inside a session's project tab. When `ProjectTab` runs inside the Detail Panel it prefers the `onOpenBrowserTab` callback (opens an in-app sub-tab); only when that callback is absent does it `window.open('/project-browser?path=...', '_blank')` — which is the path that lands on this standalone route

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

## Floating Terminal Fork
ProjectTab's markdown viewer hosts the SelectionPopup (DOM extractor) and the
"Translate file" toolbar button. Both are gated on `translationEnabled` AND a
truthy `originSessionId` AND the active file being markdown (`md`/`mdx`). When the
standalone route resolves a matching session via `useSessionStore`, the features
ARE shown (the popup forks from the resolved `originSessionId`); when no matching
session exists, the controls are hidden. See [Floating Terminal Fork](./floating-terminal-fork.md).
