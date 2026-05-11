# Project Browser View (Standalone Route)

## Function
Standalone full-page file browser mounted at `/project-browser?path=<projectPath>&file=<optionalFile>`. Reuses the in-session `ProjectTab` component outside the Detail Panel so the browser can live in its own window/tab.

## Purpose
Users often want to explore a project's file tree without keeping the whole session Detail Panel open. The "Open in new tab" button in the session project tab routes here.

## Source Files
| File | Role |
|------|------|
| `src/routes/ProjectBrowserView.tsx` | Route component — parses query params, resolves origin session, renders header + `ProjectTab` |
| `src/components/session/ProjectTab.tsx` | Shared file browser component (also used inside Detail Panel) |
| `src/styles/modules/ProjectTab.module.css` | `.standalone`, `.standaloneHeader`, `.standaloneTitle`, `.standalonePath`, `.standaloneContent`, `.standaloneEmpty` classes |

## Implementation
- **Query params**:
  - `path` (required) — absolute project path. Missing path renders "No project path specified" hint
  - `file` (optional) — initial file to open; passed to `ProjectTab` as `initialFile`
- **Derived title**: last non-empty path segment, falling back to the full path
- **Rendering**: header bar (`standaloneTitle` + `standalonePath`) + `standaloneContent` wrapper around `ProjectTab` body
- **Origin-session resolution** (ProjectBrowserView.tsx:13-26): reads `useSessionStore` and picks an active session whose `projectPath` matches the requested path (live-status preferred, falling back to any). The resolved id is passed to `ProjectTab` as `originSessionId`, enabling the SelectionPopup (translate/explain) and "Translate file" controls in the standalone view
- **Props passed to `ProjectTab`**: `projectPath`, `initialPath`/`initialIsFile` (from `?file=`), `persistId={`browser-${projectPath}`}` (namespaces tab/tree localStorage keys), `originSessionId` (or `undefined` if no matching session)
- **Navigation source**: launched by the "open in new tab" button inside a session's project tab

## Dependencies & Connections

### Depends On
- [File Browser](./file-browser.md) — embeds `ProjectTab`
- [Views / Routing](./views-routing.md) — registered with react-router
- [API Endpoints](../server/api-endpoints.md) — file list/read endpoints consumed by `ProjectTab`

### Depended On By
- Session-level project tab "open in new tab" button

### Shared Resources
- `useSessionStore` — read-only lookup to find a matching session for translate/explain integration
- `localStorage` keys are namespaced via `persistId={browser-${projectPath}}`, isolating standalone state from in-Detail-Panel state

## Change Risks
- Changing the `?path=` contract breaks every in-app deep link to the browser
- `ProjectTab` expects a session context in some paths — regressions there can surface as empty-state bugs here
- Removing the empty-state branch would render a broken `ProjectTab` when `path` is missing
- The origin-session resolver picks the first matching live session — if multiple sessions share a project, the resolver is non-deterministic about *which* one is forked from

## Floating Terminal Fork
ProjectTab's markdown viewer hosts the SelectionPopup (DOM extractor) and the
"Translate file" toolbar button. When the standalone route resolves a matching
session via `useSessionStore`, both features ARE shown (the popup forks from
the resolved `originSessionId`). When no matching session exists, the controls
are hidden. See [Floating Terminal Fork](./floating-terminal-fork.md).
