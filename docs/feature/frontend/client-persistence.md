# Dexie.js Client Persistence

## Function
Browser-side persistent storage using IndexedDB via Dexie.js with 12 tables mirroring server data plus local-only settings.

## Purpose
Enables offline access to session history, survives page reloads, and stores user preferences that don't need server roundtrips.

## Source Files
| File | Role |
|------|------|
| `src/lib/db.ts` (~9KB) | Dexie database definition, 12 tables, persistence functions |

## Implementation
- Database name: "claude-dashboard", schema version 2
- 12 tables: sessions (key: id), prompts (++id), responses (++id), toolCalls (++id), events (++id), notes (++id), promptQueue (++id), alerts (++id), sshProfiles (++id), settings (key: key), summaryPrompts (++id), teams (key: id)
- Compound indexes for dedup: [sessionId+timestamp] on prompts, responses, toolCalls, events
- Additional indexes: sessions has 5 (status, projectPath, startedAt, lastActivityAt, archived), toolCalls has toolName for analytics
- DbSession schema: 21 fields (id, projectPath, projectName, title, status, model, source, startedAt, lastActivityAt, endedAt, totalToolCalls, totalPrompts, archived, summary, characterModel, accentColor, teamId, teamRole, terminalId, queueCount, label)
- DbQueueItem has optional `images` field (JSON-serialized array of {name, dataUrl} image attachments)
- persistSessionUpdate(): on WS session_update, upserts session + deduplicates child records via Dexie transaction
- migrateSessionId(oldId, newId): updates sessionId across all child tables when session.replacesId is set
- deleteSession(sessionId): cascade delete session + all child records in single transaction

## Dependencies & Connections

### Depends On
- [WebSocket Client](./websocket-client.md) — receives session_update events to persist
- [State Management](./state-management.md) — settings store triggers persistence

### Depended On By
- [State Management](./state-management.md) — settingsStore reads from Dexie on init
- [Views & Routing](./views-routing.md) — HistoryView reads from IndexedDB
- [Session Detail Panel](./session-detail-panel.md) — notes, prompts, summaryPrompts from IndexedDB

### Shared Resources
- IndexedDB "claude-dashboard" database

## Change Risks
- Schema version bumps require Dexie upgrade handlers
- Changing table keys or indexes can corrupt existing data
- Removing dedup indexes causes duplicate records
- deleteSession cascade must stay in sync with table list

## translationLogs (v3)
Dexie was bumped to schema version 3 to add the `translationLogs` table backing
the [REVIEW Tab](./review-tab.md). One row per saved explanation/translation,
indexed by `uuid, mode, createdAt, originSessionId, archived, floatTerminalId`.
Existing v2 installs upgrade transparently.
