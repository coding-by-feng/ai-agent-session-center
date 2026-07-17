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
| `src/components/translate/SelectionPopup.tsx` | Floating toolbar at the selection: three icon rows (row 1 Explain ×2, row 2 Translate ×2, row 3 Vocabulary ×1) + a read-only **selection preview** + an inline **"Attach file path?" confirm** (explain modes only) + a **custom-prompt row** (textarea + Run). The preview mirrors the captured selection text because focusing the textarea collapses the browser's native selection highlight — without it the user thinks the selection was lost (the string is still held in `active.selection` and sent on spawn). |
| `server/floatingPrompt.ts` | **Pure** prompt synthesis + window labels (`buildPrompt`, `floatLabel`, `customFloatLabel`, `MAX_PROMPT_BYTES`, `FloatingMode`/`SpawnFloatingArgs` types). Extracted from the spawner so it's unit-testable without the db/pty graph (no better-sqlite3). |
| `src/styles/modules/SelectionPopup.module.css` | Popup styling — theme-aware via CSS variables (no hardcoded colours). |
| `src/hooks/useSelectionPopup.ts` | Surface-agnostic selection-watcher hook (`auto`/`alt`/`off` triggers; mouseup + click-outside + Esc to dismiss; `open()` for programmatic show). Opens **only on a real selection gesture** — a drag past `CLICK_DRAG_THRESHOLD_PX` (4px) or a double/triple-click — and skips editable fields (`input`/`textarea`). A bare click never opens it: the Claude Code TUI captures mouse events so xterm keeps a **stale** selection after a click, and without this guard clicking into the terminal input re-opened the modes popup on the previous selection. |
| `src/lib/selectionExtractors.ts` | Strategies: `extractDomSelection` (markdown) and `extractXtermSelection` (terminals). Selection capped at `MAX_SELECTION = 4000`, context line at `MAX_CONTEXT_LINE = 400`. |
| `src/lib/cliDetect.ts` | `detectCli(session)` → `'claude' | 'gemini' | 'codex' | null`. The **canonical client CLI detector**; the server's `resolveOriginCli` (`floatingSessionSpawner.ts`) deliberately mirrors its precedence (cliSource → command → model) to avoid backend/frontend divergence. |
| `src/lib/translationLog.ts` | Dexie helpers `createLog` (draft on spawn) / `captureResponse` (called periodically while the float is open — every 6s — plus on `beforeunload` and on close, keyed/overwritten by `terminalId` so it's idempotent) feeding the REVIEW tab. |
| `src/components/session/FloatingTerminalPanel.tsx` | Picture-in-picture window hosting one TerminalContainer. Forwards its **`originSessionId`** prop (the **root** session) to TerminalContainer so the float's translate/explain lookups resolve a real session **and float-visibility scoping keeps nested floats visible under the selected root** (never orphaned). Recursive fork is handled server-side: the inner `TerminalContainer` sends this float's `terminalId` as `spawnTerminalId`, and the server resolves *its* session as the fork parent. Also hosts the **⧉ pop-out** button (Electron) and rebindable hotkeys (`floatMinimize`/`floatMaximize`/`floatClose`). See [Recursive fork](#recursive-fork). |
| `src/styles/modules/FloatingTerminalPanel.module.css` | Window styling (drag, resize, collapse, popout chrome) — theme-aware via CSS variables (icons/chrome recolour per theme). |
| `src/components/session/FloatingTerminalRoot.tsx` | Renders the open floats **belonging to the currently selected session** (`originSessionId === selectedSessionId`), excluding any that are **popped out** into a native window. Mounted once in AppLayout. Listens for `popout:closed` to re-dock. See [Per-session scoping](#per-session-popup-scoping). |
| `src/components/session/PopoutTerminalView.tsx` | The **entire renderer** when the window is a popped-out float (`/?popout=terminal&terminalId=…`). Sets up its own `useWebSocket(null)` + `useSettingsInit` and hosts one `TerminalContainer` attached to the existing PTY by id, plus its own `<FileOpenChooser>` mount (separate React root from AppLayout, so the popover for terminal file-path clicks needs a local mount). Auth tokens are *not* carried in (localhost Electron only). |
| `src/styles/modules/PopoutTerminalView.module.css` | Layout for the popout window (titlebar + full-height terminal body). |
| `src/stores/floatingSessionsStore.ts` | Zustand store holding open floats; capped at `MAX_FLOATS = 4` (`open` **DELETEs the evicted PTY** so it doesn't leak). Adds `closeByOriginSession(id)`, `migrateOriginSession(oldId, newId)`, `closeOrphans(liveIds)`, `captureNow(terminalId)`, and the `poppedOut: string[]` list + `setPoppedOut(id, on)`. `captureNow(terminalId)` GETs `/api/terminals/:id/output` and snapshots the PTY output (base64 → UTF-8 via `TextDecoder`) into the REVIEW log via `captureResponse` **without killing the PTY** — idempotent/pollable (overwrite keyed by `terminalId`). `close()` delegates to `captureNow()` to take a final snapshot before it DELETEs the PTY. |
| `src/components/settings/TranslationSettings.tsx` | Settings tab for native/learning languages, inherit-context toggle, explain attach-file-path policy, and trigger mode. |
| `server/floatingSessionSpawner.ts` | Server-side: resolve origin + fork parent (via `spawnTerminalId`), detect CLI, build the launch/fork command (Claude `--resume … --fork-session` / `--continue --fork-session`; Codex `fork`/`fork --last`), apply permission + model/effort launch flags, create the PTY, and write the command. Forwards the origin's model/effort/characterModel onto the popup session; injects `/effort ultracode` post-launch when the origin is on ultracode. |
| `server/extractPreviousAnswer.ts` | Claude transcript reader: `readClaudeLastAssistant` (used by `translate-answer`) and `readClaudeTranscript` (used by the CONVERSATION tab — see [conversation-view](./conversation-view.md)). |

Wired surfaces:

| File | Wiring |
|------|--------|
| `src/components/terminal/TerminalContainer.tsx` | Mounts the popup using `extractXtermSelection` (sends its own `terminalId` as `spawnTerminalId`). Accepts the `originSessionId` prop. |
| `src/components/session/ProjectTab.tsx` | Mounts the popup with `extractDomSelection` on `markdownRef` (and `markdownFsRef` for fullscreen). Markdown selections have **no** `spawnTerminalId`, so they fork from the root. |
| `src/components/session/ProjectTabContainer.tsx` | Threads `sessionId` → `originSessionId` to `ProjectTab`. |
| `src/components/session/DetailPanel.tsx` | Threads `sessionId` → `originSessionId` to `TerminalContainer`. |
| `src/main.tsx` | Detects `?popout=terminal` and renders `PopoutTerminalView` instead of the full dashboard. |
| `electron/main.ts` | `registerPopoutHandler` (`window:open-terminal` IPC) opens the popout `BrowserWindow` (820×560, min 480×320) and sends `popout:closed` on close. |
| `electron/preload.ts` | Bridges `openTerminalWindow` (→ `window:open-terminal`) and `onPopoutClosed`. |
| `src/stores/settingsStore.ts` | `translationEnabled / translationNativeLanguage / translationLearningLanguage / translationTrigger / translationInheritContext / explainAttachFilePath` (+ setters; persisted via `persistSetting`). |

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
     learningLanguage, inheritContext? }
        │
        ▼
server/floatingSessionSpawner.ts
   resolves CLI kind (claude | codex | gemini) via resolveOriginCli(origin):
     cliSource (authoritative) → command → model → 'claude' — so a codex/gemini
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
— and throws a 400 if none is found, so a Codex/Gemini origin always fails. This
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
prefers the authoritative `origin.cliSource` (set by the codex/gemini hooks'
`cli_source`, or `inferCliSource`), then the launch command, then the model id,
defaulting to `claude` only when nothing matches. This ensures the popup runs the
**same CLI as its parent** — a Codex/Gemini parent no longer mis-spawns `claude`
(which previously also leaked the parent's model onto the launch, e.g.
`claude --model gpt-5.5`, because the Claude-only flag helper saw a `claude`
command):

* `claude '...'` (positional prompt)
* `codex '...'` (positional prompt)
* `gemini -p '...'` (`-p` flag)

When `inheritContext !== false` (the per-request flag, defaulting to the
`translationInheritContext` setting which is **on** by default) **and** the fork
parent is a Claude/Codex session **and** that parent has at least one prompt in
its history, the spawner switches from a fresh launch to a CLI-native fork:

* `claude --resume '<SESSION_ID>' --fork-session '<prompt>'`, or `claude --continue --fork-session '<prompt>'` when the parent id is an internal `term-…` placeholder.
* `codex fork '<SESSION_ID>' '<prompt>'`, or `codex fork --last '<prompt>'`.

A brand-new parent with no prompts has no transcript, so `--resume … --fork-session`
would fail with "No conversation found"; the spawner detects this
(`parentHasConversation`) and falls back to a fresh launch (the popup prompt is
self-contained anyway). Gemini has no fork support and always launches fresh.

Prompts are shell-escaped (single-quote wrapping) and capped at
`MAX_PROMPT_BYTES = 256 KB` (256 × 1024) to stay well under typical `ARG_MAX`;
the spawn endpoint's Zod schema independently caps `fileContent` at 256 KB and
`filePath` at 2048 chars.

## Configuration

`Settings → Translation` (all persisted via `settingsStore.persistSetting`):

* **Enable translation popup** (`translationEnabled`) — master toggle. Default: on.
* **Native language** (`translationNativeLanguage`) — target for translations / native-language explanations. Default: `简体中文`.
* **Learning language** (`translationLearningLanguage`) — target for "deeper" same-language explanation and translate-to-learning. Default: `English`.
* **Inherit conversation context for AI popups** (`translationInheritContext`) — when enabled, popup modes fork the origin Claude/Codex session via the CLI's native fork command (when the parent has a conversation), so the AI grounds its answer in the prior conversation. No effect for Gemini origins (no fork support). Default: on. Sent as the per-request `inheritContext` flag.
* **Attach file path (explain)** (`explainAttachFilePath`) — `ask` / `always` / `never`. When an Explain mode runs on a selection inside an open file, optionally include that file's path in the prompt. `ask` prompts once via the inline confirm and then remembers the choice. Default: `ask`. Only applies in the file viewer.
* **Trigger** (`translationTrigger`) — `auto` (every selection) / `alt` (require ⌥ held) / `off` (labelled **Disabled** in the UI). Since the popup is the only client trigger, `off` disables the feature's whole UI surface.

No API key field exists — the feature is auth-free.

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
(Gemini stays fresh).

## Pop-out to a native window (Electron)

A floating terminal can be **popped out** into its own native OS window (the ⧉
header button, shown only under Electron) so it can be dragged to another
monitor — a DOM panel can't leave the app window.

> **Reused by the main TERMINAL and COMMANDS tabs.** The same machinery
> (`openTerminalWindow` → `PopoutTerminalView` via `?popout=terminal` →
> `popout:closed` re-dock) now also backs the `⧉` pop-out on the main terminal
> and the COMMANDS (ops) terminal in `DetailPanel`. Those use the **same**
> `floatingSessionsStore.poppedOut` list and the `FloatingTerminalRoot`
> `popout:closed` listener, but render a `PoppedOutTerminalPlaceholder` in the
> detail panel (not a hidden float) while out. See [Session detail panel →
> Pop-out to a native window](./session-detail-panel.md#pop-out-to-a-native-window).

* **Trigger.** `FloatingTerminalPanel` calls `electronAPI.openTerminalWindow({
  terminalId, originSessionId, label })` and, on success, marks the float
  `poppedOut` in `floatingSessionsStore`. `FloatingTerminalRoot` then **hides**
  the in-app panel (the float entry + server PTY stay alive), so the popout
  window becomes the **sole WS subscriber** — no two-subscriber contention.
* **The window.** `electron/main.ts` `registerPopoutHandler` creates a
  `BrowserWindow` (820×560, same `webPreferences`/reload-block/`setWindowOpenHandler`
  as the main window) loading `http://localhost:${port}/?popout=terminal&terminalId=…`.
  It's tracked per `terminalId` (re-focused instead of duplicated).
* **Monitor placement.** `computePopoutBounds()` (main process) sets the window's
  `x`/`y` so a fresh popout opens on a **second monitor** when one exists (centered
  on the first non-primary display, else the display under the cursor). The bounds
  are remembered across opens — saved to `popout-bounds.json` on `moved`/`resized`
  and restored next time (validated against connected displays so an unplugged
  monitor falls back to auto-placement). See [App lifecycle](../electron/app-lifecycle.md).
* **The renderer.** `src/main.tsx` detects `?popout=terminal` and renders
  `PopoutTerminalView` (its own `useWebSocket` + `useSettingsInit` + one
  `TerminalContainer` attached to the existing PTY by id) **instead of** the full
  dashboard.
* **Re-dock.** When the native window closes, `main.ts` sends `popout:closed`
  (terminalId) to the main window; `FloatingTerminalRoot` (via
  `electronAPI.onPopoutClosed`) clears `poppedOut`, re-mounting the in-app panel,
  which re-attaches and replays the PTY buffer. The session is only ended by the
  in-app float's ✕.

**Limitations:** Electron only (the button is hidden in the browser). Auth tokens
aren't carried into the popout window, so password-protected setups would need
token plumbing. Nested floats spawned from inside a popout window aren't rendered
(the popout hosts a single terminal).

## Cross-Feature Dependencies

| Connected feature | Why |
|-------------------|-----|
| [Session matching](../server/session-matching.md) | Floating sessions are spawned via the same `createTerminal + pendingLink` path as fork/clone. |
| [Terminal/SSH](../server/terminal-ssh.md) | Float pty registration goes through `sshManager.createTerminal`. |
| [Session detail panel](./session-detail-panel.md) | DetailPanel passes `originSessionId` into TerminalContainer. |
| [Project browser](./project-browser.md) | ProjectTab markdown viewer is the second translatable surface. |
| [UI primitives](./ui-primitives.md) | Popup/toolbar buttons use the shared `Tooltip` + `tooltips` registry: `selExplainLearning`, `selExplainNative`, `selVocabNative`, `selTranslateLearning`, `selTranslateNative`, `selCustomPrompt`, `floatTerminalClose`. |
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
  `Session` (`getSession(originSessionId)`); standalone Project Browser route
  has no session, so floats are disabled there.
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
response is captured periodically while the float is open (a `setInterval` every
6s in `FloatingTerminalRoot`), on window `beforeunload`, on a final flush when the
float set changes / the root unmounts, and on close — all routed through the
idempotent `floatingSessionsStore.captureNow(terminalId)` (overwrite keyed by
`terminalId`), so a restart/reload with a popup open no longer loses the answer.
Browse, search, archive, and annotate entries via the [REVIEW Tab](./review-tab.md).
