# Dexie.js Client Persistence

## Function
Browser-side persistent storage using IndexedDB via Dexie.js with 15 tables mirroring server data plus local-only settings and queue/translation state.

## Purpose
Enables offline access to session history, survives page reloads, and stores user preferences and queue automation that don't need server roundtrips.

## Source Files
| File | Role |
|------|------|
| `src/lib/db.ts` (~21KB, 638 lines) | Dexie database definition, 15 tables, persistence functions |

## Implementation
- Database name: `claude-dashboard`, current schema **version 6** (`db.ts` declares `this.version(2..6).stores({...})`; older installs upgrade transparently through each version).
- **15 tables**: `sessions` (key: id), `prompts` (++id), `responses` (++id), `toolCalls` (++id), `events` (++id), `notes` (++id), `promptQueue` (++id), `alerts` (++id), `sshProfiles` (++id), `settings` (key: key), `summaryPrompts` (++id), `teams` (key: id), `queueAutomation` (key: sessionId — added v4), `queueHistory` (++id — added v5), `translationLogs` (++id — added v3).
- Compound indexes for dedup: `[sessionId+timestamp]` on prompts, responses, toolCalls, events.
- Additional indexes: `sessions` has 5 (status, projectPath, startedAt, lastActivityAt, archived); `toolCalls` has `toolName` for analytics; `promptQueue` has `[sessionId+position]`; `summaryPrompts` has `isDefault`; `queueHistory` has `createdAt, lastUsedAt`.
- **DbSession** schema: 20 fields (id, projectPath, projectName, title, status, model, source, startedAt, lastActivityAt, endedAt, totalToolCalls, totalPrompts, archived, summary, characterModel, accentColor, teamId, teamRole, terminalId, queueCount). Note: `totalPrompts` is derived from `promptHistory.length` at persist time.
- **DbQueueItem** carries the full per-row queue/automation payload: `images` (JSON `{name,dataUrl}[]`), `type` ('once' | 'loop' | 'schedule'), `intervalMs`, `runAt`, `nextFireAt`, `lastFiredAt`, `totalFires`, `beforeChain`/`afterChain` (JSON ChainStep[]), `execState`/`execStepIdx` (resume-mid-chain cursors), `excludeWindows` (JSON ExcludeWindow[]), `historyId` (★ favorite link), `disabled` (per-item pause int), `firstFireOfDay` ('HH:MM' loop daily clamp). The scheduler logic that reads these fields lives in [Queue Scheduler](./queue-scheduler.md).
- **persistSessionUpdate(session)**: on WS `session_update`, upserts the session record then bulk-adds new prompt/tool/response/event rows, deduplicating each child set by `timestamp` against existing rows.
- **migrateSessionId(oldId, newId)**: updates `sessionId` across all `CHILD_TABLES` when a session is re-keyed (e.g. `replacesId`).
- **deleteSession(sessionId)**: deletes the session record then cascade-deletes from `CHILD_TABLES`. **Cascade scope** is `CHILD_TABLES` (`db.ts:575-583`) = 7 tables (prompts, responses, toolCalls, events, notes, promptQueue, alerts). **`translationLogs` and `queueHistory` are NOT deleted** — deleting a session does NOT cascade-delete them. `queueAutomation` is not in `CHILD_TABLES` either, but `deleteSession` deletes its row explicitly by key (`db.queueAutomation.delete(sessionId)`, `db.ts:616`) because that table is keyed by `sessionId` rather than `++id`. Translation logs can thus be orphaned (referenced via `originSessionId`); the [REVIEW Tab](./review-tab.md) tolerates this. `queueHistory` rows are intentionally session-independent snapshots.
- **deleteSessionChildrenBatch(sessionIds)** (`db.ts:627-638`): cascade-deletes every `CHILD_TABLES` row plus the per-session `queueAutomation` row for a **batch** of session ids whose parent was already removed from `db.sessions`. Used by snapshot reconciliation in `useWebSocket.ts` so orphaned `promptQueue` / `queueAutomation` / `event` rows don't accumulate one generation per restart; the caller is responsible for deleting the `db.sessions` rows themselves.

### Schema migration history
- **v2** — base schema (12 tables).
- **v3** — adds `translationLogs` for the [REVIEW Tab](./review-tab.md). One row per saved explanation/translation, indexed by `uuid, mode, createdAt, originSessionId, archived, floatTerminalId`.
- **v4** — adds `queueAutomation` (key `sessionId`): persisted per-session pause / auto-send / auto-enter / idle-guard / skip-when-prompting toggles plus loop quiet-hours. Previously in-memory only and reset on reload.
- **v5** — adds `queueHistory`: globally favorited queue items reusable across sessions, indexed on `createdAt, lastUsedAt` for the history sheet.
- **v6** — REVIEW favorites + aliases + md highlighting. Adds `favorite`, `alias`, `sourceFilePath` to `translationLogs` (now indexed on `favorite` + `sourceFilePath`); an `.upgrade()` handler back-fills existing rows with defaults (`favorite=0`, `alias=''`, `sourceFilePath=''`).

The `queueAutomation` and `queueHistory` tables are written/read directly by the queue store; their behavior is documented in [Queue Scheduler](./queue-scheduler.md). `translationLogs` semantics live in [REVIEW Tab](./review-tab.md).

## Dependencies & Connections

### Depends On
- [WebSocket Client](./websocket-client.md) — receives `session_update` events to persist
- [State Management](./state-management.md) — settings store triggers persistence

### Depended On By
- [State Management](./state-management.md) — settingsStore reads from Dexie on init
- [Views & Routing](./views-routing.md) — HistoryView reads from IndexedDB
- [Session Detail Panel](./session-detail-panel.md) — notes, prompts, summaryPrompts from IndexedDB
- [Conversation View](./conversation-view.md) — reconstructs transcripts from persisted prompts/responses/events
- [Queue Scheduler](./queue-scheduler.md) — reads/writes `promptQueue`, `queueAutomation`, `queueHistory`
- [REVIEW Tab](./review-tab.md) — reads/writes `translationLogs`

### Shared Resources
- IndexedDB `claude-dashboard` database

## Change Risks
- Schema version bumps require an additional `this.version(n).stores({...})` block (carry over all prior tables) plus an `.upgrade()` handler when back-filling fields.
- Changing table keys or indexes can corrupt existing data.
- Removing dedup indexes (`[sessionId+timestamp]`) causes duplicate child records.
- `deleteSession` / `migrateSessionId` cascade must stay in sync with `CHILD_TABLES`; remember `translationLogs` and `queueHistory` are deliberately excluded from both, and `queueAutomation` is excluded from `CHILD_TABLES` but still deleted by key in `deleteSession`/`deleteSessionChildrenBatch` — note it is NOT re-keyed by `migrateSessionId`.
- Adding non-indexed fields to existing interfaces (e.g. `firstFireOfDay`, `alias` on history) needs no schema bump; adding an indexed field does.
