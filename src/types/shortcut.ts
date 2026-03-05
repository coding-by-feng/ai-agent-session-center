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
  | 'focusSearch'
  | 'closeOrDeselect'
  | 'toggleShortcuts'
  | 'toggleSettings'
  | 'newTerminal'
  | 'killSession'
  | 'archiveSession'
  | 'toggleMute'
  | 'toggleFullscreen'
  | 'switchSession1'
  | 'switchSession2'
  | 'switchSession3'
  | 'switchSession4'
  | 'switchSession5'
  | 'switchSession6'
  | 'switchSession7'
  | 'switchSession8'
  | 'switchSession9';

export interface ShortcutBinding {
  actionId: ShortcutActionId;
  label: string;           // "Focus search"
  section: string;         // "Navigation" | "Actions" | "Selected Session" | "Terminal"
  combo: KeyCombo;         // Current binding
  defaultCombo: KeyCombo;  // Original default
}
