# Prompt Queue System

## Function
Per-session prompt queuing with drag-and-drop reordering, cross-session moves, image/file attachments, per-session automation (auto-send / auto-enter), and `once` / `loop` / `schedule` item types. Heavier automation behavior (the global scheduler, chains, quiet hours, daily-start clamp, force-start) and the global favorites history live in dedicated sibling docs — this doc covers the queue store, the per-session tab UI, and the global queue view.

## Purpose
Users can queue up multiple prompts for a session and have them sent automatically, enabling batch / recurring workflows. The queue store is the shared source of truth that the scheduler, history, and workspace-snapshot features all read and write.

## Source Files
| File | Role |
|------|------|
| `src/stores/queueStore.ts` | `queues: Map<string, QueueItem[]>` + `automation: Map<string, QueueAutomationConfig>`; add/remove/reorder/moveToSession/setQueue/updateItem, automation setters, migrateSession, loadFromDb, and the IndexedDB persist subscription |
| `src/components/session/QueueTab.tsx` | Per-session queue view — compose row, type pills (Once/Loop/Schedule), per-item rows, header toggles (📚 history, ↵ auto-enter, ➤ auto-send), automation status row |
| `src/routes/QueueView.tsx` | Global queue view across all sessions (grouped table, add-to-any-session, move/delete) |

Closely-related features documented elsewhere (this doc cross-links rather than duplicates):
- The 1s global scheduler, chains, quiet hours, daily-start clamp, force-start, loop durability → [Queue Scheduler](./queue-scheduler.md) (`src/hooks/useGlobalQueueScheduler.ts`, `src/lib/queueScheduler.ts`, `src/lib/timePicker.ts`, `LoopExcludeWindowsModal.tsx`)
- Global favorites history (📚 sheet, ★ favorite, apply/edit/view, alias, export/import) → [Queue Scheduler](./queue-scheduler.md) (`src/stores/queueHistoryStore.ts`, `QueueHistorySheet.tsx`, `QueueItemEditModal.tsx`, `src/lib/queueHistoryExport.ts`)
- Slash-command / `@`-file autocomplete in the compose + edit textareas → [Command Autocomplete](./command-autocomplete.md) (`src/components/ui/AutocompleteTextarea.tsx`)

## Implementation

### Data model (`queueStore.ts`)
- **QueueItem**: `{id, sessionId, text, position, createdAt, images?}` plus automation fields — `type?: 'once'|'loop'|'schedule'`, `intervalMs?`, `runAt?`, `nextFireAt?`, `lastFiredAt?`, `totalFires?`, `beforeChain?`, `afterChain?`, `excludeWindows?`, `execState?`, `execStepIdx?`, `historyId?`, `disabled?`, `firstFireOfDay?`, and the transient in-memory-only `forceStart?`. The scheduling/chain semantics of these fields are documented in [Queue Scheduler](./queue-scheduler.md); they live on QueueItem because the store is the persisted source of truth.
- **QueueImageAttachment**: `{name, dataUrl}` — up to 5 attachments per item in the compose row. Three input methods:
  - **File picker** (paperclip button): accepts images + common text files (`accept="image/*,.pdf,.txt,.md,.json,.csv,.xml,.yaml,.yml,.log"`)
  - **Clipboard paste** (Cmd/Ctrl+V): captures pasted images/files via the `onPaste` handler on the compose textarea; binary data is intercepted (`e.preventDefault()`) so it doesn't paste as garbled text
  - **Drag and drop**: drop files onto the compose area; `queueComposeDragOver` adds a cyan border during drag-over
- **QueueAutomationConfig** (per-session): `{paused, autoSend, autoEnter, idleGuard, skipWhenPrompting, loopExcludeWindows?}`. `DEFAULT_AUTOMATION` is a frozen sentinel `{paused:false, autoSend:true, autoEnter:true, idleGuard:true, skipWhenPrompting:true}` — selectors fall back to it so a missing entry returns a stable reference (avoids a re-render loop). `idleGuard`, `skipWhenPrompting`, and `loopExcludeWindows` only gate the scheduler (see [Queue Scheduler](./queue-scheduler.md)); `autoSend` and `autoEnter` are described below.

### Queue operations
- `add` (append), `remove` (by id), `reorder` (drag-and-drop, re-stamps `position`), `moveToSession` (dropdown picker; re-stamps `sessionId` + appends past target's max position), `setQueue` (bulk replace), `updateItem` (partial patch to one item).
- **Send now**: `handleSendNow` is for `once` items — sends the text then removes the entry. Loop/schedule items use the `⚡ NOW` button (`handleTriggerNow`), which sets `forceStart` and hands the full chain to the global scheduler ([Queue Scheduler](./queue-scheduler.md)).
- **Edit**: `once` items use a lightweight inline textarea (`editingId`); loop/schedule items open the rich `QueueItemEditModal` (`chainEditId`), documented in [Queue Scheduler](./queue-scheduler.md).
- **Per-item pause** (power-icon button, leftmost): `handleToggleEnabled` sets `QueueItem.disabled`; the row dims and the meta line shows `— paused —`. Re-enabling a loop resets `nextFireAt = Date.now() + intervalMs` so a frozen-in-the-past time doesn't fire immediately.

### Auto-send (➤ paper-plane)
- **Per-session** toggle stored in `QueueAutomationConfig.autoSend`, persisted to the `queueAutomation` IndexedDB table (defaults to ON). Toggling it on session A never affects session B.
- When a session is `waiting`/`input`/`idle` (`isSendableStatus`), its first queued item is sent and only removed after a successful write. Both QueueTab mounts for a session (the always-on strip in DetailPanel + the Queue tab) AND `useGlobalQueueScheduler` read the SAME per-session `automationConfig.autoSend` (re-read each tick), so the visible toggle and actual firing can never disagree.
- Older `queueAutomation` rows saved before auto-send became per-session lack the column and are read as ON (`loadFromDb` defaults `row.autoSend === undefined → true`).
- Turning auto-send OFF snaps `composeType` back to `once` (loop/schedule pills are disabled) and shows a warning banner with an inline Enable button, so users can't quietly create dead timed items.
- Note: `settingsStore.autoSendQueue` is an unrelated global settings flag consumed only by the Settings → Hooks UI (`HookSettings.tsx`); it does NOT gate firing — the per-session `autoSend` is the real control.

### Auto-enter (↵ return-arrow)
- **Per-session** toggle in `QueueAutomationConfig.autoEnter`, persisted to the same table (defaults to ON). Controls whether the send follows the prompt text with a real Enter keystroke (`\r`) to actually submit it in the CLI TUI. When OFF, the text is typed into the input box only and the user presses Enter themselves. auto-send governs *when* the prompt leaves the queue; auto-enter governs *how* it is delivered.
- **Invariant — Auto-Enter ON ⟹ Auto-send ON**: `setAutoEnter(id, true)` also flips `autoSend` ON in the same store update, because "Auto-Enter on" must mean the prompt is actually sent *and* submitted (the old decoupling silently produced "typed but never fired"). Disabling Auto-Enter leaves Auto-send untouched. The same invariant is **self-healed on load**: `loadFromDb` coerces any persisted `autoEnter && !autoSend` row to `autoSend: true`. (History: both flags were global `localStorage` keys through early Jun 2026, then made per-session; the coupling was added shortly after.)

### Send mechanism
- Both `sendItemToTerminal` (manual "send now") and the global scheduler's `sendToTerminal` delegate to `sendPromptToTerminal` (`src/lib/terminalSend.ts`). It POSTs the prompt text to `/api/terminals/{terminalId}/write` with `{data: textToSend}`, and **when auto-enter is ON, sends the submitting `\r` as a SEPARATE write** after a short pause (`SUBMIT_ENTER_DELAY_MS`, 1000 ms). The `\r` is never concatenated onto the text: a single `text + "\r"` write is read by Claude Code / Codex / Gemini TUIs as a bracketed-paste-like burst, so the trailing `\r` is inserted as a literal newline and the prompt is typed but never submitted (the "only a newline" bug). A standalone `\r`, arriving after the TUI has consumed the text, registers as a real Enter keypress — mirroring the manual paste flow (paste text, then press Enter). `\n` alone only inserts a newline inside the input box.
- Literal `\n` sequences in the queued text are un-escaped to real newlines before sending (`item.text.replace(/\\n/g, '\n')`).
- Images are uploaded first via `POST /api/queue-images` (returns temp file paths); the paths are appended to the text as extra lines (`textToSend += '\n' + paths.join('\n')`) — they are NOT a separate request field.

### Global QueueView (`QueueView.tsx`)
- Shows all sessions' queues grouped by session (only sessions with ≥1 item), with per-session item count and a totals line.
- Add a plain prompt to any session via the `Select` dropdown + textarea (Cmd/Ctrl+Enter or ADD). MOVE / DEL per row. This view does not expose type pills, chains, or automation — it is the simple cross-session list.

### Persistence (`queueStore.ts`)
- A Zustand `subscribe` callback diffs the `queues` and `automation` maps and persists only changed sessions. `persistSessionQueue` delete-then-bulk-add's a session's `promptQueue` rows via a field whitelist (so `forceStart` and other transient fields never persist). Writes are chained per session (`_persistChains`) because the subscription can fire twice for one session in quick succession (e.g. `advanceBlockedLoops` patching several due loops at once) — two overlapping delete-then-add runs would both read the pre-delete state and re-add, leaving Dexie with duplicate rows that hydrate as doubled queue items on restart. Each persist (`doPersistSessionQueue`) then wraps its delete+add in a Dexie `rw` transaction, so an interrupted write (quit mid-persist) can never leave a session's queue deleted-but-not-re-added. Automation rows are written to/deleted from the `queueAutomation` table.
- `loadFromDb` (called once on app mount) hydrates automation rows FIRST (so the scheduler reads fresh config on its first tick), then queue items. Booleans persist as `0|1`; absent columns default safely (auto-send/auto-enter/idleGuard/skip-prompting → ON). `_skipPersist` / `_skipAutomationPersist` sets prevent the load echoing straight back into Dexie.
- **Resume re-key ordering**: `src/main.tsx` `await`s `loadFromDb()` (queue + history) BEFORE rendering `<App>` (which mounts the WebSocket), so on `claude --resume` the order is deterministic — load → render → WS connect → `session_update` → `migrateSession` always sees hydrated items and re-keys instead of no-oping.
- `migrateSession(oldSessionId, newSessionId)` re-keys all queue items when a session is replaced (e.g., `claude --resume`).
- QueueTab collapsible state: `localStorage['queue-panel-collapsed']` (defaults to collapsed).

### Favorites entry point
- The QUEUE header has a 📚 button opening `QueueHistorySheet`, and each row carries a ★ button (`handleToggleFavorite`) that saves/removes a snapshot in the `queueHistory` table and stamps `QueueItem.historyId` so the star renders filled. The full history feature (apply/edit/view/alias/export/import) is documented in [Queue Scheduler](./queue-scheduler.md).

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — queueStore is a Zustand store
- [Client Persistence](./client-persistence.md) — `promptQueue`, `queueAutomation`, `queueHistory` tables in IndexedDB (Dexie v6 schema)
- [Server API](../server/api-endpoints.md) — `POST /api/terminals/:id/write` for sending, `POST /api/queue-images` for image uploads
- [Queue Scheduler](./queue-scheduler.md) — drives loop/schedule/chain firing and the favorites history off this store
- [Command Autocomplete](./command-autocomplete.md) — the compose textarea uses `AutocompleteTextarea`

### Depended On By
- [Session Detail Panel](./session-detail-panel.md) — QueueTab rendered in the QUEUE tab + as the always-on strip below the terminal
- [Views & Routing](./views-routing.md) — QueueView route
- [Queue Scheduler](./queue-scheduler.md) — reads `queues` + `automation` and writes back via `updateItem`/`remove`
- [Workspace Snapshot](./workspace-snapshot.md) — exports/imports `queueItems` (full automation config carried through)

### Shared Resources
- `useQueueStore` (`queues` + `automation` maps), the `/api/terminals/:id/write` and `/api/queue-images` endpoints

## Change Risks
- **Auto-send timing**: firing without correct idle detection can send prompts at the wrong moment — the actual gating lives in the scheduler ([Queue Scheduler](./queue-scheduler.md)); changes there ripple here.
- **Session ID migration**: `migrateSession` must re-key every queue item; the `main.tsx` await-before-render ordering is load-bearing for `claude --resume`.
- **Drag-and-drop reorder**: must update `position` correctly; `reorder` is the only path that re-stamps positions.
- **Persist field whitelist**: `persistSessionQueue` and `loadFromDb` map QueueItem fields explicitly. Any new persistent field must be added to BOTH; any new transient field (like `forceStart`) must be left OUT of the whitelist so it can't survive a reload.
- **Persist serialization + atomicity**: the per-session `_persistChains` queue and the Dexie `rw` transaction in `doPersistSessionQueue` are the only guards against two known data bugs — dropping the chain lets concurrent persists duplicate every row (doubled queue on restart), and dropping the transaction lets an interrupted write wipe a session's queue without re-adding it.
- **Dexie schema**: `queueAutomation` added in v4, `queueHistory` in v5; current schema is v6. New columns on these tables need a version bump or careful migration.
- **DEFAULT_AUTOMATION stability**: selectors must keep falling back to the frozen sentinel — minting a fresh object per render breaks Zustand's strict-equality bail-out and causes an infinite re-render loop.
