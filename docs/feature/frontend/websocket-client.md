# WebSocket Client

## Function
Manages the browser's WebSocket connection to the server with auto-reconnect, event replay, backpressure protection, and message routing for session updates, terminal I/O relay, and DB-wipe signals.

## Purpose
Real-time bridge between server and browser. Handles connection lifecycle, reconnection with exponential backoff, sequence-based event replay after a disconnect, and fan-out of incoming session deltas into the Zustand stores, IndexedDB, the sound/alarm engine, pinned auto-respawn, and floating-popup lifecycle.

## Source Files
| File | Role |
|------|------|
| `src/lib/wsClient.ts` (~4KB) | `WsClient` class: connect/reconnect, send with backpressure guard, replay request on reconnect, auth-failure handling, raw-socket access for terminal relay |
| `src/hooks/useWebSocket.ts` | React hook that creates one `WsClient`, routes `ServerMessage`s (snapshot, session_update, session_removed, clearBrowserDb), and integrates sound, persistence, pinned respawn, and floating-popup cleanup. `team_update`/`hook_stats`/`terminal_output`/`terminal_ready`/`terminal_closed` are no-ops here (`break;`) — handled by other hooks/components |
| `src/types/websocket.ts` | Discriminated-union message contracts shared by server + client: `ServerMessage` / `ClientMessage` and every member interface, plus `HookStats` shape |

## Implementation

### WsClient (`wsClient.ts`)
- **Constructor options**: `{ url, token?, onMessage, onStatus }`.
- **URL build**: resolves `url` against `window.location.origin`, upgrades scheme to `wss:`/`ws:`, appends `?token=` when a token is set.
- **Reconnection**: `BASE_DELAY = 1000` (1s), `MAX_DELAY = 10000` (10s), delay `= min(1000 * 2^attempt, 10000)`; attempt counter resets to 0 on a successful `onopen`.
- **No reconnect on auth failure**: close code `4001` → emits `disconnected` status, dispatches `document` CustomEvent `'ws-auth-failed'`, and stops (no reconnect).
- **Replay on reconnect**: `onopen` sends `{ type: 'replay', sinceSeq: lastSeq }` when `lastSeq > 0`. `lastSeq` is tracked from `snapshot` messages (`msg.seq`).
- **Backpressure**: `MAX_BUFFERED = 64 * 1024` (64KB). `send()` only writes when `readyState === OPEN`; if `bufferedAmount > 64KB` it drops the message unless `type === 'terminal_input'` (terminal input is always sent).
- **Other methods**: `setToken(token)` updates the auth token for the next connect; `getRawSocket()` returns the underlying `WebSocket` (used by the terminal relay for direct message access); `getLastSeq()` returns the current sequence; `dispose()` clears the reconnect timer, detaches all handlers, and closes the socket.

### useWebSocket hook (`useWebSocket.ts`)
Creates the client with `url: '/ws'`, registers it in `wsStore` via `setClient`, calls `connect()`, and disposes on cleanup (re-runs when `token` changes). `handleStatus` maps status → `wsStore.setConnected` / `setReconnecting`.

Message handlers:
- **`snapshot`**: dedupes `msg.sessions` by `sessionId`, keeping the entry with the highest `lastActivityAt`; `setSessions(deduped)` (bulk replace) + `setLastSeq(msg.seq)`. Unless a workspace import is in progress (`isImportInProgress()`), calls `floatingSessionsStore.closeOrphans(liveIds)` to close popups whose origin session vanished (prevents leaked PTYs). Persists every session via `persistSessionUpdate`, then reconciles IndexedDB by `bulkDelete`-ing stored sessions absent from the snapshot **and** cascade-deleting each stale session's child rows via `deleteSessionChildrenBatch(staleKeys)` (`@/lib/db`, `db.ts:627`) — cleaning orphan prompts/responses/toolCalls/events/notes/promptQueue/alerts/queueAutomation rows that would otherwise rehydrate as zombie "Unknown" queue groups.
- **`session_update`**: captures `prevStatus` before mutating. If `session.replacesId` is set, migrates the old id → new id **synchronously in Zustand first** (`queueStore.migrateSession`, `roomStore.migrateSession`, `floatingSessionsStore.migrateOriginSession`) **before** the async IndexedDB migration (`migrateSessionId(...).then(delete old)`). The async path also calls `migrateOriginSessionId(replacesId, sessionId)` (`useWebSocket.ts:100`, from `@/lib/translationLog`) to re-point persisted AI-popup/REVIEW rows at the surviving id, so `AiPopupHistory` (which lists by `originSessionId`) doesn't go empty after a re-key. This ordering is intentional: `updateSession()` re-keys the in-memory map atomically and may shift `selectedSessionId`, so QueueTab/Room/floating views must already see the new id by the time React re-renders. It does NOT call `removeSession()` (that would clear `selectedSessionId` before `updateSession` can follow it). Then `updateSession(session)` + `persistSessionUpdate`. On a **fresh** transition to `status === 'ended'` (had a prior non-ended status), calls `onSessionEnded(session)` for pinned auto-respawn (no-op for unpinned/user-closed sessions). Finally `handleEventSounds(session)` and `checkAlarms(session, ...)`.
- **`session_removed`**: `floatingSessionsStore.closeByOriginSession(msg.sessionId)` (close that session's popups so their PTYs don't leak), then `removeSession(msg.sessionId)`.
- **`clearBrowserDb`**: `floatingSessionsStore.closeAll()`, `setSessions(new Map())` (so autoSave can't re-publish killed sessions), then `db.delete().then(db.open())` to wipe + reopen IndexedDB.

### Message contracts (`types/websocket.ts`)
- **`ServerMessage`** union: `snapshot` (`{ sessions, teams, seq }`), `session_update` (`{ session, team? }`), `session_removed` (`{ sessionId }`), `team_update` (`{ team }`), `hook_stats` (`{ stats }`), `terminal_output` (`{ terminalId, data }`), `terminal_ready` (`{ terminalId }`), `terminal_closed` (`{ terminalId, reason? }`), `clearBrowserDb`.
- **`ClientMessage`** union: `terminal_input` (`{ terminalId, data }`), `terminal_resize` (`{ terminalId, cols, rows }`), `terminal_disconnect` (`{ terminalId }`), `terminal_subscribe` (`{ terminalId }`), `update_queue_count` (`{ sessionId, count }`), `replay` (`{ sinceSeq }`).
- **`HookStats`**: `{ totalHooks, hooksPerMin, events: Record<string, HookEventStats>, sampledAt }`, with per-event `count`/`rate`/`latency`/`processing` (`HookTimingStats` = `{ avg, min, max, p95 }`). Consumed elsewhere (hook stats UI), not in this hook.

## Dependencies & Connections

### Depends On
- [Server WebSocket Manager](../server/websocket-manager.md) — connects to the server WS endpoint, source of all `ServerMessage`s
- [State Management](./state-management.md) — updates sessionStore, wsStore, queueStore, roomStore, floatingSessionsStore
- [Client Persistence](./client-persistence.md) — `persistSessionUpdate`, `migrateSessionId`, `deleteSessionChildrenBatch`, IndexedDB reconcile/wipe
- [Review Tab](./review-tab.md) — `migrateOriginSessionId` (`@/lib/translationLog`) re-points persisted AI-popup/REVIEW rows on a re-key so `AiPopupHistory` survives
- [Sound & Alarm System](../multimedia/sound-alarm-system.md) — `handleEventSounds` / `checkAlarms` on each `session_update`
- [Floating Terminal Fork](./floating-terminal-fork.md) — floatingSessionsStore popup-lifecycle calls in every handler
- [Workspace Snapshot](./workspace-snapshot.md) — `isImportInProgress()` gate that suppresses orphan-close during restore

### Depended On By
- [Terminal UI](./terminal-ui.md) — terminal I/O relay (browser transport) via `getRawSocket()` and the terminal `ClientMessage`s
- ALL real-time session UI updates depend on this hook

### Shared Resources
- Single `WsClient` instance registered in `wsStore`; the `ServerMessage`/`ClientMessage` contracts are shared verbatim with the server.

## Change Risks
- Breaking reconnect or replay logic means clients silently lose events after a disconnect.
- Changing any `ServerMessage`/`ClientMessage` shape requires matching server-side changes (the union in `types/websocket.ts` is the shared contract).
- The synchronous-Zustand-then-async-IDB ordering in the `replacesId` path is load-bearing: reversing it can orphan queue/room/floating state under the dead session id.
- Skipping the floating-popup cleanup calls (`closeOrphans`/`closeByOriginSession`/`closeAll`) leaks server-side PTYs as invisible orphans.
- Dropping `handleEventSounds`/`checkAlarms` silences all event notifications and alarms.
