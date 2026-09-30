# Session Visibility (Remote Sharing)

## Function
Gates which sessions a REMOTE device (anything reaching the server over the LAN, not the machine running it) is allowed to see, read, or act on. A session is invisible everywhere — session list, WebSocket snapshot, live PTY stream, prompt/history queries, kill/fork/resume — until it is explicitly opted in via the 📡 toggle.

## Purpose
The dashboard binds `0.0.0.0` and is reachable from any device on the LAN. A password ([Authentication](./authentication.md)) gates *access*, but without this feature every authenticated device saw every session: content, transcripts, live PTY output, and the controls to kill or fork it. This closes that gap without touching the desktop app at all — localhost always sees everything.

## Source Files
| File | Role |
|------|------|
| `server/sessionVisibility.ts` | The rule itself — pure, import-free (no Express/ws/session-store) so it's unit-testable directly and reusable from both the HTTP and WebSocket boundaries without either importing the other |
| `server/apiRouter.ts` | `requireVisibleSession` middleware (`router.use('/sessions/:id', requireVisibleSession)`), `PUT /sessions/:id/remote-visible` (the toggle — localhost-only), the `GET /api/queues` and `/db/*` gates (see Change Risks) |
| `server/wsManager.ts` | Filters the connect-time session snapshot (`filterVisibleSessions(client._isLocal, ...)`), gates the `TERMINAL_SUBSCRIBE` message per-client, and gates broadcast delivery per-subscriber |
| `server/sessionStore.ts` | `setSessionRemoteVisible(sessionId, remoteVisible)` |
| `server/db.ts` | `sessions.remote_visible INTEGER DEFAULT 0` (`ALTER TABLE` migration — see Implementation) |
| `server/presenceManager.ts` | `isLoopbackAddress` — the single "is this machine?" predicate this feature shares with the auth gate and the 🖥/📱 device split |
| `src/types/session.ts` | `remoteVisible?: boolean` on `Session` |
| `src/stores/sessionStore.ts` | `toggleRemoteVisible(sessionId)` — optimistic flip + `PUT` |
| `src/components/session/SessionControlBar.tsx` | The 📡 toggle button — reads "HOST ONLY" / "SHARED" (no emoji prefix, matching the row's MUTE/ALERT convention) |
| `test/sessionVisibility.test.ts` | 11 tests covering the pure rule |

## Implementation

### The rule (`sessionVisibility.ts`)
```ts
function canSeeSession(isLocalClient, session): boolean {
  if (isLocalClient) return true;
  if (!session) return false;
  return session.remoteVisible === true;
}
```
`isLocalClient` must come from `isLoopbackAddress` (`presenceManager.ts`) — never a second hand-rolled address comparison, so the auth gate, the 🖥/📱 device split, and this feature all agree on what "this machine" means.

- `filterVisibleSessions(isLocalClient, sessions)` — the subset of a session map a client may see. Returns the input **unchanged** for a local client (the common case) rather than rebuilding a copy on every broadcast.
- `countHiddenSessions(isLocalClient, sessions)` — how many sessions are being withheld, surfaced in the UI so a remote user sees "18 hidden" rather than concluding the dashboard is broken.

### Default is deny, and the flag names the safe state
`remoteVisible` is stored so that an **absent** value (every session that predates the feature, or a fresh session before the user decides) means **NOT visible**. The column is `remote_visible INTEGER DEFAULT 0`; the `ALTER TABLE` migration back-fills every existing row with that default. A `hidden` flag would have inverted this — every pre-feature row would read `undefined`/falsy for "hidden" and be exposed to every LAN device the moment the feature shipped. The absent state must be the safe state, because that is the state of every row written before this code existed. (Contrast [`aiPopupEnabled`](../frontend/terminal-ui.md), which deliberately inverts this same rule — see that doc's "default-ON inversion" note — because *its* safe default is the opposite direction.)

### The gates
- **REST**: one middleware, not seventeen per-route checks — `requireVisibleSession` is mounted once via `router.use('/sessions/:id', requireVisibleSession)`, so it covers every `/sessions/:id/*` route (kill, fork, resume, and the rest) without relying on each new route remembering to add its own check.
- **WebSocket**: the connect-time snapshot goes through `filterVisibleSessions(client._isLocal, allSessions)`; a `TERMINAL_SUBSCRIBE` request is checked per-client (keyed by the owning session, not the raw terminal id — a hidden session's terminal must not be streamable just because its id isn't literally the session id); and outgoing broadcasts are filtered per-subscriber so a hidden session's `SESSION_UPDATE` never reaches a client that can't see it.
- **`GET /api/queues`** (the bulk queue-hydration route) sits **outside** `/sessions/:id`, so it does not inherit `requireVisibleSession` and filters for itself via `filterVisibleSessions`/`countHiddenSessions` directly.
- **`/db/*`** (prompt/history search) is a **second store** carrying the same data in a different shape (raw prompt text), so it needs its own `canSeeSession` check — hiding a live session's card does nothing for its history if this path is missed.
- **The toggle itself is localhost-only**: `PUT /sessions/:id/remote-visible` is gated the same way as every other host-only control, since anything that can reach the port must not be able to grant itself access to a hidden session.

### A missing session resolves to hidden, never to an error that leaks which case it is
`canSeeSession` returns `false` for a `null`/`undefined` session — a remote client asking about a nonexistent id gets the same denial as one asking about a real-but-hidden id. `requireVisibleSession` answers both with **404, never 403**: a 403 would tell a remote client "this session exists, you're just not allowed to see it," turning the status code into an oracle for enumerating real session ids. An unresolvable subject (a terminal with no owning session record — an ops shell, or a PTY whose first hook hasn't landed yet, or an archived session with no in-memory record) fails **closed**: denied to remote clients. For an archived session specifically this is deliberate, not incidental — a session that has ended can no longer be opted in through the UI, so treating "no live record" as permissive would build a permanently-readable set of history that no toggle can ever revoke.

## Dependencies & Connections

### Depends On
- [Authentication](./authentication.md) — `isLoopbackAddress` backs both the auth gate and this feature's local/remote split
- [State Management](../frontend/state-management.md) — `remoteVisible` lives on the `Session` object

### Depended On By
- [WebSocket Manager](./websocket-manager.md) — snapshot filter, `TERMINAL_SUBSCRIBE` gate, per-subscriber broadcast filter
- [API Endpoints](./api-endpoints.md) — the `requireVisibleSession` middleware and the `/sessions/:id/remote-visible` route
- [Session Management](./session-management.md) — `setSessionRemoteVisible`
- [Database](./database.md) — `sessions.remote_visible` column + migration
- [Session Detail Panel](../frontend/session-detail-panel.md) — the 📡 control lives in `SessionControlBar`
- [Multi-Device Presence](./multi-device-presence.md) — defines "this machine" the same way the 🖥/📱 device split does

### Shared Resources
- `isLoopbackAddress` (`presenceManager.ts`)
- `sessions.remote_visible` DB column

## Change Risks
- **The list is only the most visible of six leak paths** — the WS connect-time snapshot, `SESSION_UPDATE` broadcast, `GET /api/sessions`, the `/sessions/:id/*` routes, `TERMINAL_SUBSCRIBE`, and `/db/*` all carry the same data independently. A fix that only gates the list "works" in the UI while every other path still leaks.
- Adding a new bulk/list-shaped endpoint that reads sessions is exactly where this gets missed — it must either mount under `/sessions/:id` (inherits the middleware for free) or explicitly call `filterVisibleSessions`/`canSeeSession` itself, the way `GET /api/queues` does.
- Never replace `isLoopbackAddress` with a second hand-rolled address comparison in this file — the auth gate, the 🖥/📱 split, and this feature must never disagree about what "local" means.
- Never flip the 404/403 choice on a hidden session — 403 turns the status code into a session-id enumeration oracle.
- Never change an archived (no in-memory record) session's fail-closed default to permissive — that would make hiding a session's history permanently irrevocable in the opposite direction (unrevokable exposure instead of unrevokable denial).

Covered by `test/sessionVisibility.test.ts` (11 tests, pure — no server boot required).
