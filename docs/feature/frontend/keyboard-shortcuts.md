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
| `src/types/shortcut.ts` | `KeyCombo`, `ShortcutActionId` (31 ids), `ShortcutBinding` types |
| `src/components/modals/ShortcutsPanel.tsx` | Read-only reference overlay (`shortcuts` modal), opened from NavBar |
| `src/components/modals/ShortcutSettingsModal.tsx` | Standalone rebind/reset modal (`shortcut-settings` modal, mounted in App.tsx) |
| `src/components/settings/ShortcutSettings.tsx` | Embedded rebind/reset UI for the Settings panel's Shortcuts tab |
| `src/components/modals/ShortcutRow.tsx` | Shared row: label, clickable `<kbd>`, reset button (used by both editors) |

## Implementation
- Hardcoded shortcuts in useKeyboardShortcuts.ts (not rebindable): Cmd/Ctrl+Shift+F (global search toggle — `global-search` modal), Cmd/Ctrl+F (find-in-file when a session is selected — dispatches `projectTab:findInFile`; falls through to native browser find when no session), Escape (close modal, else skip if xterm focused), `[` (previous session, only when a session is selected and not typing), `]` (jump to latest finished session)
- Rebindable shortcuts via shortcutStore (37 actions, see `DEFAULTS` in shortcutKeys.ts):
  - Alt+F11 (`toggleFullscreen`)
  - Cmd/Ctrl+Alt+B (`scrollToBottom`)
  - Terminal-toolbar actions, all **unbound by default** (section `'Terminal'`): `terminalToggleAutoScroll`, `terminalRefresh`, `terminalBookmark`, `terminalClone`, `terminalFork`, `terminalPopOut`. These run the matching toolbar button on the **selected session's** terminal only (dispatched as CustomEvent `terminal:action` with `{ action, terminalId }`; `TerminalContainer` reacts only when `detail.terminalId` matches its own, so clone/fork never fan out to other/floating terminals).
  - Cmd/Ctrl+Shift+P (`switchLatestSession` — labelled "Switch to previous session"; routes to `switchToPreviousSession`)
  - Cmd/Ctrl+Alt+1-9 (`switchSession1..9`)
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
- `dispatchAction` routes to: `toggleFullscreen` (`document.documentElement.requestFullscreen` / `exitFullscreen`), `scrollToBottom` (CustomEvent `terminal:scrollToBottom`), `switchLatestSession` (→ `switchToPreviousSession`), `switchSession1-9` (→ `switchToSessionByIndex`), `switchTab*` → CustomEvent `detailTabs:switchTab` with `{ tabId }` mapped via `TAB_ACTION_MAP` (project/terminal/commands/conversation/notes/queue), `float*` → CustomEvent `floatTerminal:hotkey` with `{ action }` (minimize/maximize/close), `fileBrowser*` → CustomEvent `fileBrowser:action` with `{ actionId }`, `terminal*` → CustomEvent `terminal:action` with `{ action, terminalId }` (terminalId read from the selected session via `TERMINAL_ACTION_MAP`; consumed by `TerminalContainer` only when it owns that terminalId)

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — reads selectedSessionId, triggers selectSession
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

## Change Risks
- Adding shortcuts that conflict with browser defaults (Cmd+W, Cmd+T) causes unexpected behavior
- Not suppressing in inputs causes keystrokes lost while typing
- Terminal custom key handler must coordinate — double-handling causes issues
