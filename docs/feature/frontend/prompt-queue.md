# Prompt Queue System

## Function
Per-session prompt queuing with drag-and-drop reordering, cross-session moves, image attachments, optional auto-send on waiting/input status, and a global favorites history that lets users reuse a saved queue item (Once / Loop / Schedule) in any session.

## Purpose
Users can queue up multiple prompts for a session and have them sent automatically, enabling batch workflows. The global queue history lets a queued item (or full chain) be favorited once and re-applied to fresh sessions — useful when a "review + lint + test" loop pattern is repeated per project.

## Source Files
| File | Role |
|------|------|
| `src/stores/queueStore.ts` | Queues Map<string, QueueItem[]>, add/remove/reorder/moveToSession/setQueue/migrateSession/loadFromDb |
| `src/stores/queueHistoryStore.ts` | Global queueHistory entries, saveItem/updateEntry/removeEntry/incrementUsed/applyToSession/loadFromDb |
| `src/hooks/useGlobalQueueScheduler.ts` | App-level 1s tick that evaluates every session's queue (not just the focused one) |
| `src/components/session/QueueTab.tsx` | Session-specific queue view — header has 📚 button (history), ↵ (auto-enter), ➤ (auto-send); each row has ★ favorite |
| `src/components/session/QueueHistorySheet.tsx` | Global queue-history modal — list with [View] [Edit] [+ Apply] [🗑] per row, filter / type / sort controls, "Adding to: <session>" strip |
| `src/components/session/QueueItemEditModal.tsx` | 3-pane chain editor; reused by the history sheet with `title="Edit history entry"` |
| `src/routes/QueueView.tsx` | Global queue view across all sessions |

## Implementation
- QueueItem: {id, sessionId, text, position, createdAt, images?: QueueImageAttachment[]}
- QueueImageAttachment: {name, dataUrl} — up to 5 attachments per item. Three input methods:
  - **File picker** (paperclip button): accepts images + common text files (.pdf, .txt, .md, .json, .csv, .xml, .yaml, .log)
  - **Clipboard paste** (Cmd/Ctrl+V): captures pasted images/files from clipboard via `onPaste` handler on the compose textarea. Binary data is intercepted (prevents pasting as garbled text)
  - **Drag and drop**: drop files onto the compose area; cyan border highlights the drop zone during drag-over
- Queue operations: add (append), remove (by id), reorder (drag-and-drop), moveToSession (dropdown picker), send now, edit (inline textarea)
- Auto-send: per-session toggle (localStorage['queue-auto-send'], defaults to ON). When session transitions to 'waiting' or 'input' status, first queued item is sent to terminal via POST /api/terminals/{terminalId}/write, only removed after successful send. Note: settingsStore also has an `autoSendQueue: false` field, creating a dual mechanism — QueueTab uses localStorage while settingsStore has its own independent flag
- Auto-Enter: separate toggle (localStorage['queue-auto-enter'], defaults to ON). Controls whether the send appends a real Enter keystroke (`\r`) to actually submit the prompt in Claude Code / Codex / Gemini TUIs. When OFF, the text is typed into the input box only and the user presses Enter themselves. Independent of auto-send: auto-send governs *when* the prompt leaves the queue, auto-enter governs *how* it is delivered. Cyan return-arrow icon in queue header, sits left of the green paper-plane auto-send icon
- Send mechanism: POST /api/terminals/{terminalId}/write with {data: text + image paths + terminator}, where terminator = `\r` when auto-enter is ON, otherwise `''`. **Note:** `\n` would only insert a newline inside the TUI input box without submitting; `\r` mimics a real Enter keypress. Images uploaded first via POST /api/queue-images
- Global QueueView: shows all sessions' queues grouped by session, add prompt to any session via session selector (Select dropdown), table layout with MOVE/DEL actions
- Persistence: IndexedDB promptQueue table via Zustand subscribe callback, survives page reloads. Images serialized as JSON in DbQueueItem.images field
- Session ID migration: queueStore.migrateSession re-keys all items when a session is replaced (e.g., claude --resume)
- QueueTab collapsible: localStorage['queue-panel-collapsed'], defaults to collapsed
- **Global queue history (favorites)**: top-right 📚 button in the QUEUE header opens `QueueHistorySheet`. Each queue row carries a ★ button (`queueFavBtn`); clicking saves a snapshot to Dexie `queueHistory` (v5 schema) and stamps `QueueItem.historyId` so the star renders filled. Clicking the filled star silently removes the saved entry. History entries store a deep-cloned `QueueItem` with session-local fields stripped (id / sessionId / position / nextFireAt / execState / totalFires) — the snapshot is portable across sessions
- **Apply flow**: in the sheet, [+ Apply] clones the saved snapshot into the currently viewed session (target is implicit, no picker). Loop `nextFireAt` is recomputed as `now + intervalMs`; `historyId` is set on the new live item so the ★ stays filled; `usedCount` and `lastUsedAt` increment on the history entry
- **Edit / View flow**: [✎ Edit] opens `QueueItemEditModal` with `title="Edit history entry"` — Save writes to `queueHistory.update`, NOT to any session's queue. [👁 View] opens a read-only `QueueHistoryViewModal` (same component file) showing type / interval / runAt / chains / source breadcrumb / usage stats
- **History coupling to queue store**: when a history entry is removed (via 🗑 in the sheet, or by toggling the filled star), `removeEntry` walks every session's queue and clears `historyId` from any live row pointing at the deleted entry — prevents orphan filled stars
- **Per-item on/off toggle**: each queue row has a power-icon button at the leftmost edge. Clicking sets `QueueItem.disabled = true`; the row dims (~55% opacity) with a vertical pause-stripe on the left, and the meta line replaces the next-fire countdown with `— paused —`. Scheduler integration: `pickNext` and `advanceBlockedLoops` (in `src/lib/queueScheduler.ts`) filter out `disabled` items up-front, so loops don't tick, schedules don't fire at their `runAt`, and once items stay queued. Re-enabling a loop resets `nextFireAt = now + intervalMs` to avoid an immediate stale fire from a frozen-in-the-past `nextFireAt`. Status row appends `(N paused)` so the user can see at a glance that some items are inert. `disabled` is stripped from history snapshots, so a freshly applied entry always comes in enabled

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — queueStore is Zustand store
- [Client Persistence](./client-persistence.md) — promptQueue table in IndexedDB
- [Server API](../server/api-endpoints.md) — POST /api/terminals/{terminalId}/write for sending, POST /api/queue-images for image uploads

### Depended On By
- [Session Detail Panel](./session-detail-panel.md) — QueueTab rendered in QUEUE tab + below terminal
- [Views & Routing](./views-routing.md) — QueueView route

### Shared Resources
- queueStore, WebSocket messages

## Change Risks
- Auto-send without proper idle detection can send prompts at wrong time
- Session ID migration must update all queue items
- Drag-and-drop reordering must update position field correctly
- **History `historyId` consistency**: edits made via the history sheet do NOT propagate to live queue items — the ★ only marks "this row was saved once," not "this row matches the saved version." Treat as a memory aid, not a sync link
- **Dexie schema bump**: `queueHistory` introduced in v5. New users get it created on first launch; existing users upgrade automatically. Any future field additions to `DbQueueHistory` need a v6 bump or careful migration
- **Snapshot stripping**: `snapshotItem()` in queueHistoryStore drops session-local fields before save. If a new "per-session" field is added to QueueItem, remember to clear it in the snapshot or it will leak into freshly applied items
