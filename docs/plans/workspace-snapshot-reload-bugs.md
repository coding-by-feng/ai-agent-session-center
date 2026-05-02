# Workspace Snapshot Reload/Resume — Bug Fix Plan

## Overview

Bug-fix documentation for the workspace snapshot reload/resume flow (auto-load on app start, manual import from JSON file). Investigation surfaced **7 distinct bugs** that caused sessions to be lost, duplicated, or stuck during restore. Fixes are **implemented, tested, and uncommitted on `main`** (Apr 29, 2026 work).

**Scope:** Server-side terminal/SSH lifecycle + client-side snapshot import pipeline + UX error surface.
**Status:** 13 files changed, 30/30 new tests green, no commit yet.

---

## Symptoms (User-Visible)

| Symptom | Reported as |
|---------|-------------|
| Only 10 of 17 sessions resumed after restart | "Session Restore Bug" — observation #417 |
| Sessions silently dropped (no UI feedback) | "Workspace import lost sessions silently" |
| Multiple sessions in same project collapsed to one | "Two Claude sessions in same workdir merged" |
| Sessions created on the server but invisible in sidebar | "Sessions exist but no UI card" |
| First terminal in a project bound to a later session's hook | "Wrong session card lit up" |
| Workspace import wiped IndexedDB while sessions were rebuilding | "Browser cleared its session cache mid-import" |
| Hard-coded paths from another machine broke createTerminal | "ENOENT on snapshot from teammate" |

---

## Root-Cause Inventory (RC-1..RC-14)

Numbering preserved from the multi-agent investigation report (observation #1300/#1301). Six RCs were ruled non-issues; the seven below are the load-bearing bugs.

### RC-2 — Dedup key collapsed legitimate distinct sessions

- **Where:** `server/apiRouter.ts` `/workspace/save` handler **and** `src/lib/workspaceSnapshot.ts#sessionDedupeKey`.
- **Before:** 7-field key (`title + sshConfig + startupCommand`). Two Claude sessions on the same project (same title, same workdir) hashed to the same key → second one dropped.
- **Fix:** Add `originalSessionId` as the 8th field. The snapshot's authoritative identity is the original session UUID, not the launch command.

### RC-3 / RC-7 — `pendingLinks` was a single-value Map (collisions on shared workDir)

- **Where:** `server/sshManager.ts` (~line 222 onwards).
- **Before:** `Map<string, PendingLink>` — keyed by workDir, **one** link per dir. When workspace import created N terminals in the same project, the (N-1)th `pendingLinks.set(workDir, ...)` silently overwrote earlier entries; SessionStart hook for the lost ones had no terminal to bind to → orphan session.
- **Fix:** Changed shape to `Map<string, PendingLink[]>` (FIFO array). Helpers `addPendingLink`, `findPendingLinksKey`, `tryLinkByWorkDir` (shift front), `consumePendingLink(workDir, terminalId?)` (target by ID or shift front), expiry sweep, and `cleanup()` all updated. Test-only `__addPendingLinkForTest` / clear helper exposed.

### RC-6 — `pty.spawn` ENOENT on missing workingDir

- **Where:** `server/sshManager.ts#createTerminal`, local-shell branch.
- **Before:** `cwd = workDir` was passed straight to `pty.spawn`. Snapshots exported on another machine often contain absolute paths (`/Users/old-user/...`) that don't exist on the current machine; spawn threw ENOENT and the session card was never created.
- **Fix:** Fall back to `homedir()` when `existsSync(workDir)` is false. Logs a warning so the user knows; they can `cd` once the shell opens.

### RC-12 — Orphan sessions after room ID remap

- **Where:** `src/lib/workspaceSnapshot.ts` (room remap pass).
- **Before:** When a session's original ID was successfully remapped but its room's `sessionIds` ended up empty (or referenced a now-missing ID), the session was created on the server but **invisible in the sidebar** — no room rendered it.
- **Fix:** After `remappedRooms` is built, scan `idRemap.values()` for IDs not referenced by any room. Bucket them all into a synthesized `"Ungrouped"` room (or merge into an existing one). Deliberately **not** matching orphans by name — that would be heuristic and risky.

### RC-14 — Raw command shell metacharacters rejected by validateCommand

- **Where:** `src/lib/workspaceSnapshot.ts` (terminal create POST body) and `server/apiRouter.ts` (`POST /api/terminals` launch path).
- **Before:** For non-Claude (term-*) sessions, the snapshot's `cfg.command` may contain shell metacharacters (`&&`, `|`, `>`). The server's `validateCommand` regex blocks these for SSH safety, so creation failed.
- **Fix:** Route raw commands through `startupCommand` (which has no metachar validation — written directly to the PTY shell) and send `command: ''` so spawn doesn't auto-launch with the rejected command. The server preserves the explicit empty command, spawns a blank shell with `deferredLaunch`, then writes `startupCommand` via `writeWhenReady`. Claude UUID sessions retain the existing flow because the server rebuilds their command from `resumeSessionId`.

### Contract C2 — `clear-all` broadcast race

- **Where:** `server/apiRouter.ts` `/sessions/clear-all` handler **and** `src/lib/workspaceSnapshot.ts#importSnapshot`.
- **Before:** Workspace import calls `/api/sessions/clear-all` then immediately starts creating sessions. The existing `CLEAR_BROWSER_DB` broadcast raced with the new `SESSION_UPDATE` messages and wiped the freshly-rebuilt IndexedDB mirror in the browser.
- **Fix:** Server accepts `{ suppressBroadcast: true }` body flag; importSnapshot sends it. The client clears its own localStorage state before this point, so the broadcast is redundant during import.

### Contract C7 — No surface for failed sessions

- **Where:** `src/lib/workspaceSnapshot.ts`, `src/hooks/useWorkspaceAutoLoad.ts`, `src/components/ui/WorkspaceLoadingOverlay.tsx`.
- **Before:** `importSnapshot` returned `void`. Failures were counted but never surfaced — user saw "loaded 10 of 17" with no idea which 7 failed.
- **Fix:** `importSnapshot` now returns `{ created, failed, failedTitles }`. Overlay component subscribes to a module-level event channel (`reportWorkspaceLoadErrors` — same pattern as `showToast`) and renders an error panel listing failed titles with a DISMISS button when `failed > 0`.

---

## File Summary

### Modified Files (uncommitted)

| # | Path | Changes | Bugs Fixed |
|---|------|---------|-----------|
| 1 | `server/apiRouter.ts` | +29/-12 | RC-2 (dedup), C2 (suppressBroadcast), RC-14 server launch |
| 2 | `server/sshManager.ts` | +132/-29 | RC-3, RC-6, RC-7 |
| 3 | `src/lib/workspaceSnapshot.ts` | +97/-8 | RC-2, RC-12, RC-14, C7 |
| 4 | `src/hooks/useWorkspaceAutoLoad.ts` | +41/-13 | C7 |
| 5 | `src/components/ui/WorkspaceLoadingOverlay.tsx` | +66/-3 | C7 |
| 6 | `src/styles/modules/WorkspaceLoadingOverlay.module.css` | +75/-0 | C7 (error panel styling) |
| 7 | `docs/feature/server/api-endpoints.md` | +4/-1 | docs |
| 8 | `docs/feature/server/terminal-ssh.md` | +3/-1 | docs |
| 9 | `docs/feature/frontend/workspace-snapshot.md` | +31/-13 | docs |

### New Test Files (uncommitted)

| # | Path | Coverage |
|---|------|----------|
| 1 | `test/apiRouter.workspaceFixes.test.ts` | 316 lines — `/workspace/save` dedup w/ originalSessionId, `/sessions/clear-all` suppressBroadcast, `/terminals` raw startupCommand launch |
| 2 | `test/sshManager.pendingLinks.test.ts` | 119 lines — FIFO ordering, shared-workDir collisions, `consumePendingLink(terminalId)` |
| 3 | `test/sshManager.workdir.test.ts` | 91 lines — ENOENT fallback to homedir() |
| 4 | `src/lib/workspaceSnapshot.test.ts` | 516 lines — dedup key, RC-12 orphan bucketing, RC-14 command rerouting, C7 failedTitles propagation |
| 5 | `test/fixtures/user-workspace-snapshot.json` | Real-world 16-session × 10-room snapshot (regression fixture from observation #1302/#1310) |

**Test count:** 30 tests, all green (`npx vitest run` confirms 30/30 pass on May 1).

### Other modified files (NOT part of bug fix — separate work today)

These are mixed into the same uncommitted diff but unrelated to workspace fixes:

- `src/components/session/ProjectTab.tsx` — refresh icon + new file/folder + collapse-all icon fixes (today)
- `src/components/session/SessionSwitcher.tsx` — replaced bounce animation with red `!` badge (today)
- `src/styles/modules/DetailPanel.module.css` — bounce removal + attention badge styling (today)
- `.gitignore` — single line addition

**Recommendation:** split into two commits — one for the workspace fixes, one for today's UI tweaks. They're logically distinct.

---

## Verification Plan

### 1. Re-run the new test suite

```bash
npx vitest run \
  test/apiRouter.workspaceFixes.test.ts \
  test/sshManager.pendingLinks.test.ts \
  test/sshManager.workdir.test.ts \
  src/lib/workspaceSnapshot.test.ts
# Expect: 4 files, 30 tests passed
```

### 2. Real-world regression — 16-session snapshot

```bash
# 1. Drop test/fixtures/user-workspace-snapshot.json into the dashboard import flow
# 2. Confirm: 16 sessions appear in the sidebar
# 3. Confirm: 10 rooms preserved with their original groupings
# 4. Confirm: no duplicates, no orphans, no "Ungrouped" room (everything routed correctly)
```

### 3. Manual: shared-workDir collision

```bash
# 1. Create 3 sessions all targeting the same project workdir (no SSH config diff)
# 2. Save workspace JSON, restart app, auto-load
# 3. Confirm: all 3 sessions restored with distinct cards (RC-3/RC-7)
```

### 4. Manual: missing workingDir

```bash
# 1. Edit a snapshot JSON, change workingDir to /nonexistent/path
# 2. Auto-load
# 3. Confirm: terminal opens in $HOME with a warning log; session card present (RC-6)
```

### 5. Manual: failure surface

```bash
# 1. Edit a snapshot JSON, set one session's command to a string that fails validation server-side
# 2. Auto-load
# 3. Confirm: WorkspaceLoadingOverlay flips to "WORKSPACE LOADED WITH ERRORS"
#    and lists the failing session's title; DISMISS clears it (C7)
```

### 6. Browser IndexedDB integrity

```bash
# 1. Open DevTools → Application → IndexedDB → AgentManager
# 2. Trigger workspace import
# 3. Confirm: rebuilt sessions persist in IndexedDB during and after import (C2 — no race wipe)
```

---

## Remaining Gaps / Open Questions

| # | Gap | Priority | Notes |
|---|-----|----------|-------|
| 1 | Commit not yet made | High | All work uncommitted on `main`. Recommend split commit (workspace fixes vs. today's UI) |
| 2 | No E2E test exercising the full file-import → restore loop | Med | Vitest covers units; Playwright test would exercise the real WebSocket + IPC paths |
| 3 | RC-6 fallback message only logged — not surfaced to user | Low | User sees a session in `~` instead of expected dir; warning is server-side only |
| 4 | "Ungrouped" room can grow unbounded across multiple imports | Low | Each failed-remap import appends to it; no cap. Acceptable for now |
| 5 | C7 error panel does not persist across app restart | Low | Failed titles are in-memory; user dismissal is the only state. Acceptable |
| 6 | RC-14 startupCommand routing: shell metacharacters still execute as-is | Med-Sec | Same security posture as the existing manual "Startup Command" field. Worth noting in docs |
| 7 | No telemetry for restore success rate | Low | Future: emit a metric so we know if RC-* fixes hold over time |

---

## Implementation Order (already done)

1. Server: `pendingLinks` array shape + helpers (RC-3/RC-7)
2. Server: `createTerminal` ENOENT fallback (RC-6)
3. Server: `clear-all` suppressBroadcast (C2)
4. Server: `/workspace/save` 8-field dedup (RC-2)
5. Client: `sessionDedupeKey` mirror (RC-2)
6. Client: `importSnapshot` orphan bucketing (RC-12)
7. Client: `importSnapshot` command rerouting (RC-14)
8. Client: `importSnapshot` returns failedTitles (C7)
9. UX: `WorkspaceLoadingOverlay` error panel (C7)
10. UX: `useWorkspaceAutoLoad` consumes failedTitles (C7)
11. Tests: 4 new files, 29 tests
12. Docs: 3 feature docs updated

---

## Related Memory / Observations

- #417, #418, #420, #421, #422 — original symptom reports
- #1291–1297 — architecture mapping for workspace auto-load
- #1300, #1301 — 7 confirmed bugs + 7 fix proposals
- #1302, #1310 — real-world snapshot fixture added
- #1303, #1305 — parallel agent dispatch (server + client)
- #1311, #1315 — test baseline + post-fix test status
- #1312, #1313 — pendingLinks architecture confirmation + feature-doc inventory
- #1314, #1319, #1320 — feature doc updates
- #1316, #1317, #1321 — final change-set numbers
- Saved memory: `project_workspace_snapshot_fixes.md` (Apr 30)

---

**Status: BUG FIX COMPLETE — UNCOMMITTED. Ready for review and commit.**
