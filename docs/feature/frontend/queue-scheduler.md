# Queue Scheduler & History

## Function
A single app-level 1-second tick (`useGlobalQueueScheduler`) that evaluates **every** session's prompt queue and fires due items into the right terminal, driven by the pure scheduling helpers in `queueScheduler.ts` (priority selection, before→main→after chains, loop/schedule timing, quiet-hours / daily-start clamps, and a per-step "chain gate"). It also covers the global **Queue History** favorites store + 📚 sheet (save / view / edit / apply / export / import of reusable queue patterns), the 12-hour time picker that backs all time inputs, and the pinned-session auto-respawn helper.

## Purpose
The scheduler used to live inside `QueueTab.tsx`, bound to the selected session — backgrounded sessions had their tab unmounted, which silently paused all their loops and schedules. Lifting it to app level lets background sessions keep firing. The pure-helper split (`queueScheduler.ts`) keeps all timing/chain math testable without React, Dexie, the DOM, or `fetch`. Queue History exists so a user can save a loop / schedule / chain pattern once and re-apply it to any other session or project without rebuilding it by hand, including across machines via JSON export/import.

## Source Files
| File | Role |
|------|------|
| `src/lib/queueScheduler.ts` | Pure scheduling helpers — `pickNext`, `advanceAfterFire`, `advanceBlockedLoops`, `chainGateDecision`, `onceGateDecision`, exclude-window / daily-start / quiet-hours predicates, chain-step math, `describeNextFire`, `formatInterval`. No DOM / fetch / Dexie. |
| `src/lib/terminalSend.ts` | Owns the actual prompt→PTY write — `sendPromptToTerminal(terminalId, text, autoEnter, delayMs=SUBMIT_ENTER_DELAY_MS)` and `SUBMIT_ENTER_DELAY_MS = 1000`. Writes the prompt text via `POST /api/terminals/{id}/write`, then (only when `autoEnter`) writes a **separate** submitting `'\r'` after `delayMs`; never concatenates the `'\r'` onto the text. Used by the scheduler tick and the manual "send now". |
| `src/hooks/useGlobalQueueScheduler.ts` | App-level `setInterval(…, 1000)` tick mounted once in `App.tsx`; iterates every session each tick, applies the helpers, and POSTs the prompt to the session's terminal. Owns per-session re-entrance, cooldown, and chain-gate refs. |
| `src/stores/queueHistoryStore.ts` | Zustand store of saved favorites (`QueueHistoryEntry[]`), backed by the Dexie `queueHistory` table (v5 schema). save/update/setAlias/remove/incrementUsed/applyToSession/bulkImport/loadFromDb. |
| `src/components/session/QueueHistorySheet.tsx` | 📚 overlay sheet — filter/sort, per-row View/Edit/Apply/Remove, inline alias rename, export & import-with-preview. |
| `src/components/session/QueueItemEditModal.tsx` | Three-pane editor (before chain / main / after chain) for a Loop or Schedule item; type pills, interval + daily-start, datetime-local, per-item exclude windows, and **main-prompt image attachments** (paste / pick / remove, seeded from `item.images`, saved back into the patch). Reused by both QueueTab and the history sheet's Edit. |
| `src/components/session/LoopExcludeWindowsModal.tsx` | Session-level "quiet hours" editor — windows that apply to every loop in the session, OR'd with each loop's own windows. |
| `src/lib/queueHistoryExport.ts` | Pure serialize / parse / validate for the `aasc-queue-history` JSON file envelope, plus `downloadAsFile`. |
| `src/lib/pinnedRespawn.ts` | Keeps PINNED sessions alive — relaunches a pinned session whose process died, with a crash-loop cap + backoff. |
| `src/components/ui/TimePicker12.tsx` | Three-dropdown 12-hour time picker (Hour 1-12 / Minute / AM-PM) writing the `HH:MM` 24-hour string used downstream. |
| `src/lib/timePicker.ts` | Pure 12↔24-hour conversion (`parseHHMM`, `formatHHMM`) + pre-built option arrays. |

Closely-related, documented elsewhere (cross-linked, not duplicated):
- Queue store, per-session QueueTab UI, global queue view → [Prompt Queue](./prompt-queue.md) (`src/stores/queueStore.ts`, `QueueTab.tsx`, `QueueView.tsx`)
- `/` command + `@` file autocomplete inside the edit textareas → [Command Autocomplete](./command-autocomplete.md) (`AutocompleteTextarea.tsx`)

## Implementation

### Data structures & state
- **`QueueItem`** (defined in `queueStore.ts`, snapshotted/cloned here): `type?: 'once' | 'loop' | 'schedule'`, `intervalMs?`, `runAt?`, `nextFireAt?`, `lastFiredAt?`, `totalFires?`, `beforeChain?: ChainStep[]`, `afterChain?: ChainStep[]`, `excludeWindows?: ExcludeWindow[]`, `firstFireOfDay?: string` (`HH:MM`), `execState?: ChainExecState`, `execStepIdx?`, `disabled?`, `historyId?: number`, and the **in-memory-only** `forceStart?: boolean` (the ⚡ NOW bypass).
- **`ChainStep`**: `{ id, text, images? }`. **`ExcludeWindow`**: `{ id, startHHMM, endHHMM }`. **`ChainExecState`**: `'idle' | 'before' | 'main' | 'after'`. **`QueueItemType`**: `'once' | 'loop' | 'schedule'`.
- **`QueueHistoryEntry`**: `{ id, alias: string|null, item: QueueItem, sourceSessionTitle, sourceSessionId, usedCount, createdAt, lastUsedAt }`.
- **`ChainGate`** (per-session ref): `{ itemId, sawWork, openedAt }` — holds the next chain step until the prior step's turn has visibly finished.
- **`OnceGate`** (per-session ref): `{ sawWork, openedAt }` — same completion semantics as `ChainGate` but NOT keyed to an item id; sequences independent `once` items so a queue of several `once` prompts drains one-at-a-time (the next fires only after the previous one's task reaches Stop), instead of flooding the CLI in an ~1s burst.
- **Scheduler refs** (all `useRef<Map<string, …>>`): `firingRefs` (re-entrance guard), `coolDownRefs` (800ms post-fire buffer), `chainGateRefs` (the chain gate), `onceGateRefs` (the once gate), all keyed by sessionId.
- **`QueueAutomationConfig`** (read per session each tick from `queueStore.automation`, default `DEFAULT_AUTOMATION`): `{ paused, autoSend, autoEnter, idleGuard, skipWhenPrompting, loopExcludeWindows? }`.

### Constants & values
- `NO_WORK_FALLBACK_MS = 12_000` (`useGlobalQueueScheduler.ts`) — gate release for a step that never visibly goes to "work" (instant no-op prompts) so a chain can't stall forever.
- Cooldown buffer `= 800` ms; scheduler interval `= 1000` ms.
- `SUBMIT_ENTER_DELAY_MS = 1000` ms (`terminalSend.ts`) — delay between writing a prompt's text and writing the standalone submitting `'\r'` when Auto-Enter is on.
- Loop interval clamp / default `= 60_000` ms (60s) — used by `snapshotItem`, `advanceAfterFire`, `applyTypeDefaults`, and `coerceEntry` so an enabled loop with a missing/≤0/NaN interval is **healed to 60s, never silently deleted**.
- `applyTypeDefaults`: `once → nextFireAt = 0`; `loop → nextFireAt = Date.now() + intervalMs`; `schedule → runAt = options.runAt ?? Date.now() + 60_000`, `nextFireAt = runAt`.
- Export: `EXPORT_SCHEMA = 'aasc-queue-history'`, `EXPORT_VERSION = 1`, `MAX_IMPORT_SIZE = 50 * 1024 * 1024` (50 MB).
- Respawn: `MAX_ATTEMPTS = 3`, `WINDOW_MS = 60_000`, `backoffMs(n) = Math.min(8_000, 2_000 * 2 ** n)` (→ 2s, 4s, 8s); user-closing grace = 10_000 ms.
- TimePicker: `HOUR_OPTIONS_12 = [12,1,2,…,11]`, `MINUTE_OPTIONS = 0..59`, `EMPTY_SENTINEL = '__empty__'`.

### Pure scheduling helpers (`queueScheduler.ts`)
- `itemType(item)` — treats a missing `type` as `'once'` (legacy migration). `effectiveNextFireAt` — `once` always sorts to 0. `isExecuting` — `execState ∈ {before, main, after}`. `isSendableStatus(status)` — `'waiting' | 'input' | 'idle'`.
- **`pickNext(items, now, sessionWaiting, idleGuard, sessionExcludeWindows?, blockedByPrompting?)`** — selects the one item to fire, in priority order, after filtering out `disabled` items:
  - **Short-circuit** — `blockedByPrompting` → return `null` (checked before everything, so even in-flight chains pause one tick rather than typing over a just-submitted prompt).
  - **Priority 0** — any in-flight chain (`isExecuting`) keeps firing until complete (chains are atomic relative to other items); still respects idle-guard.
  - **Priority 0.5** — a fresh (non-executing) `forceStart` item begins immediately, bypassing due-time, idle-guard, quiet-hours, and daily-start. An in-flight chain still wins.
  - **Priority 1** — drain `once` items, but only when `sessionWaiting`; consecutive `once` items are then paced one-at-a-time by the once gate (see the tick walkthrough) so each waits for the previous one's task to finish.
  - **Priority 2** — earliest-due `loop`/`schedule` with `nextFireAt ≤ now`; loops additionally skip if inside any exclude window (item OR session) or before the daily-start clamp.
- **`getActiveStep(item)`** — what to send *now*: the current before/after step text+images, or the main prompt; a fresh item with a before-chain sends `beforeChain[0]`. A corrupt `execStepIdx` falls back to the main prompt.
- **`startExecution(item)`** — initial `execState` for a fresh pick (`before`/`main`), or `null` if already executing.
- **`advanceAfterFire(item, now)`** → `{action:'continue', patch}` | `{action:'remove'}` | `{action:'reschedule', patch}`. Walks `idle → before(0..N) → main → after(0..M) → done`; clears `forceStart` on the first advance. `once`/`schedule` → remove; `loop` → reschedule `nextFireAt = now + intervalMs` (interval healed to 60s if invalid) and bumps `totalFires`.
- **`advanceBlockedLoops(items, now)`** — rolls due loops' `nextFireAt` forward (skipping disabled, before-daily-start, executing, or interval-less rows) without incrementing `totalFires`. Used while `skipWhenPrompting` or a foreign in-flight chain blocks the session, so a missed cycle is dropped, not stockpiled.
- **`chainGateDecision(gate, pickId, atRest, sessionSendable, now, noWorkFallbackMs)`** → `'fire' | 'hold'`. No gate / different item → fire. `sawWork === true` → fire only when `atRest` (status `'waiting'` = the genuine Stop signal); decayed `idle` does **not** count. `sawWork === false` → fire if sendable past `noWorkFallbackMs`, else hold.
- **`onceGateDecision(gate, atRest, sessionSendable, now, noWorkFallbackMs)`** → `'fire' | 'hold'`. Identical logic to `chainGateDecision` minus the item-id match — used to sequence consecutive `once` items: after one `once` fires, the next is held until the prior one's turn reaches `atRest` (Stop), with the same `noWorkFallbackMs` escape for instant no-op prompts.
- Exclude/clamp predicates: `isInExcludeWindow` (same-day `[start,end)` or wrap-midnight `[start,1440)∪[0,end)`; `start===end` ignored), `isItemInQuietHours` (loops only, item ∨ session windows), `isBeforeDailyStart` (loops only, local time-of-day before `firstFireOfDay`).
- Display: `describeNextFire` (once→"next when idle", loop→live countdown "in 5m 12s"/"due now", schedule→absolute time + "(overdue)"), `formatInterval`, `totalChainSteps`, `currentChainStep`.

### Scheduler tick flow (`useGlobalQueueScheduler.ts`, per session, every 1s)
1. Skip if `firingRefs[sid]` is set (re-entrance), session/queue missing, `automationConfig.paused`, no `terminalId`, or inside the cooldown window.
2. **Early bail** when `autoSend` is OFF and there is no active work (no enabled `forceStart`/in-flight item) — keeps an idle queue ~free per tick.
3. **Gate observation** (before any early-return): if a chain gate is open and the session is now busy, set its `sawWork = true`; the same observation runs for an open once gate. This MUST run on busy ticks even when no item is picked.
4. If `blockedByPrompting` (`skipWhenPrompting && status === 'prompting'`) and no fresh force → roll blocked loops forward (only while `autoSend` ON) and return.
5. If any foreign chain is in flight and `autoSend` ON → `advanceBlockedLoops` for the others.
6. `pickNext(...)`. If a pick exists but `autoSend` is OFF and it's neither `forceStart` nor executing → hold.
7. If the pick is executing → `chainGateDecision`; `'hold'` returns. Otherwise (fresh pick): a `once` pick consults `onceGateDecision` and `'hold'` returns until the prior once finished; then clear any stale chain gate.
8. Set `firingRefs[sid]`, `getActiveStep`, then `sendToTerminal`, which delegates to `sendPromptToTerminal(terminalId, text, autoEnter)` (`@/lib/terminalSend`). It POSTs the prompt text (`\\n`→newline; uploaded image paths appended), then — only when `autoEnter` — submits a **separate, standalone `'\r'` keystroke after 1000ms (`SUBMIT_ENTER_DELAY_MS`)**. The `'\r'` is never concatenated onto the text (that concatenation made the TUI insert a literal newline instead of submitting — the bug this avoids).
9. On success: set 800ms cooldown, run `advanceAfterFire`, then `remove` / `updateItem(patch)` on the queue store. On `continue`, open a fresh chain gate `{itemId, sawWork:false, openedAt:now}`. On `remove` of a `once`, open a fresh once gate `{sawWork:false, openedAt:now}` so the next `once` holds until this one's task finishes. Emit a session-prefixed toast (e.g. `[name] Chain main sent (2 / 4)`, `Loop fired`, `Auto-sent queued prompt`).
10. `finally` clears `firingRefs[sid]`. Sessions are evaluated fire-and-forget in parallel.

### Endpoints (called by the scheduler / respawn)
- `POST /api/queue-images` — body `{ images }`, returns `{ paths }` (image attachments are uploaded before the prompt is sent).
- `POST /api/terminals/{terminalId}/write` — body `{ data }` (prompt text + optional `\r`).
- `POST /api/terminals` — recreate a dead pinned session (`buildRespawnBody`).

### Queue History store (`queueHistoryStore.ts`) + 📚 sheet
- **`snapshotItem`** strips per-session fields (`id=0`, `sessionId=''`, `position=0`, resets `nextFireAt`/`lastFiredAt`/`totalFires`/`execState`/`execStepIdx`, drops `disabled`), keeps the pattern (`text`, chains, `intervalMs` clamped to ≥60s, `excludeWindows`, `firstFireOfDay`).
- `saveItem(item, source)` → adds a row, returns the new id (caller stamps `historyId` onto the live item for a filled ★ without a DB round-trip). `removeEntry(id)` deletes the row **and** clears `historyId` from every live queue item that pointed at it. `setAlias`, `updateEntry` (re-snapshots the patch), `incrementUsed`.
- **`applyToSession(entryId, targetSessionId)`** clones the snapshot with a fresh id (`max(maxExistingId, Date.now()) + 1` to dodge collisions with QueueTab's `Date.now()` id source), `position = existing.length`, `historyId = entryId`, resets exec/totals, recomputes timing (loop → `now + intervalMs`; schedule → keeps its `runAt`; once → 0), `add`s it, then `incrementUsed`.
- **★ favorite toggle** lives in `QueueTab.tsx` (`handleToggleFavorite`): `★`/`☆` button calls `saveItem` (stamps `historyId`) or `removeFromHistory` (clears it).
- **Sheet UI** (`QueueHistorySheet`): header 📚 + Export/Import icon buttons + ✕; "Adding to:" target strip (Apply lands in the session that opened the sheet — no picker); filter text input; type filter (`All/Once/Loop/Schedule`); sort (`recent`/`used`/`created`). Each `HistoryRow`: inline alias edit ("+ Add name" / ✎, max 80 chars, Enter commits / Esc cancels, double-commit guarded), type chip (`⟳ Loop 10m` / `🕐 Schedule` / `▢ Once`), 120-char text preview, source breadcrumb, "saved" date, "used N×", "· N steps", and View / Edit / + Apply / 🗑 buttons. ESC closes topmost layer first (view → edit → sheet). Edit opens `QueueItemEditModal` bound to the current session's `sessionId`+`projectPath` (so `/` and `@` autocomplete stay meaningful) with `autoSendEnabled={true}`.

### Export / import (`queueHistoryExport.ts`)
- Envelope: `{ schema:'aasc-queue-history', version:1, exportedAt: ISO8601, count, entries: ExportedEntry[] }`; each entry mirrors `QueueHistoryEntry` minus its DB `id` (re-minted on import). `serializeEntries` pretty-prints; `defaultExportFilename` → `queue-history-YYYY-MM-DD.json`; `downloadAsFile` blobs + clicks an anchor.
- `parseImportFile(text, byteLength?)` → `{ok:true, file, skipped}` | `{ok:false, error}`. `ImportError`: `'too-large' | 'invalid-json' | 'wrong-schema' | 'newer-version' | 'malformed'` (mapped to user toasts in the sheet). `coerceEntry` skips rows missing `item.text`/`item.createdAt` (counted as `skipped`, not a whole-file failure) and heals an invalid loop `intervalMs` to 60s.
- `bulkImport` writes rows sequentially inside a Dexie `rw` transaction to capture every minted id, prepends them to the in-memory list, returns the count written (0 on whole-transaction rollback). The sheet shows a preview/confirm modal (file, exported date, entry count, skipped, existing-history note) before committing.

### 12-hour time picker (`TimePicker12.tsx` + `timePicker.ts`)
- Internal storage is `HH:MM` 24-hour everywhere downstream (db, scheduler, snapshots); only the rendering surface is 12-hour. `parseHHMM("13:45") → {hour:1, minute:45, ampm:'PM'}`, `formatHHMM(1,45,'PM') → "13:45"` (midnight `00:00 ↔ 12:00 AM`, noon `12:00 ↔ 12:00 PM`).
- `allowEmpty` adds a leading "—" sentinel; picking it anywhere fires `onChange(undefined)` ("no clamp"). Picking one dropdown when unset fills the other two with defaults (minute 0, AM) so the field becomes set in one gesture. Used by the daily-start clamp ("first fire each day", `allowEmpty`) and every exclude-window start/end input.

### Pinned-session respawn (`pinnedRespawn.ts`)
- `onSessionEnded(session)` (called from `useWebSocket.ts` on a status→`'ended'` transition) schedules a respawn for eligible pinned sessions; `shouldRespawn` requires `pinned && !isFloating && sshConfig && !userClosing` (floating PiP popups never respawn; clone/fork sessions with bare `isFork` do, and `buildRespawnBody` re-sends `isFork`/`originSessionId` so the respawned clone keeps its kill-guard). Crash-loop cap keyed by `respawnKey = projectPath + ' ' + title` (stable across id changes): max 3 attempts per rolling 60s, then "giving up" toast. Backoff 2s/4s/8s; `buildRespawnBody` resumes a real CLI id via `resumeSessionId` or routes a raw `term-*` command through `startupCommand`. `markUserClosing(session)` (called from `RobotListSidebar.tsx` on deliberate close) suppresses the next `'ended'` and cancels a pending respawn, auto-clearing after 10s.

### Storage keys
- Dexie `queueHistory` table — schema `'++id, createdAt, lastUsedAt'` (db v5; alias/sourceSessionTitle/sourceSessionId/usedCount/lastUsedAt/item are non-indexed columns on `DbQueueHistory`).
- Dexie `queueAutomation` table (`'sessionId'`, db v4) — per-session `QueueAutomationConfig` incl. `loopExcludeWindows`; read by the scheduler each tick.
- Dexie `promptQueue` table — `QueueItem` rows (owned by [Prompt Queue](./prompt-queue.md)); the scheduler mutates these via the store.

## Dependencies & Connections

### Depends On
- [Prompt Queue](./prompt-queue.md) — `queueStore` (`queues`, `automation`, `add`/`remove`/`updateItem`, `DEFAULT_AUTOMATION`) is the persisted source of truth the scheduler and history read/write.
- [State Management](./state-management.md) — reads `useSessionStore` each tick (status, `terminalId`, `title`, `projectPath`).
- [Client Persistence](./client-persistence.md) — Dexie `queueHistory` / `queueAutomation` / `promptQueue` tables (`db.ts`).
- [Command Autocomplete](./command-autocomplete.md) — `AutocompleteTextarea` inside `QueueItemEditModal`.
- [UI Primitives](./ui-primitives.md) — `showToast` / `ToastContainer` for all scheduler/history/respawn toasts.
- [WebSocket Client](./websocket-client.md) — `useWebSocket` invokes `onSessionEnded` for pinned respawn.
- [Terminal/SSH](../server/terminal-ssh.md) — `POST /api/terminals/{id}/write` and `POST /api/terminals` (respawn) target the PTY layer.
- [API Endpoints](../server/api-endpoints.md) — `POST /api/queue-images`, `/api/terminals*`.

### Depended On By
- [Prompt Queue](./prompt-queue.md) — QueueTab mounts `QueueItemEditModal`, `QueueHistorySheet`, `LoopExcludeWindowsModal`, and renders `describeNextFire` / `formatInterval`; the ★ toggle calls the history store.
- [Session Detail Panel](./session-detail-panel.md) — surfaces the queue tab that hosts these editors.
- [Robot System](../3d/robot-system.md) — `RobotListSidebar` calls `markUserClosing` when a pinned session is closed.
- [Workspace Snapshot](./workspace-snapshot.md) — snapshot import recreates sessions with the same body shape `buildRespawnBody` mirrors.

### Shared Resources
- `QueueItem` / `QueueAutomationConfig` / `ChainStep` / `ExcludeWindow` types (`queueStore.ts`), shared with [Prompt Queue](./prompt-queue.md).
- Session **status** vocabulary (`waiting`/`idle`/`input`/`working`/`prompting`/`ended`) from the [Session state machine](../server/session-management.md) — `isSendableStatus`, the `atRest` Stop signal, and `blockedByPrompting` all key off it.
- The `Terminal.module.css` `chainModal*` shell is shared by `QueueItemEditModal` and `LoopExcludeWindowsModal`; `TimePicker12.module.css` and `QueueHistory.module.css` are dedicated.

## Change Risks
- **Status semantics**: `isSendableStatus` and the `atRest = status === 'waiting'` Stop signal are load-bearing. Treating decayed `idle` as completion re-introduces the "next chain step typed on top of a still-working agent" bug; changing the auto-idle decay window in [Session Management](../server/session-management.md) shifts gate behavior.
- **Loop durability**: the 60s interval heal appears in 4 places (`snapshotItem`, `advanceAfterFire`, `applyTypeDefaults`, `coerceEntry`). Removing any one re-opens the "my enabled loop vanished on first fire" bug.
- **Re-entrance / cooldown / chain-gate refs** are the only guards against double-firing and flooding the CLI; the gate observation in step 3 must run before every early-return or a busy tick is missed and the next step fires too early (regressed once already — see the ⚡ NOW mid-chain interleaving fix).
- **`forceStart` is in-memory-only** (not persisted) and is cleared on the first `advanceAfterFire`; persisting it or clearing it elsewhere would let ⚡ NOW re-fire step 1 on top of a working agent.
- **History/queue id-collision**: `applyToSession` picks `max(maxExistingId, Date.now()) + 1` to avoid colliding with QueueTab's `Date.now()` id source — changing either id scheme can produce duplicate ids and lost updates.
- **Export schema**: bumping `EXPORT_VERSION` without keeping `version > EXPORT_VERSION → 'newer-version'` back-compat breaks cross-version import; the Dexie `queueHistory` index list (`++id, createdAt, lastUsedAt`) must stay in sync with the store's `orderBy('createdAt')` load.
- **Per-session automation**: `autoSend`/`autoEnter`/`idleGuard`/`skipWhenPrompting`/`loopExcludeWindows` are read fresh each tick from each session's config; reverting to a global flag would make one session's toggle pause/fire others.
- **Pinned respawn**: the `respawnKey` (projectPath + title) must stay stable across respawns or the crash-loop cap never accumulates; `markUserClosing` must run on every deliberate close path or a user-closed pinned session respawns itself.
