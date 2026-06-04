# Session Creation Modals

## Function
Two modal forms for launching new sessions: NewSessionModal (full-featured SSH + local) and QuickSessionModal (fast local launch). Both support remote control auto-enable.

## Purpose
Primary UI entry points for creating sessions. NewSessionModal handles complex configurations (SSH, model, effort, ops terminal). QuickSessionModal provides a faster path for common local sessions.

## Source Files
| File | Role |
|------|------|
| `src/components/modals/NewSessionModal.tsx` | Full session creation form with SSH, model, effort, remote control, ops terminal |
| `src/components/modals/QuickSessionModal.tsx` | Fast local session creation with label, room, remote control |
| `src/lib/remoteControlName.ts` | Remote control name derivation, settings persistence (`remote-control:settings`) |

## Implementation

### NewSessionModal

- Opened via NavBar "New Session" button or keyboard shortcut
- Fields: host, port (default 22), username, auth method (key/password), private key path, password, workingDir, command, title, label, room, effortLevel (Claude Code levels `low`/`medium`/`high`/`xhigh`/`max`, default `high`), model, ops terminal toggle
  - Effort levels are centralized in `src/lib/remoteControlName.ts` (`EFFORT_LEVELS`, `DEFAULT_EFFORT_LEVEL`, `normalizeEffortLevel`); `normalizeEffortLevel` coerces a stale stored value (e.g. an old `min`) back to `high` on load. Shared by both modals.
- Working dir history merged with known Claude Code projects via `useKnownProjects()`
- Combobox suggestions for host, username, command (from session history)
- SSH keys fetched from `GET /api/ssh-keys` on mount
- On submit: `POST /api/terminals` (browser) or `window.electronAPI.createPty` (Electron IPC path)
- Session config persisted via `saveDirSessionConfig(workingDir)` and `saveRemoteControlSettings()`

### QuickSessionModal

- Opened via keyboard shortcut (quick-launch)
- Fields: command, workingDir, title, label, room, ops terminal toggle, remote control
- Also uses IPC path detection: `window.electronAPI?.createPty` → IPC; otherwise HTTP `POST /api/terminals`

### Remote Control section (both modals)

- **Visibility**: shown only when `isClaudeCommand` (`command.trim().toLowerCase().startsWith('claude')`)
- **Enable Remote Control** checkbox: `enableRemoteControl` state — pre-checked when `autoEnable` is true OR `settings.enabled` was previously true
- **Remote control name field**: auto-derived via `deriveRemoteControlName(sessionTitle, workingDir, sessions)` or manually edited; sanitized to `^[a-zA-Z0-9_.\-]+$`
- **Auto-enable for future Claude sessions** checkbox (v2.10.20): `autoEnableRemoteControl` state — when checked, the Enable Remote Control checkbox is pre-checked on future modal opens whenever command starts with `claude`. Saved to `remote-control:settings.autoEnable`.
- On submit: `saveRemoteControlSettings({ enabled, autoEnable, lastName })` persists all three fields

### remoteControlName.ts

- **`STORAGE_KEY`**: `'remote-control:settings'` (localStorage)
- **`PersistedSettings`** interface: `{ enabled: boolean; autoEnable?: boolean; lastName?: string }`
  - `autoEnable`: pre-checks remote control for claude commands regardless of last manual choice
  - `lastName`: hint for the name field, not auto-applied
- **`loadRemoteControlSettings()`**: parses localStorage, defaults `{ enabled: false, autoEnable: false }` on missing/corrupt
- **`saveRemoteControlSettings(settings)`**: writes JSON to localStorage, silently ignores quota errors
- **`deriveRemoteControlName(sessionTitle, workingDir, sessions)`**: prefers sanitized session title; falls back to `<projectBasename>-<n>` where n counts existing sessions sharing the same project basename
- **`sanitize(name)`**: replaces `[^a-zA-Z0-9_.-]+` with `-`, strips leading/trailing dashes
- **`projectBasename(workingDir)`**: takes last path segment, falls back to `'session'`

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — reads rooms (roomStore), sessions (sessionStore for name derivation)
- [IPC Transport](../electron/ipc-transport.md) — QuickSessionModal/NewSessionModal branch on `window.electronAPI?.createPty`
- [PTY Host](../electron/pty-host.md) — receives `remoteControlName` in `PtyCreateConfig` for auto-apply
- [Settings System](./settings-system.md) — `useKnownProjects` hook for working dir history

### Depended On By
- [IPC Transport](../electron/ipc-transport.md) — documents the QuickSessionModal branching pattern
- [PTY Host](../electron/pty-host.md) — auto-applies `/remote-control <name>` when `remoteControlName` is set

### Shared Resources
- localStorage key `remote-control:settings` — shared between both modals; last value wins
- localStorage keys for SSH history, dir session config, host/username/command suggestions

## Change Risks
- `isClaudeCommand` check is case-insensitive prefix match — commands like `claude-code` would also trigger the remote control section
- `deriveRemoteControlName` reads `useSessionStore.getState()` directly (not a hook) to avoid stale closure; if the store shape changes this breaks silently
- `autoEnable` defaults `false` on parse error — users who had it set will lose the setting if localStorage is corrupted
- Both modals duplicate the remote control UI and save logic — changes must be applied to both
