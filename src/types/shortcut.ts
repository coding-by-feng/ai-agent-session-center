/**
 * Shortcut types — keyboard shortcut bindings and action identifiers.
 */

export interface KeyCombo {
  key: string;              // e.g. '/', 'Escape', 'F11', 's'
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export type ShortcutActionId =
  | 'toggleFullscreen'
  | 'scrollToBottom'
  // Terminal toolbar buttons (act on the selected session's terminal)
  | 'terminalToggleAutoScroll'
  | 'terminalRefresh'
  | 'terminalBookmark'
  | 'terminalClone'
  | 'terminalFork'
  | 'terminalPopOut'
  | 'switchSession1'
  | 'switchSession2'
  | 'switchSession3'
  | 'switchSession4'
  | 'switchSession5'
  | 'switchSession6'
  | 'switchSession7'
  | 'switchSession8'
  | 'switchSession9'
  | 'switchLatestSession'
  // Detail panel tabs
  | 'switchTabProject'
  | 'switchTabTerminal'
  | 'switchTabCommands'
  | 'switchTabPrompts'
  | 'switchTabNotes'
  | 'switchTabQueue'
  // File Browser
  | 'fileBrowserSearch'
  | 'fileBrowserNewFile'
  | 'fileBrowserNewFolder'
  | 'fileBrowserRefresh'
  | 'fileBrowserOpenNewTab'
  | 'fileBrowserFormat'
  | 'fileBrowserToggleOutline'
  | 'fileBrowserToggleBookmark'
  | 'fileBrowserToggleWordWrap'
  | 'fileBrowserFullscreen'
  // Floating terminal window (acts on the focused float)
  | 'floatMinimize'
  | 'floatMaximize'
  | 'floatClose';

export interface ShortcutBinding {
  actionId: ShortcutActionId;
  label: string;           // "Focus search"
  section: string;         // "Navigation" | "Actions" | "Selected Session" | "Terminal"
  combo: KeyCombo | null;  // null = unbound (no shortcut)
  defaultCombo: KeyCombo | null;  // Original default; null for file browser actions
}
