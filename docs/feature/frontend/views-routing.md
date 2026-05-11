# Views & Routing

## Function
React Router v7 client-side routing providing 6 views: Live, Agenda, History, Queue, Review, Project Browser.

## Purpose
Organizes the dashboard into distinct functional areas accessible via navigation bar.

## Source Files
| File | Role |
|------|------|
| `src/routes/LiveView.tsx` | 3D Cyberdrome scene (or flat list when 3D disabled) with Suspense + error boundary |
| `src/routes/HistoryView.tsx` | Paginated session archive with filters (uses @tanstack/react-query) |
| `src/routes/QueueView.tsx` | Global prompt queue across all sessions |
| `src/routes/AgendaView.tsx` | Task management |
| `src/routes/ReviewView.tsx` | Review view — translation/explain log review (translationLog) |
| `src/routes/ProjectBrowserView.tsx` | Standalone file browser (route: /project-browser, no AppLayout chrome) |
| `src/App.tsx` | Router + layout + providers (QueryClientProvider, SetupWizard gate, AuthGate, Dashboard, AppLayout) |
| `src/components/layout/NavBar.tsx` | Navigation bar (LIVE, AGENDA, HISTORY, QUEUE, REVIEW + NEW/QUICK session buttons + WorkdirLauncher) |
| `src/components/layout/TitleBar.tsx` | Window title bar (Electron drag region + window controls) |
| `src/components/session/FloatingTerminalRoot.tsx` | Renders all PIP fork-translate floating terminals from floatingSessionsStore |

## Implementation
- LiveView: lazy-loads CyberdromeScene via Suspense with SceneErrorBoundary. When scene3dEnabled is false, shows FlatView (RobotListSidebar + SceneOverlay, no WebGL)
- HistoryView: filters (query, project, status, date range, sort), paginated 50/page, uses @tanstack/react-query for data fetching
- AgendaView: task priorities (Urgent/High/Medium/Low), collapsible Done section, search + priority + tag filters (uses agendaStore)
- QueueView: global view of all session queues, grouped by session with table layout, add prompt to any session via Select dropdown
- ProjectBrowserView: standalone at /project-browser?path=<path>, optional file=<path> query param, no AppLayout chrome
- App.tsx: QueryClientProvider wraps everything. SetupWizard gate via `isSetup` from electronAPI (App.tsx:127-135) renders the wizard until setup completes. After setup, AuthGate handles login flow. Dashboard wires up useSettingsInit + useWebSocket + useWorkspaceAutoSave/Load. AppLayout provides Header + NavBar + ActivityFeed + modals + DetailPanel + FloatingTerminalRoot rendered alongside DetailPanel (App.tsx:64)
- NavBar: 5 nav links (LIVE, AGENDA, HISTORY, QUEUE, REVIEW — NavBar.tsx:17) + NEW/QUICK session buttons + WorkdirLauncher + shortcuts help button (?)

## Dependencies & Connections

### Depends On
- [3D Cyberdrome Scene](../3d/cyberdrome-scene.md) — LiveView renders it
- [Session Detail Panel](./session-detail-panel.md) — AppLayout renders DetailPanel (not inside LiveView)
- [File Browser](./file-browser.md) — ProjectBrowserView reuses file browser
- [Server API](../server/api-endpoints.md) — HistoryView queries server DB via @tanstack/react-query
- [State Management](./state-management.md) — agendaStore for AgendaView, settingsStore for scene3dEnabled in LiveView
- [Review Tab](./review-tab.md) — ReviewView renders the translation/explain log
- [Floating Terminal Fork](./floating-terminal-fork.md) — FloatingTerminalRoot mounts PIP terminals globally

### Depended On By
- Top-level App.tsx renders routes

### Shared Resources
- React Router, navigation state

## Change Risks
- Adding heavy components to LiveView degrades 3D performance
- LiveView SceneErrorBoundary catches 3D crashes — removing it causes full app crash
- HistoryView uses react-query — changing API response shapes requires updating types
- Lazy-loaded routes (HistoryView, QueueView, AgendaView, ProjectBrowserView) must have Suspense fallbacks
