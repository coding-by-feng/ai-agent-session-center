# Remote Control Relink Daemon

## Function
Keeps a session's Claude Code **Remote Control** link fresh, so the session
keeps showing as live in the Claude app. When an armed session goes idle, the
daemon cycles the link: `/remote-control` (disconnect), a short pause, then
`/remote-control <name>` (reconnect).

## Purpose
`/remote-control <name>` is injected once at session start (`sshManager.ts`,
from `config.remoteControlName`) and never touched again — a link that goes
stale stays stale. There was also no way to refresh it short of typing the
commands by hand.

## Source Files
| File | Role |
|------|------|
| `server/remoteControlDaemon.ts` | Arming, cooldown ledger, name derivation, the relink itself |
| `server/autoIdleManager.ts` | Fires `onSessionIdle` on the transition into idle; resolves the terminal and performs the PTY write |
| `server/apiRouter.ts` | `PUT /api/sessions/:id/remote-control-daemon` (arm/disarm) |
| `server/sessionStore.ts` | `migrateSession` on re-key, `forgetSession` on delete |
| `src/components/session/SessionControlBar.tsx` | 🛰 AUTO-RELINK toggle |
| `test/remoteControlDaemon.test.ts` | 23 tests |

## The two commands

Verified against the installed Claude Code binary's own strings rather than
assumed:

- `"Disconnect anytime with /remote-control"` → **bare = disconnect**
- `"You can always enable it later with /remote-control"`

So the name is meaningful **only on the enable half**. Attaching it to the
first command would re-enable rather than disconnect, and the cycle would be a
no-op.

## The self-retrigger hazard

Writing the commands is PTY *input*. Input moves the session out of `idle`, and
it returns to `idle` minutes later — an idle edge **the cycle itself created**.
Unguarded, this is an unattended loop typing slash commands into a live session
forever.

**Both guards are required; neither is sufficient alone:**

| Guard | Why it isn't enough by itself |
|---|---|
| Edge-triggering (`autoIdleManager`'s loop `continue`s on already-idle sessions) | The cycle produces a genuine edge |
| `COOLDOWN_MS` = 30 min, per session | A long-idle session would re-fire every window forever |

Together: the relink's own idle→working→idle round trip finishes far inside 30
minutes, so the edge it causes is suppressed.

The cooldown is stamped **before** the writes. A PTY that dies mid-cycle still
consumes the window rather than being retried on every subsequent idle edge.

## Rules

1. **Disarming is sticky.** Nothing re-arms a session automatically. A watchdog
   that re-enables what the user switched off makes the off switch a lie.
2. **Off by default**, opt-in per session — it types into a live CLI, so it
   must never be something the user gets by accident.
3. **The name must never be empty.** `/remote-control` with no argument is the
   *disconnect* command, so a title that sanitizes to `''` (an all-CJK title,
   for instance) would silently disconnect instead of reconnecting.
   `remoteControlNameFor` falls back title → projectName → `session-<id8>`.
4. **Server-owned PTYs only.** An Electron `pty-*` terminal lives in `ptyHost`
   where the server sees no bytes; `getTerminalGeometry` returning null is the
   liveness check.
5. **State follows the session.** `migrateSession` on a `claude --resume`
   re-key (next to `migrateControl` — without it an armed session silently
   disarms and its cooldown resets, so the first idle after a resume relinks
   immediately), `forgetSession` on delete.

## Why the name never matched before

`deriveRemoteControlName` runs **only** in `NewSessionModal` /
`QuickSessionModal`, against the modal's title field — but `session.title` is
`''` until the first `UserPromptSubmit`. So the link is almost always named
`<projectBasename>-<n>` and never tracks the title the user sees. Re-deriving
at relink time is the fix; seeding a non-empty title at creation instead would
permanently suppress the auto-title.

`NAME_SAFE_RE` is duplicated from `src/lib/remoteControlName.ts` because
`tsconfig.server.json` includes only `server` and `src/types` and cannot reach
`src/lib` — the same constraint as `ptyRing.ts`. A test asserts the two regexes
stay identical, since drift produces a name the API rejects with a 400 and no
obvious cause.

## Dependencies & Connections

### Depends On
- [Process Monitor](./process-monitor.md) — `autoIdleManager`'s idle-transition loop is what fires `onSessionIdle`
- [Terminal / SSH](./terminal-ssh.md) — the relink is written as PTY input on the session's terminal
- [Session Management](./session-management.md) — armed state migrates on `migrateSession` (resume re-key) and is dropped on `forgetSession` (delete)
- `src/lib/remoteControlName.ts` — `NAME_SAFE_RE` is duplicated here (see "Why the name never matched before") and must stay identical

### Depended On By
- [Session Detail Panel](../frontend/session-detail-panel.md) — the 🛰 AUTO-RELINK toggle lives in `SessionControlBar`

### Shared Resources
- `sshManager.ts`'s `config.remoteControlName` (the one-time injection at session start that this daemon refreshes)

## Change risks
- Widening what re-arms a session breaks rule 1 and makes the toggle dishonest.
- Removing the cooldown reopens the infinite relink loop (4 tests go red).
- Removing the empty-name fallback turns a reconnect into a silent disconnect
  (3 tests go red).
