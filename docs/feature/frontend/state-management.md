# Zustand State Management (9 Stores)

## Function
Global state management via 9 Zustand stores providing reactive session, UI, settings, queue, camera, room, WebSocket, shortcut, and agenda state.

## Purpose
Single source of truth for all frontend state. Zustand chosen for its minimal API and compatibility with React Three Fiber (no context providers needed inside Canvas).

## Source Files
| File | Role |
|------|------|
| `src/stores/sessionStore.ts` | Sessions Map, selectedSessionId, previousSessionId, addSession/removeSession/updateSession/selectSession/deselectSession/setSessions/togglePin/toggleMute/toggleAlert |
| `src/stores/wsStore.ts` | connected, reconnecting, lastSeq, client, setConnected/setReconnecting/setLastSeq/setClient |
| `src/stores/uiStore.ts` | activeModal, detailPanelOpen, detailPanelMinimized, activityFeedOpen, detailHeaderCollapsed, pendingFileOpen, cardDisplayMode, workspaceLoad, selectedRoomIds. Actions: openModal/closeModal, panel controls, openFileInProject, toggleCardDisplayMode, workspaceLoad lifecycle, toggleRoomFilter/clearRoomFilter |
| `src/stores/settingsStore.ts` | 9 themes, 6 robot models, sound profiles (4 CLIs), ambient, hooks, API keys, animationSpeed. Complex store with side effects (DOM CSS vars, data attributes). Actions include per-CLI sound config, label alarms, import/export, resetDefaults |
| `src/stores/queueStore.ts` | Queues Map<string, QueueItem[]>, per-session prompt queues with image attachments (QueueImageAttachment). Actions: add/remove/reorder/moveToSession/setQueue/migrateSession/loadFromDb. Persist subscription writes changes to IndexedDB |
| `src/stores/cameraStore.ts` | pendingTarget, isAnimating, flyTo(), completeAnimation(). Defaults: [18,16,18] position, [0,1,0] target |
| `src/stores/roomStore.ts` | Rooms with id/name/sessionIds/collapsed/createdAt/roomIndex, persisted to localStorage['session-rooms']. Actions: createRoom/renameRoom/deleteRoom/addSession/removeSession/moveSession/toggleCollapse/setRoomIndex/migrateSession/getRoomForSession/loadFromStorage |
| `src/stores/shortcutStore.ts` | Rebindable keyboard shortcuts. bindings array, rebind/resetOne/resetAll/getConflict/findActionForEvent/loadFromDb. Persisted to IndexedDB via db.settings key 'shortcutBindings' |
| `src/stores/agendaStore.ts` | Tasks Map<string, AgendaTask>, loading, filter (AgendaFilter). Actions: fetchTasks/createTask/updateTask/deleteTask/toggleTask/setFilter. Server-backed via /api/agenda |

## Implementation
- Immutability: `set((s) => ({ sessions: new Map(s.sessions) }))` — always new Map for sessions
- sessionStore deduplication: most recent lastActivityAt wins when two sessions have same ID
- sessionStore: togglePin/toggleMute/toggleAlert optimistically update local state and fire PUT to server
- settingsStore persistence: each setter calls persistSetting(key, value) -> Dexie db.settings.put(), 2s autosave flash, safe serialization (catches circular refs)
- settingsStore side effects: theme -> data-theme attribute on body, fontSize -> documentElement.style.fontSize, scanlines -> no-scanlines class, animationIntensity + animationSpeed -> CSS variables
- uiStore: detailHeaderCollapsed persisted to localStorage['detail-header-collapsed'], cardDisplayMode to localStorage['card-display-mode'], selectedRoomIds to localStorage['room-filter']
- queueStore: persist subscription tracks changed sessions and writes to IndexedDB via bulkDelete+bulkAdd. loadFromDb uses _skipPersist Set to avoid delete+re-insert cycle during initial load. Supports image attachments (QueueImageAttachment: name + dataUrl)
- roomStore: auto-assigns next available roomIndex on createRoom. migrateSession re-keys sessionIds when session is replaced
- agendaStore: server-backed via /api/agenda REST API, tasks stored as Map<string, AgendaTask>, filter state with search/priority/tag/showCompleted/sortBy
- Map for session collections (not arrays) for O(1) lookup
- Zero Zustand subscriptions inside Canvas (critical rule — prevents React Error #185)

## Dependencies & Connections

### Depends On
- [Client Persistence](./client-persistence.md) — settings persist to Dexie IndexedDB
- [WebSocket Client](./websocket-client.md) — wsStore tracks connection state

### Depended On By
- ALL frontend components read from stores
- [3D Cyberdrome Scene](../3d/cyberdrome-scene.md) — reads sessionStore, roomStore, settingsStore, cameraStore from DOM layer
- [Session Detail Panel](./session-detail-panel.md) — reads selectedSessionId, session data
- [Sound/Alarm System](../multimedia/sound-alarm-system.md) — reads settingsStore for sound profiles

### Shared Resources
- Zustand stores are singletons, accessed via hooks or getState()

## Change Risks
- Mutating session objects directly (instead of new Map) causes stale renders
- Adding Zustand subscriptions inside Canvas causes React Error #185
- Changing settingsStore keys breaks persistence migration
- Modifying sessionStore actions affects all consumers
