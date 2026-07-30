# Session Matcher (8-Priority System)

## Function
Links incoming hook events (with unknown session IDs) to existing terminal sessions using a priority cascade (0→4.5) of matching strategies, and — when nothing matches — surfaces genuinely unmatched interactive sessions as external cards (Priority 5) instead of dropping them.

## Purpose
Hooks fire from CLI processes that don't know about dashboard terminals. The matcher bridges this gap so events appear on the correct session card.

## Source Files
| File | Role |
|------|------|
| `server/sessionMatcher.ts` (~30KB, 640 lines) | Priority matching engine (0→5) + terminal adoption + external fallback + fork routing + source detection |
| `test/sessionMatcher.test.js` | Priority and regression coverage, including Codex terminal re-keying, shared-PID parallel threads, and stale teardown events |
| `test/sessionMatcher.adoption.test.ts` | Priority 4.5 terminal-adoption coverage: adopt-on-any-event, sole-owner requirement, and the CONNECTING / teardown / subagent guards |

## Implementation

### Fork Routing (pre-step, before any priority)
Before PID caching and the priority cascade, `matchSession()` detects `claude --resume '<originId>' --fork-session`. A fork fires ALL hooks (including `SessionEnd` and PID updates) with `session_id == originId`. When the hook also carries `agent_terminal_id`, the matcher looks up that terminal key; if the candidate has `isFork === true` and owns the terminal (`terminalId` or `lastTerminalId` matches), the event is redirected to the fork session. This runs *before* PID caching so the fork's PID does not get mapped to the origin (which would otherwise let `processMonitor` end the origin when the fork dies).

### PID Caching
After fork routing, the matcher caches `claude_pid` on the resolved session (not blindly on the raw hook ID), so fork redirects point at the fork. `pidToSession` retains the most recent mapping used by PID fallbacks, but PID is not a unique Codex thread identity: multiple thread cards may legitimately carry the same `cachedPid`. On `SessionStart` for a session found by direct Map lookup, stale `pendingResume` and `pendingLinks` entries for that terminal/path are cleaned up.

### Priority Cascade

| Priority | Strategy | Risk |
|----------|----------|------|
| 0 | pendingResume + terminal ID (explicit user action) | Low |
| 0 fallback | pendingResume + workDir (single candidate only) | Medium |
| 0.5 | Snapshot-restored ended session by cwd/zombie SSH (post-restart linking) | Medium |
| 1 | agent_terminal_id direct Map key (pre-created terminal) | Low |
| 1b | Scan by terminalId property (subsequent starts in same terminal) | Low |
| 1.5 | Cached PID match (same process, new session_id) | Medium |
| 2 | tryLinkByWorkDir via pendingLinks Map (SSH terminal) — **`SessionStart` only** | Medium |
| 3 | Path scan of CONNECTING sessions (picks newest if >1) — **`SessionStart` only** | Medium |
| 4 | PID parent check via pgrep -P (unreliable across shells) | High |
| 4.5 | Terminal adoption — re-key the **sole** owner of `agent_terminal_id` on ANY event type (covers a lost `SessionStart`) | Medium |
| 5 | External fallback — create an `isExternal` card for a real hook-only session the dashboard didn't launch (gated on `tty_path`, non-subagent, non-teardown) | Medium |

### Priority 0.5 (snapshot restore auto-link)
Gated on `hook_event_name === SESSION_START` + a `cwd` (sessionMatcher.ts:325-369). Collects candidates whose `projectPath` (trailing slash stripped) equals the hook `cwd`, via three independent matches:
- **Match 1 — restored ended card**: `status === ENDED` + carries a `ServerRestart` event + `Date.now() - endedAt < 30 * 60 * 1000` (30-min window, so an ancient ended card is never adopted).
- **Match 2 — process survived the restart**: `status === IDLE` + carries a `ServerRestart` event + no `terminalId`. Covers the case where the PID match failed because the PID wasn't cached or changed.
- **Match 3 — zombie SSH safety net**: `source === 'ssh'`, not ended, no `terminalId`, *no* `ServerRestart` event, and `lastActivityAt` stale by >60s.

Resolution: **exactly one candidate** → `reKeyResumedSession` adopts it. With multiple candidates, the **#47 tie-break** applies — if exactly one is ENDED and at least one zombie is present, the ENDED one wins; otherwise the match is skipped as ambiguous and a new card is created (path alone can't disambiguate two sessions sharing a directory).

### Priorities 1b and 1.5 — guarded re-key
- Priority 1's direct `AGENT_MANAGER_TERMINAL_ID` lookup can claim a fresh placeholder only for `SessionStart`, plus Codex `UserPromptSubmit` when it arrives before the queued start. A delayed `Stop`, `SessionEnd`, or tool event carrying the same terminal ID is not allowed to re-key/end the newly launched card.
- Priority 1b normally scans a terminal owner only on `SessionStart`. Codex can deliver `UserPromptSubmit` before its queued `SessionStart`, so that one startup-like event may also re-key when `cli_source === 'codex'`, the same `agent_terminal_id` is present, and the cached PID matches. Unknown `Stop`/`SessionEnd` IDs never use this path, preventing a delayed teardown from moving the active card backward.
- Priority 1.5 matches by cached PID only for `SessionStart` or a process-scan `external-<pid>` card's first real hook. A normal Codex event never re-keys on PID alone because distinct Codex threads can share a host process.
- The `external-<pid>` branch still upgrades a process-scan discovered card in place on its first real hook of any type so Priority 5 cannot create a second card for the same PID.

### Priority 4.5 (terminal adoption) — the last resort before minting a card
Every re-key path above (0.5, 1, 1b, 2, 3) is gated on `hook_event_name === SESSION_START`. That gate is correct in isolation but leaves a single point of failure: **if that one hook is lost, one session becomes two cards.** Priority 4.5 closes it by adopting the terminal on *any* forward event.

**The failure it fixes (observed live, Jul 2026 — `sms-ops`):** Claude Code fires `SessionEnd(reason: "resume")` whenever it re-keys its own session id mid-flight (a `/model` change, `--resume`, a compaction). The card correctly goes to `ENDED` and its `cachedPid` is released, while `terminalId` is deliberately kept (the PTY is still alive). The follow-up `SessionStart` normally rescues it via Priority 1b. When that `SessionStart` never arrives — MQ truncation, a dropped hook, or an agent that resumes without re-firing it — the next `PreToolUse` fell through to Priority 5, which minted a **second** card bound to the *same live PTY*. Result: the origin card stranded in `ENDED` (Terminal tab shows "Terminal disconnected / Reconnect" for a session that is actively running) and an untitled twin — `title: ''`, `promptHistory: []`, because titles are only assigned on `UserPromptSubmit` — surfacing as **"Unnamed"** in the Common Area.

**Resolution:** collect every session whose `terminalId` *or* `lastTerminalId` equals `hookData.agent_terminal_id`. **Exactly one owner** → `reKeyResumedSession` adopts it onto the new `session_id`, which preserves `title` and `previousSessions`, resets `status` to `IDLE`, clears `endedAt`/`isHistorical`, and lets the event's own handler apply the real status. Zero or 2+ owners → fall through to Priority 5 (ambiguity is never resolved by guessing, consistent with P0/P0.5/P3).

Deliberately narrow — each guard mirrors an existing one:
- **Sole owner only.** 2+ owners logs `SKIP terminal adoption: N sessions own <term>` and creates a new card.
- **`CONNECTING` sessions skipped** — those are Priority 3's placeholders.
- **Map key `=== termId` skipped** — that is Priority 1's case.
- **`SessionEnd` / `Stop` excluded** — a late teardown hook from a dead thread must not drag an active card backward. Same reasoning that makes Priority 1b startup-gated.
- **Subagent events excluded** (`parent_session_id` / `agent_name`) — [Team/Subagent](./team-subagent.md) owns those under their parent.

A successful adoption logs `ADOPTED terminal <termId> — re-keyed <old> -> <new> (no SessionStart observed; first event=<event>)`. That log line is the signal that a `SessionStart` was lost; a burst of them points at hook delivery, not at the matcher.

### Priority 5 (external fallback)
Runs only when no earlier priority matched and `found === false` (sessionMatcher.ts:533-566). Previously this branch hit `return null` — an unmatched hook event was silently dropped ("SSH-only mode"), so a real Claude the dashboard didn't launch (external terminal, or started before hooks were installed) stayed untraced. It now surfaces those as a distinct **external card** instead:
- **Still dropped (`return null`)**:
  - **Subagent events** — `hookData.parent_session_id` or `hookData.agent_name` present (`isSubagentEvent`); [Team/Subagent](./team-subagent.md) owns these under their parent.
  - **`SessionEnd` or `Stop`** — no value creating a card from an unmatched teardown event.
  - **Headless sessions** — no `hookData.tty_path`. A `claude -p`, CI run, or MCP-spawned Claude fires hooks with no controlling tty; gating on `tty_path` keeps them from spawning phantom cards. Interactive sessions always carry a `tty_path` (and are independently caught by the process-scan, which also requires a real tty).
- **Surfaced**: for a non-subagent, non-teardown, tty-bearing event, `createDefaultSession()` builds the card and copies `transcript_path` / `permission_mode`. If `agent_terminal_id` is present, the hook won an Electron registration race: the card is created as managed SSH (`terminalId` set, `isExternal = false`) so the later registration enriches it rather than creating a duplicate. Without a managed terminal ID it remains a hook-only external card (`detectHookSource`, `terminalId = null`, `isExternal = true`).

### SSH-Only Mode
- Unmatched events are dropped when they are subagent events, teardown events (`Stop`/`SessionEnd`), or headless (no `tty_path`) — see **Priority 5** above. Other interactive, tty-bearing unmatched events become an `isExternal` display card.

### Session Source Detection
- `detectHookSource()` maps enriched hook env fields (`vscode_pid`, `term_program`, `is_ghostty`, `wezterm_pane`, `tmux`) to one of 11 labels: `vscode`, `jetbrains`, `iterm`, `warp`, `kitty`, `ghostty`, `alacritty`, `wezterm`, `hyper`, `terminal`, `tmux`. If `term_program` is set but unrecognized, the raw lowercased `term_program` string is returned; otherwise it defaults to `terminal`.
- The `ssh` source is NOT produced here — it is assigned in Priority 2 via `createDefaultSession(..., 'ssh', ...)` when a workDir link resolves to an SSH terminal.

### Session Re-keying
- `reKeyResumedSession()` transfers a session from its old key to the new `session_id`, resets live state (status→`idle`, animation→`idle`, clears emote/endedAt/currentPrompt, zeroes `totalToolCalls`/`toolUsage`, empties `promptHistory`/`toolLog`/`responseLog`/`events`) and appends a `SessionResumed` event.
- **Clears `isExternal` (`isExternal = false`) on BOTH re-key paths** — the existing-merge branch (sessionMatcher.ts:107) and the `oldSession` branch (sessionMatcher.ts:122). A session adopted onto a dashboard terminal (via any priority) is no longer "external"; if a discovered/external card is re-keyed, its external badge is dropped.
- Before resetting, the old session's data is archived into `previousSessions` via `toArchivedSession()` (`server/sessionTrim.ts`), deduped against the last entry to avoid double-archiving when `resumeSession()` already archived, capped at 5 entries. The archive carries only `sessionId`/`startedAt`/`endedAt`/`promptHistory`; this site overrides `sessionId` with the **old** id because the session's own `sessionId` has not been rewritten yet. `previousSessions` itself is intentionally preserved across re-keys to maintain the history chain.
- **Phantom-archive guard for discovered cards**: the `hasData` archive check treats an EMPTY discovered external card as having no data (`isEmptyDiscovered` — `isExternal && promptHistory.length === 0 && no toolLog && no responseLog`, sessionMatcher.ts:59-66). A process-scan discovered card carries only a lone synthetic `SessionDiscovered` event and no prompts/tools, so without this guard the plain `events?.length > 0` test would archive a phantom `previousSessions` entry when the card is upgraded on its first real hook. `isEmptyDiscovered` forces `hasData = false` for that case, so nothing is archived.
- Clears the stale `cachedPid → session` mapping in `pidToSession` so the next hook re-caches under the new ID.
- Merge branch: if the target `newSessionId` already exists in the map (e.g. restored from a server snapshot on a second restart), the existing session's accumulated data is preserved and only the terminal-linkage fields (`terminalId`, `opsTerminalId`, `sshConfig`/`sshHost`/`sshCommand`) are transferred from the new terminal — avoiding overwrite with the fresh `term-*` session's empty state.
- Sets `replacesId` so the DB / IndexedDB mirror can migrate the old record to the new ID.

### Team & Counter Side-effects (cascade-resolved sessions)
- For every session resolved via the priority cascade — new *or* re-keyed; sessions found by the direct Map lookup return early (sessionMatcher.ts:267) and skip both side-effects — `matchSession()` copies enriched team fields when present and not already set: `agent_name`, `agent_type`, `team_name`, `agent_color`.
- Increments a per-project counter in `projectSessionCounters` keyed by `projectName`.

### CLI Source Preservation
- `createDefaultSession()` copies hook-provided `cli_source` into the session as `cliSource`. Codex hooks set this explicitly, which keeps robot/header badges and later UI gating from relying only on model-name or event-shape heuristics.

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — reads sessions Map, pendingResume Map, pidToSession Map, projectSessionCounters Map; recognizes the `external-<pid>` discovered cards seeded by `sessionStore.registerDiscoveredSession` (Priority 1.5 upgrades them in place)
- [Process Monitor](./process-monitor.md) — Mechanism B scans live PIDs and (via `sessionStore.registerDiscoveredSession`) creates the `external-<pid>` discovered cards that Priority 1.5's `existingSessionId.startsWith('external-')` branch upgrades on their first real hook, preventing a duplicate card from Priority 5
- [Hook System](./hook-system.md) — receives enriched hook payloads with env vars for matching; Priority 5 reads `tty_path`, `parent_session_id`/`agent_name`, `transcript_path`, and `permission_mode` from the payload
- [Terminal/SSH](./terminal-ssh.md) — imports `tryLinkByWorkDir`, `getTerminalByPtyChild`, `consumePendingLink` from `sshManager.ts` (Priority 2/4 + pendingLink cleanup)

### Depended On By
- [Session Management](./session-management.md) — provides match results for event routing
- [Terminal/SSH](./terminal-ssh.md) — pendingLinks registered on terminal creation are consumed here
- [Team/Subagent](./team-subagent.md) — `matchSession()` seeds `agentName`/`agentType`/`teamName`/`agentColor` onto new sessions from enriched hook data

### Shared Resources
- sessions Map
- pendingResume Map
- pendingLinks Map
- pidToSession Map

## Change Risks
- Most dangerous module to change
- Wrong matches cause events to appear on wrong sessions
- Breaking Priority 1 blocks all SSH terminal integration
- Breaking Priority 0 blocks session resume
- Priorities 2 & 3 are gated on `hook_event_name === SESSION_START` (`isSessionStart` in `matchSession`, mirroring Priorities 1b/1.5). **Bug fixed (Jun 2026):** they previously fired on ANY event type, so a `PreToolUse` from an unrelated, already-running Claude in the same workDir — whose own `SessionStart` predated the server, so its first observed event was a tool event with no `agent_terminal_id` — would consume a freshly-spawned dashboard terminal's pending workDir link (P2) or adopt its `CONNECTING` placeholder by path (P3), hijacking the terminal and producing a duplicate/mislabeled card. Do NOT remove these guards. Note: the gate wraps only P2's `tryLinkByWorkDir` call and P3's CONNECTING scan — Priority 4 (PID parent) and the SSH-only null-return stay reachable for all event types.
- **Orphan-merge guard (`sessionStore.handleEvent`, post-`matchSession`)**: after a re-key (`session.replacesId` set), the handler absorbs a same-path `CONNECTING` "orphan" terminal into the re-keyed session — intended for the Priority-0.5 restart case (a re-keyed ENDED session kept a now-DEAD terminalId and needs the fresh auto-load terminal). **Bug fixed (Jun 2026):** it ran unconditionally, so with TWO sessions in the same workDir, session #1 (matched via Priority 1 to its OWN live terminal) absorbed session #2's still-`CONNECTING` placeholder, overwriting #1's live `terminalId` with #2's → #2's Claude then matched the stolen id (Priority-1b scan) and the two collapsed into one card (data loss; also broke scrollback prefill). Now gated on `!ownTerminalLive` (`getTerminals().some(t => t.terminalId === session.terminalId)`): only merge when the re-keyed session's own terminal is NOT live (the dead-terminalId Priority-0.5 case). Do NOT remove the guard.
- Fork routing must stay BEFORE PID caching — moving it after would map a fork's PID onto the origin session and let `processMonitor` end the origin when the fork dies
- **Priority 5 gating must stay intact**: the `tty_path` check keeps headless (`claude -p`/CI/MCP) sessions from spawning phantom cards, and the subagent + teardown checks keep `matchSession` from stealing team-owned sessions or creating stale cards. Removing these guards re-opens phantom/duplicate-card bugs.
- **Priority 4.5 is the only unguarded-by-`SessionStart` re-key path — its own guards carry the whole load.** Widening it (dropping the sole-owner requirement, admitting `CONNECTING` sessions, or letting `SessionEnd`/`Stop` through) turns it into exactly the terminal-hijack bug the P2/P3 gate above was added to fix, and this time on *every* event type. Narrowing it back to `SESSION_START` re-opens the split-card bug: one dropped startup hook → an `ENDED` card stuck on "Reconnect" plus an "Unnamed" twin on the same PTY. Covered by `test/sessionMatcher.adoption.test.ts`.
- **Adoption does not retroactively merge an already-split pair.** Once both cards exist, the new hook matches the twin by direct id lookup and returns before the cascade runs. Pre-existing duplicates must be closed by hand; the fix is preventative only.
- **Priority 1.5 ↔ Priority 5 coupling**: Priority 1.5's `existingSessionId.startsWith('external-')` branch MUST upgrade a discovered card on its first real hook of ANY event type. If that branch is re-narrowed to `SESSION_START` only, a discovered card whose first hook is non-`SessionStart` falls through to Priority 5 and a **duplicate** card is created for the same PID. The `external-<pid>` key format is set by [Process Monitor](./process-monitor.md) / `registerDiscoveredSession`; changing that prefix silently breaks this upgrade.
- Priority 1's fresh-placeholder gate and Priority 1b's stricter terminal-plus-PID gate are complementary. PID, title, or cwd alone would collapse legitimate parallel Codex threads; stale `Stop`/`SessionEnd` must remain excluded from both re-key paths.
- **Phantom-archive guard**: `isEmptyDiscovered` in `reKeyResumedSession()` must keep excluding empty discovered external cards from archival, or upgrading a discovered card archives a bogus `previousSessions` entry built from its lone synthetic `SessionDiscovered` event.
- The source-code module docstring still says "5-priority" (the `@module` header at line 3); the real cascade has more steps (0, 0-fallback, 0.5, 1, 1b, 1.5, 2, 3, 4, 4.5, 5) — trust the table above, not the comment
