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
| `src/components/modals/ShortcutsPanel.tsx` | Shortcuts reference panel |

## Implementation
- Hardcoded shortcuts in useKeyboardShortcuts.ts (not rebindable): Cmd+Shift+F (global search toggle), Cmd+F (find-in-file when session selected), Escape (close modal > skip if xterm focused), `[` (previous session), `]` (jump to latest finished session)
- Rebindable shortcuts via shortcutStore (26 actions): Alt+F11 (fullscreen), Cmd+Alt+B (scroll to bottom), Cmd+Shift+P (switch to previous session), Cmd+Alt+1-9 (session switch), 14 file browser actions (all unbound by default)
- Suppressed in INPUT/TEXTAREA/SELECT/contentEditable elements (exception: Alt+modifier session-switch shortcuts fire even inside xterm's hidden textarea)
- Alt+digit uses e.code (Digit1) to avoid macOS special-character conflicts
- Escape priority: modal > xterm (let terminal handle). Does NOT deselect session (removed to prevent scroll position loss when panel is hidden via display:none)
- Rebindable: Settings -> Shortcuts tab, recording mode on click, conflict detection
- File browser shortcuts: all 14 unbound by default (search, new file/folder, refresh, open in new tab, format, toggle outline/bookmark/word wrap/fullscreen/hidden/datetime, sort by name/date)
- Shortcuts persisted to IndexedDB via db.settings key 'shortcutBindings'
- dispatchAction routes to: toggleFullscreen (document.requestFullscreen), scrollToBottom (CustomEvent), switchLatestSession, switchSession1-9, fileBrowser:* (CustomEvent)

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — reads selectedSessionId, triggers selectSession
- [Settings System](./settings-system.md) — shortcut definitions persist via settingsStore
- [Session Detail Panel](./session-detail-panel.md) — Escape closes search / restores minimized panel (no longer deselects)

### Depended On By
- [Terminal UI](./terminal-ui.md) — custom key handler forwards Escape/Cmd+Alt+1-9
- [File Browser](./file-browser.md) — find-in-file triggered by Cmd+F (dispatches projectTab:findInFile CustomEvent)

### Shared Resources
- document keydown event listener, shortcutStore

## Change Risks
- Adding shortcuts that conflict with browser defaults (Cmd+W, Cmd+T) causes unexpected behavior
- Not suppressing in inputs causes keystrokes lost while typing
- Terminal custom key handler must coordinate — double-handling causes issues
