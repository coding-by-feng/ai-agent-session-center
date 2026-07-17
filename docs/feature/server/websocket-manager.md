# WebSocket Manager

## Function
Manages WebSocket connections, broadcasts session state changes, relays terminal I/O, and handles reconnect replay.

## Purpose
Real-time communication channel between server and all connected browser clients. Without it, the UI would need polling.

## Source Files
| File | Role |
|------|------|
| `server/wsManager.ts` (~9KB) | WebSocket server, broadcast, terminal relay, heartbeat |
| `server/index.ts` | WS origin (CSWSH) + token gate before `handleConnection()`; `maxPayload` on the `WebSocketServer` (index.ts:82) |
| `server/hookProcessor.ts` | `scheduleBroadcast` — 250ms/session `session_update` coalescing (`SESSION_UPDATE_THROTTLE_MS`, hookProcessor.ts:11-33) + the piggybacked `team_update` |

## Implementation

### Connection Lifecycle
Origin validation and auth both happen in `server/index.ts` (`wss.on('connection')`, lines ~206-236) BEFORE `handleConnection()` runs — wsManager itself does NO origin/auth checks:
- Origin validation (anti-CSWSH): if `origin`'s host differs from the request `host`, close with code **4003** (`Forbidden: origin mismatch`); an unparseable origin closes 4003 (`Forbidden: invalid origin`)
- Auth: only when password protection is enabled (`isPasswordEnabled()`), the token is read from the `auth_token` cookie (preferred) or `extractToken(req)`; an invalid token closes with code **4001** (`Unauthorized`)
- `handleConnection()` then: enforces max **50** connections (close code **4003**, `Too many connections`) -> registers client -> starts the heartbeat (on first client only) -> sends a `snapshot` (all sessions + teams + event seq) -> wires message/close/error handlers

Per-client guards inside the message handler:
- Rate limit: max **100** messages/sec; on exceed, close with code **4004** (`Rate limit exceeded`)
- Max inbound message size: **524288** bytes (512KB), enforced **twice with different failure modes**: the ws server is constructed with `maxPayload: 512 * 1024` (`index.ts:82`), which makes the ws library reject an oversized frame at the frame layer and **close the connection** (1009); wsManager then re-checks `rawStr.length > 524288` (wsManager.ts:112) and silently **drops** (does not parse) anything that gets through

### Heartbeat
- ping every 30s (`HEARTBEAT_INTERVAL_MS = 30000`); on each tick, terminate any client that hasn't replied with a pong since the previous ping (effective drop window: up to 30s). Started lazily on the first connection and stopped when the last client disconnects.

### Server-to-Client Messages
- `snapshot`, `session_update`, `session_removed`, `team_update`, `hook_stats`, `terminal_output`, `terminal_ready`, `terminal_closed`, `terminal_error`, `clearBrowserDb`
- Replay responses: the server answers a client `replay` request by re-sending each missed event's raw `data` payload individually (not as a wrapped `replay` message)

### Client-to-Server Messages
- `terminal_input`, `terminal_resize`, `terminal_disconnect`, `terminal_subscribe`, `update_queue_count`, `replay`
- Unknown message types are silently ignored

### Broadcast Throttle
- session_update broadcasts are throttled to 250ms per sessionId (max 4/sec) via hookProcessor.ts scheduleBroadcast, coalescing updates within each window

### Backpressure
- hook_stats dropped if client.bufferedAmount > 1MB

### hook_stats Throttle
- Max 1/sec per client, pending stored and sent when window expires

### Event Ring Buffer
- 500 events, client sends replay {sinceSeq: N} to recover missed events

### Terminal Input Validation & Subscription Enforcement
- A client may only write/resize/disconnect terminals it has subscribed to — `terminal_input`, `terminal_resize`, and `terminal_disconnect` are ignored for terminal IDs not in the client's `_terminalIds` set
- Max terminal input data size: **262144** bytes (256KB); oversized payloads rejected
- Terminal resize bounds enforced: cols 1-500, rows 1-200; a `resizeTerminal()` error is relayed back to the client as a `terminal_error`

### Terminal Relay
- `terminal_subscribe` registers the client via `setWsClient()` only if the terminal actually exists; the buffered scrollback is replayed immediately on subscribe (handled in `sshManager.ts`). Non-existent terminals are ignored
- `terminal_disconnect` unsubscribes the client (`setWsClient(id, null)`) WITHOUT killing the PTY — the PTY is only destroyed by `DELETE /api/terminals/:id` or a session kill

### Queue Count Sync
- `update_queue_count` (sessionId + count, validated 0-10000) calls `updateQueueCount()`; if the session exists, the resulting session is re-broadcast as a `session_update`

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — `getAllSessions`/`getAllTeams`/`getEventSeq`/`getEventsSince`/`updateQueueCount` for snapshot, replay, and queue-count sync
- [Authentication](./authentication.md) — token validation happens in `index.ts` (origin + auth gate) before `handleConnection()`
- [Terminal/SSH](./terminal-ssh.md) — `writeToTerminal`/`resizeTerminal`/`setWsClient` for terminal I/O relay

### Depended On By
- [Frontend WebSocket Client](../frontend/websocket-client.md) — receives all real-time data and issues `replay` on reconnect
- [Terminal UI](../frontend/terminal-ui.md) — terminal I/O relay (browser transport)

### Shared Resources
- WebSocket server instance
- Event ring buffer
- Terminal subscriber Map

## Change Risks
- Breaking the WS protocol disconnects ALL browser clients
- Changing message types requires frontend updates
- Breaking terminal relay blocks browser-based terminal usage
- Auth changes can lock out all clients
