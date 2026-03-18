/**
 * shortcutKeys — default shortcut definitions and KeyCombo utilities.
 */
import type { KeyCombo, ShortcutActionId, ShortcutBinding } from '@/types/shortcut';

// ---------------------------------------------------------------------------
// Default shortcut definitions
// ---------------------------------------------------------------------------

interface ShortcutDef {
  label: string;
  section: string;
  combo: KeyCombo;
}

// Platform detection: macOS uses Cmd (metaKey), Windows/Linux uses Ctrl (ctrlKey)
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform);

/** Build a session-switch KeyCombo: Cmd+Alt+N on macOS, Ctrl+Alt+N elsewhere. */
function sw(key: string): KeyCombo {
  return isMac
    ? { key, altKey: true, metaKey: true }
    : { key, altKey: true, ctrlKey: true };
}

const DEFAULTS: Record<ShortcutActionId, ShortcutDef> = {
  focusSearch:          { label: 'Focus search',                  section: 'Navigation',       combo: isMac ? { key: 'f', metaKey: true } : { key: 'f', ctrlKey: true } },
  closeOrDeselect:      { label: 'Close modal / deselect',        section: 'Navigation',       combo: { key: 'Escape' } },
  toggleShortcuts:      { label: 'Toggle shortcuts panel',        section: 'Navigation',       combo: { key: '?' } },
  toggleSettings:       { label: 'Toggle settings',               section: 'Actions',          combo: { key: 's' } },
  toggleHeader:         { label: 'Collapse / expand header',      section: 'Navigation',       combo: { key: 'h' } },
  newTerminal:          { label: 'New terminal session',          section: 'Actions',          combo: { key: 't' } },
  toggleMute:           { label: 'Mute / unmute all',             section: 'Actions',          combo: { key: 'm' } },
  killSession:          { label: 'Kill selected session',         section: 'Selected Session', combo: { key: 'k' } },
  archiveSession:       { label: 'Archive selected session',      section: 'Selected Session', combo: { key: 'a' } },
  toggleFullscreen:     { label: 'Toggle fullscreen',             section: 'Terminal',         combo: { key: 'F11', altKey: true } },
  scrollToBottom:       { label: 'Scroll to bottom',              section: 'Terminal',         combo: { key: 'b' } },
  switchLatestSession:  { label: 'Switch to previous session',    section: 'Session Switch',   combo: sw('p') },
  switchSession1:       { label: 'Switch to session 1',           section: 'Session Switch',   combo: sw('1') },
  switchSession2:       { label: 'Switch to session 2',           section: 'Session Switch',   combo: sw('2') },
  switchSession3:       { label: 'Switch to session 3',           section: 'Session Switch',   combo: sw('3') },
  switchSession4:       { label: 'Switch to session 4',           section: 'Session Switch',   combo: sw('4') },
  switchSession5:       { label: 'Switch to session 5',           section: 'Session Switch',   combo: sw('5') },
  switchSession6:       { label: 'Switch to session 6',           section: 'Session Switch',   combo: sw('6') },
  switchSession7:       { label: 'Switch to session 7',           section: 'Session Switch',   combo: sw('7') },
  switchSession8:       { label: 'Switch to session 8',           section: 'Session Switch',   combo: sw('8') },
  switchSession9:       { label: 'Switch to session 9',           section: 'Session Switch',   combo: sw('9') },
};

/** All action IDs in display order. */
export const ACTION_IDS: ShortcutActionId[] = [
  'focusSearch', 'closeOrDeselect', 'toggleShortcuts',
  'toggleSettings', 'toggleHeader', 'newTerminal', 'toggleMute',
  'killSession', 'archiveSession', 'toggleFullscreen', 'scrollToBottom',
  'switchLatestSession',
  'switchSession1', 'switchSession2', 'switchSession3',
  'switchSession4', 'switchSession5', 'switchSession6',
  'switchSession7', 'switchSession8', 'switchSession9',
];

/** Section display order. */
export const SECTION_ORDER = ['Session Switch', 'Navigation', 'Actions', 'Selected Session', 'Terminal'];

/** Build ShortcutBinding[] from defaults + optional overrides. */
export function buildBindings(
  overrides?: Partial<Record<ShortcutActionId, KeyCombo>>,
): ShortcutBinding[] {
  return ACTION_IDS.map((actionId) => {
    const def = DEFAULTS[actionId];
    return {
      actionId,
      label: def.label,
      section: def.section,
      combo: overrides?.[actionId] ?? { ...def.combo },
      defaultCombo: { ...def.combo },
    };
  });
}

// ---------------------------------------------------------------------------
// KeyCombo utilities
// ---------------------------------------------------------------------------

/** Convert a KeyCombo to a human-readable string like "Alt+F11" or "?" */
export function keyComboToString(combo: KeyCombo): string {
  const parts: string[] = [];
  if (combo.ctrlKey) parts.push('Ctrl');
  if (combo.altKey) parts.push('Alt');
  if (combo.metaKey) parts.push('Cmd');
  if (combo.shiftKey) parts.push('Shift');

  // Friendly key name
  let keyName = combo.key;
  if (keyName === ' ') keyName = 'Space';
  else if (keyName.length === 1) keyName = keyName.toUpperCase();

  parts.push(keyName);
  return parts.join('+');
}

/** Extract a KeyCombo from a KeyboardEvent. */
export function keyEventToCombo(e: KeyboardEvent): KeyCombo {
  const combo: KeyCombo = { key: e.key };
  if (e.ctrlKey) combo.ctrlKey = true;
  if (e.metaKey) combo.metaKey = true;
  if (e.altKey) combo.altKey = true;
  if (e.shiftKey) combo.shiftKey = true;
  return combo;
}

/** Check if two KeyCombos are equivalent. */
export function comboEquals(a: KeyCombo, b: KeyCombo): boolean {
  return (
    normalizeKey(a.key) === normalizeKey(b.key) &&
    !!a.ctrlKey === !!b.ctrlKey &&
    !!a.metaKey === !!b.metaKey &&
    !!a.altKey === !!b.altKey &&
    !!a.shiftKey === !!b.shiftKey
  );
}

/** Check if a KeyboardEvent matches a KeyCombo binding. */
export function comboMatchesEvent(combo: KeyCombo, e: KeyboardEvent): boolean {
  // On macOS, Alt+digit produces special characters (e.g. Alt+1 → ¡).
  // Fall back to e.code (e.g. "Digit1") when the binding uses altKey + digit.
  let keyMatch: boolean;
  if (combo.altKey && /^[0-9]$/.test(combo.key) && e.altKey) {
    keyMatch = e.code === `Digit${combo.key}`;
  } else {
    keyMatch = normalizeKey(combo.key) === normalizeKey(e.key);
  }
  if (!keyMatch) return false;

  if (!!combo.ctrlKey !== e.ctrlKey) return false;
  if (!!combo.metaKey !== e.metaKey) return false;
  if (!!combo.altKey !== e.altKey) return false;

  // Special: '?' inherently requires Shift — don't require shiftKey flag in binding
  if (combo.key === '?') return true;

  if (!!combo.shiftKey !== e.shiftKey) return false;
  return true;
}

/** Keys that are modifier-only (no action key). */
const MODIFIER_ONLY = new Set(['Control', 'Shift', 'Alt', 'Meta']);

/** Keys reserved from binding. */
const RESERVED_KEYS = new Set(['Tab', 'Enter', ' ']);

/** Whether a key event is modifier-only or reserved. */
export function isReservedOrModifierOnly(e: KeyboardEvent): boolean {
  return MODIFIER_ONLY.has(e.key) || RESERVED_KEYS.has(e.key);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeKey(key: string): string {
  // Single letter keys: case-insensitive compare
  if (key.length === 1) return key.toLowerCase();
  return key;
}
