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

const DEFAULTS: Record<ShortcutActionId, ShortcutDef> = {
  focusSearch:      { label: 'Focus search',                section: 'Navigation',       combo: { key: '/' } },
  closeOrDeselect:  { label: 'Close modal / deselect',      section: 'Navigation',       combo: { key: 'Escape' } },
  toggleShortcuts:  { label: 'Toggle shortcuts panel',      section: 'Navigation',       combo: { key: '?' } },
  toggleSettings:   { label: 'Toggle settings',             section: 'Actions',          combo: { key: 's' } },
  newTerminal:      { label: 'New terminal session',        section: 'Actions',          combo: { key: 't' } },
  toggleMute:       { label: 'Mute / unmute all',           section: 'Actions',          combo: { key: 'm' } },
  killSession:      { label: 'Kill selected session',       section: 'Selected Session', combo: { key: 'k' } },
  archiveSession:   { label: 'Archive selected session',    section: 'Selected Session', combo: { key: 'a' } },
  toggleFullscreen: { label: 'Toggle fullscreen',           section: 'Terminal',         combo: { key: 'F11', altKey: true } },
};

/** All action IDs in display order. */
export const ACTION_IDS: ShortcutActionId[] = [
  'focusSearch', 'closeOrDeselect', 'toggleShortcuts',
  'toggleSettings', 'newTerminal', 'toggleMute',
  'killSession', 'archiveSession', 'toggleFullscreen',
];

/** Section display order. */
export const SECTION_ORDER = ['Navigation', 'Actions', 'Selected Session', 'Terminal'];

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
  // For single-char shortcuts, compare case-insensitively so both 's' and 'S' match
  if (normalizeKey(combo.key) !== normalizeKey(e.key)) return false;

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
