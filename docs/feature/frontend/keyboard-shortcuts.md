# Keyboard Shortcuts System

## Function
Global keyboard shortcut handling with rebindable keys, context-aware suppression, and conflict detection.

## Purpose
Power user efficiency — quick navigation, session control, and modal toggling without mouse.

## Source Files
| File | Role |
|------|------|
| `src/hooks/useKeyboardShortcuts.ts` | Keyboard event handler with action routing |
| `src/stores/shortcutStore.ts` | Rebindable shortcut definitions and persistence |
| `src/lib/shortcutKeys.ts` (~9KB) | Key definitions, default bindings, action registry |
| `src/types/shortcut.ts` | `KeyCombo`, `ShortcutActionId`, `ShortcutBinding` types |
| `src/components/modals/ShortcutsPanel.tsx` | Shortcuts reference panel |
| `src/components/modals/ShortcutSettingsModal.tsx` | Shortcut editing modal (used in App.tsx) |
| `src/components/modals/ShortcutRow.tsx` | Shared row component for shortcut display/editing |

## Implementation
- Hardcoded shortcuts in useKeyboardShortcuts.ts (not rebindable): Cmd+Shift+F (global search toggle), Cmd+F (find-in-file when session selected), Escape (close modal > skip if xterm focused), `[` (previous session), `]` (jump to latest finished session)
- Rebindable shortcuts via shortcutStore (32 actions): Alt+F11 (fullscreen), Cmd+Alt+B (scroll to bottom), Cmd+Shift+P (switch to previous session), Cmd+Alt+1-9 (session switch), Cmd+Shift+1-6 (detail-panel tab switch — Project/Terminal/Commands/Prompts/Notes/Queue), 14 file browser actions (all unbound by default)
- Section groupings (for settings UI, see `SECTION_ORDER` in shortcutKeys.ts): 'Session Switch', 'Detail Tabs', 'Terminal', 'File Browser'
- Suppressed in INPUT/TEXTAREA/SELECT/contentEditable elements (exception: Alt+modifier session-switch shortcuts fire even inside xterm's hidden textarea)
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

- `comboMatchesEvent` falls back to `e.code === 'Digit<N>'` for digit bindings that require Alt OR Shift (Alt+1→¡ on macOS, Shift+1→! on all platforms)
- Escape priority: modal > xterm (let terminal handle). Does NOT deselect session (removed to prevent scroll position loss when panel is hidden via display:none)
- Rebindable: Settings -> Shortcuts tab, recording mode on click, conflict detection
- File browser shortcuts: all 14 unbound by default (search, new file/folder, refresh, open in new tab, format, toggle outline/bookmark/word wrap/fullscreen/hidden/datetime, sort by name/date)
- Shortcuts persisted to IndexedDB via db.settings key 'shortcutBindings'
- dispatchAction routes to: toggleFullscreen (document.requestFullscreen), scrollToBottom (CustomEvent `terminal:scrollToBottom`), switchLatestSession, switchSession1-9, switchTab* → CustomEvent `detailTabs:switchTab` with `{ tabId }` mapped via `TAB_ACTION_MAP` (project/terminal/commands/conversation/notes/queue), fileBrowser:* → CustomEvent `fileBrowser:action`

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — reads selectedSessionId, triggers selectSession
- [Settings System](./settings-system.md) — shortcut definitions persist via settingsStore
- [Session Detail Panel](./session-detail-panel.md) — Escape closes search / restores minimized panel (no longer deselects)

### Depended On By
- [Terminal UI](./terminal-ui.md) — custom key handler forwards Escape/Cmd+Alt+1-9
- [File Browser](./file-browser.md) — find-in-file triggered by Cmd+F (dispatches projectTab:findInFile CustomEvent)
- [Session Detail Panel](./session-detail-panel.md) — listens to `detailTabs:switchTab` CustomEvent to drive `externalTab` state

### Shared Resources
- document keydown event listener, shortcutStore

## Change Risks
- Adding shortcuts that conflict with browser defaults (Cmd+W, Cmd+T) causes unexpected behavior
- Not suppressing in inputs causes keystrokes lost while typing
- Terminal custom key handler must coordinate — double-handling causes issues
