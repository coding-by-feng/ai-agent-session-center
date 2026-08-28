# Multi-Device Presence & Control

## Function
Lets several devices point at the same server at once: everyone sees every session and every terminal live, while exactly one device at a time may *write* to a given session. Also decides which single device may run the (destructive) workspace restore and which may persist the shared workspace snapshot.

## Purpose
Opening the dashboard from a second device used to **destroy the first device's workspace**. `useWorkspaceAutoLoad` is mounted in `App.tsx`, so it ran on every client; its first act is `POST /api/sessions/clear-all`, which kills every PTY and deletes every session, after which it rebuilds them from the shared snapshot. Two clients doing that concurrently produced duplicate session cards, dead terminals, and orphans bucketed into the synthesized "Ungrouped" room.

Independently, terminals were **last-subscriber-wins**: `Terminal.wsClient` was a single reference, so a second device subscribing silently stole the output stream and the first device's terminal froze with no error raised anywhere.

Both are the same root cause: global, shared, mutable state being driven by per-client code with no notion of *who is asking*.

## Source Files
| File | Role |
|------|------|
| `server/presenceManager.ts` | Device registry, restore claim, control batons, workspace-writer election |
| `server/ptySubscribers.ts` | Pure `fanOutToSockets()` — multi-subscriber send + dead-socket pruning |
| `server/wsManager.ts` | Registers/unregisters devices, gates `terminal_input`/`terminal_resize`, broadcasts presence |
| `server/index.ts` | Reads `clientId`/`label` off the WebSocket upgrade URL |
| `server/apiRouter.ts` | `clientIdFromRequest()`, restore-claim + presence/control endpoints, `clear-all` and `workspace/save` guards; `GET /api/config` also returns `localIP` (below) |
| `server/networkInfo.ts` | `getLocalIP()` — this machine's LAN-reachable IPv4, shared by the startup log (`server/index.ts`) and `GET /api/config` so the two can't disagree |
| `server/sshManager.ts` | `Terminal.wsClients` Set, `setWsClient`/`removeWsClient`/`removeClientFromAllTerminals`, `getTerminalSessionId` |
| `server/sessionStore.ts` | `migrateControl` on re-key, `dropControl` on delete/clear-all |
| `src/lib/deviceIdentity.ts` | Stable per-browser `clientId` + human label (`deriveDeviceLabel` is pure) |
| `src/lib/presenceClient.ts` | Global fetch identity headers + typed wrappers for the presence endpoints |
| `src/stores/presenceStore.ts` | Client read-model + `canControlSession` / `canWriteWorkspace` selectors |
| `src/components/layout/DevicePresenceChip.tsx` | Header chip (in `.stats`, alongside `?`/export/import/settings/quit — moved out of NavBar) + portaled device panel |
| `src/components/session/SessionControlLock.tsx` | Per-session holder badge, Ask / Take control / Grant / Release |
| `src/styles/modules/DevicePresence.module.css` | Chip, panel, and lock styling |
| `test/presenceManager.test.ts`, `test/workspaceRestoreClaim.test.ts`, `test/ptySubscribers.test.ts`, `src/stores/presenceStore.test.ts`, `test/networkInfo.test.ts`, `src/components/layout/DevicePresenceChip.test.tsx` | Coverage |

## Implementation

### The model: shared reads, exclusive writes
There is only ONE PTY per session, on the server; every client is a *view* of it. So "pause the session on the other device" is the wrong shape — pausing the view would blank a window while the agent kept running. What actually collides is writes:

- two people typing into one PTY interleaves keystrokes into garbage
- a resize mutates the shared PTY (a phone in portrait reflows the desktop to ~40 columns)
- two queue schedulers on one session fire every prompt twice
- two auto-resume watchdogs each burn an attempt from a budget sized for one

Reads therefore fan out to everyone; writes go through a per-session baton.

### Device identity
`src/lib/deviceIdentity.ts` mints a `clientId` (localStorage, `crypto.randomUUID`) and derives a label like `iPhone · Safari` / `Mac · Desktop App`. Identity is **per browser profile, not per tab** — you should never fight your own second tab for a baton. It reaches the server two ways:

- **HTTP**: `installClientIdentityHeaders()` patches `window.fetch` **once**, in `main.tsx`, adding `x-aasc-client-id` / `x-aasc-client-label`. Threading a header through ~100 call sites would make a single omission silently degrade that call to "anonymous device". The patch only touches **same-origin** requests — a custom header on a cross-origin request converts it from a CORS simple request into a preflighted one.
- **WebSocket**: `clientId` + `label` query params on the upgrade URL. Not a post-connect `hello` message: `handleConnection` sends the snapshot and registers presence synchronously, so an async handshake would race its own first broadcast.

The label is attacker-controlled text that gets logged and rendered, so `sanitizeDeviceLabel` strips C0/C1 control characters (a raw newline would forge a server-log line), collapses whitespace, and caps at 60 chars.

### Workspace-restore claim
`POST /api/workspace/restore-claim` grants exactly **one** device per server process the right to restore. Everyone else is told who owns it and skips the restore entirely.

`isReclaimable` re-grants a held claim only when **all three** hold, and each condition is load-bearing:

| Condition | Removing it causes |
|-----------|--------------------|
| `CLAIM_GRACE_MS` (60 s) elapsed | Two devices booting against a fresh server both get granted — the holder's WS has not registered yet, so a claim made microseconds ago looks stale. Both restore. The bug returns via a race. |
| Holder disconnected | A crashed restore locks the workspace for the rest of the server's life. |
| Zero live sessions | A reconnecting client can `clear-all` a workspace other devices are using — the original bug, re-armed. |

An explicit `POST /api/workspace/restore-claim/release` bypasses the grace window, so a genuinely failed import retries immediately. `useWorkspaceAutoLoad` releases on every failure and no-op path.

### The `clear-all` guard
`POST /api/sessions/clear-all` returns **409** `{error:'workspace-in-use', liveSessions, by}` unless the caller holds the restore claim, or zero sessions are live (a cold server has nothing to lose). The check keys off the **claim**, not "is this a known device" — a stale or hostile client that merely sends a client-id must not pass.

Client-side, `importSnapshot` **aborts** on 409 and returns `{created:0, failed:0, failedTitles:[]}`. It must not fall through: continuing would clear the Zustand store and re-create every session on top of the ones still running, which is precisely the duplicate-card outcome. This is the one failure mode where "continue anyway" is worse than doing nothing.

### Workspace writer
Auto-save also runs on every client, and the snapshot carries the **room layout**, which lives in each client's own localStorage. A phone that has never seen the desktop's rooms would overwrite them with an empty set — and the pre-existing "never save an empty snapshot" guard does **not** catch it, because the session list is fully populated from the WS snapshot and only the rooms are wrong.

`getWorkspaceWriter()` elects one device: **local beats remote, then oldest connection**. The locality preference is the important half — the machine running the server owns the authoritative room layout even if a phone has been connected longer. It is *derived*, not claimed, so there is no state to go stale and the role transfers by itself on disconnect. `POST /api/workspace/save` 409s a non-writer; the client also skips the request via `canWriteWorkspace()`.

### Control baton
`controllers: Map<sessionId, ControlHolder>` in `presenceManager`.

- `canControl` is true when the session is **unclaimed**, **already yours**, or held by a **disconnected** device. The last one means closing a laptop hands its sessions to the phone with no timer, no grace period, and no cleanup pass that could race a reconnect. The entry is deliberately *kept* so the UI can still name who had it last (`online: false`).
- `noteControlActivity(sessionId, clientId)` refreshes the idle window and **implicitly claims a free session**. This is what makes "the device that launched a session controls it" fall out with no extra call: `POST /api/terminals` calls it, so a phone connecting later finds every session taken and is a spectator by default.
- `claimControl(..., {force:true})` succeeds only once the holder has been idle ≥ `IDLE_TAKEOVER_MS` (60 s), so an unattended desktop can never lock you out from your phone.
- `requestControl` / `grantControl` are the cooperative path; only the current holder may grant.
- **`migrateControl` runs on re-key.** A session is re-keyed from its `term-*` placeholder to the CLI's real UUID moments after launch, so a baton claimed at creation would be stranded under a dead id — silently demoting the launching device to a spectator on its own new session. Wired into `sessionStore`'s `replacesId` branch. `dropControl` runs on delete and in the `clearAllSessions` loop.

### Multi-subscriber terminals
`Terminal.wsClients: Set<WebSocket>` replaces the single `wsClient`. `setWsClient` is now additive; scrollback replay is sent **only to the joining socket** (re-sending it to the others would duplicate their whole screen).

The Set moves a hazard into `ptySubscribers.ts`: a single reference was self-cleaning (the next subscriber overwrote it), while a Set retains every socket that ever joined. Pruning is therefore part of the send path:

- **CONNECTING (0) is never pruned** — a socket mid-handshake is not dead; evicting it would unsubscribe a device during its own connect and leave a permanently blank terminal until reload.
- **CLOSING (2) / CLOSED (3) are pruned.**
- **A throwing `send` prunes and the loop continues** — `ws` can throw on a socket that closed between the readyState check and the write; unhandled, one wedged socket throws on every chunk forever *and* starves every subscriber after it in iteration order.

`detachClient()` in `wsManager` removes a departing socket from every terminal. Without it a long-lived server accumulates one corpse per terminal per reconnect.

### Write gate
`holdsControl()` in `wsManager` gates `terminal_input` and `terminal_resize`. A terminal with **no linked session** is always writable — otherwise a brand-new session would be unusable for the seconds before it is matched. Denials emit a `control_denied` throttled to once per session per `CONTROL_DENY_NOTICE_MS` (3 s), because `terminal_input` fires per keystroke.

### UI
- **`DevicePresenceChip`** is **always shown** (changed Aug 2026 — it used to `return null` while only one device was connected, so the common, solo case had no way to check what was connected or learn this device's own address for a phone to use; the panel's per-device logic already worked correctly at length 1, it was only ever the render gate hiding it). The panel is `createPortal`'d to `<body>` as `position: fixed`, placed from the trigger's viewport rect and clamped, re-placing on `scroll` with `capture: true` (scroll does not bubble). Its z-index is **10060** — in the 10000+ band with Tooltip (10000) and SelectionPopup (10050) — because portaling re-parents it into the root stacking context where it competes with full-screen overlays, not with its own Header row. The chip carries `min-height: 32px` to match the `.headerIconBtn` neighbours it now sits among (it renders ~21px on its own padding alone), and owns no margin — `.stats` spaces the cluster with `gap`. Each device row also shows its address (`formatAddress` — strips the `::ffff:` IPv4-mapped-IPv6 prefix, and normalizes bare `::1` to `127.0.0.1`; `d.address` itself is a raw `req.socket.remoteAddress`, unreadable as-is).
- **The panel's own "connect a phone at …" line** (Aug 2026) is a *different* address from the per-device ones above — those show where *already-connected* devices came FROM, this shows where a *new* device should connect TO. `GET /api/config` gained a `localIP` field (`server/networkInfo.ts`'s `getLocalIP()`, extracted out of `server/index.ts` so the startup log and this endpoint can't drift on which interface they prefer — en0/en1/eth0/wlan0, first non-internal IPv4, else any non-internal IPv4, else `null`). Fetched lazily — only once the panel is **opened**, not on mount — since the chip is now always rendered, and hitting `/api/config` on every page load for a value most sessions never look at would undo the "no chrome for the common case" restraint the rest of this component follows; cached after the first fetch (a mid-session LAN change is rare enough that a reload covers it). The port half comes from `window.location.port` — the page's OWN actual port — not the config file's nominal `port` field, which can diverge from it after a `portManager.ts` `EADDRINUSE` retry. Renders nothing when `localIP` is `null` (no reachable LAN interface). A small copy button reuses the `navigator.clipboard.writeText` + transient-checkmark pattern already used in `ConversationView`/`ProjectTab`. **A password is now REQUIRED before that URL works at all** — remote clients are refused with 403 (HTTP) / 4003 (WebSocket) when none is configured, so the panel shows an actionable ⚠ notice in that state, gated on the `passwordEnabled` flag `GET /api/config` returns. See [Authentication → Remote access requires a password](./authentication.md).
- **`SessionControlLock`** sits first in `SessionControlBar`. Without it a spectator types into the terminal and nothing happens, which reads as a broken app rather than as another device holding the session.

## Dependencies & Connections

### Depends On
- [WebSocket Manager](./websocket-manager.md) — transport for `presence_update` / `control_denied` / `control_requested`
- [Terminal/SSH](./terminal-ssh.md) — subscriber Set, `getTerminalSessionId`
- [Session Management](./session-management.md) — live session count, re-key hook for `migrateControl`

### Depended On By
- [Workspace Snapshot](../frontend/workspace-snapshot.md) — restore claim + writer election
- [Queue Scheduler](../frontend/queue-scheduler.md) / [Auto-Resume Watchdog](../frontend/auto-resume-watchdog.md) — `canControlSession` gate
- [Session Detail Panel](../frontend/session-detail-panel.md) — control lock
- [State Management](../frontend/state-management.md) — `presenceStore`

### Shared Resources
- `devices` / `controllers` Maps and the restore claim (module state in `presenceManager`)
- `Terminal.wsClients` Sets

## Change Risks
- **Weakening any of the three `isReclaimable` conditions re-arms the workspace-destruction bug.** Each has a named regression test.
- **Granting the restore claim to an unidentified caller** (no `x-aasc-client-id`) makes it impossible to distinguish one anonymous caller from the next; the endpoint 400s instead.
- **Letting `importSnapshot` continue past a 409** recreates duplicate cards on top of live sessions.
- **Removing `migrateControl` from the re-key path** silently makes the launching device a spectator on its own new session.
- **Un-portaling the presence panel, or lowering its z-index out of the 10000+ band**, renders it behind `.detailOverlay` (100) — fully placed, correctly sized, invisible.
- **Pruning CONNECTING sockets** unsubscribes devices mid-connect.
- **Dropping the whole subscriber set on `terminal_disconnect`** (the old `setWsClient(id, null)`) blanks every other device's terminal.
- **Removing the `canControlSession` gate from `evaluateSession`** double-fires every queued prompt once a second device connects. The gate must stay *above* the `maybeAutoResume` call, which sends prompts of its own.
- **Coverage boundary:** Electron IPC terminals (`pty-*`, created via `electronAPI.createPty`) live in `ptyHost` where the server sees no bytes, so they cannot be shared or arbitrated. Only server-owned `term-*` PTYs participate — which today is all of them, since `QuickSessionModal` (the sole `createPty` caller) is unmounted.
