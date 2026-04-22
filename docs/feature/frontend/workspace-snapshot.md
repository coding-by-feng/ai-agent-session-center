# Workspace Snapshot (Export/Import)

## Function
Serializes the live workspace — sessions (title, SSH config, startup command, accent, model, room assignment), project sub-tabs, and session metadata — to a JSON snapshot that can be saved to the server and reloaded later.

## Purpose
So users can recreate their multi-session layout after a server restart, across machines, or after the desktop app relaunches. Auto-saves on change, auto-loads on boot.

## Source Files
| File | Role |
|------|------|
| `src/lib/workspaceSnapshot.ts` | Snapshot types (`SessionSnapshot`, `ProjectSubTab`), serializer, `flushSave` |
| `src/hooks/useWorkspaceAutoSave.ts` | Debounced save triggered when session/room state changes |
| `src/hooks/useWorkspaceAutoLoad.ts` | One-shot load on app boot, rehydrates sessionStore + roomStore |
| `src/components/ui/WorkspaceLoadingOverlay.tsx` | Blocking overlay while hydrating |
| `src/components/ui/SavingOverlay.tsx` | Small save indicator |
| `server/apiRouter.ts` (lines 1894-1950) | `/api/workspace/save`, `/api/workspace/load` |

## Implementation
- **Storage path**: `process.env.APP_USER_DATA/workspace-snapshot.json` (Electron) or `data/workspace-snapshot.json` (Node server).
- **Save dedup**: server rejects duplicate sessions keyed on `(title, sshConfig.host, sshConfig.port, sshConfig.username, sshConfig.workingDir, sshConfig.command, startupCommand)` joined with `\0`. Logs how many duplicates were removed.
- **Save validation**: rejects missing `version` or non-array `sessions` with 400.
- **Load**: 404 when snapshot absent — client treats as empty workspace.
- **Snapshot shape**: top-level `{version, sessions: SessionSnapshot[], rooms?: Room[], exportedAt: number}`. Each `SessionSnapshot` carries `originalSessionId` for remapping room assignments on import, plus fields: `status`, `label`, `pinned`, `muted`, `alerted`, `permissionMode`, `fileTabs`.
- **Project sub-tabs**: `ProjectSubTab` preserves per-session file-browser tabs (path, label, `customLabel`, `initialPath`, `initialIsFile`).
- **Auto-save debounce**: store subscription → `scheduleAutoSave()` after settle. `flushSave()` is only used for explicit saves (e.g., beforeunload).
- **Dynamic import**: `App.tsx:79` imports `flushSave` lazily to avoid pulling the module into initial bundle.
- **Auto-resume on import**: when `originalSessionId` looks like a real CLI session UUID (matches `^[a-zA-Z0-9_-]+$` and does NOT start with `term-`), the client passes it as `resumeSessionId` to `POST /api/terminals`. The server strips any prior `--resume/--continue UUID` and `--fork-session` flags from `sshConfig.command`, applies `reconstructPermissionFlags(…, permissionMode)`, and rebuilds the launch command as `<baseCmd> --resume '<UUID>' || <baseCmd> --continue`. The terminal is spawned with an empty command (so `createTerminal` skips auto-launch) and the rebuilt command is injected via `writeWhenReady`. This ensures re-imports pick up the user's actual conversation instead of re-forking from the ancestor or starting fresh. Non-Claude commands (codex, gemini) and `term-*` originalSessionIds bypass this logic and run `sshConfig.command` verbatim.

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — reads sessionStore and roomStore
- [API Endpoints](../server/api-endpoints.md) — `/api/workspace/save`, `/api/workspace/load`
- [Session Management](../server/session-management.md) — imported sessions are recreated via session creation APIs

### Depended On By
- App boot flow (`src/App.tsx`) — shows `WorkspaceLoadingOverlay` while loading

### Shared Resources
- `workspace-snapshot.json` file on server disk (only one slot — no multi-slot support)

## Change Risks
- Changing `SessionSnapshot` shape without a version bump silently breaks `/api/workspace/load` for old snapshots
- Dedup key change on the server can drop sessions that previously imported cleanly
- Session ID remapping must run before room reconciliation — otherwise rooms attach to wrong sessions
- The resume command stripping regex in `apiRouter.ts` (`POST /terminals` handler) must keep parity with the `/sessions/:id/resume` flow — adding new Claude flags (e.g., `--permission-mode`) without updating both call sites produces divergent resume behavior between the detail-panel resume button and workspace auto-load
- `resumeSessionId` passes through Zod as alphanumeric+dashes/underscores only — any Claude session ID format change (e.g., adding dots/colons) requires updating the regex in both `terminalCreateSchema` and the client-side `looksLikeRealSessionId` check
