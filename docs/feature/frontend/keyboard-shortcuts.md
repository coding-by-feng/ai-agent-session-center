# Keyboard Shortcuts System

## Function
Global keyboard shortcut handling with rebindable keys, context-aware suppression, and conflict detection.

## Purpose
Power user efficiency — quick navigation, session control, and modal toggling without mouse.

## Source Files
| File | Role |
|------|------|
| `src/hooks/useKeyboardShortcuts.ts` | Global keydown handler + `dispatchAction` routing + session-switch helpers |
| `src/stores/shortcutStore.ts` | Zustand store: bindings, rebind/reset, conflict + event lookup, IndexedDB persistence |
| `src/lib/shortcutKeys.ts` (~10KB) | `DEFAULTS`, `ACTION_IDS`, `SECTION_ORDER`, `buildBindings`, KeyCombo utilities |
| `src/types/shortcut.ts` | `KeyCombo`, `ShortcutActionId` (37 ids), `ShortcutBinding` types |
| `src/components/modals/ShortcutsPanel.tsx` | Read-only reference overlay (`shortcuts` modal), opened from the `?` button in `Header`'s icon cluster (moved there from NavBar) or the `?` key |
| `src/components/modals/ShortcutSettingsModal.tsx` | Standalone rebind/reset modal (`shortcut-settings` modal, mounted in App.tsx) |
| `src/components/settings/ShortcutSettings.tsx` | Embedded rebind/reset UI for the Settings panel's Shortcuts tab |
| `src/components/modals/ShortcutRow.tsx` | Shared row: label, clickable `<kbd>`, reset button (used by both editors) |
| `src/hooks/useSessionSwitchHold.ts` | Cmd/Ctrl+E hold-to-cycle session switcher — independent keydown/keyup/blur/visibilitychange listeners, NOT part of the ACTION_IDS/dispatchAction table |
| `src/components/modals/SessionSwitchOverlay.tsx` | The popup UI for the hold-to-cycle switcher (`useSessionSwitchHold` consumer, mounted unconditionally in App.tsx) |
| `src/components/modals/SessionJumpOverlay.tsx` | The "go to session #" box opened by `jumpToSession` (Alt+⌘+0): type a badge number to switch; mounted unconditionally in App.tsx, visibility in `uiStore.sessionJumpOpen` |
| `src/lib/sessionJump.ts` | `resolveJumpInput` (pure: what typed digits point at, and whether more digits could change that) and `jumpToSessionNumber` (the switch path shared with Alt+⌘+1…9) |

## Implementation
- Hardcoded shortcuts in useKeyboardShortcuts.ts (not rebindable): Cmd/Ctrl+Shift+F (global search toggle — `global-search` modal), Cmd/Ctrl+F (find-in-file when a session is selected — dispatches `projectTab:findInFile`; falls through to native browser find when no session), Escape (close modal, else skip if xterm focused), `[` (previous session, only when a session is selected and not typing), `]` (jump to latest finished session)
- **Cmd/Ctrl+E hold-to-cycle session switcher** (`useSessionSwitchHold.ts` + `SessionSwitchOverlay.tsx`, added Sep 2026) — NOT part of the ACTION_IDS table below, and not rebindable. Hold Cmd (macOS) / Ctrl (other), tap E to open a popup listing every other live session in `sortSessionsByActivity` order (pinned first, then most-recently-active — same ordering `SessionSwitcher`'s activity-sort mode uses); each further tap while still held advances a highlight, wrapping at the list end; releasing the modifier commits the highlighted session via `selectSession`. Escape, a row click, or the window losing focus (`blur`/`visibilitychange`) all resolve the popup without waiting for a keyup. Two deliberate departures from the rest of this file's shortcuts:
  - It runs its own independent `document` keydown/keyup listeners rather than a slot in `dispatchAction` — nothing else here holds state across a keydown/keyup pair or reacts to a modifier's *release*, so the static `ShortcutDef`/`ACTION_IDS` table (one keydown → one action) can't express it.
  - It is never gated by `isTyping()`: the trigger always requires metaKey (Mac) or ctrlKey (other), and no browser produces a plain "e" text keystroke while that modifier is held, so it fires safely inside xterm or a plain input without needing the modifier-switch carve-out described below.
  - OS key-repeat on a physically-held E is ignored (`e.repeat`) — "tap repeatedly" means discrete presses, not holding the key down.
  - The lost-focus cancel listens to `blur`/`visibilitychange` directly inside the same effect as the key listeners, rather than deriving a `focused` boolean via a second hook and reacting to it in a separate effect — the latter shape calls setState synchronously in an effect body, which is exactly what `react-hooks/set-state-in-effect` flags (see CLAUDE.md's Key Invariants for this lint rule recurring elsewhere in this codebase).
- Rebindable shortcuts via shortcutStore (36 actions, see `DEFAULTS` in shortcutKeys.ts):
  - Alt+F11 (`toggleFullscreen`)
  - Cmd/Ctrl+Alt+B (`scrollToBottom`)
  - Terminal-toolbar actions, all **unbound by default** (section `'Terminal'`): `terminalToggleAutoScroll`, `terminalRefresh`, `terminalClone`, `terminalFork`, `terminalPopOut`. These run the matching toolbar button on the **selected session's** terminal only (dispatched as CustomEvent `terminal:action` with `{ action, terminalId }`; `TerminalContainer` reacts only when `detail.terminalId` matches its own, so clone/fork never fan out to other/floating terminals).
  - Cmd/Ctrl+Shift+P (`switchLatestSession` — labelled "Switch to previous session"; routes to `switchToPreviousSession`)
  - Cmd/Ctrl+Alt+1-9 (`switchSession1..9`)
  - Cmd/Ctrl+Alt+0 (`jumpToSession`, "Go to session by number", Sep 2026) — opens `SessionJumpOverlay`, which reaches any badge number where 1-9 stop. See "Go to session #" below.
  - Cmd/Ctrl+Shift+1-6 (detail-panel tab switch — Project/Terminal/Commands/Prompts/Notes/Queue; the Prompts row maps to tab id `conversation` via `TAB_ACTION_MAP`)
  - Cmd/Ctrl+Alt+Down / Up / W (`floatMinimize` / `floatMaximize` / `floatClose` — act on the focused floating terminal; modifier-switch combos so they fire even while the float's terminal has focus)
  - 10 file browser actions (all unbound by default)
- Section groupings (for settings UI, see `SECTION_ORDER` in shortcutKeys.ts): `'Session Switch'`, `'Detail Tabs'`, `'Terminal'`, `'Floating Window'`, `'File Browser'`
- Suppressed in INPUT/TEXTAREA/SELECT/contentEditable elements via `isTyping()` (exception: Cmd/Ctrl+Alt or Cmd/Ctrl+Shift modifier-switch shortcuts fire even inside xterm's hidden textarea — detected via `closest('.xterm')`)
- Scoped shortcuts owned by file browser components (not routed through `shortcutStore`):

  | Scope | Key | Action |
  |-------|-----|--------|
  | Find-in-file bar (focused input) | Enter / ArrowDown | Next match |
  | Find-in-file bar (focused input) | Shift+Enter / ArrowUp | Previous match |
  | Find-in-file bar (mounted, document-level) | F3 | Next match |
  | Find-in-file bar (mounted, document-level) | Shift+F3 | Previous match |
  | Find-in-file bar | Escape | Close bar |
  | Image viewer (focused container) | `+` / `=` | Zoom in (cursor-anchored via wheel equivalent) |
  | Image viewer (focused container) | `-` / `_` | Zoom out |
  | Image viewer (focused container) | `0` | Reset zoom + pan |
  | Image viewer (focused container) | `f` | Fit to screen |
  | Image viewer (focused container, zoom > 1) | Arrow keys | Pan by `PAN_STEP` px |
  | Image viewer | Double-click | Reset zoom + pan |
  | Image viewer | Mouse wheel | Cursor-anchored zoom |

- `comboMatchesEvent` falls back to `e.code === 'Digit<N>'` for digit bindings that require Alt OR Shift (Alt+1→¡ on macOS, Shift+1→! on all platforms); `'?'` is treated as inherently requiring Shift so the shift flag is not enforced
- Escape priority: modal > xterm (let terminal handle). Does NOT deselect session (removed to prevent scroll position loss when panel is hidden via display:none)
- Rebindable in two equivalent editors: the standalone `shortcut-settings` modal (`ShortcutSettingsModal`) and the Settings panel's Shortcuts tab (`ShortcutSettings`). Both use a capture-phase keydown listener for recording mode (click a `<kbd>` to record, Escape cancels), reject modifier-only/reserved keys (`isReservedOrModifierOnly` — `Control/Shift/Alt/Meta`, `Tab/Enter/Space`), and check `getConflict` before applying. `ShortcutsPanel` is read-only and links to the modal via a "Customize..." button.
- File browser shortcuts: all 10 unbound by default (`fileBrowserSearch`, `NewFile`, `NewFolder`, `Refresh`, `OpenNewTab`, `Format`, `ToggleOutline`, `ToggleBookmark`, `ToggleWordWrap`, `Fullscreen`); they fire only when the Project tab is open
- Shortcuts persisted to IndexedDB via `db.settings` key `'shortcutBindings'` (`DB_KEY`); only non-default overrides are stored as a JSON map of `actionId → KeyCombo`
- `dispatchAction` routes to: `toggleFullscreen` (`document.documentElement.requestFullscreen` / `exitFullscreen`), `scrollToBottom` (CustomEvent `terminal:scrollToBottom`), `switchLatestSession` (→ `switchToPreviousSession`), `switchSession1-9` (→ `switchToSessionByIndex`, which is now just `jumpToSessionNumber(index + 1)`), `jumpToSession` (→ `uiStore.openSessionJump()`), `switchTab*` → CustomEvent `detailTabs:switchTab` with `{ tabId }` mapped via `TAB_ACTION_MAP` (project/terminal/commands/conversation/notes/queue), `float*` → CustomEvent `floatTerminal:hotkey` with `{ action }` (minimize/maximize/close), `fileBrowser*` → CustomEvent `fileBrowser:action` with `{ actionId }`, `terminal*` → CustomEvent `terminal:action` with `{ action, terminalId }` (terminalId read from the selected session via `TERMINAL_ACTION_MAP`; consumed by `TerminalContainer` only when it owns that terminalId)


### Go to session # (Sep 2026)
- **Why**: Alt+⌘+1…9 only reach badges 1-9, and a workspace commonly has 20+ sessions. `jumpToSession` (default Cmd/Ctrl+Alt+0, rebindable; a modifier-switch combo, so it fires with the terminal focused) opens `SessionJumpOverlay`: type the number on a session's card (`#13`) and it switches there.
- **One numbering.** The badges (`SessionSwitcher`'s `sessionIndexMap`), `switchSession1-9` and the jump all read [`numberedSessions()`](../../../src/lib/sessionSort.ts) — live sessions, pinned first, then status, then `title || projectName || ''` (deliberately not `sessionDisplayTitle`, which would renumber untitled cards). Before, the rail and the keyboard hook each had their own copy of the sort; a third copy is how "type 13" lands somewhere other than the card showing 13.
- **When it jumps**: `resolveJumpInput(digits, count)` → `{ n, valid, canGrow }`, with `canGrow = n*10 <= count`. A valid number that cannot grow jumps at once (of 23: "13", "3"); one that can grow waits for another digit or Enter (of 23: "1" could be 10-19). No timer, so it never jumps while you are still typing. A leading 0 is ignored; an out-of-range number shows `✕ No session #29 · 1–23` and Enter does nothing; Backspace edits; Esc, a click outside, or the window losing focus cancels; any other key cancels **and passes through** (not consumed), so a stray press never eats typing.
- **Focus never moves** (same rule as `useSessionSwitchHold`): keys are read by a `document` keydown listener in the **capture** phase and the handled ones are stopped there (`preventDefault` + `stopPropagation` + `stopImmediatePropagation`), so they never reach xterm's textarea or the bubble-phase shortcut handler, and the terminal keeps focus. Digits are matched by `e.code` (`Digit*`/`Numpad*`) first — Option+1 is "¡" on macOS and the shortcut's own modifiers may still be held.
- **Switch path** (`jumpToSessionNumber`): the session already open is only un-minimized (`restoreDetailPanel`), never re-selected — re-selecting would make it its own `previousSessionId` and break switch-to-previous; otherwise `selectSession`. Toast `Switched to <title>`, as before. This also changed Alt+⌘+1…9, which used to re-select.
- **Styling** shares `SessionSwitchOverlay.module.css` (`.overlay/.panel/.header/.row`) plus `.jump*` classes. Measuring it found the shared grey text (`--text-dim`: header, hint, row project/status) at 1.96-4.01:1 on the panel in **every** theme, the Cmd+E switcher included; it is now `color-mix(--text-secondary 10%, --text-primary)` — solarized sets the limit (10% → 4.52, 15% → 4.41) — and `.hint` lost its 0.75 opacity. The preview row is outlined (`.jumpPreview`), not `.rowHighlighted`: the cyan fill pulled its text to 3.52:1 in solarized, and it is not a choice among many. No red text clears 4.5:1 on the solarized panel (best 3.01), so the error keeps readable text and puts the red on a `✕` glyph (3:1 applies). Measured from pixels, every line ≥4.51:1 in all ten themes.
- Covered by `src/lib/sessionJump.test.ts`, `src/components/modals/SessionJumpOverlay.test.tsx` (real key events at a focused stand-in terminal), `src/hooks/useKeyboardShortcuts.jump.test.tsx` (the real hook; modifier follows `isMac`), and `numberedSessions` in `src/lib/sessionSort.test.ts`.

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — reads selectedSessionId, triggers selectSession; `useSessionSwitchHold` additionally reads the full `sessions` map and `src/lib/sessionSort.ts`'s `sortSessionsByActivity` (also used directly by `SessionSwitcher.tsx`'s own activity-sort mode; owned in the manifest by [Cyberdrome Scene](../3d/cyberdrome-scene.md)/[Views & Routing](./views-routing.md)/[Workspace Snapshot](./workspace-snapshot.md), none of which is a natural conceptual fit — it's a shared, undomained sort utility) for its popup's candidate list
- [Client Persistence](./client-persistence.md) — overrides persisted to IndexedDB `db.settings` (`shortcutBindings`); loaded on startup via `loadFromDb`
- [Session Detail Panel](./session-detail-panel.md) — Escape closes search / restores minimized panel (no longer deselects)

### Depended On By
- [Terminal UI](./terminal-ui.md) — listens to `terminal:scrollToBottom`; xterm hidden textarea exception lets modifier-switch combos through
- [File Browser](./file-browser.md) — `projectTab:findInFile` (Cmd/Ctrl+F) and `fileBrowser:action` consumed by ProjectTab
- [Session Detail Panel](./session-detail-panel.md) — listens to `detailTabs:switchTab` CustomEvent to drive `externalTab` state
- [Floating Terminal Fork](./floating-terminal-fork.md) — `floatTerminal:hotkey` consumed by FloatingTerminalPanel (minimize/maximize/close)
- [Settings System](./settings-system.md) — Settings panel embeds the Shortcuts tab (`ShortcutSettings`)

### Shared Resources
- document keydown event listener, shortcutStore, IndexedDB `db.settings` (`shortcutBindings`)
- A second, independent document keydown/keyup listener pair owned by `useSessionSwitchHold` (Cmd/Ctrl+E) — deliberately outside shortcutStore, see above

## Change Risks
- Adding shortcuts that conflict with browser defaults (Cmd+W, Cmd+T) causes unexpected behavior
- Not suppressing in inputs causes keystrokes lost while typing
- Terminal custom key handler must coordinate — double-handling causes issues
- A new bare-letter-plus-modifier binding (like Cmd/Ctrl+E) must be checked against Electron's app-menu accelerators (`electron/main.ts`) — a matching accelerator would intercept the combo before it ever reaches the renderer, with no error anywhere
