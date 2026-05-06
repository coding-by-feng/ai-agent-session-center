# Project Browser View (Standalone Route)

## Function
Standalone full-page file browser mounted at `/project-browser?path=<projectPath>&file=<optionalFile>`. Reuses the in-session `ProjectTab` component outside the Detail Panel so the browser can live in its own window/tab.

## Purpose
Users often want to explore a project's file tree without keeping the whole session Detail Panel open. The "Open in new tab" button in the session project tab routes here.

## Source Files
| File | Role |
|------|------|
| `src/routes/ProjectBrowserView.tsx` | Route component — parses query params, renders header + `ProjectTab` |
| `src/components/session/ProjectTab.tsx` | Shared file browser component (also used inside Detail Panel) |
| `src/styles/modules/ProjectTab.module.css` | `.standalone`, `.standaloneHeader`, `.standaloneTitle`, `.standaloneEmpty` classes |

## Implementation
- **Query params**:
  - `path` (required) — absolute project path. Missing path renders "No project path specified" hint
  - `file` (optional) — initial file to open; passed to `ProjectTab` as `initialFile`
- **Derived title**: last non-empty path segment, falling back to the full path
- **Rendering**: header bar (standalone title) + `ProjectTab` body; no session context — operates on the project directory directly
- **Navigation source**: launched by the "open in new tab" button inside a session's project tab

## Dependencies & Connections

### Depends On
- [File Browser](./file-browser.md) — embeds `ProjectTab`
- [Views / Routing](./views-routing.md) — registered with react-router
- [API Endpoints](../server/api-endpoints.md) — file list/read endpoints consumed by `ProjectTab`

### Depended On By
- Session-level project tab "open in new tab" button

### Shared Resources
- No session state — path-driven only, so it works without any live session

## Change Risks
- Changing the `?path=` contract breaks every in-app deep link to the browser
- `ProjectTab` expects a session context in some paths — regressions there can surface as empty-state bugs here
- Removing the empty-state branch would render a broken `ProjectTab` when `path` is missing

## Floating Terminal Fork
ProjectTab's markdown viewer hosts the SelectionPopup (DOM extractor) and the
"Translate file" toolbar button when invoked from a DetailPanel that has an
active session id. Standalone Project Browser route has no session, so both
features are hidden there. See [Floating Terminal Fork](./floating-terminal-fork.md).
