# Auto-Resume Watchdog

## Function
Detects when an agent turn died from a **transient** failure — an `API Error: 529 Overloaded` / 5xx banner, a rate limit, or a connection error printed into the PTY — and automatically sends a configurable continuation prompt so the session resumes instead of sitting parked. Bounded by exponential backoff, jitter, and a rolling-window attempt ledger.

## Purpose
The hook stream carries **no error payload**. A turn killed by a 529 still ends with `Stop`, so the session lands in `waiting` — byte-for-byte identical to a turn that finished its task successfully. Nothing in the session state machine can tell the two apart, which means:

1. An unattended session silently stops making progress after a transient provider error, and stays stopped until a human notices.
2. Worse, if a queue is running, `isSendableStatus('waiting')` is `true`, so [Queue Scheduler](./queue-scheduler.md) **already** fires the *next* queue item into a turn that never finished — quietly skipping the interrupted work.

The error text exists only in the terminal bytes, so detection has to read the PTY. Detection and policy are split across the process boundary on purpose: the server owns the byte stream (event-driven, O(chunk)), the renderer owns the retry policy, per-session config, and the single writer to the PTY.

## Source Files
| File | Role |
|------|------|
| `server/interruptionDetector.ts` | Edge-triggered banner recognition. `matchFault(text)` (pure classifier), `scanChunk(terminalId, chunk, now)` (stateful, per-terminal carry + dedupe), `clearFaultState`, `resetFaultStates`. |
| `src/lib/resumeWatchdog.ts` | Pure policy state machine — `decideResume(prev, input)`, `pruneAttempts`, `backoffFor`, `faultLabel`, and every constant below. No React, no store, no clock of its own. |
| `server/sshManager.ts` | `registerTerminalFaultCallback(cb)` + the private `notePtyOutput(terminalId, data)` helper, called from both agent-terminal `onData` seams; `clearFaultState(terminalId)` in `cleanup`. |
| `server/sessionStore.ts` | Attaches the fault to the owning session (`session.interruption`), broadcasts it, and clears it on forward-progress hook events. |
| `src/types/session.ts` | `FaultKind`, `SessionInterruption`, and the `Session.interruption` field. |
| `src/hooks/useGlobalQueueScheduler.ts` | `maybeAutoResume(...)` — evaluates the watchdog once per session per 1s tick, ahead of the queue, sharing `firingRefs`/`coolDownRefs`. Owns `resumeRefs`. |
| `src/stores/queueStore.ts` | `autoResume`, `resumeMaxRetries`, `resumePrompt` on `QueueAutomationConfig`; `setAutoResume`, `setResumeMaxRetries`, `setResumePrompt`. |
| `src/lib/db.ts` | `DbQueueAutomation.autoResume` / `.resumeMaxRetries` / `.resumePrompt` — **non-indexed**, so no Dexie version bump. |
| `src/components/session/QueueTab.tsx` | 🩺 `Auto-resume on/off` toggle in the queue status row. |
| `src/components/session/SessionControlBar.tsx` | `⚠ <reason>` interrupted status chip. |
| `src/styles/modules/DetailPanel.module.css` | `.ctrlInterrupted` — deliberately styled *against* `.ctrlBtn`. |
| `test/interruptionDetector.test.ts` | 15 tests — classification, the real 529 banner, ANSI, edge-triggering, dedupe, split chunks. |
| `src/lib/resumeWatchdog.test.ts` | 23 tests — arming gates, backoff, recovery, and the runaway-loop guard. |

## Implementation

### Constants
Detection (`interruptionDetector.ts`):
- `MAX_FAULT_LINE = 200` — longest line still treated as a status banner. The CLIs render into a 120-column PTY so a real banner wraps well below this; anything longer is prose (a catted file, the agent quoting a log).
- `CARRY_BYTES = 512` — tail carried between chunks so a banner split across two PTY reads still matches.
- `MAX_SCAN_BYTES = 8192` — regex ceiling per chunk.
- `DEDUPE_MS = 60_000` — an identical banner inside this window is a redraw, not a second fault.

Policy (`resumeWatchdog.ts`):
- `SETTLE_MS = 5_000` — quiet period the output must hold after the banner before arming.
- `VERIFY_WINDOW_MS = 60_000` — how long a sent resume gets to clear the fault before it counts as failed.
- `BACKOFF_MS = [30_000, 120_000, 480_000]` — 30s / 2m / 8m; the last value repeats.
- `MAX_JITTER_MS = 15_000` — random spread added to every backoff.
- `ATTEMPT_WINDOW_MS = 30 * 60_000` — 30-minute rolling window over which `maxRetries` is counted.
- `DEFAULT_MAX_RETRIES = 3`.
- `DEFAULT_RESUME_PROMPT` = `'The previous turn was interrupted by a transient error, not by you finishing. Continue from exactly where you left off — do not restart the task and do not repeat completed work.'`

### Fault classification (`matchFault`)
Splits `stripAnsi(text)` into lines and walks **backwards** (newest banner wins), skipping blank lines and lines longer than `MAX_FAULT_LINE`. Patterns are ordered most-specific first, so a 429 is classified by its cause rather than its shape:

| Order | `kind` | Pattern (case-insensitive) |
|-------|--------|---------------------------|
| 1 | `rate_limit` | `rate limit` / `rate-limited` / `too many requests` / `API Error: 429` / `usage limit reached` |
| 2 | `api_error` | `API Error: 5xx` / `overloaded` / `internal server error` / `service unavailable` |
| 3 | `network` | `connection error|reset|refused` / `fetch failed` / `socket hang up` / `network error` / `ECONNRESET` / `ECONNREFUSED` / `ETIMEDOUT` / `ENOTFOUND` / `EAI_AGAIN` |

### Edge-triggering (`scanChunk`)
The banner **sits in scrollback** for as long as the screen holds it, so a level-triggered check (`tail contains /529/`) re-reports the same dead turn forever — the identical trap [`isAgentBusyOutput`](../server/approval-detection.md) documents for the busy spinner. Two mechanisms make this edge-triggered:

1. **Only the incoming chunk is scanned** (`carry + chunk`), and the carry is set to `''` the moment a fault is reported. Without that reset, the banner sits in the carry and re-fires on the first unrelated chunk after `DEDUPE_MS` lapses.
2. **Signature dedupe** — `kind:line` within `DEDUPE_MS` is suppressed, so a full-screen TUI repaint cannot re-fire an already-reported fault. A *different* banner reports immediately without waiting out the window.

State is per-terminal (`Map<terminalId, {carry, lastSig, lastAt}>`) and cleared by `clearFaultState` in `sshManager.cleanup` — terminal ids can be reused across a resume, and a stale entry would make the new terminal's first banner look like a redraw of the old one's.

### Server wiring
`notePtyOutput(terminalId, data)` runs inside both agent-terminal `onData` handlers in `sshManager.ts` (the `createTerminal` seam and the `attachToTmuxPane` seam), right after `ringWrite`. It is regex-only — no I/O, no process probe — so it is safe on the hot path (cf. the "never call a process probe synchronously on the event loop" invariant). Any throw is swallowed to `log.debug`: detection must never break terminal streaming.

`sessionStore.ts` registers the callback and attaches the fault to whichever **non-`ended`** session has `terminalId === terminalId`, then `invalidateSessionsCache()` + `broadcastSessionUpdate(session)`:

```ts
session.interruption = { kind, line, detectedAt: Date.now() }
```

It deliberately does **not** touch `session.status`: the turn really has ended, and re-labelling it would break the queue's own gates. The interruption is a separate, additive fact about *why* it ended.

### Clearing (the recovery signal)
`session.interruption` is cleared at the top of the hook-event switch on `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `SessionStart` — the four events that prove the CLI took a prompt and is doing work.

**`Stop` is deliberately not in that list.** A 529 ends in `Stop` exactly like a clean finish, so clearing there would erase the fault before anything could act on it. This clearing rule is also the main false-positive filter for echoed text: if a queued prompt happens to *contain* the words "API Error: 529", the PTY echo is detected, but the session then goes `prompting` → the interruption is cleared before it can ever arm.

### Policy state machine (`decideResume`)
`WatchdogState = { phase: 'idle'|'armed'|'resuming'|'exhausted', attempts: number[], nextAttemptAt, sentAt, faultAt }`.

`decideResume(prev, { interruption, status, now, enabled, maxRetries, jitter })` → `{ state, send, justExhausted }`:

| Current | Condition | Result |
|---------|-----------|--------|
| any | `!enabled` | drop state entirely (`null`) |
| any | `interruption === null` | phase → `idle`, **ledger kept**; state dropped only once the ledger empties |
| `idle` | `attempts.length >= cap` | → `exhausted` (`justExhausted` only on the transition) |
| `idle` | `now - detectedAt < SETTLE_MS` | hold (output may still be flowing) |
| `idle` | `!isSendableStatus(status)` | hold (turn not over / at an approval prompt) |
| `idle` | settled and at rest | → `armed`, `nextAttemptAt = now + backoffFor(attempts.length, jitter)` |
| `armed` | `now < nextAttemptAt` | hold |
| `armed` | session went busy again | hold — never type over a running agent |
| `armed` | due and sendable | → `resuming`, **`send: true`**, append `now` to `attempts` |
| `resuming` | `now - sentAt < VERIFY_WINDOW_MS` | hold |
| `resuming` | window elapsed, fault still set, budget spent | → `exhausted`, `justExhausted: true` |
| `resuming` | window elapsed, budget left | → `armed` with the next backoff step |
| `exhausted` | — | hold (recovers only when the ledger ages out) |

`maxRetries` is floored at 1, so a stored `0` can never mean "retry forever".

### The attempt ledger is the loop guard — not the phase
The obvious design keys the retry count off the current fault and resets it when a new fault arrives. **That self-destructs.** The resume prompt makes the session work briefly → the server clears `interruption` → the same outage 529s the very next turn → a brand-new `detectedAt` → a fresh budget → forever.

So `attempts` holds the **timestamps of resume prompts actually sent** within `ATTEMPT_WINDOW_MS`, and it survives both recovery and re-fault. A new `faultAt` restarts the *phase* but never the ledger. Budget is regained only by the window sliding, which also means an `exhausted` session self-heals ~30 minutes after its last attempt. Covered by `resumeWatchdog.test.ts` → *"cannot be reset by a fresh fault right after a resume (the runaway case)"*.

### Scheduler integration (`maybeAutoResume`)
Runs inside `evaluateSession`, **after** the `paused` / `terminalId` / cooldown checks and **before** the `items.length === 0` bail-out — an interrupted session needs rescuing whether or not it has queued items. Returns `true` when a prompt was sent, and the caller then skips the queue for that tick.

- `jitter: Math.random()` is drawn fresh per evaluation so sessions that faulted together in a provider-wide outage don't retry in lockstep.
- Sends via `sendPromptToTerminal(terminalId, prompt, /* autoEnter */ true)` — **always** auto-Enter, because a resume prompt typed but not submitted leaves the session exactly as stuck, plus text sitting in the box.
- **On send failure the ledger entry is rolled back** (`attempts.slice(0, -1)`) and the state re-armed for `now + 5_000`; nothing was delivered, so it must not consume budget.
- Shares `firingRefs` / `coolDownRefs` (800ms) with the queue, so a resume and a queue fire can never interleave into the same PTY.
- Toasts: `[name] Auto-resumed after <reason> (n/max)` (`info`, 4s) and, once, `[name] Auto-resume gave up after N attempts — needs you` (`error`, 8s).

### UI
- **Queue status row** (`QueueTab.tsx`) — `🩺 Auto-resume on|off`, same `queueStatusToggle` class as its siblings; the ON title spells out the cap and backoff.
- **Control bar chip** (`SessionControlBar.tsx`) — `⚠ API error` / `⚠ rate limit` / `⚠ network` via `faultLabel(kind)`, rendered only while `session.interruption` is set, with the raw banner in its `title`. There is no dismiss control: the chip self-clears on the next forward-progress hook event, including a prompt the user types by hand.
- `.ctrlInterrupted` is styled **against** `.ctrlBtn` on purpose — pill radius (`999px`) instead of `4px`, no border, `font-weight: 400`, sentence case, `cursor: help`. It shares a row with KILL / MUTE / ALERT (and ALERT is also orange), so matching the button treatment made it read as a fourth, fake-clickable button. The differentiators are structural, not colour.

### Storage keys
Dexie `queueAutomation` table (keyed by `sessionId`) gains three **non-indexed** columns — `autoResume` (0/1), `resumeMaxRetries` (int), `resumePrompt` (string, omitted when empty). Non-indexed means **no schema version bump**, the same back-compat route `autoSend` / `autoEnter` / `skipWhenPrompting` took. Rows written before the watchdog existed read `undefined` and the loader maps them to the defaults (`autoResume: true`, `3`, `''`).

## Dependencies & Connections

### Depends On
- [Terminal/SSH](../server/terminal-ssh.md) — the `onData` seams and `cleanup` in `sshManager.ts`; `POST /api/terminals/{id}/write` delivers the resume prompt.
- [Session Management](../server/session-management.md) — `session.interruption` lives on the Session object; the hook-event switch clears it; `broadcastSessionUpdate` ships it.
- [Queue Scheduler](./queue-scheduler.md) — hosts the tick, `isSendableStatus`, `sendPromptToTerminal`, and the shared `firingRefs`/`coolDownRefs` mutex.
- [Prompt Queue](./prompt-queue.md) — `QueueAutomationConfig` + the `paused` gate; the toggle lives in `QueueTab`'s status row.
- [Client Persistence](./client-persistence.md) — the `queueAutomation` Dexie row.
- [Session Detail Panel](./session-detail-panel.md) — `SessionControlBar` hosts the chip.
- [UI Primitives](./ui-primitives.md) — `showToast`.

### Depended On By
- [Queue Scheduler](./queue-scheduler.md) — its tick calls `maybeAutoResume` first and skips the queue when it fires.

### Shared Resources
- `session.interruption` — written by `sessionStore`, read by `useGlobalQueueScheduler` and `SessionControlBar`.
- `firingRefs` / `coolDownRefs` — the single-writer mutex shared with the queue.
- `isSendableStatus` from `queueScheduler.ts` — one definition of "the prompt box is ready".
- The session **status** vocabulary from the [Session state machine](../server/session-management.md).

## Change Risks
- **Coverage gap — `pty-*` terminals are invisible to this feature.** Terminals created via `electronAPI.createPty` (`QuickSessionModal`) are owned by `electron/ptyHost.ts`; `POST /api/terminals/register` files only a session card, so `sshManager.terminals` has no entry. `getTerminalOutputTail` returns `null` and `POST /api/terminals/{id}/write` 404s for them. The queue already cannot fire into those terminals, so the watchdog inherits the same gap rather than introducing one — but anyone "fixing" detection there must fix the **write** path first, or the watchdog will detect faults it can never act on.
- **Edge-triggering is load-bearing.** Dropping the carry-reset on report, or the signature dedupe, turns a single dead turn into a resume every `DEDUPE_MS` until the budget is spent. Both are asserted in `test/interruptionDetector.test.ts`.
- **The attempt ledger must outlive recovery.** Resetting `attempts` when `interruption` clears, or keying the budget to `faultAt`, re-opens the runaway loop described above — the single most expensive failure mode this feature has (it burns API quota unattended).
- **Never clear `interruption` on `Stop`.** That is the event a 529 *also* produces; clearing there makes the whole feature a no-op with no error anywhere.
- **The settle + sendable gates are the false-positive filter.** An agent printing the words of an error (quoting a log, echoing a queued prompt) keeps producing output and keeps working; a dead turn goes silent. Shortening `SETTLE_MS` toward zero, or arming on a non-sendable status, starts injecting prompts into live turns.
- **Jitter matters at fleet scale.** A provider-wide 529 faults every session at once; without `MAX_JITTER_MS` they retry in lockstep and hammer an already-overloaded API.
- **Send-failure rollback**: if `sendPromptToTerminal` fails and the ledger entry is *not* rolled back, a session whose terminal is momentarily unwritable burns its whole budget without ever delivering a prompt.
- **`.ctrlInterrupted` must not drift back toward `.ctrlBtn`.** Giving it a border, bold uppercase, or a 4px radius restores the fake-clickable-button bug that the render check caught. No linter sees this.
- **Detection runs on the PTY hot path.** Anything added to `notePtyOutput` beyond regex — a process probe, a DB write, an `await` — puts per-chunk latency on every terminal in the app.
