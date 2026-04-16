# Setup Wizard (First-Run)

## Function
Five-step onboarding flow for first-time users: Welcome → DepsCheck → Configure → Install → Done. Resolves port, picks which CLIs to monitor (Claude, Gemini, Codex), hook density, debug, session history retention, then installs hooks.

## Purpose
Hooks must be wired into each CLI's settings file before the dashboard can observe sessions. The wizard turns a multi-step CLI install into a guided flow on first launch.

## Source Files
| File | Role |
|------|------|
| `src/components/setup/SetupWizard.tsx` | Wizard shell, progress bar, step router, `defaultConfig` |
| `src/components/setup/steps/WelcomeStep.tsx` | Intro step |
| `src/components/setup/steps/DepsCheckStep.tsx` | Checks node/jq/CLI binaries are present |
| `src/components/setup/steps/ConfigureStep.tsx` | Port, CLI selection, hook density, debug, history hours |
| `src/components/setup/steps/InstallStep.tsx` | Runs hook install via API, streams progress |
| `src/components/setup/steps/DoneStep.tsx` | Completion + next steps |
| `src/types/electron.d.ts` | `SetupConfig` shape |
| `server/hookInstaller.js` | Backend hook installer invoked by InstallStep |
| `src/__tests__/firstRunFlow.test.tsx` | E2E-ish first-run flow test |
| `src/components/setup/__tests__/SetupWizard.test.tsx` | SetupWizard unit tests |
| `src/components/setup/__tests__/WizardSteps.test.tsx` | Individual wizard step tests |

## Implementation
- **Default config**: `{port: 3333, enabledClis: ['claude'], hookDensity: 'medium', debug: false, sessionHistoryHours: 24}`.
- **Progress bar** width = `(step / (total - 1)) * 100%`; each label reflects `active`/`done` state.
- **Hook density**: passed through to `hookInstaller` which filters which events the bash hook emits (`low` / `medium` / `high`).
- **CLI targets**: each enabled CLI gets its own settings file patched atomically (write-to-tmp + rename per known-issues guardrail).
- **Deps check**: looks for `jq`, `node`, CLI binary on PATH; blocks forward progress if missing.
- **Step tests**: `ConfigureStep.test.tsx`, `DepsCheckStep.test.tsx`, `InstallStep.test.tsx` cover per-step behavior.

## Dependencies & Connections

### Depends On
- [Authentication](../server/authentication.md) — Wizard runs before auth prompt on fresh installs
- [Hook System](../server/hook-system.md) — installer writes into each CLI's settings
- [API Endpoints](../server/api-endpoints.md) — install/config endpoints

### Depended On By
- App boot flow — first-run detection decides whether to show the wizard

### Shared Resources
- `~/.claude/settings.json` (and equivalents for Gemini/Codex) — modified with atomic write

## Change Risks
- Adding a step without updating the `labels` array in `WizardHeader` desyncs the progress bar
- Changing `defaultConfig` shape requires updating `SetupConfig` type and `hookInstaller` to match
- Install failures must surface errors — silent failure leaves the user with broken hooks and no signal
