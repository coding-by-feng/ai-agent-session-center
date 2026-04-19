# WebSocket Manager

## Function
Manages WebSocket connections, broadcasts session state changes, relays terminal I/O, and handles reconnect replay.

## Purpose
Real-time communication channel between server and all connected browser clients. Without it, the UI would need polling.

## Source Files
| File | Role |
|------|------|
| `server/wsManager.ts` (~9KB) | WebSocket server, broadcast, terminal relay, heartbeat |

## Implementation

### Connection Lifecycle
- connect -> enforce max 50 connections -> auth check performed in `server/index.ts` (lines ~226-233) BEFORE `handleConnection()` is called (wsManager does NO auth) -> send snapshot (all sessions + teams + seq) -> heartbeat loop
- Per-client rate limit: max 100 messages/sec, close with code 4004 if exceeded
- Max inbound message size: 512KB (oversized messages silently dropped)

### Heartbeat
- ping every 30s; on each tick, terminate any client that hasn't replied with a pong since the previous ping (effective drop window: up to 30s)

### Server-to-Client Messages
- snapshot, session_update, session_removed, team_update, hook_stats, terminal_output, terminal_ready, terminal_closed, terminal_error, clearBrowserDb, replay

### Client-to-Server Messages
- terminal_input, terminal_resize, terminal_disconnect, terminal_subscribe, update_queue_count, replay

### Broadcast Throttle
- session_update broadcasts are throttled to 250ms per sessionId (max 4/sec) via hookProcessor.ts scheduleBroadcast, coalescing updates within each window

### Backpressure
- hook_stats dropped if client.bufferedAmount > 1MB

### hook_stats Throttle
- Max 1/sec per client, pending stored and sent when window expires

### Event Ring Buffer
- 500 events, client sends replay {sinceSeq: N} to recover missed events

### Terminal Input Validation
- Max terminal input data size: 262,144 bytes (256KB); oversized payloads rejected
- Terminal resize bounds enforced: cols 1-500, rows 1-200

### Terminal Relay
- terminal_subscribe registers WS client for terminal output
- Buffer replay sent immediately on subscribe

### Authentication
- Rejected with WS code 4001 if password enabled and token invalid

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — reads session data for snapshot and updates
- [Authentication](./authentication.md) — validates tokens on connection
- [Terminal/SSH](./terminal-ssh.md) — relays terminal I/O to/from PTY processes

### Depended On By
- Frontend websocket client — receives all real-time data
- Frontend terminal UI — terminal I/O relay (browser transport)

### Shared Resources
- WebSocket server instance
- Event ring buffer
- Terminal subscriber Map

## Change Risks
- Breaking the WS protocol disconnects ALL browser clients
- Changing message types requires frontend updates
- Breaking terminal relay blocks browser-based terminal usage
- Auth changes can lock out all clients
