# WebSocket Manager

## Function
Manages WebSocket connections, broadcasts session state changes, relays terminal I/O, and handles reconnect replay.

## Purpose
Real-time communication channel between server and all connected browser clients. Without it, the UI would need polling.

## Source Files
| File | Role |
|------|------|
| `server/wsManager.ts` (~20KB, 503 lines) | WebSocket server, broadcast, terminal relay, heartbeat, presence registration + control gating + per-client session-visibility gating |
| `server/index.ts` | WS origin (CSWSH) + two-dimensional auth/remote-password gate before `handleConnection()`; `maxPayload` on the `WebSocketServer` (index.ts:63); parses `clientId`/`label` off the upgrade URL and passes them in as `ClientIdentity` |
| `server/sessionVisibility.ts` | `canSeeSession`/`filterVisibleSessions` — gates the snapshot, every session-bearing broadcast, and `terminal_subscribe`. Owned by [Authentication](./authentication.md), which documents the full rule. |
| `server/presenceManager.ts` | Device registry + per-session control baton consulted on every `terminal_input`/`terminal_resize`; source of `presenceSnapshot()`. See [Multi-Device Presence](./multi-device-presence.md) |
| `server/hookProcessor.ts` | `scheduleBroadcast` — 250ms/session `session_update` coalescing (`SESSION_UPDATE_THROTTLE_MS`, hookProcessor.ts:11-33) + the piggybacked `team_update` |
| `server/sessionUpdateCoalescer.ts`, `test/sessionUpdateCoalescer.test.ts` | Pure latest-state/earliest-`replacesId` merge and regression coverage for rapid re-key events |

## Implementation

### Connection Lifecycle
Origin validation and auth both happen in `server/index.ts` (`wss.on('connection')`, lines ~204-262) BEFORE `handleConnection()` runs — wsManager itself does NO origin/auth checks:
- Origin validation (anti-CSWSH): if `origin`'s host differs from the request `host`, close with code **4003** (`Forbidden: origin mismatch`); an unparseable origin closes 4003 (`Forbidden: invalid origin`)
- Auth is now the **same two-dimensional gate** as `authMiddleware` (see [Authentication → Remote access requires a password](./authentication.md)), not password-only: when password protection is enabled (`isPasswordEnabled()`), the token is read from the `auth_token` cookie (preferred) or `extractToken(req)`; an invalid token closes with code **4001** (`Unauthorized`). When NO password is configured, a **loopback** connection still passes freely, but a **remote** one is refused with code **4003** (`Forbidden: set a password to allow remote devices`) — 4003 rather than 4001 because there is no credential to submit. `isLoopbackAddress` (`presenceManager.ts`) is the shared predicate, same one used by the auth gate and the device-presence 🖥/📱 split.
- `handleConnection(ws, identity?)` then: enforces max **50** connections (close code **4003**, `Too many connections`) -> registers client -> registers the device with `presenceManager` -> starts the heartbeat (on first client only) -> sends a `snapshot` -> `broadcastPresence()` -> wires message/close/error handlers
- **The snapshot is now visibility-filtered, not "all sessions".** `filterVisibleSessions(client._isLocal, allSessions)` (`server/sessionVisibility.ts`) drops any session not shared with a remote client — localhost always gets everything. The response carries a `hiddenCount` (the difference between the unfiltered and filtered session counts) so a remote client can report "18 hidden" instead of looking broken with a near-empty dashboard. See [Authentication → Per-session remote visibility](./authentication.md) for the full rule and the other five leak paths it closes.

### Device Identity (multi-device)
- `ClientIdentity = { clientId, label, address }` is **read from the WS upgrade URL query params** in `index.ts` (`clientId` sliced to 128 chars, `label` to 200; a malformed URL degrades to an unidentified client) and handed to `handleConnection`. It is deliberately NOT a post-connect `hello` message: `handleConnection` sends the snapshot and calls `broadcastPresence()` synchronously, so an async handshake would race its own first broadcast and the joining device would render before it knew it was a spectator.
- `WsClient` gains `_clientId` (`''` when unidentified), `_label` (through `presence.sanitizeDeviceLabel`), `_isLocal` (computed once at connect via `isLoopbackAddress(identity.address)` — the same predicate backing the auth gate and the device list, so all three agree on what "this machine" means; drives both the snapshot filter and the per-broadcast visibility check below), and `_lastDenyAt: Map<sessionId, number>` (the `control_denied` throttle).
- `broadcastPresence()` is **exported** and pushes `presence_update` (devices + controllers + `restoreOwner` + `workspaceWriter`) to every client. It fires on connect, on close, and on error. `apiRouter` fires the same message on every baton change from its **own** private copy of the helper, which `await import('./wsManager.js')`s `broadcast` lazily — apiRouter cannot statically import wsManager without a cycle, so the two helpers are duplicates by necessity.

Per-client guards inside the message handler:
- Rate limit: max **100** messages/sec; on exceed, close with code **4004** (`Rate limit exceeded`)
- Max inbound message size: **524288** bytes (512KB), enforced **twice with different failure modes**: the ws server is constructed with `maxPayload: 512 * 1024` (`index.ts:63`), which makes the ws library reject an oversized frame at the frame layer and **close the connection** (1009); wsManager then re-checks `rawStr.length > 524288` (wsManager.ts:179) and silently **drops** (does not parse) anything that gets through

### Heartbeat
- ping every 30s (`HEARTBEAT_INTERVAL_MS = 30000`); on each tick, terminate any client that hasn't replied with a pong since the previous ping (effective drop window: up to 30s). Started lazily on the first connection and stopped when the last client disconnects.

### Server-to-Client Messages
- `snapshot`, `session_update`, `session_removed`, `team_update`, `hook_stats`, `terminal_output`, `terminal_ready`, `terminal_closed`, `terminal_error`, `clearBrowserDb`
- `terminal_geometry` (`WS_TYPES.TERMINAL_GEOMETRY`) — the PTY's real `{ cols, rows }` ([`sshManager.getTerminalGeometry`](./terminal-ssh.md)), sent by `sendGeometry()` to the joining socket only on `terminal_subscribe`, and re-broadcast by `broadcastGeometry()` to every subscriber of that terminal after any resize. Lets a client too narrow to drive the PTY (a phone) render at the PTY's actual width and pan instead of soft-wrapping a hard-wrapped 120-column screen into ~49. Both are best-effort/silent-fail: a client that never receives it just falls back to fitting its own container.
- Multi-device: `presence_update` (broadcast — full device/baton state), `control_denied` (unicast to the rejected writer), `control_requested` (broadcast; only the client whose id equals `toClientId` reacts). All are in `WS_TYPES` (`server/constants.ts`) and in the `ServerMessage` union (`src/types/websocket.ts`).
- Replay responses: the server answers a client `replay` request by re-sending each missed event's raw `data` payload individually (not as a wrapped `replay` message)

### Client-to-Server Messages
- `terminal_input`, `terminal_resize`, `terminal_disconnect`, `terminal_subscribe`, `update_queue_count`, `replay`
- Unknown message types are silently ignored

### Broadcast Throttle
- session_update broadcasts are throttled to 250ms per sessionId (max 4/sec) via `hookProcessor.scheduleBroadcast`. `coalesceSessionUpdate` takes the latest state/team while retaining the earliest one-shot `replacesId`, so a rapid follow-up hook cannot hide a terminal→UUID migration from clients.
- **Every session-bearing broadcast is now also visibility-filtered per client.** `broadcastToClients` pulls the `remoteVisible` flag off a `SESSION_UPDATE`'s `session` payload (`broadcastSubject`) and, for each connected client, skips the send when `!canSeeSession(client._isLocal, subject)` — serialized once regardless, since the common case (no hidden session in play) needs no second payload. Without this the snapshot filter would be pointless: the very next status change on a hidden session would re-broadcast it to everyone. Broadcasts with no `session` field (presence, hook stats, teams) are never subject to this check and reach every client as before. See [Authentication → Per-session remote visibility](./authentication.md).

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

- An **unidentified socket bypasses arbitration entirely** — `if (!client._clientId) return true;` — an old cached client or a non-browser consumer writes freely, exactly as before this feature existed. This is deliberate, not an oversight: letting it through `noteControlActivity` would register `''` as a session's holder and put a phantom device in the presence UI.
- `holdsControl` resolves the terminal's session via `sessionIdForTerminal(terminalId)`, **not** `getTerminalSessionId` alone — that function tries [`sshManager.getTerminalSessionId`](./terminal-ssh.md) first (O(1), but only populated by `linkSession`, which runs on the workDir-matching path) and falls back to [`sessionStore.getSessionIdByTerminalId`](./session-management.md) (a Map scan keyed by `session.terminalId`, which survives re-keying). Relying on the first alone would silently disable the write gate for any terminal matched by another priority or created via the API — the worst failure mode here, since the feature would look implemented and arbitrate nothing.
- Once a session is resolved, `presence.noteControlActivity(sessionId, client._clientId)` both **arbitrates** the write and **refreshes** the idle-takeover window, so no separate "claim" call is needed for normal typing.
- **A terminal with no linked session is always writable.** An ops shell, or an agent PTY whose first hook has not landed, has no baton to arbitrate; gating it would make a brand-new session unusable for the seconds before it is matched.
- `terminal_resize` is gated for the same reason as input, not for symmetry: a resize mutates the *shared* PTY, so a phone in portrait would reflow the desktop's terminal to ~40 columns.
- A denial emits a `control_denied` (`{ sessionId, terminalId, by, byClientId }`) throttled per session by `CONTROL_DENY_NOTICE_MS = 3000`. The throttle is mandatory: `terminal_input` fires **per keystroke**, so an un-throttled notice would emit one message per character a spectator types.

### Terminal Relay
- `terminal_subscribe` first checks `canSubscribeToTerminal(client, terminalId)` — localhost always may; a remote client may only if the terminal resolves (via the same `sessionIdForTerminal` fallback above) to a session that is `remoteVisible`, and a terminal with NO resolvable session (an ops shell, or a PTY whose first hook hasn't landed) is denied to remote clients, failing closed. This is the **non-obvious** visibility leak: subscription is keyed by `terminalId`, not session id, so without this check a remote client could hide a session from its own list yet still stream that session's live PTY output in full. A blocked attempt is logged and simply drops the subscribe (no message sent) — see [Authentication → Per-session remote visibility](./authentication.md).
- Only once that check passes does it register the client via `setWsClient()`, which itself returns `false` only if the terminal doesn't exist; `setWsClient` is **additive** (a Set of subscribers), and the buffered scrollback is replayed to the joining socket only (handled in `sshManager.ts`), which also sends the initial `terminal_geometry` for that terminal (see above). A non-existent terminal returns `terminal_closed { terminalId, reason: "unavailable" }` to the requesting client so the UI shows an unavailable state instead of an empty xterm.
- `terminal_disconnect` unsubscribes **this client only** — `removeWsClient(id, client)`, NOT the old `setWsClient(id, null)`. Now that subscribers are a Set, nulling the whole set would blank every *other* device's terminal because one device closed a tab. The PTY is still only destroyed by `DELETE /api/terminals/:id` or a session kill.
- A successful `terminal_resize` re-broadcasts `terminal_geometry` to every OTHER subscriber of that terminal (`broadcastGeometry`), so a panning phone re-pins to the new width instead of silently clipping or over-padding until it reconnects.

### Client Detach (`detachClient`)
`close` and `error` both route through `detachClient(client)`, which removes the socket from `clients`, calls `removeClientFromAllTerminals(client)`, clears `_terminalIds`, and `presence.unregisterClient(_clientId)`; the handlers then `broadcastPresence()`. The first `clients.delete` doubles as an idempotence guard (a socket that errors then closes detaches once).

This is required, not tidy-up: the single `wsClient` reference it replaced was self-cleaning (the next subscriber overwrote it), while a Set retains every socket that ever subscribed. Skip it and each terminal leaks one dead socket per reconnect, and every chunk of PTY output then pays a failed send for each corpse.

### Queue Count Sync
- `update_queue_count` (sessionId + count, validated 0-10000) calls `updateQueueCount()`; if the session exists, the resulting session is re-broadcast as a `session_update`

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — `getAllSessions`/`getAllTeams`/`getEventSeq`/`getEventsSince`/`updateQueueCount`/`getSessionIdByTerminalId`/`getSession` for snapshot, replay, queue-count sync, and the `sessionIdForTerminal`/visibility-check fallbacks
- [Authentication](./authentication.md) — token validation and the remote-password gate happen in `index.ts` (origin + auth gate) before `handleConnection()`; `server/sessionVisibility.ts`'s `canSeeSession`/`filterVisibleSessions` gate the snapshot, every session-bearing broadcast, and `terminal_subscribe` — see that doc's "Per-session remote visibility" section for the full rule
- [Terminal/SSH](./terminal-ssh.md) — `writeToTerminal`/`resizeTerminal`/`setWsClient`/`removeWsClient`/`removeClientFromAllTerminals`/`getTerminalSessionId`/`getTerminalGeometry` for terminal I/O relay and the `terminal_geometry` message
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
- **Relying on `getTerminalSessionId` alone (skipping the `getSessionIdByTerminalId` fallback) silently disables the write gate** for any terminal not matched via the workDir-linking path — which is most terminals matched by another priority, or created via the API. The failure is invisible: the feature still looks implemented, it just arbitrates nothing.
- **Filtering the session list/snapshot without also filtering `SESSION_UPDATE` broadcasts and `terminal_subscribe`** produces a feature that only appears to work — the next status change, or a direct terminal subscribe, re-leaks the session that the list correctly hid.
