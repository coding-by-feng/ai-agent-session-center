# Setup Wizard (First-Run)

## Function
First-run onboarding. Two parallel implementations share the same `data/server-config.json` shape:
- **Electron GUI wizard** — five-step flow: Welcome → Check Deps → Configure → Install → Done. Resolves port, picks which CLIs to monitor (Claude always on, Gemini/Codex optional), hook density, session-history retention, and an optional dashboard password, then installs hooks.
- **CLI wizard** (`hooks/setup-wizard.js`, run by `npm run setup`) — six interactive prompts in the terminal: port, CLI selection, hook density, debug, history retention, password — then writes config and runs `install-hooks.js`.

## Purpose
Hooks must be wired into each CLI's settings file before the dashboard can observe sessions. The wizard turns a multi-step CLI install into a guided flow — a native window on first Electron launch, or a terminal flow for headless/server installs.

## Source Files
| File | Role |
|------|------|
| `src/components/setup/SetupWizard.tsx` | Wizard shell, progress bar, step router, `defaultConfig` |
| `src/components/setup/steps/WelcomeStep.tsx` | Intro step |
| `src/components/setup/steps/DepsCheckStep.tsx` | Checks platform binaries (`curl`/`jq` on macOS, PowerShell policy on Windows) via `checkDeps` IPC |
| `src/components/setup/steps/ConfigureStep.tsx` | Port, Gemini/Codex toggles, hook density, history retention, optional password — `react-hook-form` + Zod |
| `src/components/setup/steps/InstallStep.tsx` | Runs hook install via `installHooks` IPC, streams `onInstallLog` lines |
| `src/components/setup/steps/DoneStep.tsx` | Completion summary + Launch / Open-in-browser |
| `src/types/electron.d.ts` | `SetupConfig`, `DepCheckResult`, `InstallResult`, `ElectronAPI` IPC contract |
| `electron/ipc/setupHandlers.ts` | Main-process IPC handlers: `setup:is-complete`, `setup:check-deps`, `setup:save-config`, `setup:install-hooks`, `setup:complete` |
| `electron/ipc/appHandlers.ts` | `app:rerun-setup` (deletes flag + relaunch), `app:get-port`, `app:open-browser` |
| `electron/preload.ts` | contextBridge mapping `electronAPI` methods → IPC channels |
| `hooks/setup-wizard.js` | Terminal CLI wizard (`npm run setup`) — interactive prompts, scrypt password hashing, writes config, runs `install-hooks.js` |
| `server/hookInstaller.js` | `ensureHooksInstalled()` — runs on every server startup; density-aware hook registration for Claude/Gemini/Codex |
| `src/__tests__/firstRunFlow.test.tsx` | Integration test: App boot → wizard (first run) vs dashboard (already set up) |
| `src/components/setup/__tests__/SetupWizard.test.tsx` | SetupWizard shell / navigation tests |
| `src/components/setup/__tests__/WizardSteps.test.tsx` | Welcome / DepsCheck / Install / Done step tests |
| `src/components/setup/steps/ConfigureStep.test.tsx`, `DepsCheckStep.test.tsx`, `InstallStep.test.tsx` | Per-step unit tests |

## Implementation

### Boot gate (Electron only)
`App.tsx` calls `window.electronAPI.isSetup()` (`setup:is-complete`, returns `existsSync(setup.json)` in `userData`). `null` → loading splash, `false` → render `<SetupWizard/>`, `true` → dashboard. In **web mode** (`window.electronAPI` absent) the gate is skipped entirely (`isSetup` forced to `true`); the wizard component still renders if mounted directly but every Electron-only step degrades gracefully.

### Default config
`defaultConfig = { port: 3333, enabledClis: ['claude'], hookDensity: 'medium', debug: false, sessionHistoryHours: 24 }`. Matches the `SetupConfig` type (electron.d.ts:11-18); `passwordHash?: string` is optional.

### Progress bar
`WizardHeader` renders five fixed labels `['Welcome', 'Check Deps', 'Configure', 'Install', 'Done']`. Fill width = `(step / (total - 1)) * 100%`; each label gets `active` (current) or `done` (past) class.

### Check Deps
`DepsCheckStep` calls `checkDeps()` (`setup:check-deps`). The main process probes on **any non-Windows** platform (`setupHandlers.ts` branches on `!isWin`, so Linux is probed too):
- **non-Windows**: `jq --version` (optional — improves session detection) and `which curl` (required — hooks reach dashboard over HTTP fallback).
- **Windows**: PowerShell `Get-ExecutionPolicy`, OK only if `RemoteSigned`/`Unrestricted`/`Bypass`.

`REQUIRED_DEPS`/`OPTIONAL_DEPS` in the component drive which results block forward progress. Missing **required** deps disable Continue; missing optional deps show a warning but allow continuing. Web mode (no API) resolves to an empty result set and shows Continue immediately. On `checkDeps` rejection it offers "Continue Anyway".

> **Gap — Linux is never gated.** `REQUIRED_DEPS`/`OPTIONAL_DEPS` (`DepsCheckStep.tsx:6-14`) are keyed `darwin`/`win32` **only**. With `const platform = window.electronAPI?.platform ?? 'darwin'` resolving to `'linux'`, both `REQUIRED_DEPS[platform] ?? []` and `OPTIONAL_DEPS[platform] ?? []` yield `[]`, so `allRequiredOk` is vacuously true: on Linux the wizard renders **no dependency rows at all** and Continue is never blocked, even with curl missing — despite the main process having probed for it. The mismatch is invisible to `tsc` because `preload.ts:5` casts `process.platform as 'darwin' | 'win32'` (and `electron.d.ts:53` types it that way), so `'linux'` never appears in the type. Adding a `linux` key to both maps would close it.

### Configure
`ConfigureStep` is a `react-hook-form` + `zodResolver` form. Fields: Claude Code (checkbox, always checked + disabled), Gemini CLI / Codex toggles, hook density radio (High/Medium/Low with descriptions), dashboard port (`int` 1–65535), session-history retention `Select` (12 / 24 / 48 / 168 h), and a "Require password" toggle revealing password + confirm fields. The Zod `passwordSchema` enforces 8+ chars with upper/lower/digit/special; a `superRefine` checks confirm-match only when the toggle is on. On submit it builds `enabledClis` from the toggles (`['claude', ...]`), sets `debug: false` (no UI control), pushes to `setConfig`, and — in Electron — awaits `saveConfig()` (`setup:save-config`) before `onNext()`.

### Save config
`setup:save-config` validates every field (port range, density enum, CLI allow-list, history 0<h≤8760, `passwordHash` string ≤256 chars) and atomically writes (`tmp` + `rename`) to `server-config.json` in **`userData`** — not `PROJECT_ROOT`, which is inside the read-only asar in packaged builds.

### Install
`InstallStep` runs once (`startedRef`). It registers `onInstallLog` (`setup:install-log`), then calls `installHooks({ hookDensity, enabledClis })` (`setup:install-hooks`). The main process loads `hooks/install-hooks-api.cjs` (a `.cjs` so `require()` can read it directly from `extraResources` in packaged builds) and calls `installHooks({ density, enabledClis, projectRoot, onLog })`, streaming log lines back to the renderer; a final `DONE` line flips status to done and auto-advances after 1500 ms. On error the step shows a Retry button. **Web mode** logs `[skip] No Electron API` and auto-advances.

### Done
`DoneStep` shows a summary (port, CLIs, density). "Launch Dashboard" calls `completeSetup()` (`setup:complete`) which writes the `setup.json` flag, sets `APP_USER_DATA`, starts the embedded server (`server/index.js startServer()`), and reloads the window at `http://localhost:<port>`. "Open in browser instead" calls `openInBrowser()` (`app:open-browser`).

### Re-run
`rerunSetup()` (`app:rerun-setup`) deletes the `setup.json` flag and relaunches the app, forcing the wizard on next boot.

### CLI wizard (`hooks/setup-wizard.js`)
Invoked by `npm run setup`. Six steps via readline: (1) port (validated 1–65535), (2) CLI selection (Claude only / +Gemini / +Codex / all), (3) hook density (high/medium/low with event-count hints), (4) debug on/off, (5) history retention (12/24/48/168 h), (6) dashboard password. Existing `data/server-config.json` values seed the defaults on re-run. Passwords are entered with masked raw-mode input, validated (8+ chars, upper/lower/digit/special), and hashed with `scrypt` as `salt:hash` (matching the server's `authManager`); the hash is persisted to config only when set. After writing config it runs `node hooks/install-hooks.js --density <d> --clis <list>` and prints a summary.

### Hook density → registered events
Both install paths pass `density` to the installer, which selects per-CLI lifecycle events (`server/hookInstaller.js` `ensureHooksInstalled`, also re-run on every server startup):
- **Claude** (`~/.claude/settings.json`): high = 14 events, medium = 12, low = 5 (start, prompt, permission, stop, end).
- **Gemini** (`~/.gemini/settings.json`): high = 8, medium = 5, low = 3.
- **Codex** (`~/.codex/config.toml`, TOML command lifecycle hooks): high = 10, medium = 6, low = 4. Codex has no `SessionEnd`; `Stop` is its terminal signal.

Each CLI's settings file is patched atomically (write-to-tmp + rename per the project guardrail); existing dashboard hook entries are detected by command substring and never duplicated.

## Dependencies & Connections

### Depends On
- [Authentication](../server/authentication.md) — optional password is scrypt-hashed (`salt:hash`) and seeded into config so first launch already has a login
- [Hook System](../server/hook-system.md) — installer writes density-selected events into each CLI's settings
- [IPC Transport](../electron/ipc-transport.md) — all wizard ↔ main-process calls go through the `setup:*` / `app:*` IPC channels
- [App Lifecycle](../electron/app-lifecycle.md) — `setup:complete` starts the embedded server and reloads the window; `app:rerun-setup` relaunches
- [Settings System](./settings-system.md) — `server-config.json` (port, CLIs, density, debug, history, passwordHash) is the persisted config the dashboard reads

### Depended On By
- App boot flow (`App.tsx`) — `isSetup()` decides whether to show the wizard

### Shared Resources
- `data/server-config.json` (CLI wizard) / `<userData>/server-config.json` (Electron wizard) — persisted setup config
- `<userData>/setup.json` — first-run completion flag
- `~/.claude/settings.json`, `~/.gemini/settings.json`, `~/.codex/config.toml` — modified with atomic write / TOML block replacement

## Change Risks
- Adding a step without updating the `labels` array in `WizardHeader` desyncs the progress bar
- Changing `SetupConfig` shape requires updating `defaultConfig`, the `setup:save-config` validators (electron), and `hooks/setup-wizard.js` to match
- The Electron install path goes through `install-hooks-api.cjs` (not `hookInstaller.js`); the `.cjs` extension is load-bearing for `require()` from packaged `extraResources`
- Config writes to `userData` in Electron, not `PROJECT_ROOT` — packaged builds run inside a read-only asar
- Install failures must surface errors — silent failure leaves the user with broken hooks and no signal
- Density event lists must stay in sync between the doc and `hookInstaller.js` / `install-hooks-core.js`; per-CLI counts differ
