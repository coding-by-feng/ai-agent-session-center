# Session Creation Modals

## Function
UI entry points for launching new terminal/agent sessions. The active path is **NewSessionModal** (full-featured SSH + local form) plus **WorkdirLauncher** (one-click NavBar dropdown that relaunches a recent directory). **QuickSessionModal** is a fast-launch form that still exists in the codebase but is currently **not mounted** (see note below). All paths can auto-enable Claude Code remote control and apply a model/effort level.

## Purpose
Create sessions without leaving the dashboard. NewSessionModal covers complex configurations (SSH host/auth, model, effort, remote control, commands terminal). WorkdirLauncher provides a zero-form relaunch of a previously-used directory. QuickSessionModal was the original fast local-launch form.

## Source Files
| File | Role |
|------|------|
| `src/components/modals/NewSessionModal.tsx` | Full session creation form: SSH host/port/auth, working dir, command, title, room, API key, model, effort, remote control, commands terminal. Rendered in `App.tsx`; opened by NavBar `+ NEW` button (`openModal('new-session')`). |
| `src/components/layout/WorkdirLauncher.tsx` | `DIRS` dropdown in the NavBar. Lists recent + known working directories; one click relaunches a `claude` session there using saved per-directory config. |
| `src/components/modals/QuickSessionModal.tsx` | Fast local launch form with label chips, model, effort, remote control. **Orphaned: not imported, rendered, or opened by any shortcut/handler** — kept for reference, code below still describes its behavior. |
| `src/lib/remoteControlName.ts` | Remote control name derivation, remote-control settings persistence (`remote-control:settings`), and shared model/effort prefs + `EFFORT_LEVELS` (`session-create-prefs`). |

## Implementation

### NewSessionModal

- Opened via NavBar `+ NEW` button → `useUiStore.openModal('new-session')`. Rendered unconditionally in `App.tsx`; the shared `Modal` shows it only when `activeModal === 'new-session'`.
- Fields: host, port (default `22`), username, auth method (key/password via a `SSH Key`/`Password` Combobox), private key path, password, working dir (default `~`), command, session title, room, API key (overrides `ANTHROPIC_API_KEY`), model, effort level, remote control, commands terminal toggle. (No `label` field — session labels were removed from this modal.)
- **Validation**: required fields are host, port (`1`–`65535`), username, working dir, command. Submit is disabled until all valid; per-field "Required"/"1-65535" errors show after blur/touch.
- **Working dir / suggestions**: working-dir options come from `useKnownProjects()` (history merged with `GET /api/known-projects`). Host (`host-history` + `localhost`), username (`username-history`), and command (`getCommandSuggestions`) all use Combobox suggestions from localStorage history (max 20 each).
- **SSH keys**: fetched from `GET /api/ssh-keys` on mount; populate the private-key-path Combobox.
- **Model + Effort** (shown only when command starts with `claude`): model Combobox offers `opus`/`sonnet`/`haiku` (free-text allowed); effort Combobox lists `EFFORT_LEVELS`. Persisted via `saveSessionPrefs({ model, effortLevel })` and reloaded on next open via `loadSessionPrefs()` + `normalizeEffortLevel()`.
- **Submit** (`handleSubmit`): always `POST /api/terminals` with `forceNew: true` (NewSessionModal has no Electron-IPC branch). On success: saves workdir/host/username/command history, `lastSession`, per-dir config (`dir-session-configs`), session prefs, and remote-control settings; auto-selects the new session (`selectSession`) and assigns it to the chosen room.

### WorkdirLauncher

- `DIRS` toggle button in the NavBar opens a dropdown listing recent directories: `workdir-history` merged with `useKnownProjects()` (deduped). Closes on outside click (`useClickOutside`) or `Escape`.
- Clicking a directory calls `handleLaunch(dir)`: it resolves saved connection params with a 3-tier fallback — per-directory config (`dir-session-configs`) → most-recent live session in the store with a matching `sshConfig.workingDir` → global `lastSession` — then `POST /api/terminals` with `command` defaulting to `claude` and `host` defaulting to `window.location.hostname`/`localhost`.
- On success: auto-selects the new session and re-saves the per-directory config so the next click reuses it. Toasts success/error.
- A per-row `x` removes a directory from `workdir-history` (does not affect known projects, which re-merge on next open).

### QuickSessionModal (orphaned)

Still compiles but is not wired into the app (nothing opens `modalId="quick-session"`). Behavior if mounted:
- Fields: label chips (built-ins `ONEOFF`/`HEAVY`/`IMPORTANT` + custom labels in `custom-labels`), session title, working dir (defaults to first `workdir-history` entry), command (default `claude`), model, effort, remote control, room, commands terminal.
- Dual transport: `window.electronAPI?.createPty` (Electron IPC) when available, else `POST /api/terminals` with `forceNew: true`.
- Persists session prefs and remote-control settings on launch; auto-selects the session and assigns to room.

### Remote Control section (both modals)

- **Visibility**: shown only when `isClaudeCommand` — `command.trim().toLowerCase().startsWith('claude')`.
- **Enable Remote Control** checkbox (`enableRemoteControl`): pre-checked when `settings.autoEnable` is true OR `settings.enabled` was previously true.
- **Name field** (shown when enabled): defaults to `deriveRemoteControlName(sessionTitle, workingDir, sessions)`; once the user edits it (`remoteControlNameTouched`), the manual value is sanitized via `sanitizeRemoteControlName`. The effective name is sent only when remote control is enabled and the command is Claude.
- **Auto-enable for future Claude sessions** checkbox (`autoEnableRemoteControl`): persisted to `remote-control:settings.autoEnable`; pre-checks Enable Remote Control on future opens whenever the command starts with `claude`.
- On submit: `saveRemoteControlSettings({ enabled, autoEnable, lastName })` (`lastName` only when the name was manually edited). The server runs `/remote-control <name>` after Claude starts (see [PTY Host](../electron/pty-host.md) / [Terminal & SSH](../server/terminal-ssh.md)).

### Model + Effort application

`effortLevel` and `model` travel in the create-terminal request (`CreateTerminalRequest.effortLevel` / `.model`) and are applied as `--model`/`--effort` **launch flags** when the CLI process starts — deterministic, before the first prompt. `ultracode` is the exception: the `--effort` flag rejects it (it is a Claude Code menu-only level), so it is applied via a post-startup `/effort ultracode` slash command. The flag-building logic lives server-side (`server/config.ts`, used by `sshManager.ts`/`ptyHost.ts`); these modals only collect and forward the values.

### remoteControlName.ts

- **`STORAGE_KEY` = `'remote-control:settings'`** (localStorage) for remote-control prefs; **`SESSION_PREFS_KEY` = `'session-create-prefs'`** for model/effort prefs.
- **`PersistedSettings`**: `{ enabled: boolean; autoEnable?: boolean; lastName?: string }`. `autoEnable` pre-checks remote control for claude commands; `lastName` is a name-field hint only (not auto-applied).
- **`loadRemoteControlSettings()` / `saveRemoteControlSettings()`**: load defaults to `{ enabled: false, autoEnable: false }` on missing/corrupt; save silently ignores quota errors.
- **`EFFORT_LEVELS` = `['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']`**; **`DEFAULT_EFFORT_LEVEL` = `'high'`**. `normalizeEffortLevel(value)` coerces an unknown/stale stored value (e.g. the removed `min`) back to `high`.
- **`loadSessionPrefs()` / `saveSessionPrefs()`**: read/write `{ model?, effortLevel? }` JSON, ignore parse/quota errors.
- **`deriveRemoteControlName(sessionTitle, workingDir, sessions)`**: prefers the sanitized session title; else `<projectBasename>-<n>` where n counts existing sessions sharing the same project basename (≥ 1).
- **`sanitize` (exported as `sanitizeRemoteControlName`)**: replaces `[^a-zA-Z0-9_.-]+` with `-`, strips leading/trailing dashes (matches server regex `^[a-zA-Z0-9_.\-]+$`).
- **`projectBasename(workingDir)`**: last path segment; falls back to `'session'`.

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — `useUiStore` (open/close modal, `activeModal`), `useSessionStore` (auto-select + name derivation), `useRoomStore` (room assignment).
- [UI Primitives](./ui-primitives.md) — `Modal`, `Combobox`, `ToastContainer.showToast`, `useClickOutside`.
- [Project Browser](./project-browser.md) — `useKnownProjects()` / `GET /api/known-projects` for working-dir suggestions.
- [Command Autocomplete](./command-autocomplete.md) — `getCommandSuggestions`/`saveCommand` for the command field.
- [API Endpoints](../server/api-endpoints.md) — `POST /api/terminals`, `GET /api/ssh-keys`, `GET /api/known-projects`.
- [IPC Transport](../electron/ipc-transport.md) — QuickSessionModal branches on `window.electronAPI?.createPty` (orphaned path).
- [PTY Host](../electron/pty-host.md) — receives `remoteControlName`/`effortLevel`/`model` in the create config for auto-apply.

### Depended On By
- [Views & Routing](./views-routing.md) — NavBar (`+ NEW`, `DIRS`) is the primary launch surface.
- [Terminal & SSH](../server/terminal-ssh.md) — consumes the create-terminal request fields produced here.

### Shared Resources
- localStorage `remote-control:settings` and `session-create-prefs` — shared between both modals (last value wins).
- localStorage `workdir-history`, `lastSession`, `dir-session-configs` — shared by NewSessionModal and WorkdirLauncher.
- localStorage `host-history`, `username-history`, command-suggestion history.

## Change Risks
- **QuickSessionModal is dead code**: changes there have no runtime effect until it is re-mounted. Do not assume edits to it change app behavior; if reviving it, wire `openModal('quick-session')` to a shortcut/button and render `<QuickSessionModal />` in `App.tsx`.
- `isClaudeCommand` is a case-insensitive prefix match — `claude-code` and similar also trigger the remote-control/model/effort sections.
- `deriveRemoteControlName` reads `useSessionStore.getState()` directly (not a hook) to avoid stale closures; a store-shape change breaks it silently.
- `autoEnable` defaults `false` on parse error — a corrupted `remote-control:settings` loses the user's setting.
- NewSessionModal and (orphaned) QuickSessionModal duplicate the remote-control and model/effort UI + save logic — keep them in sync if QuickSessionModal is revived.
- WorkdirLauncher and NewSessionModal both write `dir-session-configs` — relaunch params are last-write-wins per directory.
