# WebSocket Client

## Function
Manages WebSocket connection to server with auto-reconnect, event replay, and message handling for session updates and terminal I/O.

## Purpose
Real-time bridge between server and browser. Handles connection lifecycle, reconnection with exponential backoff, and event deduplication.

## Source Files
| File | Role |
|------|------|
| `src/lib/wsClient.ts` (~4KB) | WebSocket client class with reconnect logic |
| `src/hooks/useWebSocket.ts` | React hook that creates WsClient, handles 4 message types (snapshot, session_update, session_removed, clearBrowserDb); team_update/hook_stats/terminal_output/terminal_ready/terminal_closed are silently dropped (`break;`). Integrates sound + persistence |

## Implementation
- Reconnection: 1s base delay, 10s max, formula min(1000 * 2^attempt, 10000), no reconnect on auth failure (code 4001)
- On reconnect: sends {type: 'replay', sinceSeq: lastSeq} to recover missed events
- useWebSocket handles: snapshot -> setSessions() bulk replace + setLastSeq + reconcile stale IndexedDB sessions, session_update -> updateSession() with replacesId migration (queue + room + IndexedDB) + persistSessionUpdate() + handleEventSounds() + checkAlarms(), session_removed -> removeSession(), clearBrowserDb -> delete + reopen IndexedDB
- Deduplication: sessions by most recent lastActivityAt
- Sound integration: handleEventSounds() on every session_update, checkAlarms() for approval/input status
- Auth failure: WsClient dispatches CustomEvent 'ws-auth-failed' on close code 4001, does not reconnect
- Backpressure: WsClient checks bufferedAmount before sending, drops non-critical messages above 64KB threshold (terminal_input always sent)
- Additional WsClient methods: `setToken()` (update auth token), `getRawSocket()` (access underlying WebSocket), `getLastSeq()` (current sequence number)

## Dependencies & Connections

### Depends On
- [Server WebSocket Manager](../server/websocket-manager.md) — connects to server WS
- [State Management](./state-management.md) — updates sessionStore, wsStore
- [Client Persistence](./client-persistence.md) — persists session data to IndexedDB
- [Sound/Alarm System](../multimedia/sound-alarm-system.md) — triggers sounds on events

### Depended On By
- [Terminal UI](./terminal-ui.md) — terminal I/O relay (browser transport)
- ALL real-time UI updates depend on this

### Shared Resources
- Single WsClient instance, wsStore state

## Change Risks
- Breaking reconnect logic means clients lose connection permanently
- Changing message types requires server-side changes
- Missing sound integration silences all event notifications
