# WebSocket Client

## Function
Manages the browser's WebSocket connection to the server with auto-reconnect, event replay, backpressure protection, and message routing for session updates, terminal I/O relay, and DB-wipe signals.

## Purpose
Real-time bridge between server and browser. Handles connection lifecycle, reconnection with exponential backoff, sequence-based event replay after a disconnect, and fan-out of incoming session deltas into the Zustand stores, IndexedDB, the sound/alarm engine, pinned auto-respawn, and floating-popup lifecycle.

## Source Files
| File | Role |
|------|------|
| `src/lib/wsClient.ts` (~4KB) | `WsClient` class: connect/reconnect, send with backpressure guard, replay request on reconnect, auth-failure handling, raw-socket access for terminal relay |
| `src/hooks/useWebSocket.ts` | React hook that creates one `WsClient`, routes `ServerMessage`s (snapshot, session_update, session_removed, queue_update, clearBrowserDb, presence_update, control_denied, control_requested), and integrates sound, persistence, pinned respawn, and floating-popup cleanup. `team_update`/`hook_stats`/`terminal_output`/`terminal_ready`/`terminal_closed` are no-ops here (`break;`) — handled by other hooks/components |
| `src/types/websocket.ts` | Discriminated-union message contracts shared by server + client: `ServerMessage` / `ClientMessage` and every member interface, plus `HookStats`, `DevicePresence`, and `ControlHolderView` shapes |
| `src/lib/deviceIdentity.ts` | `getClientId()` / `getClientLabel()` — the stable per-browser-profile identity appended to the WS URL |
| `src/lib/presenceClient.ts` | `installClientIdentityHeaders()` — the same identity on HTTP, patched onto `window.fetch` once from `src/main.tsx` |

## Implementation

### WsClient (`wsClient.ts`)
- **Constructor options**: `{ url, token?, onMessage, onStatus }`.
- **URL build**: resolves `url` against `window.location.origin`, upgrades scheme to `wss:`/`ws:`, appends `?token=` when a token is set, then appends `clientId` + `label` from `src/lib/deviceIdentity.ts`.
- **Why identity rides on the URL, not a post-connect `hello`**: the server sends the `snapshot` and registers the device with `presenceManager` **synchronously** inside `handleConnection`, so an async handshake would race its own first broadcast — the joining device would render the snapshot before it knew it was a spectator. Query params are the only channel available before the first byte, since a browser `WebSocket` cannot set request headers. See [Multi-Device Presence](../server/multi-device-presence.md).
- **Reconnection**: `BASE_DELAY = 1000` (1s), `MAX_DELAY = 10000` (10s), delay `= min(1000 * 2^attempt, 10000)`; attempt counter resets to 0 on a successful `onopen`.
- **No reconnect on auth failure**: close code `4001` → emits `disconnected` status, dispatches `document` CustomEvent `'ws-auth-failed'`, and stops (no reconnect).
- **Replay on reconnect**: `onopen` sends `{ type: 'replay', sinceSeq: lastSeq }` when `lastSeq > 0`. `lastSeq` is tracked from `snapshot` messages (`msg.seq`).
- **Backpressure**: `MAX_BUFFERED = 64 * 1024` (64KB). `send()` only writes when `readyState === OPEN`; if `bufferedAmount > 64KB` it drops the message unless `type === 'terminal_input'` (terminal input is always sent).
- **Other methods**: `setToken(token)` updates the auth token for the next connect; `getRawSocket()` returns the underlying `WebSocket` (used by the terminal relay for direct message access); `getLastSeq()` returns the current sequence; `dispose()` clears the reconnect timer, detaches all handlers, and closes the socket.

### useWebSocket hook (`useWebSocket.ts`)
Creates the client with `url: '/ws'`, registers it in `wsStore` via `setClient`, calls `connect()`, and disposes on cleanup (re-runs when `token` changes). `handleStatus` maps status → `wsStore.setConnected` / `setReconnecting`.

Message handlers:
- **`snapshot`**: dedupes `msg.sessions` by `sessionId`, keeping the entry with the highest `lastActivityAt`; `setSessions(deduped)` (bulk replace) + `setLastSeq(msg.seq)`. Unless a workspace import is in progress (`isImportInProgress()`), calls `floatingSessionsStore.closeOrphans(liveIds)` to close popups whose origin session vanished (prevents leaked PTYs). Persists every session via `persistSessionUpdate`, then reconciles IndexedDB by `bulkDelete`-ing stored sessions absent from the snapshot **and** cascade-deleting each stale session's child rows via `deleteSessionChildrenBatch(staleKeys)` (`@/lib/db`, `db.ts:627`) — cleaning orphan prompts/responses/toolCalls/events/notes/promptQueue/alerts/queueAutomation rows that would otherwise rehydrate as zombie "Unknown" queue groups.
- **`session_update`**: captures `prevStatus` before mutating. If `session.replacesId` is set, migrates the old id → new id **synchronously in Zustand first** (`queueStore.migrateSession`, `roomStore.migrateSession`, `floatingSessionsStore.migrateOriginSession`) **before** the async IndexedDB migration (`migrateSessionId(...).then(delete old)`). The async path also calls `migrateOriginSessionId(replacesId, sessionId)` (`useWebSocket.ts:103`, from `@/lib/translationLog`) to re-point persisted AI-popup/REVIEW rows at the surviving id, so `AiPopupHistory` (which lists by `originSessionId`) doesn't go empty after a re-key. This ordering is intentional: `updateSession()` re-keys the in-memory map atomically and may shift `selectedSessionId`, so QueueTab/Room/floating views must already see the new id by the time React re-renders. It does NOT call `removeSession()` (that would clear `selectedSessionId` before `updateSession` can follow it). Then `updateSession(session)` + `persistSessionUpdate`. On a **fresh** transition to `status === 'ended'` (had a prior non-ended status), calls `onSessionEnded(session)` for pinned auto-respawn (no-op for unpinned/user-closed sessions). Finally `handleEventSounds(session)` and `checkAlarms(session, ...)`.
- **`session_removed`**: `floatingSessionsStore.closeByOriginSession(msg.sessionId)` (close that session's popups so their PTYs don't leak), then `removeSession(msg.sessionId)`.
- **`queue_update`** (broadcast whenever any device changes a session's shared prompt queue): applied directly via `queueStore.applyRemoteQueue(sessionId, items, automation, originClientId)` rather than a "go re-fetch" nudge, so the message alone is enough for a receiving device to converge — no follow-up request. `applyRemoteQueue` is the one that no-ops on the sender's own echo (`originClientId === getClientId()`); this handler does no filtering itself, just an inline runtime shape guard (`typeof sessionId === 'string' && Array.isArray(items)`) before forwarding. See [Prompt Queue → Shared across devices](./prompt-queue.md#shared-across-devices-server-backed-aug-2026).
- **`clearBrowserDb`**: `floatingSessionsStore.closeAll()`, `setSessions(new Map())` (so autoSave can't re-publish killed sessions), then `db.delete().then(db.open())` to wipe + reopen IndexedDB.
- **`presence_update`** (broadcast): `presenceStore.applyPresence(msg)` — the whole device list, control batons, `restoreOwner`, and `workspaceWriter` are replaced wholesale; the server is the single source of truth and this store is a read-model.
- **`control_denied`** (unicast to the rejected writer): `presenceStore.setDenial({ sessionId, by, at: Date.now() })`. The server throttles these per session (`terminal_input` fires per keystroke), so it is a notice explaining the silence, not a per-key event.
- **`control_requested`** (broadcast, carries `toClientId`): `presenceStore.addRequest({...})` **only when `msg.toClientId === getClientId()`**. Unlike `control_denied` this one is sent to every client, so the addressing is enforced on the receiving end — drop the check and a hand-over request aimed at one holder raises a prompt on every connected device.

### HTTP-side identity (`presenceClient.ts`)
The same `clientId`/`label` reach the REST API as `x-aasc-client-id` / `x-aasc-client-label`, installed **once** by `installClientIdentityHeaders()` from `src/main.tsx` before anything fetches. Threading a header through ~100 call sites would let a single omission silently degrade that call to "anonymous device". The patch touches **same-origin requests only** — attaching a custom header to a cross-origin request converts it from a CORS *simple* request into a *preflighted* one, which would break third-party calls that work today — and never overwrites a header the caller already set.

### Message contracts (`types/websocket.ts`)
- **`ServerMessage`** union: `snapshot` (`{ sessions, teams, seq }`), `session_update` (`{ session, team? }`), `session_removed` (`{ sessionId }`), `queue_update` (`{ sessionId, items, automation, updatedAt, originClientId }`), `team_update` (`{ team }`), `hook_stats` (`{ stats }`), `terminal_output` (`{ terminalId, data }`), `terminal_ready` (`{ terminalId }`), `terminal_closed` (`{ terminalId, reason? }`), `clearBrowserDb`, `presence_update` (`{ devices, controllers, restoreOwner, workspaceWriter }`), `control_denied` (`{ sessionId, terminalId, by, byClientId }`), `control_requested` (`{ sessionId, fromClientId, fromLabel, toClientId }`).
- **`ClientMessage`** union: `terminal_input` (`{ terminalId, data }`), `terminal_resize` (`{ terminalId, cols, rows }`), `terminal_disconnect` (`{ terminalId }`), `terminal_subscribe` (`{ terminalId }`), `update_queue_count` (`{ sessionId, count }`), `replay` (`{ sinceSeq }`). **`update_queue_count` is defined (type + `WS_TYPES.UPDATE_QUEUE_COUNT` on the server) but never actually sent** — queue counts reach the UI through `queueStore` (persisted/synced independently, see [Prompt Queue](./prompt-queue.md)), not this message. Don't assume it fires; two components' own comments (`DetailTabs.tsx`, `SessionSwitcher.tsx`) already flag it as unused.
- **`HookStats`**: `{ totalHooks, hooksPerMin, events: Record<string, HookEventStats>, sampledAt }`, with per-event `count`/`rate`/`latency`/`processing` (`HookTimingStats` = `{ avg, min, max, p95 }`). Consumed elsewhere (hook stats UI), not in this hook.

## Dependencies & Connections

### Depends On
- [Server WebSocket Manager](../server/websocket-manager.md) — connects to the server WS endpoint, source of all `ServerMessage`s
- [State Management](./state-management.md) — updates sessionStore, wsStore, queueStore, roomStore, floatingSessionsStore
- [Prompt Queue](./prompt-queue.md) — `queue_update` is applied straight into `queueStore.applyRemoteQueue`, the receiving half of the queue's cross-device sync
- [Client Persistence](./client-persistence.md) — `persistSessionUpdate`, `migrateSessionId`, `deleteSessionChildrenBatch`, IndexedDB reconcile/wipe
- [Review Tab](./review-tab.md) — `migrateOriginSessionId` (`@/lib/translationLog`) re-points persisted AI-popup/REVIEW rows on a re-key so `AiPopupHistory` survives
- [Sound & Alarm System](../multimedia/sound-alarm-system.md) — `handleEventSounds` / `checkAlarms` on each `session_update`
- [Floating Terminal Fork](./floating-terminal-fork.md) — floatingSessionsStore popup-lifecycle calls in every handler
- [Workspace Snapshot](./workspace-snapshot.md) — `isImportInProgress()` gate that suppresses orphan-close during restore
- [Multi-Device Presence](../server/multi-device-presence.md) — `deviceIdentity` supplies the URL params + fetch headers; `presenceStore` consumes all three presence messages

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
- **Moving `clientId`/`label` to a post-connect handshake re-opens the snapshot race** — the server registers presence and sends the snapshot synchronously, so an async hello lands after both.
- **Dropping the `msg.toClientId === getClientId()` check on `control_requested`** pops a hand-over prompt on every connected device, since the message is broadcast.
- **`queue_update` handling must stay a straight pass-through to `applyRemoteQueue`.** The echo-suppression (ignore a broadcast that is this device's own write, reflected back by the server) lives entirely inside `applyRemoteQueue`/`_skipServerPush`, not in this hook — duplicating or second-guessing that check here risks either double-applying an echo (ping-pong) or dropping a genuine remote update.
- **Widening `installClientIdentityHeaders` past same-origin** turns every cross-origin `fetch` into a preflighted request.
