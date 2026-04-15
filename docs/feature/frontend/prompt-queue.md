# Prompt Queue System

## Function
Per-session prompt queuing with drag-and-drop reordering, cross-session moves, image attachments, and optional auto-send on waiting/input status.

## Purpose
Users can queue up multiple prompts for a session and have them sent automatically, enabling batch workflows.

## Source Files
| File | Role |
|------|------|
| `src/stores/queueStore.ts` | Queues Map<string, QueueItem[]>, add/remove/reorder/moveToSession/setQueue/migrateSession/loadFromDb |
| `src/components/session/QueueTab.tsx` | Session-specific queue view |
| `src/routes/QueueView.tsx` | Global queue view across all sessions |

## Implementation
- QueueItem: {id, sessionId, text, position, createdAt, images?: QueueImageAttachment[]}
- QueueImageAttachment: {name, dataUrl} — up to 5 attachments per item. Three input methods:
  - **File picker** (paperclip button): accepts images + common text files (.pdf, .txt, .md, .json, .csv, .xml, .yaml, .log)
  - **Clipboard paste** (Cmd/Ctrl+V): captures pasted images/files from clipboard via `onPaste` handler on the compose textarea. Binary data is intercepted (prevents pasting as garbled text)
  - **Drag and drop**: drop files onto the compose area; cyan border highlights the drop zone during drag-over
- Queue operations: add (append), remove (by id), reorder (drag-and-drop), moveToSession (dropdown picker), send now, edit (inline textarea)
- Auto-send: per-session toggle (localStorage['queue-auto-send'], defaults to ON). When session transitions to 'waiting' or 'input' status, first queued item is sent to terminal via POST /api/terminals/{terminalId}/write, only removed after successful send
- Send mechanism: POST /api/terminals/{terminalId}/write with {data: text + images paths + newline}. Images uploaded first via POST /api/queue-images
- Global QueueView: shows all sessions' queues grouped by session, add prompt to any session via session selector (Select dropdown), table layout with MOVE/DEL actions
- Persistence: IndexedDB promptQueue table via Zustand subscribe callback, survives page reloads. Images serialized as JSON in DbQueueItem.images field
- Session ID migration: queueStore.migrateSession re-keys all items when a session is replaced (e.g., claude --resume)
- QueueTab collapsible: localStorage['queue-panel-collapsed'], defaults to collapsed

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
