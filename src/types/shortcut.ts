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
  | 'toggleFullscreen';

export interface ShortcutBinding {
  actionId: ShortcutActionId;
  label: string;           // "Focus search"
  section: string;         // "Navigation" | "Actions" | "Selected Session" | "Terminal"
  combo: KeyCombo;         // Current binding
  defaultCombo: KeyCombo;  // Original default
}
