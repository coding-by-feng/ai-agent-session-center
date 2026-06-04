# Floating Terminal Fork (Select-to-Translate / Explain)

> **Function** Spawn a forked AI CLI session inside a draggable picture-in-picture
> window, pre-loaded with a synthesized prompt. Used for selection-anchored
> "explain this" and full-content "translate this" flows.

## Purpose

When a user is reading AI output (terminal scrollback) or a markdown file in
ProjectTab, they often want to:

1. **Explain (learning lang)** — same language, deeper unpacking of the selection.
2. **Explain (native lang)** — bridge a language gap on the selected phrase.
3. **Translate previous answer** — translate the last assistant message into the native language.
4. **Translate file** — translate a whole markdown file into the native language.
5. **Custom prompt** — type your own instruction in the popup; it's combined with the selected text to start a **fresh** floating session (never inherits context, works for any CLI).

Supported modes spawn a brand-new CLI session in a floating window. **No new
model auth, no new API key** — they reuse whatever CLI the origin session is
running. `translate-answer` is currently Claude-only because it reads Claude
transcripts.

## Source Files

| File | Role |
|------|------|
| `src/components/translate/SelectionPopup.tsx` | Floating toolbar at the selection: two icon rows (Explain ×2, Translate ×2) + a **custom-prompt row** (textarea + Run) for mode 5. |
| `server/floatingPrompt.ts` | **Pure** prompt synthesis + window labels (`buildPrompt`, `floatLabel`, `customFloatLabel`, mode types). Extracted from the spawner so it's unit-testable without the db/pty graph. |
| `src/styles/modules/SelectionPopup.module.css` | Popup styling — theme-aware via CSS variables (no hardcoded colours). |
| `src/hooks/useSelectionPopup.ts` | Surface-agnostic selection-watcher hook. |
| `src/lib/selectionExtractors.ts` | Strategies: `extractDomSelection` (markdown) and `extractXtermSelection` (terminals). |
| `src/components/session/FloatingTerminalPanel.tsx` | Picture-in-picture window hosting one TerminalContainer. |
| `src/styles/modules/FloatingTerminalPanel.module.css` | Window styling (drag, resize, collapse) — theme-aware via CSS variables (icons/chrome recolour per theme). |
| `src/components/session/FloatingTerminalRoot.tsx` | Renders all currently-open floats. Mounted once in `App.tsx` AppLayout. |
| `src/stores/floatingSessionsStore.ts` | Zustand store holding open floats; capped at 4. |
| `src/components/settings/TranslationSettings.tsx` | Settings tab for native/learning languages + trigger. |
| `server/floatingSessionSpawner.ts` | Server-side mode validation, prompt synthesis, CLI detection, and Claude/Codex fork-command construction for inherited explain sessions. |
| `server/extractPreviousAnswer.ts` | Claude transcript reader used only by `translate-answer`. |

Wired surfaces:

| File | Wiring |
|------|--------|
| `src/components/terminal/TerminalContainer.tsx` | Mounts the popup using `extractXtermSelection`. Adds `originSessionId` prop. |
| `src/components/terminal/TerminalToolbar.tsx` | Adds the **Translate previous answer** icon button (`onTranslateAnswer`). |
| `src/components/session/ProjectTab.tsx` | Mounts the popup with `extractDomSelection` on `markdownRef`. Adds **Translate file** toolbar button. |
| `src/components/session/ProjectTabContainer.tsx` | Threads `sessionId` → `originSessionId` to `ProjectTab`. |
| `src/components/session/DetailPanel.tsx` | Threads session id to `TerminalContainer`. |
| `src/stores/settingsStore.ts` | Adds `translationEnabled / translationNativeLanguage / translationLearningLanguage / translationTrigger`. |

## Data Flow

```
User selects text (terminal or markdown)
        │
        ▼
useSelectionPopup hook (mouseup → extractor → ExtractedSelection)
        │
        ▼
<SelectionPopup>  [🔎 EN] [🌐 中文]
        │   click
        ▼
POST /api/sessions/spawn-floating
   { originSessionId, mode, selection?, contextLine?, fileContent?,
     filePath?, customPrompt?, nativeLanguage, learningLanguage }
        │
        ▼
server/floatingSessionSpawner.ts
   resolves CLI kind (claude | codex | gemini)
   builds prompt template per mode
   spawns pty in originCwd via createTerminal + writeWhenReady
        │
        ▼
{ terminalId, label }
        │
        ▼
floatingSessionsStore.open() → FloatingTerminalRoot renders
<FloatingTerminalPanel> hosting <TerminalContainer>
```

For mode `translate-answer`, the spawner additionally reads the most recent
assistant message from the Claude transcript via
`server/extractPreviousAnswer.ts`. TerminalContainer hides the translate-previous-answer
toolbar action for non-Claude origins; server validation still rejects direct
Codex / Gemini `translate-answer` calls because no transcript reader exists yet.

## Modes

| Mode | Prompt template (literal) |
|------|---------------------------|
| `explain-learning` | "Explain the following in `{learningLanguage}`. Cover meaning, nuance…" |
| `explain-native` | "Explain the following in `{nativeLanguage}`. Use `{nativeLanguage}` for the explanation…" |
| `translate-answer` | "Translate the following text into `{nativeLanguage}`. Preserve markdown…" |
| `translate-file` | "Translate the following markdown file into `{nativeLanguage}`. Preserve markdown syntax exactly…" |
| `custom` | "`{customPrompt}`" then the selection in a `"""` fence (contextLine prepended if present). **Always a fresh launch** — `custom` is excluded from context inheritance regardless of the setting. Window label is `Custom: {first ~24 chars}`. Logged to the REVIEW tab with `mode='custom'` and `prompt=customPrompt`. |

The CLI binary is selected from `origin.startupCommand`:

* `claude '...'` (positional prompt)
* `codex '...'` (positional prompt)
* `gemini -p '...'` (`-p` flag)

When `translationInheritContext` is enabled for explain modes, Claude and Codex
switch from fresh prompt launches to CLI-native forks:

* `claude --resume '<SESSION_ID>' --fork-session '<prompt>'` or `claude --continue --fork-session '<prompt>'`
* `codex fork '<SESSION_ID>' '<prompt>'` or `codex fork --last '<prompt>'`

Prompts are shell-escaped (single-quote wrapping) and capped at 256 KB to stay
well under typical `ARG_MAX`.

## Configuration

`Settings → Translation`:

* **Enable translation popup** — master toggle.
* **Native language** — target for translations / native-language explanations. Default: 简体中文.
* **Learning language** — target for "deeper" same-language explanation. Default: English.
* **Inherit conversation context for explain modes** — when enabled, `explain-learning` and `explain-native` fork the origin Claude or Codex session via the CLI's native fork command, so the AI grounds its answer in the prior conversation. Translate modes are unaffected (they're self-contained). No effect for Gemini origins. Default: on.
* **Trigger** — `auto` (every selection) / `alt` (require ⌥ held) / `off` (popup disabled, toolbar buttons still work).

No API key field exists — the feature is auth-free.

## Cross-Feature Dependencies

| Connected feature | Why |
|-------------------|-----|
| [Session matching](../server/session-matching.md) | Floating sessions are spawned via the same `createTerminal + pendingLink` path as fork/clone. |
| [Terminal/SSH](../server/terminal-ssh.md) | Float pty registration goes through `sshManager.createTerminal`. |
| [Session detail panel](./session-detail-panel.md) | DetailPanel passes `originSessionId` into TerminalContainer. |
| [Project browser](./project-browser.md) | ProjectTab markdown viewer is the second translatable surface. |
| [Tooltip system](../../shared/tooltips.md) | New tooltip entries: `selExplainLearning`, `selExplainNative`, `termTranslateAnswer`, `projTranslateFile`, `floatTerminalClose`. |

## Change Risks

* **Origin session must exist server-side.** The endpoint requires a live
  `Session` (`getSession(originSessionId)`); standalone Project Browser route
  has no session, so floats are disabled there.
* **`translate-answer` only supports Claude origins** in v1. TerminalContainer
  hides the button for Codex/Gemini/OpenClaw origins; direct API calls from
  unsupported CLIs return a 400 error.
* **Prompts are passed as shell-quoted positional args.** Very large markdown
  files may approach `ARG_MAX`; the spawner enforces a 256 KB cap.
* **Floats share their PTY lifecycle** — closing the window kills the pty via
  `DELETE /api/terminals/:id`. The origin session is unaffected.
* **Settings shape changed** (`translationEnabled`, etc.) — exported settings
  files from older versions still load, but new fields fall back to defaults.
* **Popup colours are fully theme-variable-driven** — `SelectionPopup.module.css` uses
  `var(--bg-card)`, `var(--glow-accent)`, `var(--bg-accent)`, `var(--border-accent-strong)`,
  and `var(--bg-accent-strong)`. Adding new themes must define all five variables or the
  popup will inherit the `:root` defaults.
* **Floating window chrome + collapsed pill are theme-variable-driven** —
  `FloatingTerminalPanel.module.css` mirrors the `DetailPanel.module.css` `.float*` pattern:
  panel/pill background `var(--bg-panel)`, borders `var(--border-accent*)`, header gradient
  `var(--bg-accent*)`, and the launch icons / title / resize grip `var(--accent-cyan)`. The
  collapsed pill keeps per-session identity via `var(--pill-accent, …)` (origin robot colour)
  and falls back to the theme accent when no origin session is resolved. Earlier versions hard-coded
  bright cyan (`rgba(0,255,255,…)`) and referenced non-existent `--panel-bg`/`--panel-border`, so
  the chrome stayed cyan regardless of the selected theme — fixed so it recolours per theme.

## Phase 2 (not yet implemented)

* SummaryTab + NotesTab as additional translatable surfaces (mark with
  `data-translatable`, mount popup with `domExtractor`).
* Codex / Gemini transcript readers for `translate-answer`.
* SSH-origin floats (today the spawner reuses the SSH config but has not been
  exercised end-to-end in remote scenarios).
* Bracketed-paste path for prompts > 256 KB.

## REVIEW Tab (persistence)
Every spawn writes a draft entry to the `translationLogs` Dexie table; the
response is captured when the float is closed. Browse, search, archive, and
annotate entries via the [REVIEW Tab](./review-tab.md).
