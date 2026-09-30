# Floating Terminal Fork (Select-to-Translate / Explain / Vocab)

> **Function** Spawn a forked AI CLI session inside a draggable picture-in-picture
> window, pre-loaded with a synthesized prompt. Used for selection-anchored
> "explain / translate / define this" flows and full-content "translate this file"
> / "translate the last answer" flows.

## Purpose

When a user is reading AI output (terminal scrollback) or a markdown file in
ProjectTab, they often want to act on a selection or the whole content. The
feature offers eight `FloatingMode`s:

1. **`explain-learning`** — explain the selection in the *learning* language (deeper unpacking, nuance, examples).
2. **`explain-native`** — explain the selection in the *native* language (bridge a language gap).
3. **`vocab-native`** — bilingual-dictionary entry for the selected word/phrase, written in the native language (POS, IPA, definition, example sentences, synonyms).
4. **`translate-selection-learning`** — direct translation of the selection → learning language (output-only, no commentary).
5. **`translate-selection-native`** — direct translation of the selection → native language.
6. **`translate-answer`** — translate the origin's last assistant message → native language (Claude-only; reads the transcript). *Server-side mode; no UI trigger.*
7. **`translate-file`** — translate a whole markdown file → native language (sends `fileContent`). *Server-side mode; no UI trigger.*
8. **`custom`** — type your own instruction in the popup; it's combined with the selected text into a fresh prompt.

`SelectionPopup` surfaces modes 1–5 + custom (six buttons) and is the **only
client trigger**.

> **Modes 6–7 are currently server-only.** `translate-answer` and `translate-file`
> still exist end-to-end on the server (`FloatingMode` + `buildPrompt` + `floatLabel`
> in `floatingPrompt.ts`, the `POST /api/sessions/spawn-floating` Zod enum) and
> still render as mode labels/icons/filter options in REVIEW + AI POPUPS, but **no
> component can spawn them** — the terminal-toolbar and ProjectTab-toolbar buttons
> that used to fire them no longer exist. They are retained for API compatibility
> and for rendering historical REVIEW rows, and are reachable only via a direct
> POST to `/api/sessions/spawn-floating`.

All modes spawn a brand-new CLI session in a floating window. **No new model
auth, no new API key** — they reuse whatever CLI the origin session is running.
When the inherit-context setting is on (default) and the origin is Claude/Codex
*with a resumable conversation*, the spawn uses the CLI's native fork command so
the new session inherits the prior conversation — this applies to **every** mode,
not just explain. `translate-answer` is Claude-only because only the Claude
transcript reader exists.

## Source Files

| File | Role |
|------|------|
| `src/components/translate/SelectionPopup.tsx` | Floating toolbar at the selection: three icon rows (row 1 Explain ×2, row 2 Translate ×2, row 3 Vocabulary ×1) + a read-only **selection preview** + a **quick-settings row** (Model, +Effort on Claude) + an inline **"Attach file path?" confirm** (explain modes only) + a **custom-prompt row** (`AutocompleteTextarea` + Run). The preview mirrors the captured selection text because focusing the textarea collapses the browser's native selection highlight — without it the user thinks the selection was lost (the string is still held in `active.selection` and sent on spawn). See [Quick settings (Model + Effort)](#quick-settings-model--effort) below. |
| `server/floatingPrompt.ts` | **Pure** prompt synthesis + window labels (`buildPrompt`, `floatLabel`, `customFloatLabel`, `MAX_PROMPT_BYTES`, `FloatingMode`/`SpawnFloatingArgs` types). Extracted from the spawner so it's unit-testable without the db/pty graph (no better-sqlite3). |
| `src/styles/modules/SelectionPopup.module.css` | Popup styling — theme-aware via CSS variables (no hardcoded colours). |
| `src/hooks/useSelectionPopup.ts` | Surface-agnostic selection-watcher hook (`auto`/`alt`/`off` triggers; mouseup + click-outside + Esc to dismiss; `open()` for programmatic show). Opens **only on a real selection gesture** — a drag past `CLICK_DRAG_THRESHOLD_PX` (4px) or a double/triple-click — and skips editable fields (`input`/`textarea`). A bare click never opens it: the Claude Code TUI captures mouse events so xterm keeps a **stale** selection after a click, and without this guard clicking into the terminal input re-opened the modes popup on the previous selection. |
| `src/lib/selectionExtractors.ts` | Strategies: `extractDomSelection` (markdown) and `extractXtermSelection` (terminals). Selection capped at `MAX_SELECTION = 4000`, context line at `MAX_CONTEXT_LINE = 400`. |
| `src/lib/cliDetect.ts` | `detectCli(session)` → `'claude' | 'codex' | null`. The **canonical client CLI detector**; the server's `resolveOriginCli` (`floatingSessionSpawner.ts`) deliberately mirrors its precedence (cliSource → command → model) to avoid backend/frontend divergence. |
| `src/lib/translationLog.ts` | Dexie helpers `createLog` (draft on spawn) / `captureResponse` (called periodically while the float is open — every 6s — plus on `beforeunload` and on close, keyed/overwritten by `terminalId` so it's idempotent) feeding the REVIEW tab. |
| `src/components/session/FloatingTerminalPanel.tsx` | Picture-in-picture window hosting one TerminalContainer. Forwards its **`originSessionId`** prop (the **root** session) to TerminalContainer so the float's translate/explain lookups resolve a real session **and float-visibility scoping keeps nested floats visible under the selected root** (never orphaned). Recursive fork is handled server-side: the inner `TerminalContainer` sends this float's `terminalId` as `spawnTerminalId`, and the server resolves *its* session as the fork parent. Constrains both size and position to the renderer viewport before render and after viewport/state transitions. Also hosts the **`DetachIcon` pop-out** button (always rendered — Electron gets a native window, a browser tab gets a `window.open` popup) and rebindable hotkeys (`floatMinimize`/`floatMaximize`/`floatClose`). See [Recursive fork](#recursive-fork). |
| `src/components/ui/DetachIcon.tsx` | Shared window-with-escaping-arrow SVG (`size` prop, default 14) for every "pop out to a native OS window" button — used here at `size={12}`; see [Session detail panel → Pop-out to a native window](./session-detail-panel.md#pop-out-to-a-native-window) for the other two consumers. |
| `src/components/session/FloatingTerminalPanel.test.tsx` | Regression coverage for origin-session forwarding plus initial and live-resize viewport fitting of the in-app panel. |
| `src/styles/modules/FloatingTerminalPanel.module.css` | Window styling (drag, resize, collapse, popout chrome) — theme-aware via CSS variables (icons/chrome recolour per theme), with border-box viewport caps and shrinkable flex children so the right edge and header controls remain visible. |
| `src/components/session/FloatingTerminalRoot.tsx` | Renders the open floats **belonging to the currently selected session** (`originSessionId === selectedSessionId`), excluding any that are **popped out** into a native window. Mounted once in AppLayout. Listens for `popout:closed` to re-dock. See [Per-session scoping](#per-session-popup-scoping). |
| `src/components/session/PopoutTerminalView.tsx` | The **entire renderer** when the window is a popped-out float (`/?popout=terminal&terminalId=…`). Sets up its own `useWebSocket(null)` + `useSettingsInit` and hosts one `TerminalContainer` attached to the existing PTY by id, plus its own `<FileOpenChooser>` mount (separate React root from AppLayout, so the popover for terminal file-path clicks needs a local mount). No token is passed: auth rides on the HttpOnly `auth_token` cookie that every same-origin window shares. |
| `src/components/session/PopoutTerminalView.test.tsx` | Renders the real memo'd `TerminalContainer` inside the pop-out and asserts it subscribes once its socket opens — the blank-pop-out regression test |
| `src/styles/modules/PopoutTerminalView.module.css` | Layout for the popout window (titlebar + full-height terminal body). |
| `src/stores/floatingSessionsStore.ts` | Zustand store holding open floats; capped at `MAX_FLOATS = 4` (`open` **DELETEs the evicted PTY** so it doesn't leak). Adds `closeByOriginSession(id)`, `migrateOriginSession(oldId, newId)`, `closeOrphans(liveIds)`, `captureNow(terminalId)`, and the `poppedOut: string[]` list + `setPoppedOut(id, on)`. `captureNow(terminalId)` GETs `/api/terminals/:id/output` and snapshots the PTY output (base64 → UTF-8 via `TextDecoder`) into the REVIEW log via `captureResponse` **without killing the PTY** — idempotent/pollable (overwrite keyed by `terminalId`). `close()` delegates to `captureNow()` to take a final snapshot before it DELETEs the PTY. |
| `src/components/settings/TranslationSettings.tsx` | Settings tab for native/learning languages, inherit-context toggle, explain attach-file-path policy, and trigger mode. |
| `server/floatingSessionSpawner.ts` | Server-side: resolve origin + fork parent (via `spawnTerminalId`), detect CLI, build the launch/fork command (Claude `--resume … --fork-session` / `--continue --fork-session`; Codex `fork`/`fork --last`), apply permission + model/effort launch flags, create the PTY, and write the command. Applies the popup's quick-settings model/effort **override** when present, else forwards the origin's own model/effort/characterModel onto the popup session; injects `/effort ultracode` post-launch when the effective effort is ultracode. |
| `src/components/ui/AutocompleteTextarea.tsx` | Powers the custom-prompt textarea's `/` command, `$` Codex-skill and `@` file autocomplete — see [Command Autocomplete](./command-autocomplete.md). Its dropdown is portaled to `document.body`; nesting it un-portaled inside `.popup` (which has `backdrop-filter: blur(8px)`) would have put the dropdown's `position: fixed` math inside a CSS containing block the ancestor establishes, offsetting it by roughly the popup's own on-screen position instead of the true viewport — confirmed with a throwaway harness before this was wired in. |
| `server/extractPreviousAnswer.ts` | Claude transcript reader: `readClaudeLastAssistant` (used by `translate-answer`) and `readClaudeTranscript` (used by the CONVERSATION tab — see [conversation-view](./conversation-view.md)). |
| `src/components/translate/SelectionPopup.test.tsx` | Custom-prompt spawn payload; quick-settings row (Claude Combobox pair vs. Codex `Select` + live catalog fetch, model/effort flowing into the payload, blank-stays-inherited default). |

Wired surfaces:

| File | Wiring |
|------|--------|
| `src/components/terminal/TerminalContainer.tsx` | Mounts the popup using `extractXtermSelection` (sends its own `terminalId` as `spawnTerminalId`). Accepts the `originSessionId` prop; the popup is gated on `enabled: translationEnabled && !!originSessionId && aiPopupEnabled` (the last term is the per-terminal toggle below) and rendered only when `popup.active && originSessionId`. `useSelectionPopup` is given `scopeSelector: '.xterm'` because distraction-free fullscreen reparents the xterm element into a body-level overlay, outside `rootRef`'s subtree — without the scope the popup would stop firing in fullscreen. |
| `src/components/terminal/TerminalToolbar.tsx` | Renders the `⧉` pop-out button (`PopOutIcon`, `tooltips.termPopOut`) **only when the `onPopOut` prop is passed**, which is how floats and the popout view itself suppress re-popping-out. TerminalContainer omits `onPopOut`/`onClone` on its fullscreen-overlay toolbar instance, so ⧉ is absent in fullscreen. Also renders the sparkle `AiPopupIcon` per-terminal on/off toggle (`onToggleAiPopup`/`aiPopupEnabled` — see [Per-terminal enable/disable](#per-terminal-enabledisable)) whenever the caller passes it. Carries **no** translate/explain buttons — the removed `translate-answer` trigger lived here. |
| `src/components/session/ProjectTab.tsx` | Mounts the popup with `extractDomSelection` on `markdownRef` (and `markdownFsRef` for fullscreen). Markdown selections have **no** `spawnTerminalId`, so they fork from the root. Gated only on `translationEnabled && !!originSessionId` (+ its own edit/fullscreen view-state flags) — the per-terminal `aiPopupEnabled` toggle below does not apply here. |
| `src/components/session/ProjectTabContainer.tsx` | Threads `sessionId` → `originSessionId` to `ProjectTab`. |
| `src/components/session/DetailPanel.tsx` | Threads `sessionId` → `originSessionId` to the **main TERMINAL** `TerminalContainer` only; the COMMANDS ops-shell `TerminalContainer` omits it, so the AI popup (and its toolbar toggle) is disabled in COMMANDS — the pop-out is shared between the two (see [Pop-out to a native window](#pop-out-to-a-native-window)), the popup is not. |
| `src/main.tsx` | Detects `?popout=terminal` and renders `PopoutTerminalView` instead of the full dashboard. The import is `lazy()` **inside that branch** and wrapped in `<Suspense fallback={null}>`, so the dashboard window never loads the popout renderers — see [Views & Routing → Bundle splitting](./views-routing.md). |
| `electron/main.ts` | `registerPopoutHandler` (`window:open-terminal` IPC) opens the popout `BrowserWindow` (820×560, min 480×320) and sends `popout:closed` on close. |
| `electron/preload.ts` | Bridges `openTerminalWindow` (→ `window:open-terminal`) and `onPopoutClosed`. |
| `src/stores/settingsStore.ts` | `translationEnabled / translationNativeLanguage / translationLearningLanguage / translationTrigger / translationInheritContext / explainAttachFilePath` (+ setters; persisted via `persistSetting`). Also `selectionSpawnModel / selectionSpawnCodexModel / selectionSpawnEffort` — the quick-settings row's remembered override (see below). |

## Data Flow

```
User selects text (terminal or markdown)
        │
        ▼
useSelectionPopup hook (mouseup → extractor → ExtractedSelection)
        │
        ▼
<SelectionPopup>  row1 Explain ×2 | row2 Translate ×2 | row3 Vocabulary | custom row
        │   click  (explain modes may pause for "Attach file path?" confirm)
        ▼
POST /api/sessions/spawn-floating
   { originSessionId, spawnTerminalId?, mode, selection?, contextLine?,
     fileContent?, filePath?, customPrompt?, nativeLanguage,
     learningLanguage, inheritContext?, model?, effortLevel? }
        │
        ▼
server/floatingSessionSpawner.ts
   resolves CLI kind (claude | codex) via resolveOriginCli(origin):
     cliSource (authoritative) → command → model → 'claude' — so a codex
     parent spawns the SAME CLI instead of defaulting to claude
   resolves fork parent (spawnTerminalId → its session, else origin)
   buildPrompt(args, prevAnswer?)  [floatingPrompt.ts]
   forks (--fork-session / codex fork) when inheritContext + claude/codex
     + parent has a conversation; else fresh launch
   applies permission + model/effort launch flags
   createTerminal + createTerminalSession + writeWhenReady in originCwd
   session is marked isFork (kill-guard) + isFloating (hidden from the
     agents sidebar / header strip / 3D scene — rendered only as a PiP panel;
     main-session clone/fork set isFork WITHOUT isFloating and stay listed)
        │
        ▼
{ terminalId, label }
        │
        ▼
SelectionPopup writes a REVIEW draft (createLog) then
floatingSessionsStore.open() → FloatingTerminalRoot renders
<FloatingTerminalPanel> hosting <TerminalContainer>
```

For mode `translate-answer`, the spawner first reads the most recent assistant
message from the Claude transcript via `readClaudeLastAssistant`
(`server/extractPreviousAnswer.ts`) — but only when `resolveOriginCli(origin) === 'claude'`
— and throws a 400 if none is found, so a Codex origin always fails. This
mode has **no UI trigger** today; it is reachable only via a direct POST to
`/api/sessions/spawn-floating`.

## Modes

`buildPrompt(args, prevAnswer)` in `server/floatingPrompt.ts` returns the literal
prompt per mode (or `null` when required input is missing, which the spawner
turns into a 400):

| Mode | Prompt template (gist) |
|------|------------------------|
| `explain-learning` | "Explain the following in `{learningLanguage}`. Cover meaning, nuance, related concepts, and short examples. Be concise." + optional file hint + surrounding line + the selection in a `"""` fence. |
| `explain-native` | "Explain the following in `{nativeLanguage}`. Use `{nativeLanguage}` for the explanation…" (same structure). |
| `vocab-native` | "Act as a bilingual dictionary…" → POS, IPA (single word), `{nativeLanguage}` definition, 2–3 `{learningLanguage}` example sentences each with `{nativeLanguage}` translation, synonyms, and sense in the surrounding line. |
| `translate-selection-learning` | "Translate the following text into `{learningLanguage}`. Output ONLY the translation… Preserve original formatting." |
| `translate-selection-native` | Same → `{nativeLanguage}`. |
| `translate-answer` | "Translate the following text into `{nativeLanguage}`. Preserve markdown…" over the origin's last assistant message. |
| `translate-file` | "Translate the following markdown file into `{nativeLanguage}`. Preserve markdown syntax exactly…" over `fileContent`. |
| `custom` | `{customPrompt}` leads, then the surrounding line (if any) + the selection in a `"""` fence. Requires both a selection and a custom prompt. Window label is `Custom: {first ~24 chars}` (`customFloatLabel`). Logged to the REVIEW tab with `mode='custom'` and `prompt=customPrompt`. |

The CLI binary is selected by the spawner's `resolveOriginCli(origin)`, which
prefers the authoritative `origin.cliSource` (set by the codex hooks'
`cli_source`, or `inferCliSource`), then the launch command, then the model id,
defaulting to `claude` only when nothing matches. This ensures the popup runs the
**same CLI as its parent** — a Codex parent no longer mis-spawns `claude`
(which previously also leaked the parent's model onto the launch, e.g.
`claude --model gpt-5.5`, because the Claude-only flag helper saw a `claude`
command):

* `claude '...'` (positional prompt)
* `codex '...'` (positional prompt)

When `inheritContext !== false` (the per-request flag, defaulting to the
`translationInheritContext` setting which is **on** by default) **and** the fork
parent is a Claude/Codex session **and** that parent has a resumable conversation,
the spawner switches from a fresh launch to a CLI-native fork:

* `claude --resume '<SESSION_ID>' --fork-session '<prompt>'`, or `claude --continue --fork-session '<prompt>'` when the parent id is an internal `term-…` placeholder.
* `codex fork '<SESSION_ID>' '<prompt>'`, or `codex fork --last '<prompt>'`.

"Resumable" means both *used* (`parentHasConversation` — at least one prompt in
history) and *persisted* (a local Claude parent's transcript is actually on disk,
via `resolveResumableClaudeSessionId`). Either miss falls back to a fresh launch,
because `--resume … --fork-session` against a conversation Claude cannot find
exits instantly with "No conversation found with session ID" and leaves the float
sitting on a bare shell — while the popup prompt is self-contained anyway. See
[Floating Session Spawner → Fork-mode (Claude/Codex)](../server/floating-session-spawner.md#fork-mode-claudecodex)
for why prompt history alone is not proof.

Prompts are shell-escaped (single-quote wrapping) and capped at
`MAX_PROMPT_BYTES = 256 KB` (256 × 1024) to stay well under typical `ARG_MAX`;
the spawn endpoint's Zod schema independently caps `fileContent` at 256 KB and
`filePath` at 2048 chars.

## Configuration

`Settings → Translation` (all persisted via `settingsStore.persistSetting`):

* **Enable translation popup** (`translationEnabled`) — master toggle. Default: on.
* **Native language** (`translationNativeLanguage`) — target for translations / native-language explanations. Default: `简体中文`.
* **Learning language** (`translationLearningLanguage`) — target for "deeper" same-language explanation and translate-to-learning. Default: `English`.
* **Inherit conversation context for AI popups** (`translationInheritContext`) — when enabled, popup modes fork the origin Claude/Codex session via the CLI's native fork command (when the parent has a conversation), so the AI grounds its answer in the prior conversation. Default: on. Sent as the per-request `inheritContext` flag.
* **Attach file path (explain)** (`explainAttachFilePath`) — `ask` / `always` / `never`. When an Explain mode runs on a selection inside an open file, optionally include that file's path in the prompt. `ask` prompts once via the inline confirm and then remembers the choice. Default: `ask`. Only applies in the file viewer.
* **Trigger** (`translationTrigger`) — `auto` (every selection) / `alt` (require ⌥ held) / `off` (labelled **Disabled** in the UI). Since the popup is the only client trigger, `off` disables the feature's whole UI surface.

No API key field exists — the feature is auth-free.

## Per-terminal enable/disable

Independent of the global `translationEnabled` toggle above, each **terminal**
carries its own on/off switch: a sparkle `AiPopupIcon` button in
`TerminalToolbar`, rendered whenever `originSessionId` is set — the main
TERMINAL tab only, since `DetailPanel`'s COMMANDS ops-shell `TerminalContainer`
never receives `originSessionId` and so never renders the button. Clicking it
calls `sessionStore.toggleAiPopup(sessionId)`, flipping `session.aiPopupEnabled`.

The gate always reads through [`isAiPopupEnabled(session)`](../../../src/lib/aiPopup.ts),
never the raw field directly: an unset `aiPopupEnabled` (every session that
predates this toggle, or one still missing its DB record) resolves to
**enabled**. This is the same "the absent state must be the safe state" rule
`remoteVisible` follows, but with the opposite polarity — the popup already
shipped on for everyone, so its safe default is *on*, not *off* (`!undefined`
being `true` is exactly the trap a naive `session.aiPopupEnabled` read falls
into). `TerminalContainer`'s full enable expression is therefore
`translationEnabled && !!originSessionId && aiPopupEnabled`.

This toggle is **terminal-only** — `ProjectTab`'s two `useSelectionPopup`
instances (inline markdown viewer + fullscreen) are unaffected and keep gating
only on `translationEnabled && !!originSessionId` plus their own edit/fullscreen
view-state flags.

## Quick settings (Model + Effort)

A row between the selection preview and the custom-prompt row lets the user
override which model (and, on Claude, effort level) the **next** spawn from
this popup launches with — any of the six buttons, not just custom. Blank
stays on the pre-existing default: inherit the origin session's own
`model`/`effortLevel`.

* **CLI-conditional.** `cli = detectCli(origin) ?? 'claude'` (same precedence
  the server's `resolveOriginCli` uses) decides what renders:
  * **Claude** — two `Combobox`es (`MODEL_OPTIONS` / `EFFORT_LEVELS` from
    `src/lib/remoteControlName.ts`), matching `NewSessionModal`'s own
    Model/Effort row.
  * **Codex** — one `Select` sourced from the live `GET /api/codex/models`
    catalog (fetched once per popup mount), matching `NewSessionModal`'s
    Codex model picker's `{value, label}` shape and its `Default (Codex
    recommended)` `placeholder` — but the resolved **default option's own
    label** is shortened here to `Default (<displayName>)` to fit the
    popup's narrower `quickSettingsModel` width, where `NewSessionModal`
    spells it out as `Default (Codex recommended: <displayName>)`. The
    `Select` itself renders only once the catalog resolves
    (`codexModelStatus === 'ready'`, a 4-state `'idle' | 'loading' | 'ready'
    | 'error'` machine); while loading or after a failed fetch, a disabled
    placeholder input shows `Loading Codex models…` / `Default (catalog
    unavailable)` instead, and the spawn falls through to the inherited
    origin model. The fetch is aborted (`AbortController`) on unmount or CLI
    change. Codex has no effort concept, so no second control renders.
* **Separate Claude/Codex model fields.** `selectionSpawnModel` (Claude) and
  `selectionSpawnCodexModel` (Codex) are kept apart in settingsStore — a
  single shared field would show a Claude alias like `sonnet` as the value
  in a Codex origin's picker (or vice versa) the next time the popup opens
  against the other CLI. Mirrors `SessionPrefs`'s existing
  `model`/`codexModel` split in `remoteControlName.ts`.
* **Persisted immediately on change**, like `explainAttachFilePath` — the
  choice is remembered across popups (and origin sessions) via
  `persistSetting`, not reset per-popup.
* **Server precedence.** `spawnFloatingSession` computes
  `effectiveModel = args.model || origin.model` and
  `effectiveEffort = args.effortLevel || origin.effortLevel` once, near the
  top — every downstream use (`applyClaudeLaunchFlags`, the `inherit` object
  written onto the popup's own session, the ultracode upgrade check, the log
  line) reads the effective value, not `origin.*` directly. An empty-string
  override (a blank Combobox) is falsy, so it correctly falls through to the
  inherited value rather than being treated as "explicitly chosen blank".

## In-app panel sizing

The in-app `FloatingTerminalPanel` defaults to `540×360`, has nominal minimums
of `360×220`, and keeps a `12px` margin from every renderer-viewport edge. Its
saved `float-terminal-pos:<terminalId>` and `float-terminal-size:<terminalId>`
values are treated as preferences, not guaranteed geometry: the component
constrains both dimensions and coordinates on initial render, browser/Electron
renderer resize, collapsed-pill expansion, and maximize restore. When the
viewport itself is narrower or shorter than a nominal minimum, the panel shrinks
to the available viewport (`viewport - 24px`) so content is not clipped off the
right or bottom edge.

`FloatingTerminalPanel.module.css` uses `box-sizing: border-box`, matching
`max-width`/`max-height` guards, and `min-width: 0` on the panel's flex children.
Once the shell changes size, `useTerminal`'s existing `ResizeObserver` runs the
xterm fit addon and forwards the resulting rows/columns to the PTY.

## Per-session popup scoping

Each float records the `originSessionId` of the main session that spawned it. A
popup **belongs to that session**: `FloatingTerminalRoot` renders only the floats
whose `originSessionId === selectedSessionId` (and renders none when no session is
selected). Switching sessions therefore hides the previous session's popups and
shows the new one's.

* **Hide = unmount, not CSS-hide.** A hidden float's panel unmounts, but the store
  keeps the entry and the **server PTY stays alive**. Switching back re-mounts it
  and `useTerminal.attach` replays the server buffer, so scrollback/state and the
  per-`terminalId` localStorage position/size/collapsed are restored intact.
* **Spawn-time visibility.** SelectionPopup only renders inside the selected
  session's detail surface, so at spawn time `originSessionId === selectedSessionId`
  — the new popup is immediately visible.

### Orphan prevention (a popup whose origin can never be selected would be invisible *and* leak its PTY)

| Path that could orphan a float | Guard |
|--------------------------------|-------|
| Origin session removed (`session_removed` WS event, covers the sidebar close round-trip) | `useWebSocket` calls `floatingSessionsStore.closeByOriginSession(id)` before `removeSession` — snapshots output, kills the PTY, drops the float. |
| Origin session re-keyed via `replacesId` (clone / fork / `--resume`) | `useWebSocket` calls `migrateOriginSession(oldId, newId)` alongside the queue/room migrations, re-pointing floats to the surviving id. |
| Workspace restore assigns the origin a **new** id | `importSnapshot` re-opens floats in a **second pass** (after `idRemap` is complete), mapping `originSessionId` through `idRemap` to the origin's new id. |
| Selective restore excludes a popup's origin session | `importSnapshot` drops fork popups whose origin isn't in the restore set **before** creating them — no orphan PTY is spawned. |
| Origin vanishes from a fresh WS `snapshot` (server-side prune during a disconnect — no `session_removed` fires) | `useWebSocket` calls `closeOrphans(new Set(snapshot ids))`, gated by `!isImportInProgress()` so an in-flight workspace restore (whose session set is intentionally partial) never kills valid popups. |
| `clearBrowserDb` wipes all sessions | `useWebSocket` calls `closeAll()` before clearing. (Suppressed during restore via `suppressBroadcast`.) |
| `MAX_FLOATS` (4) eviction drops the oldest popup | `open()` DELETEs the evicted PTY so it can't leak as a now-unmounted orphan. |

## Recursive fork

Selecting text **inside** a floating session and spawning a new popup forks from
that floating session — not the original root — so context chains down
(`root → A → B → …`). Two parent roles are kept **separate** to make this safe:

* **`originSessionId`** (the **root** session) — drives cwd/CLI detection and,
  client-side, **float-visibility scoping** (`FloatingTerminalRoot` renders only
  floats whose `originSessionId === selectedSessionId`). Every nested float keeps
  the root here, so it stays visible under the selected session and never becomes
  an invisible orphan.
* **`spawnTerminalId`** (the host terminal) — the **fork parent is resolved
  server-side**, not threaded as a session id from the client. `TerminalContainer`
  sends its own `terminalId` as `spawnTerminalId` (so a float sends its id, the
  main DetailPanel terminal sends the main terminal's id); `SelectionPopup`
  forwards it in the spawn POST. The server
  (`floatingSessionSpawner.spawnFloatingSession`) calls
  `getSessionByTerminalId(spawnTerminalId)` and forks from that session's
  `sessionId` (`--resume … --fork-session`), falling back to `originSessionId`
  when there's no host terminal (project-tab markdown selections) or it doesn't
  resolve. This keeps the fork-graph resolution in `sessionStore` rather than
  reconstructing it in a React component.

All modes inherit context when the setting is on and the parent has a
conversation, so recursive forking applies to every mode on Claude/Codex origins

## Pop-out to a native window

A floating terminal can be **popped out** into its own window (the header
`DetachIcon` button, **always rendered**) so it can be dragged to another
monitor — a DOM panel can't leave the app window. The button used to
render as a raw `⧉` Unicode glyph; it now renders `DetachIcon`
(`src/components/ui/DetachIcon.tsx`, `size={12}`) — the same window-with-
escaping-arrow SVG the PROJECT and SESSION popout buttons use (see [Session
detail panel → Pop-out to a native window](./session-detail-panel.md#pop-out-to-a-native-window)),
extracted to a shared component so a third copy was never hand-rolled.
`TerminalToolbar`'s own `PopOutIcon` (main TERMINAL/COMMANDS tabs, see the
callout below) is a **separate, unchanged** icon component — the two happen
to serve the same action but were never the same code.

Its tooltip is now also registered (`tooltips.floatTerminalPopOut` in
`src/lib/tooltips.ts`, spread via `{...tooltips.floatTerminalPopOut}` exactly
like PROJECT's `tooltips.floatProject` and the main terminal's
`tooltips.termPopOut`), following the same "Detach ___ into its own window"
label + description shape. It used to be an ad-hoc inline `label="Pop out to
a window (drag to another monitor)"` with no `description` line — functionally
identical, but the one pop-out tooltip in the app that wasn't wired through
the shared registry, and visibly less polished than PROJECT's (bold title +
description) side by side.

> **Reused by the main TERMINAL and COMMANDS tabs.** The same machinery
> (`openTerminalWindow` → `PopoutTerminalView` via `?popout=terminal` →
> `popout:closed` re-dock) now also backs the `⧉` pop-out on the main terminal
> and the COMMANDS (ops) terminal in `DetailPanel`. Those use the **same**
> `floatingSessionsStore.poppedOut` list and the `FloatingTerminalRoot`
> `popout:closed` listener, but render a `PoppedOutTerminalPlaceholder` in the
> detail panel (not a hidden float) while out — and, like this float's own
> button, the `⧉` is **always rendered** (no more Electron-only gate) with the
> exact same three-way branch, sharing the browser-fallback half via
> `openTerminalPopupFallback` (`src/lib/popoutTerminalWindow.ts`) so the two
> `DetailPanel` call sites and this float's own never drift on sizing. See
> [Session detail panel →
> Pop-out to a native window](./session-detail-panel.md#pop-out-to-a-native-window).

* **Trigger.** `handlePopOut` delegates to
  [`openFloatWindow`](../../../src/lib/popoutTerminalWindow.ts), which owns the
  three-way branch (it is shared with `SelectionPopup`'s spawn path — see
  [Spawning straight into a window](#spawning-straight-into-a-window) — so the
  platform rules cannot drift between "detach an existing panel" and "open a new
  session directly"). It mirrors `DetailTabs`'s `openProjectWindow` exactly:
  (1) `electronAPI.openTerminalWindow` present → calls it with
  `{ terminalId, originSessionId, label }` and, on success, marks
  the float `poppedOut` in `floatingSessionsStore` — `FloatingTerminalRoot` then
  **hides** the in-app panel (the float entry + server PTY stay alive), so the
  popout window becomes the **sole WS subscriber**, no two-subscriber
  contention; (2) `electronAPI` present but missing `openTerminalWindow` (stale
  preload) → returns `{ placed: 'docked', reason: 'stale-preload' }`, same
  reasoning as `openProjectWindow` (falling through to
  `window.open` under Electron would pop the system browser open on
  localhost); (3) no `electronAPI` at all (browser tab) → delegates to
  [`openTerminalPopupFallback`](../../../src/lib/popoutTerminalWindow.ts) (a
  small shared helper, also used by `DetailPanel`'s two `handlePopOut`s — see
  the callout below), which `window.open`s the same `?popout=terminal&terminalId=…`
  URL Electron loads, with a `popup,width=…,height=…` features string that
  forces a real detached window rather than a new tab, and a deterministic
  window `name` so a second click focuses it instead of duplicating it. That
  helper returns the `Window | null` handle so a **blocked popup** is
  distinguishable from a successful open (`{ placed: 'docked', reason:
  'popup-blocked' }`) rather than failing silently. For `handlePopOut`
  specifically a `docked` outcome simply means "stay put" — the panel is already
  on screen — but see the spawn path below, where it is load-bearing. Branch
  3 has no reliable "window closed" signal back
  to the opener the way Electron's `popout:closed` IPC does, so unlike branch 1
  it does **not** hide the in-app panel — the float and the browser popup
  simply coexist as two live subscribers, which `wsClients: Set<WebSocket>`
  (see [WebSocket manager](../server/websocket-manager.md)) already supports
  safely. The button itself is **always rendered** — there is no
  Electron-only visibility gate — so branch 3 is reachable at all.
* **The window.** `electron/main.ts` `registerPopoutHandler` creates a
  `BrowserWindow` (820×560, same `webPreferences`/reload-block/`setWindowOpenHandler`
  as the main window) loading `http://localhost:${port}/?popout=terminal&terminalId=…`.
  It's tracked per `terminalId` (re-focused instead of duplicated).
* **Monitor placement.** `computePopoutBounds('terminal')` (main process) sets the
  window's `x`/`y` so a fresh popout opens on a **second monitor** when one exists
  (centered on the first non-primary display, else the display under the cursor).
  The bounds are remembered across opens — saved to `popout-bounds.json` under the
  `'terminal'` key on `moved`/`resized` and restored next time (validated against
  connected displays so an unplugged monitor falls back to auto-placement). **This
  key is exclusive to terminal floats** (fixed Aug 2026) — before that, ONE shared
  slot was read/written by all four popout kinds (terminal, project, session,
  internal), so resizing or maximizing the content-heavy Project Browser or
  whole-session popout permanently oversized every later terminal float, even a
  one-line Explain/Translate prompt opening at whatever huge size a file browser
  was last left at. See `electron/popoutBounds.ts` and [App lifecycle](../electron/app-lifecycle.md).
* **The renderer.** `src/main.tsx` detects `?popout=terminal` and renders
  `PopoutTerminalView` (its own `useWebSocket` + `useSettingsInit` + one
  `TerminalContainer` attached to the existing PTY by id) **instead of** the full
  dashboard. It sets `document.title = label` rather than drawing its own
  in-page title strip — the native/browser-popup window chrome already shows a
  title, so an in-page one only duplicated it (and, unlike Electron's
  `BrowserWindow` `title` option, a `window.open` popup has no other way to get
  a real one). Matches `PopoutProjectView`, which has never drawn an in-page
  title for the same reason.
* **Re-dock.** When the native window closes, `main.ts` sends `popout:closed`
  (terminalId) to the main window; `FloatingTerminalRoot` (via
  `electronAPI.onPopoutClosed`) clears `poppedOut`, re-mounting the in-app panel,
  which re-attaches and replays the PTY buffer. The session is only ended by the
  in-app float's ✕. **Electron only** — a browser-popup fallback (branch 3
  above) has no equivalent close signal, so its float is never hidden in the
  first place and there is nothing to re-dock.

**Limitations:** Nested floats
spawned from inside a popout window aren't rendered (the popout hosts a single
terminal). The browser-popup fallback (branch 3) has no re-dock signal, so its
originating float stays visible and subscribed for as long as the popup is open
— by design, not a bug (see Trigger, above).

## Spawning straight into a window

Clicking Explain / Translate / a custom prompt in `SelectionPopup` lands the new
session **directly in a real OS window**, skipping the in-app panel entirely.
Previously the spawn always docked, and reaching a second monitor took a second
manual click on the panel's `⧉` detach button.

`SelectionPopup.spawn()` calls the same
[`openFloatWindow`](../../../src/lib/popoutTerminalWindow.ts) as `handlePopOut`
(one branch point, so the two can never diverge), then:

* `{ placed: 'window' }` → `setPoppedOut(terminalId, true)`. **This must be set
  even though no panel ever mounted** — it is what keeps the popout the sole WS
  subscriber and what `FloatingTerminalRoot` reads to stay out of the way.
* `{ placed: 'docked', … }` → falls back to `openFloat()`, i.e. the classic
  in-app panel, plus a toast for the two user-actionable reasons
  (`stale-preload` → restart the app; `popup-blocked` → allow popups).

> **The docked fallback is not politeness — it is orphan prevention.** The
> session is created **server-side by `POST /api/sessions/spawn-floating` before
> any window exists**. If the window can't be opened and the caller does nothing,
> the result is a live forked CLI session holding a WebSocket subscription with
> **no UI attached to it** — invisible, and unclosable from the dashboard. This
> is the same class of hazard as [Orphan
> prevention](#orphan-prevention-a-popup-whose-origin-can-never-be-selected-would-be-invisible-and-leak-its-pty)
> above, reached by a different route. It is also why `openFloatWindow` **resolves**
> on a rejected IPC call instead of throwing: a throw would escape into
> `spawn()`'s `catch`, be shown as a spawn *error*, and the user would retry —
> creating a **second** live session.

Controlled by `settingsStore.selectionSpawnTarget` (`'window'` default |
`'docked'`), persisted to Dexie like the other `selectionSpawn*` keys and exposed
as **Settings ▸ TRANSLATION ▸ "Where the result opens"**. Choosing `'docked'`
restores the old always-dock behaviour; `'window'` still falls back to docking
when no window can be opened.

Covered by `src/lib/popoutTerminalWindow.test.ts` (all three branches, plus the
blocked-popup and rejected-IPC fallbacks).

### Preopening — why the browser popup didn't reliably survive its own spawn

**Fixed Aug 2026.** In the plain-browser branch, `'popup-blocked'` used to fire
close to *every* spawn, not as a rare edge case. `spawn()` did `await
fetch('/api/sessions/spawn-floating')` — a real network round trip, forking a
CLI session server-side — **before** its only `window.open()` call, since the
URL needs the `terminalId` that fetch returns. By the time it resolved,
Chrome's transient activation (the short window in which a `window.open()` is
still trusted as user-initiated) had already expired, so the popup reliably got
blocked and the toast fired on the ordinary path, not just flaky networks.

The fix is the standard workaround: [`preopenTerminalPopup()`](../../../src/lib/popoutTerminalWindow.ts)
opens a placeholder window **synchronously**, as the first thing inside
`spawn()`'s body — still within the click's call stack even though `spawn` is
`async`, because everything up to its first `await` runs synchronously in the
same task as the triggering event. The placeholder loads a `data:` URL (a tiny
inline "Starting session…" page matching the app's light theme) rather than a
real route — a `data:` URL renders with no network round trip, so there's never
a flash of true blank-white while the spawn is still in flight, and unlike a
real route it can't itself fail to load. Once the spawn resolves,
`openFloatWindow`'s new `preopened` param **navigates that same window**
(`.location.href = …`) instead of calling `window.open()` a second time —
setting `.location` on a window reference you already hold is not subject to
the popup-blocking gate, only `window.open()` itself is, which is the entire
point.

Three rules hold this up:

1. **Skipped when `spawnTarget === 'docked'`** — no reason to flash a
   placeholder open only to abandon it when the user has chosen to always dock.
2. **Every path that doesn't consume the preopened window must close it, or a
   failed/redirected spawn strands a "Starting session…" tab forever.**
   `openFloatWindow` closes it in the Electron IPC-success and stale-preload
   branches (the real window there comes from somewhere else, or doesn't exist
   at all); `spawn()`'s own `catch` closes it if the fetch itself throws.
3. **A closed-or-never-given preopened window falls through to the ORIGINAL
   fresh `window.open()` call**, unchanged from before this fix — so the
   graceful docked-fallback behavior above still holds exactly as documented;
   this only removes the structural, every-time cause, not the residual
   possibility of a real site-level "always block popups" setting.

Also harmless under Electron: `attachWindowOpenPolicy` intercepts `window.open`,
and a `data:` URL matches neither "our own origin" nor "http/https external" —
the same "everything else — dropped" bucket as `ms-msdt:`/`file:`/`javascript:`
— so the call either returns `null` or a non-functional handle, and
`openFloatWindow`'s Electron branches close/ignore it either way. (Unexercised
until Sep 2026: with the preload missing, Electron always took branch 3 — see
below.)

Covered by `src/lib/popoutTerminalWindow.test.ts` (preopen geometry/naming, the
navigate-vs-fresh-open branch, close-on-every-non-consuming-path) and
`src/components/translate/SelectionPopup.test.tsx` (asserts `window.open` fires
**synchronously, before the spawn fetch resolves** — the actual claim the fix
rests on; verified to fail — 3 of 4 new tests red — against a version with the
preopen call removed).

### Why one spawn opened a blank native window *and* a docked panel (fixed Sep 2026)

The screenshot that kept coming back: one Explain/Translate/Vocab spawn produced
a native window whose terminal stayed blank (toolbar and cursor, no output), the
docked in-app panel for the same session, and the toast "Popup blocked — opened
in-app instead". Two independent bugs combined:

1. **The Electron preload never loaded** ([App Lifecycle → Build Configuration](../electron/app-lifecycle.md#build-configuration)).
   With `window.electronAPI` undefined, `openFloatWindow` took branch 3 (plain
   browser). `attachWindowOpenPolicy` caught its `window.open('/?popout=terminal…')`
   and opened a real native window via `openInternalWindow()`, but the handler
   returns `deny`, so the renderer got `null` → `{ placed: 'docked', reason:
   'popup-blocked' }` → `openDocked()` + the toast. With the preload loading,
   spawns take branch 1 (`window:open-terminal`) and nothing docks. The Sep 16
   change to branch 3's `catch` was correct but was never on this path.
2. **The pop-out never subscribed to its PTY**: `memo(TerminalContainer)`
   swallowed the re-render that follows the socket opening. See
   [Terminal UI → Blank pop-out terminal](./terminal-ui.md#blank-pop-out-terminal-a-websocket-reference-identity-race-not-a-layout-bug).

With both fixed, closing the native window re-docks the session into the in-app
panel via `popout:closed` (branch 1's behaviour, described above); ✕ on that
panel ends the session.

## Cross-Feature Dependencies

| Connected feature | Why |
|-------------------|-----|
| [Session matching](../server/session-matching.md) | Floating sessions are spawned via the same `createTerminal + pendingLink` path as fork/clone. |
| [Terminal/SSH](../server/terminal-ssh.md) | Float pty registration goes through `sshManager.createTerminal`. |
| [Session detail panel](./session-detail-panel.md) | DetailPanel passes `originSessionId` into TerminalContainer. |
| [Project browser](./project-browser.md) | ProjectTab markdown viewer is the second translatable surface. |
| [UI primitives](./ui-primitives.md) | Popup/toolbar buttons use the shared `Tooltip` + `tooltips` registry: `selExplainLearning`, `selExplainNative`, `selVocabNative`, `selTranslateLearning`, `selTranslateNative`, `selCustomPrompt`, `floatTerminalClose`. The quick-settings row reuses `Combobox` and `Select` (both `src/components/ui/`), the same components `NewSessionModal` uses for its own Model/Effort fields. |
| [Command Autocomplete](./command-autocomplete.md) | The custom-prompt row is an `AutocompleteTextarea`, not a plain `<textarea>` — `/` commands, `$` Codex skills (session-CLI-gated), and `@` files (via `origin.projectPath`), same as the Queue compose box. |
| [Terminal UI](./terminal-ui.md) | TerminalContainer mounts the popup and re-attaches/replays the PTY buffer on re-dock. |
| [Conversation view](./conversation-view.md) | Shares `extractPreviousAnswer.ts` — `readClaudeTranscript` backs the CONVERSATION tab; `readClaudeLastAssistant` backs `translate-answer`. |
| [REVIEW tab](./review-tab.md) | Each spawn writes a draft via `createLog`; the response is captured via `captureResponse` — periodically while the float is open (every 6s), on `beforeunload`, and on close — through the idempotent `captureNow`, so a restart/reload with a popup open no longer loses the answer. |
| [Session management](../server/session-management.md) | Float visibility is keyed to `sessionStore.selectedSessionId`; removal/re-key cleanup is wired in `useWebSocket` next to the queue/room migrations. |
| [Workspace snapshot](./workspace-snapshot.md) | `importSnapshot` re-links popups to the origin's new id via `idRemap` and drops popups whose origin isn't restored. |
| [IPC transport](../electron/ipc-transport.md) | Pop-out uses the `window:open-terminal` IPC + `popout:closed` event bridged in `preload.ts`. |

## Change Risks

* **The whole feature depends on xterm drag-selection staying possible.**
  Claude Code ≥ 2.1.150's fullscreen renderer captures the mouse (DECSET
  1000/1002/1003/1006), which silently disables xterm selections — no selection,
  no SelectionPopup, no AI popup. Dashboard-spawned PTYs therefore set
  `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` (see
  [Terminal/SSH → Environment](../server/terminal-ssh.md)); `macOptionClickForcesSelection`
  (⌥-drag) is the fallback for TUIs that still capture the mouse. Don't remove
  either guard.
* **Origin session must exist server-side.** The endpoint requires a live
  `Session` (`getSession(originSessionId)`). The standalone Project Browser
  route resolves an origin by matching `?path=` against live sessions'
  `projectPath` (see [Project browser](./project-browser.md)); floats are
  disabled there only when **no** session matches that path, and which
  session gets picked is non-deterministic when several share the directory.
* **`translate-answer` only supports Claude origins.** The spawner reads the
  previous answer only when `resolveOriginCli(origin) === 'claude'` and returns a
  400 otherwise (only the Claude transcript reader exists). It currently has **no
  UI trigger**, so this is reachable only via a direct API call.
* **Prompts are passed as shell-quoted positional args.** Very large markdown
  files may approach `ARG_MAX`; the spawner enforces `MAX_PROMPT_BYTES = 256 KB`,
  and the endpoint Zod schema caps `fileContent` at 256 KB / `filePath` at 2048 chars.
* **Floats share their PTY lifecycle** — closing the window kills the pty via
  `DELETE /api/terminals/:id`. The origin session is unaffected.
* **Popups are scoped to their origin session** (`originSessionId === selectedSessionId`).
  A float whose origin can never be selected would be invisible *and* leak its PTY,
  so any new path that removes/re-keys a session, or restores floats, must keep the
  origin reachable — see [Orphan prevention](#orphan-prevention-a-popup-whose-origin-can-never-be-selected-would-be-invisible-and-leak-its-pty). When adding such a path, route it through
  `closeByOriginSession` / `migrateOriginSession` or the `idRemap` re-link.
* **Settings shape changed** (`translationEnabled`, etc.) — exported settings
  files from older versions still load, but new fields fall back to defaults.
* **`AutocompleteTextarea`'s dropdown must stay portaled to `document.body`.**
  `.popup` sets `backdrop-filter: blur(8px)`, which (confirmed empirically,
  not assumed) establishes a CSS containing block for `position: fixed`
  descendants in this Chromium build — an un-portaled dropdown's
  `getBoundingClientRect()`-based math would be re-scoped to `.popup`'s own
  box instead of the true viewport, landing roughly the popup's own
  on-screen offset away from the textarea. Reverting the portal (in
  `AutocompleteTextarea.tsx`, shared with the Queue compose box) reintroduces
  this the moment any consumer nests it inside a `filter`/`backdrop-filter`/
  `transform`/`will-change` ancestor — its two other homes (`QueueTab`,
  `QueueItemEditModal`) have none today, so the bug is latent there too, not
  exclusive to this popup.
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
* Codex transcript readers for `translate-answer`.
* SSH-origin floats (today the spawner reuses the SSH config but has not been
  exercised end-to-end in remote scenarios).
* Bracketed-paste path for prompts > 256 KB.

## REVIEW Tab (persistence)
Every spawn writes a draft entry to the `translationLogs` Dexie table; the
response is captured periodically while the float is open (a `setInterval` every
6s in `FloatingTerminalRoot`), on window `beforeunload`, on a final flush when the
float set changes / the root unmounts, and on close — all routed through the
idempotent `floatingSessionsStore.captureNow(terminalId)` (overwrite keyed by
`terminalId`), so a restart/reload with a popup open no longer loses the answer.
Browse, search, archive, and annotate entries via the [REVIEW Tab](./review-tab.md).
