# Session Creation Modals

## Function
UI entry points for launching new terminal/agent sessions. The active path is **NewSessionModal** (local-only form — remote/SSH mode was removed) plus **WorkdirLauncher** (one-click NavBar dropdown that relaunches a recent directory). **QuickSessionModal** is a fast-launch form that still exists in the codebase but is currently **not mounted** (see note below). All paths create **local** sessions only and can auto-enable Claude Code remote control and apply a model/effort level.

## Purpose
Create sessions without leaving the dashboard. NewSessionModal covers local session configuration (working dir, command, model, effort, remote control, commands terminal). WorkdirLauncher provides a zero-form relaunch of a previously-used directory. QuickSessionModal was the original fast local-launch form. Remote/SSH session creation is no longer offered in the UI; the server's SSH path remains only for restoring previously-saved SSH sessions from workspace snapshots.

## Source Files
| File | Role |
|------|------|
| `src/components/modals/NewSessionModal.tsx` | Local session creation form: working dir, command, title, room, API key, model, effort, remote control, commands terminal. Rendered in `App.tsx`; opened by NavBar `+ NEW` button (`openModal('new-session')`). |
| `src/components/layout/WorkdirLauncher.tsx` | `DIRS` dropdown in the NavBar. Lists recent + known working directories; each row carries Claude / Codex / Gemini launch buttons that start a local session running that CLI in the directory. |
| `src/components/layout/CliBrandIcons.tsx` | `ClaudeIcon` / `CodexIcon` / `GeminiIcon` — official-style brand marks (Anthropic sunburst, OpenAI blossom-knot, Gemini spark) used by the DIRS launch buttons. |
| `src/components/modals/QuickSessionModal.tsx` | Fast local launch form with label chips, model, effort, remote control. **Orphaned: not imported, rendered, or opened by any shortcut/handler** — kept for reference, code below still describes its behavior. |
| `src/lib/remoteControlName.ts` | Remote control name derivation, remote-control settings persistence (`remote-control:settings`), and shared model/effort prefs + `EFFORT_LEVELS` + `MODEL_OPTIONS` (`session-create-prefs`). |

## Implementation

### NewSessionModal

- Opened via NavBar `+ NEW` button → `useUiStore.openModal('new-session')`. Rendered unconditionally in `App.tsx`; the shared `Modal` shows it only when `activeModal === 'new-session'`.
- Fields: working dir (default `~`), command, session title, room, API key (overrides `ANTHROPIC_API_KEY`), model, effort level, remote control, commands terminal toggle. (No `label` field — session labels were removed from this modal. No host/port/username/auth fields — remote/SSH mode was removed.)
- **Local-only**: the create request carries no host/port/username/auth fields. The server resolves a host-less request to `localhost` and spawns a local PTY (`apiRouter` defaults `host → 'localhost'`, `username → OS user`); see [Terminal & SSH](../server/terminal-ssh.md).
- **Validation**: required fields are working dir and command. Submit is disabled until both valid; per-field "Required" errors show after submit/touch.
- **Working dir / suggestions**: working-dir options come from `useKnownProjects()` (history merged with `GET /api/known-projects`); command suggestions come from `getCommandSuggestions` (localStorage history, max 20). Both modals render a `BrowseDirButton` (`src/components/ui/BrowseDirButton.tsx`) beside the working-dir Combobox: in Electron it opens the native OS folder picker (`window.electronAPI.selectDirectory` → `dialog:select-directory`) and fills the field with the chosen absolute path; in a plain browser it renders nothing (the sandbox can't return an absolute path), leaving the Combobox as the only picker.
- **Model + Effort** (shown only when command starts with `claude`): model Combobox offers `MODEL_OPTIONS` — aliases `fable`/`opus`/`sonnet`/`haiku` plus full IDs `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5` (free-text still allowed; server validates with shell-safe regex `^[a-zA-Z0-9._-]+$`); effort Combobox lists `EFFORT_LEVELS`. Persisted via `saveSessionPrefs({ model, effortLevel })` and reloaded on next open via `loadSessionPrefs()` + `normalizeEffortLevel()`.
- **Submit** (`handleSubmit`): always `POST /api/terminals` with `forceNew: true` (NewSessionModal has no Electron-IPC branch). On success: saves workdir/command history, `lastSession` and per-dir config (`dir-session-configs`) — both now `{ workingDir, command }` only — session prefs, and remote-control settings; auto-selects the new session (`selectSession`) and assigns it to the chosen room.

### WorkdirLauncher

- `DIRS` toggle button in the NavBar opens a dropdown listing recent directories: `workdir-history` merged with `useKnownProjects()` (deduped). Closes on outside click (`useClickOutside`) or `Escape`.
- Each directory row shows three CLI launch buttons (`CLI_OPTIONS`: Claude / Codex / Gemini, rendered with the brand icons). The row itself is no longer clickable; clicking a CLI button calls `handleLaunch(dir, command)` with that explicit CLI and `POST /api/terminals` body `{ workingDir, command }`. No host/auth params are sent — the launch is always local. On success it auto-selects the new session and records `dir-session-configs[dir] = { command, workingDir }` (the last CLI used there, read by the session modals when prefilling a command). The old saved-command resolution (`lastSession` / live-session fallback) was removed since the CLI is now chosen explicitly per launch.
- On success: auto-selects the new session and re-saves the per-directory config (`{ workingDir, command }`) so the next click reuses it. Toasts success/error.
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

`effortLevel` and `model` travel in the create-terminal request (`CreateTerminalRequest.effortLevel` / `.model`) and are applied as `--model`/`--effort` **launch flags** when the CLI process starts — deterministic, before the first prompt. `ultracode` is a special case: the raw `--effort ultracode` value is rejected by the CLI (it is a Claude Code menu-only level), so it launches as `--effort xhigh` (its valid base level) and is then upgraded to true ultracode via a post-startup `/effort ultracode` slash command. The flag-building logic lives server-side (`server/config.ts`, used by `sshManager.ts`/`ptyHost.ts`); these modals only collect and forward the values.

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
- [API Endpoints](../server/api-endpoints.md) — `POST /api/terminals`, `GET /api/known-projects`. (`GET /api/ssh-keys` is no longer called — the private-key-path field was removed with remote mode.)
- [IPC Transport](../electron/ipc-transport.md) — QuickSessionModal branches on `window.electronAPI?.createPty` (orphaned path).
- [PTY Host](../electron/pty-host.md) — receives `remoteControlName`/`effortLevel`/`model` in the create config for auto-apply.

### Depended On By
- [Views & Routing](./views-routing.md) — NavBar (`+ NEW`, `DIRS`) is the primary launch surface.
- [Terminal & SSH](../server/terminal-ssh.md) — consumes the create-terminal request fields produced here.

### Shared Resources
- localStorage `remote-control:settings` and `session-create-prefs` — shared between both modals (last value wins).
- localStorage `workdir-history`, `lastSession`, `dir-session-configs` — shared by NewSessionModal and WorkdirLauncher; both write only `{ workingDir, command }` now.
- localStorage command-suggestion history. (`host-history` / `username-history` are no longer read or written; stale entries may linger in localStorage.)

## Change Risks
- **Remote/SSH mode is UI-removed, not server-removed**: `POST /api/terminals` still accepts host/port/username/auth (all optional in `terminalCreateSchema`), and the server SSH path still exists for snapshot-restored SSH sessions. Re-adding remote creation only requires reintroducing the form fields — but `SshConnectionConfig.username` is now optional (`src/types/api.ts`), so don't assume it's always present.
- **Stale localStorage**: `lastSession` / `dir-session-configs` entries written before the removal may still contain `host`/`username`/`authMethod` keys. Both readers only access `.workingDir`/`.command`, so these can't leak into a create request — keep it that way.
- **QuickSessionModal is dead code**: changes there have no runtime effect until it is re-mounted. Do not assume edits to it change app behavior; if reviving it, wire `openModal('quick-session')` to a shortcut/button and render `<QuickSessionModal />` in `App.tsx`.
- `isClaudeCommand` is a case-insensitive prefix match — `claude-code` and similar also trigger the remote-control/model/effort sections.
- `deriveRemoteControlName` reads `useSessionStore.getState()` directly (not a hook) to avoid stale closures; a store-shape change breaks it silently.
- `autoEnable` defaults `false` on parse error — a corrupted `remote-control:settings` loses the user's setting.
- NewSessionModal and (orphaned) QuickSessionModal duplicate the remote-control and model/effort UI + save logic — keep them in sync if QuickSessionModal is revived.
- WorkdirLauncher and NewSessionModal both write `dir-session-configs` — relaunch params are last-write-wins per directory.
