# Workspace Snapshot (Export/Import)

## Function
Serializes the live workspace — sessions (title, SSH config, startup command, accent, model, room assignment), project sub-tabs, and session metadata — to a JSON snapshot that can be saved to the server and reloaded later.

## Purpose
So users can recreate their multi-session layout after a server restart, across machines, or after the desktop app relaunches. Auto-saves on change, auto-loads on boot.

## Source Files
| File | Role |
|------|------|
| `src/lib/workspaceSnapshot.ts` | Snapshot types (`SessionSnapshot`, `ProjectSubTab`), serializer, `importSnapshot`, `flushSave`, `sessionDedupeKey` (8-field), orphan room bucketing, `failedTitles` tracking, `term-*` command rerouting, `reportWorkspaceLoadErrors` publisher |
| `src/lib/workspaceSnapshot.test.ts` | Vitest coverage (11 tests): dedup-key 8-field, orphan room synth, term-* rewrite, failedTitles, suppressBroadcast body |
| `src/hooks/useWorkspaceAutoSave.ts` | Debounced save triggered when session/room state changes |
| `src/hooks/useWorkspaceAutoLoad.ts` | One-shot load on app boot, rehydrates sessionStore + roomStore, forwards `failedTitles` to overlay via `reportWorkspaceLoadErrors` |
| `src/components/ui/WorkspaceLoadingOverlay.tsx` | Blocking overlay while hydrating; on partial-failure swaps to error panel with dismiss button |
| `src/components/ui/SavingOverlay.tsx` | Small save indicator |
| `server/apiRouter.ts` | `/api/workspace/save` (8-field dedup with `originalSessionId`), `/api/workspace/load`, `POST /api/sessions/clear-all` (honors `{ suppressBroadcast: true }`) |
| `server/sshManager.ts` | Per-workDir FIFO `pendingLinks` queue; `workingDir` existence check with `os.homedir()` fallback; `consumePendingLink(workDir, terminalId?)` 2-arg form |
| `test/apiRouter.workspaceFixes.test.ts` | 7 server tests: 3 for `suppressBroadcast` paths, 4 for 8-field dedup including a regression run against `test/fixtures/user-workspace-snapshot.json` |
| `test/sshManager.pendingLinks.test.ts` | 8 tests for FIFO queue semantics |
| `test/sshManager.workdir.test.ts` | 3 tests for missing-workDir fallback |
| `test/fixtures/user-workspace-snapshot.json` | Real-world 16-session snapshot for regression (do not modify) |

## Implementation
- **Storage path**: `process.env.APP_USER_DATA/workspace-snapshot.json` (Electron) or `data/workspace-snapshot.json` (Node server).
- **Save dedup (8-field key)**: server rejects duplicates keyed on `(title, sshConfig.host, sshConfig.port, sshConfig.username, sshConfig.workingDir, sshConfig.command, startupCommand, originalSessionId)` joined with `\0`. The 8th field (`originalSessionId`) was added to prevent collapsing legitimately distinct sessions that share the same workingDir + title (e.g., multiple Claude conversations against the same project). Client-side `sessionDedupeKey()` in `src/lib/workspaceSnapshot.ts` uses the matching 8-field formula. Logs how many duplicates were removed.
- **Save validation**: rejects missing `version` or non-array `sessions` with 400.
- **Load**: 404 when snapshot absent — client treats as empty workspace.
- **Snapshot shape**: top-level `{version, sessions: SessionSnapshot[], rooms?: Room[], exportedAt: number}`. Each `SessionSnapshot` carries `originalSessionId` for remapping room assignments on import, plus fields: `status`, `label`, `pinned`, `muted`, `alerted`, `permissionMode`, `fileTabs`, `queueItems`.
- **Project sub-tabs**: `ProjectSubTab` preserves per-session file-browser tabs (path, label, `customLabel`, `initialPath`, `initialIsFile`).
- **Auto-save debounce**: store subscription → `scheduleAutoSave()` after settle. `flushSave()` is only used for explicit saves (e.g., beforeunload).
- **Dynamic import**: `App.tsx:79` imports `flushSave` lazily to avoid pulling the module into initial bundle.
- **Auto-resume on import**: when `originalSessionId` looks like a real CLI session UUID (matches `^[a-zA-Z0-9_-]+$` and does NOT start with `term-`), the client passes it as `resumeSessionId` to `POST /api/terminals`. The server strips any prior `--resume/--continue UUID` and `--fork-session` flags from `sshConfig.command`, applies `reconstructPermissionFlags(…, permissionMode)`, and rebuilds the launch command as `<baseCmd> --resume '<UUID>' || <baseCmd> --continue`. The terminal is spawned with an empty command (so `createTerminal` skips auto-launch) and the rebuilt command is injected via `writeWhenReady`. This ensures re-imports pick up the user's actual conversation instead of re-forking from the ancestor or starting fresh. Non-Claude commands (codex, gemini) and `term-*` originalSessionIds bypass this logic and run `sshConfig.command` verbatim.
- **`term-*` command rerouting**: For synthetic `term-…` sessions (no real Claude UUID), the client now sends `command: ''` and routes the original `cfg.command` through `startupCommand` (which has no shell-metacharacter validator on the server). This allows compound commands like `npm run dev && claude` to import without being rejected by `validateCommand` in `sshManager.ts`. Existing snapshot `startupCommand` is preferred over `cfg.command` when both exist.
- **`suppressBroadcast` clear-all**: `importSnapshot` calls `POST /api/sessions/clear-all` with body `{ "suppressBroadcast": true }`. The server then calls `clearAllSessions()` without broadcasting `CLEAR_BROWSER_DB` over WebSocket, eliminating the race where the broadcast wipes IndexedDB entries for newly created sessions mid-import. The Reset button (manual user action) still sends no body and gets the broadcast.
- **Orphan session bucketing**: After room remap, any session whose new ID isn't referenced by any room's `sessionIds` is bucketed into a synthesized `Ungrouped` room (or appended to an existing one named `Ungrouped`). This prevents sessions that exist in `snapshot.sessions[]` but aren't listed in any `rooms[].sessionIds` from becoming invisible after import. Orphans are NOT auto-matched to rooms by name — bucketing is conservative.
- **Failure surfacing**: `importSnapshot()` returns `{ created, failed, failedTitles[] }` (the third field is new). `useWorkspaceAutoLoad` passes `failedTitles` to `WorkspaceLoadingOverlay`, which switches to an error panel listing each failed title with a `DISMISS` button. The overlay does NOT auto-hide while errors are visible. On full success it dismisses normally.
- **`workingDir` existence fallback** (`server/sshManager.ts`): `createTerminal` checks `existsSync(workDir)` before `pty.spawn`. If the directory no longer exists (e.g., user deleted the project), the spawn falls back to `os.homedir()` with a `log.warn` instead of throwing ENOENT. The session card is still created so the user can re-cd manually.
- **Per-workDir FIFO `pendingLinks`** (`server/sshManager.ts`): `pendingLinks` was promoted from `Map<string, PendingLink>` to `Map<string, PendingLink[]>` (FIFO queue). Multiple sessions sharing the same `workingDir` (e.g., 6 thesis sessions in `/Users/.../thesis`) now each get a distinct slot — the previous last-write-wins behavior caused all but the last to fail to bind their `SessionStart` hook to the correct terminal card. `consumePendingLink(workDir, terminalId?)` accepts an optional 2nd argument for surgical removal; default behavior pops the front.

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
- The dedup key formula must stay synchronized between client (`src/lib/workspaceSnapshot.ts:sessionDedupeKey`) and server (`server/apiRouter.ts` save handler). Both currently use the 8-field formula `[title, host, port, user, workdir, command, startupCommand, originalSessionId]` joined with `\0`. If you reorder, rename, or add fields, update both files in the same commit or sessions will be silently dropped from one side
- Session ID remapping must run before room reconciliation — otherwise rooms attach to wrong sessions
- The resume command stripping regex in `apiRouter.ts` (`POST /terminals` handler) must keep parity with the `/sessions/:id/resume` flow — adding new Claude flags (e.g., `--permission-mode`) without updating both call sites produces divergent resume behavior between the detail-panel resume button and workspace auto-load
- `resumeSessionId` passes through Zod as alphanumeric+dashes/underscores only — any Claude session ID format change (e.g., adding dots/colons) requires updating the regex in both `terminalCreateSchema` and the client-side `looksLikeRealSessionId` check
- `suppressBroadcast` is a soft contract — if a future caller of `/api/sessions/clear-all` needs the broadcast suppressed during a multi-session orchestration, send `{ suppressBroadcast: true }` and remember to manually reset client state. The Reset button MUST continue to send no body so it broadcasts normally
- `pendingLinks` is now an array-per-workDir queue. Any new caller must use the exported helpers (`addPendingLink`, `tryLinkByWorkDir`, `consumePendingLink`) — direct `Map.set/get` access on `pendingLinks` will break when multiple sessions share a workDir
- `term-*` synthetic IDs route the user's command through `startupCommand` to bypass `validateCommand`'s shell-metachar regex. If `startupCommand` ever gains its own validator, the `term-*` import path will need a new escape route (e.g., `bash -c` wrapping). Currently safe because `startupCommand` is just `writeWhenReady` to the PTY shell.
- `workingDir` fallback to `os.homedir()` is silent — only a `log.warn`. If users complain about sessions opening in `~` instead of their project, the fallback was triggered. Consider surfacing this in the failure overlay if it becomes common.
- `failedTitles` lives in a module-level publisher (`reportWorkspaceLoadErrors` in `workspaceSnapshot.ts`). If you replace the overlay with a Zustand store, migrate the publisher or the failure list will silently disappear from the UI
