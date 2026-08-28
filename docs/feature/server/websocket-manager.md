# WebSocket Manager

## Function
Manages WebSocket connections, broadcasts session state changes, relays terminal I/O, and handles reconnect replay.

## Purpose
Real-time communication channel between server and all connected browser clients. Without it, the UI would need polling.

## Source Files
| File | Role |
|------|------|
| `server/wsManager.ts` (~9KB) | WebSocket server, broadcast, terminal relay, heartbeat, presence registration + control gating |
| `server/index.ts` | WS origin (CSWSH) + token gate before `handleConnection()`; `maxPayload` on the `WebSocketServer` (index.ts:82); parses `clientId`/`label` off the upgrade URL and passes them in as `ClientIdentity` |
| `server/presenceManager.ts` | Device registry + per-session control baton consulted on every `terminal_input`/`terminal_resize`; source of `presenceSnapshot()`. See [Multi-Device Presence](./multi-device-presence.md) |
| `server/hookProcessor.ts` | `scheduleBroadcast` — 250ms/session `session_update` coalescing (`SESSION_UPDATE_THROTTLE_MS`, hookProcessor.ts:11-33) + the piggybacked `team_update` |
| `server/sessionUpdateCoalescer.ts`, `test/sessionUpdateCoalescer.test.ts` | Pure latest-state/earliest-`replacesId` merge and regression coverage for rapid re-key events |

## Implementation

### Connection Lifecycle
Origin validation and auth both happen in `server/index.ts` (`wss.on('connection')`, lines ~219-248) BEFORE `handleConnection()` runs — wsManager itself does NO origin/auth checks:
- Origin validation (anti-CSWSH): if `origin`'s host differs from the request `host`, close with code **4003** (`Forbidden: origin mismatch`); an unparseable origin closes 4003 (`Forbidden: invalid origin`)
- Auth: only when password protection is enabled (`isPasswordEnabled()`), the token is read from the `auth_token` cookie (preferred) or `extractToken(req)`; an invalid token closes with code **4001** (`Unauthorized`)
- `handleConnection(ws, identity?)` then: enforces max **50** connections (close code **4003**, `Too many connections`) -> registers client -> registers the device with `presenceManager` -> starts the heartbeat (on first client only) -> sends a `snapshot` (all sessions + teams + event seq) -> `broadcastPresence()` -> wires message/close/error handlers

### Device Identity (multi-device)
- `ClientIdentity = { clientId, label, address }` is **read from the WS upgrade URL query params** in `index.ts` (`clientId` sliced to 128 chars, `label` to 200; a malformed URL degrades to an unidentified client) and handed to `handleConnection`. It is deliberately NOT a post-connect `hello` message: `handleConnection` sends the snapshot and calls `broadcastPresence()` synchronously, so an async handshake would race its own first broadcast and the joining device would render before it knew it was a spectator.
- `WsClient` gains `_clientId` (`''` when unidentified), `_label` (through `presence.sanitizeDeviceLabel`), and `_lastDenyAt: Map<sessionId, number>` (the `control_denied` throttle).
- `broadcastPresence()` is **exported** and pushes `presence_update` (devices + controllers + `restoreOwner` + `workspaceWriter`) to every client. It fires on connect, on close, and on error. `apiRouter` fires the same message on every baton change from its **own** private copy of the helper, which `await import('./wsManager.js')`s `broadcast` lazily — apiRouter cannot statically import wsManager without a cycle, so the two helpers are duplicates by necessity.

Per-client guards inside the message handler:
- Rate limit: max **100** messages/sec; on exceed, close with code **4004** (`Rate limit exceeded`)
- Max inbound message size: **524288** bytes (512KB), enforced **twice with different failure modes**: the ws server is constructed with `maxPayload: 512 * 1024` (`index.ts:82`), which makes the ws library reject an oversized frame at the frame layer and **close the connection** (1009); wsManager then re-checks `rawStr.length > 524288` (wsManager.ts:112) and silently **drops** (does not parse) anything that gets through

### Heartbeat
- ping every 30s (`HEARTBEAT_INTERVAL_MS = 30000`); on each tick, terminate any client that hasn't replied with a pong since the previous ping (effective drop window: up to 30s). Started lazily on the first connection and stopped when the last client disconnects.

### Server-to-Client Messages
- `snapshot`, `session_update`, `session_removed`, `team_update`, `hook_stats`, `terminal_output`, `terminal_ready`, `terminal_closed`, `terminal_error`, `clearBrowserDb`
- Multi-device: `presence_update` (broadcast — full device/baton state), `control_denied` (unicast to the rejected writer), `control_requested` (broadcast; only the client whose id equals `toClientId` reacts). All three are in `WS_TYPES` (`server/constants.ts`) and in the `ServerMessage` union (`src/types/websocket.ts`).
- Replay responses: the server answers a client `replay` request by re-sending each missed event's raw `data` payload individually (not as a wrapped `replay` message)

### Client-to-Server Messages
- `terminal_input`, `terminal_resize`, `terminal_disconnect`, `terminal_subscribe`, `update_queue_count`, `replay`
- Unknown message types are silently ignored

### Broadcast Throttle
- session_update broadcasts are throttled to 250ms per sessionId (max 4/sec) via `hookProcessor.scheduleBroadcast`. `coalesceSessionUpdate` takes the latest state/team while retaining the earliest one-shot `replacesId`, so a rapid follow-up hook cannot hide a terminal→UUID migration from clients.

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

### Write Gating (control baton)
Reads are shared across devices; **writes are not**. Both `terminal_input` and `terminal_resize` pass through `holdsControl(client, terminalId)` before touching the PTY:

- `holdsControl` resolves the terminal's session via `getTerminalSessionId(terminalId)` (O(1) Map read) and calls `presence.noteControlActivity(sessionId, client._clientId)` — which both **arbitrates** the write and **refreshes** the idle-takeover window, so no separate "claim" call is needed for normal typing.
- **A terminal with no linked session is always writable.** An ops shell, or an agent PTY whose first hook has not landed, has no baton to arbitrate; gating it would make a brand-new session unusable for the seconds before it is matched.
- `terminal_resize` is gated for the same reason as input, not for symmetry: a resize mutates the *shared* PTY, so a phone in portrait would reflow the desktop's terminal to ~40 columns.
- A denial emits a `control_denied` (`{ sessionId, terminalId, by, byClientId }`) throttled per session by `CONTROL_DENY_NOTICE_MS = 3000`. The throttle is mandatory: `terminal_input` fires **per keystroke**, so an un-throttled notice would emit one message per character a spectator types.

### Terminal Relay
- `terminal_subscribe` registers the client via `setWsClient()` only if the terminal actually exists; `setWsClient` is **additive** (a Set of subscribers), and the buffered scrollback is replayed to the joining socket only (handled in `sshManager.ts`). A non-existent terminal returns `terminal_closed { terminalId, reason: "unavailable" }` to the requesting client so the UI shows an unavailable state instead of an empty xterm.
- `terminal_disconnect` unsubscribes **this client only** — `removeWsClient(id, client)`, NOT the old `setWsClient(id, null)`. Now that subscribers are a Set, nulling the whole set would blank every *other* device's terminal because one device closed a tab. The PTY is still only destroyed by `DELETE /api/terminals/:id` or a session kill.

### Client Detach (`detachClient`)
`close` and `error` both route through `detachClient(client)`, which removes the socket from `clients`, calls `removeClientFromAllTerminals(client)`, clears `_terminalIds`, and `presence.unregisterClient(_clientId)`; the handlers then `broadcastPresence()`. The first `clients.delete` doubles as an idempotence guard (a socket that errors then closes detaches once).

This is required, not tidy-up: the single `wsClient` reference it replaced was self-cleaning (the next subscriber overwrote it), while a Set retains every socket that ever subscribed. Skip it and each terminal leaks one dead socket per reconnect, and every chunk of PTY output then pays a failed send for each corpse.

### Queue Count Sync
- `update_queue_count` (sessionId + count, validated 0-10000) calls `updateQueueCount()`; if the session exists, the resulting session is re-broadcast as a `session_update`

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — `getAllSessions`/`getAllTeams`/`getEventSeq`/`getEventsSince`/`updateQueueCount` for snapshot, replay, and queue-count sync
- [Authentication](./authentication.md) — token validation happens in `index.ts` (origin + auth gate) before `handleConnection()`
- [Terminal/SSH](./terminal-ssh.md) — `writeToTerminal`/`resizeTerminal`/`setWsClient`/`removeWsClient`/`removeClientFromAllTerminals`/`getTerminalSessionId` for terminal I/O relay
- [Multi-Device Presence](./multi-device-presence.md) — `registerClient`/`unregisterClient`/`noteControlActivity`/`getController`/`presenceSnapshot`; the write gate and `presence_update` both live here

### Depended On By
- [Frontend WebSocket Client](../frontend/websocket-client.md) — receives all real-time data and issues `replay` on reconnect
- [Terminal UI](../frontend/terminal-ui.md) — terminal I/O relay (browser transport)

### Shared Resources
- WebSocket server instance
- Event ring buffer
- Per-terminal subscriber **Set** (`Terminal.wsClients`, owned by `sshManager`)
- `presenceManager`'s device registry + control batons

## Change Risks
- Breaking the WS protocol disconnects ALL browser clients
- Changing message types requires frontend updates
- Breaking terminal relay blocks browser-based terminal usage
- Auth changes can lock out all clients
- **Moving identity to a post-connect handshake re-opens the snapshot race.** The snapshot and the first `presence_update` are sent synchronously inside `handleConnection`; an async hello lands after both, so the joining device would briefly believe it controls sessions another device holds.
- **Dropping `detachClient` (or reverting `terminal_disconnect` to `setWsClient(id, null)`) is invisible in testing with one device.** The first leaks dead sockets onto every terminal; the second blanks the *other* device's terminal — neither raises an error anywhere.
- **The `control_denied` throttle is not cosmetic** — `terminal_input` is per-keystroke, so removing `CONTROL_DENY_NOTICE_MS` turns a spectator holding a key down into a message flood that also trips the 100 msg/sec rate limiter.
- Gating a terminal with **no** linked session would make every newly created session unusable until its first hook lands.
