# Zustand State Management (12 Stores)

## Function
Global state management via 12 Zustand stores providing reactive session, WebSocket, UI, settings, queue, queue-history, camera, room, label, shortcut, agenda, and floating-sessions state.

## Purpose
Single source of truth for all frontend state. Zustand chosen for its minimal API and compatibility with React Three Fiber (no context providers needed inside Canvas).

## Source Files
| File | Role |
|------|------|
| `src/stores/sessionStore.ts` | `sessions: Map<string, Session>`, selectedSessionId, previousSessionId. Actions: addSession/removeSession/updateSession/selectSession/deselectSession/setSessions/togglePin/toggleMute/toggleAlert/setSessionTitle. togglePin/toggleMute/toggleAlert/setSessionTitle optimistically update local state and fire `PUT /api/sessions/{id}/{pinned,muted,alerted,title}`. updateSession follows `replacesId` (deletes the old entry, re-points selection) |
| `src/stores/wsStore.ts` | connected, reconnecting, lastSeq, client (WsClient). Actions: setConnected/setReconnecting/setLastSeq/setClient |
| `src/stores/uiStore.ts` | activeModal, roomKillTargetId (`string\|null` — room targeted by the bulk kill-confirm modal), detailPanelOpen, detailPanelMinimized, pendingFileOpen, pendingFileChooser, cardDisplayMode (`'detailed'\|'compact'`), navPosition (`'top'\|'left'`, persisted), maximized, navRailCollapsed, sessionSortMode (`'room'\|'activity'`, persisted), workspaceLoad (WorkspaceLoadState), selectedRoomIds (`Set<string>`). Exports `ROOM_KILL_MODAL_ID`. Actions: openModal/closeModal (closeModal also clears roomKillTargetId), openRoomKill (sets activeModal=ROOM_KILL_MODAL_ID + roomKillTargetId), setDetailPanelOpen, minimizeDetailPanel/restoreDetailPanel, openFileInProject/clearPendingFileOpen, openFileChooser/clearFileChooser, toggleCardDisplayMode, setNavPosition/toggleNavPosition, setMaximized/toggleMaximized, setNavRailCollapsed/toggleNavRailCollapsed, toggleSessionSortMode, workspaceLoad lifecycle (startWorkspaceLoad/advanceWorkspaceLoad/finishWorkspaceLoad), toggleRoomFilter/clearRoomFilter |
| `src/stores/settingsStore.ts` | Extends `BrowserSettings`. 9 themes (THEMES), per-CLI sound profiles (CLI_SOUND_PROFILES: claude/gemini/codex), ambient (DEFAULT_AMBIENT_SETTINGS), label alarms, hookDensity, API keys (anthropic/openai/gemini/googleTts), TTS block (ttsEnabled, ttsVoiceEn, ttsVoiceZh, ttsSpeakingRate), translation/explain block (translationEnabled, translationNativeLanguage, translationLearningLanguage, translationTrigger `'auto'\|'alt'\|'off'`, translationInheritContext, explainAttachFilePath `'ask'\|'always'\|'never'`), terminal replay buffer (`terminalReplayBufferBytes`, default `DEFAULT_TERMINAL_REPLAY_BUFFER_BYTES`; `setTerminalReplayBufferBytes` clamps via `clampReplayBufferBytes` before persisting — see [Terminal UI](./terminal-ui.md)). Complex store with DOM side effects (CSS vars, data-theme). Actions: per-CLI sound config, label alarms, setApiKey (provider includes `'googleTts'`), TTS/translation setters, loadFromDb/saveToDb, persistSetting, flashAutosave, resetDefaults |
| `src/stores/queueStore.ts` | `queues: Map<string, QueueItem[]>` + `automation: Map<string, QueueAutomationConfig>`. Actions: add/remove/reorder/moveToSession/setQueue/updateItem, automation setters (getAutomation/setPaused/setAutoSend/setAutoEnter/setIdleGuard/setSkipWhenPrompting/setLoopExcludeWindows/setAutomation (whole-config replace)), migrateSession, loadFromDb. Persist subscription writes queues→`db.promptQueue` and automation→`db.queueAutomation`. Scheduling/chain semantics live in [Prompt Queue](./prompt-queue.md) / [Queue Scheduler](./queue-scheduler.md) |
| `src/stores/queueHistoryStore.ts` | Global favorited queue items (★). `entries: QueueHistoryEntry[]`, loaded. Actions: loadFromDb/saveItem/updateEntry/setAlias/removeEntry/incrementUsed/applyToSession/bulkImport. Own Dexie table `db.queueHistory`. Cross-store: stamps/clears `historyId` on live `queueStore` items. UI + apply flow documented in [Queue Scheduler](./queue-scheduler.md) |
| `src/stores/cameraStore.ts` | pendingTarget, isAnimating; flyTo()/completeAnimation(). Exports `DEFAULT_CAMERA_POSITION` (`[18, 16, 18]`), `DEFAULT_CAMERA_TARGET` (`[0, 1, 0]`), `CameraTarget` interface (position, lookAt, `requestId`). Incrementing requestId avoids sub-ms flyTo collisions |
| `src/stores/roomStore.ts` | `rooms: Room[]` (id/name/sessionIds/collapsed/createdAt/roomIndex), persisted to `localStorage['session-rooms']`. Actions: createRoom/renameRoom/deleteRoom/addSession/removeSession/moveSession/toggleCollapse/setRoomIndex/migrateSession/getRoomForSession/loadFromStorage |
| `src/stores/labelStore.ts` | Client-only single label per session. `labels: Record<sessionId,string>` + `custom: CustomLabel[]`, persisted to `localStorage['session-label-map']` / `['custom-label-defs']`. Exports `BUILTIN_LABELS` (ONEOFF/HEAVY/IMPORTANT), `DEFAULT_LABEL_COLOR`, `MAX_CUSTOM_LABELS`. Actions: setLabel(id,name\|null)/addCustom/removeCustom; selectors labelColor/getLabel/loadFromStorage. Rendered as colored chips near the session title (picker = `LabelPicker.tsx`) — see [Session Detail Panel](./session-detail-panel.md) |
| `src/stores/shortcutStore.ts` | Rebindable keyboard shortcuts. `bindings: ShortcutBinding[]`; rebind/resetOne/resetAll/getConflict/findActionForEvent/loadFromDb. Non-default overrides persisted to IndexedDB via `db.settings` key `'shortcutBindings'` |
| `src/stores/agendaStore.ts` | `tasks: Map<string, AgendaTask>`, loading, filter (AgendaFilter). Actions: fetchTasks/createTask/updateTask/deleteTask/toggleTask/setFilter. Server-backed via `/api/agenda` (optimistic updates with revert on failure) |
| `src/stores/floatingSessionsStore.ts` | `floats: FloatingSession[]` (PIP fork-translate/fork-explain terminals) + `poppedOut: string[]` (terminals popped into native Electron windows). Capped at `MAX_FLOATS = 4` (oldest evicted, its PTY DELETEd). Actions: open/close/closeAll/closeByOriginSession/migrateOriginSession/closeOrphans/setPoppedOut/captureNow. close() calls `captureNow()` (snapshot terminal output → translationLog via `captureResponse`) before `DELETE /api/terminals/{id}`. `captureNow` is also exposed on its own — idempotent, kills nothing — so an open panel can poll it and not lose the answer if the app restarts while the popup is still open |

## Implementation

### Cross-cutting conventions
- Immutability: `set((s) => ({ sessions: new Map(s.sessions) }))` — always a new Map for collection updates; never mutate existing objects.
- `Map` for session/queue/agenda collections (not arrays) for O(1) lookup.
- Zero Zustand subscriptions inside the R3F Canvas (critical rule — prevents React Error #185). All store reads happen in the DOM layer; data flows into Canvas via props.

### sessionStore
- togglePin/toggleMute/toggleAlert optimistically flip the flag in a new Map and fire `PUT /api/sessions/{id}/pinned|muted|alerted`; network errors are ignored.
- setSessionTitle trims, no-ops on empty/unchanged, then fires `PUT /api/sessions/{id}/title`.
- setSessionRemark trims and fires `PUT /api/sessions/{id}/remark`. It no-ops only when the trimmed
  value is **unchanged** — unlike the title it must NOT no-op on empty, because clearing the remark is a
  legitimate edit (the server stores `NULL`). Capped at 200 chars to match the server `remarkSchema`.
- updateSession honors `replacesId`: deletes the replaced entry and, if it was selected, re-points `selectedSessionId` to the new id. removeSession clears selection if the removed session was selected.
- Session deduplication (most recent lastActivityAt wins) is handled in `useWebSocket.ts` snapshot handler, not sessionStore.

### settingsStore
- Persistence is per-setter: each setter calls `persistSetting(key, value)` → `db.settings.put({ key, value, updatedAt })`, then `flashAutosave()` (2s `autosaveVisible` flash). `persistSetting` validates `JSON.stringify` before writing (skips circular refs).
- DOM side effects (applied on set and in `loadFromDb`/`resetDefaults`): themeName → `data-theme` attribute on `document.body` (`command-center` removes the attribute), fontSize → `documentElement.style.fontSize`, scanlineEnabled → `no-scanlines` body class toggle, animationIntensity → `--anim-intensity` CSS var, animationSpeed → `--anim-speed` CSS var.
- Defaults of note: fontSize `13`, hookDensity `'medium'`, ttsVoiceEn `'en-US-Chirp3-HD-Aoede'`, ttsVoiceZh `'cmn-CN-Chirp3-HD-Aoede'`, ttsSpeakingRate `1.0`, translationNativeLanguage `'简体中文'`, translationLearningLanguage `'English'`, translationTrigger `'auto'`, explainAttachFilePath `'ask'`. API keys default to empty strings (privacy).
- `loadFromDb` hydrates from Dexie and re-applies all DOM side effects; `resetDefaults` resets in-memory state, re-applies side effects, and re-persists every default key.

### uiStore
- cardDisplayMode persisted to `localStorage['card-display-mode']`; selectedRoomIds persisted to `localStorage['room-filter']` (removed when empty). Both load on store init.
- `sessionSortMode: 'room' | 'activity'` persisted to `localStorage['session-sort-mode']` (default `'room'`), loaded on store init, flipped by `toggleSessionSortMode()`. Consumed only by SessionSwitcher, where `'activity'` drops the room frames and orders the strip by `lastActivityAt` descending — see [Session Detail Panel](./session-detail-panel.md).
- workspaceLoad is an ephemeral progress object `{ active, total, done, currentTitle }` driving the workspace-load overlay.
- `pendingFileOpen: { filePath, projectPath } | null` — transient "open this file in the PROJECT tab" request set via `openFileInProject()`, consumed (and cleared via `clearPendingFileOpen()`) by DetailPanel + ProjectTabContainer.
- `pendingFileChooser: { filePath, projectPath, anchor: { x, y } } | null` — transient request to show the [File-Open Chooser](./file-open-chooser.md) popover at viewport coords `anchor`. Set via `openFileChooser()` from file-path link clicks (LinkifiedText, terminal link provider), cleared via `clearFileChooser()`. The chooser's "Open in app" action then routes through `openFileInProject()`.

### queueStore
- The store is the shared, persisted source of truth for queues. `queues` items are written to `db.promptQueue`, `automation` configs to `db.queueAutomation`, via a single `subscribe` that diffs prev/next maps and persists only changed sessions (bulkDelete + bulkAdd per session).
- `loadFromDb` hydrates automation rows first (so the scheduler reads fresh config on first tick), then queue items, using `_skipPersist`/`_skipAutomationPersist` sets to avoid a delete+re-insert echo (which would mint new auto-inc IDs and duplicate rows).
- `DEFAULT_AUTOMATION` is a frozen sentinel `{ paused:false, autoSend:true, autoEnter:true, idleGuard:true, skipWhenPrompting:true }` returned for sessions with no config — selectors fall back to this stable reference to avoid a re-render loop.
- Item shape, image attachments, scheduling/chain fields, and the global scheduler are documented in [Prompt Queue](./prompt-queue.md) and [Queue Scheduler](./queue-scheduler.md).

### queueHistoryStore
- Separate from queueStore because a favorite outlives its source queue item and session, carries breadcrumbs (sourceSessionTitle, usedCount), and uses its own table. `saveItem` snapshots the QueueItem (strips per-session id/sessionId/position, resets execution state), `applyToSession` clones the snapshot into a target queue with a fresh id and recomputed timing. `removeEntry` walks every queueStore item and clears any matching `historyId`. Detailed UI/flow in [Queue Scheduler](./queue-scheduler.md).

### roomStore / agendaStore / floatingSessionsStore
- roomStore: every mutation writes the whole array to `localStorage['session-rooms']`; createRoom auto-assigns the next free `roomIndex`; migrateSession re-keys sessionIds when a session is replaced.
- agendaStore: server-backed via `/api/agenda`; all mutations are optimistic (temp id on create) and revert on a non-ok response or network error.
- floatingSessionsStore: open() de-dupes by terminalId and evicts+kills the oldest float past `MAX_FLOATS`; closeByOriginSession/closeOrphans/migrateOriginSession keep popups attached to live sessions across removal/re-key/snapshot; poppedOut tracks terminals whose panel is hidden because they live in a native Electron window.

## Dependencies & Connections

### Depends On
- [Client Persistence](./client-persistence.md) — settings, queues, queue automation, queue history, and shortcut overrides persist to Dexie IndexedDB
- [WebSocket Client](./websocket-client.md) — wsStore tracks connection state (WsClient)

### Depended On By
- ALL frontend components read from stores
- [3D Cyberdrome Scene](../3d/cyberdrome-scene.md) — reads sessionStore, roomStore, settingsStore, cameraStore from the DOM layer
- [Session Detail Panel](./session-detail-panel.md) — reads selectedSessionId, session data
- [Sound/Alarm System](../multimedia/sound-alarm-system.md) — reads settingsStore sound profiles
- [Prompt Queue](./prompt-queue.md) / [Queue Scheduler](./queue-scheduler.md) — read/write queueStore and queueHistoryStore
- [Floating Terminal Fork](./floating-terminal-fork.md) — floatingSessionsStore drives PIP fork-translate/explain terminals
- [Review Tab](./review-tab.md) — reads translationLog populated on float close

### Shared Resources
- Zustand stores are singletons, accessed via hooks or `getState()`

## Change Risks
- Mutating session objects directly (instead of new Map) causes stale renders
- Adding Zustand subscriptions inside Canvas causes React Error #185
- Changing settingsStore keys breaks persistence migration (keys are Dexie row keys)
- Modifying sessionStore actions affects all consumers and the `/api/sessions/{id}/*` PUT contracts
- Altering queueStore item/automation shape must stay in sync with the Dexie schema and the scheduler ([Prompt Queue](./prompt-queue.md))
