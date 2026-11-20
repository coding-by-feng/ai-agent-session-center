/**
 * shortcutKeys — default shortcut definitions and KeyCombo utilities.
 */
import { hasAccountChannels } from '@/lib/devicesSwitcher';
import { IS_LITE, liteAllowsShortcut } from '@/lib/edition';
import type { KeyCombo, ShortcutActionId, ShortcutBinding } from '@/types/shortcut';

// ---------------------------------------------------------------------------
// Default shortcut definitions
// ---------------------------------------------------------------------------

interface ShortcutDef {
  label: string;
  section: string;
  combo: KeyCombo | null;
}

// Platform detection: macOS uses Cmd (metaKey), Windows/Linux uses Ctrl (ctrlKey)
// Exported so other modifier-driven features (e.g. useSessionSwitchHold) share
// this one detection rather than growing a second copy of the regex.
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform);

/** Build a session-switch KeyCombo: Cmd+Alt+N on macOS, Ctrl+Alt+N elsewhere. */
function sw(key: string): KeyCombo {
  return isMac
    ? { key, altKey: true, metaKey: true }
    : { key, altKey: true, ctrlKey: true };
}

/**
 * Build a tab-switch KeyCombo: Ctrl+Cmd+N on macOS, Ctrl+Shift+N elsewhere (Nov 18 2026). Not Cmd+Shift+N on
 * a Mac: macOS keeps Cmd+Shift+3/4/5 for screenshots, so the Commands and Conversation keys never arrived.
 */
function tb(key: string): KeyCombo {
  return isMac
    ? { key, ctrlKey: true, metaKey: true }
    : { key, shiftKey: true, ctrlKey: true };
}

const DEFAULTS: Record<ShortcutActionId, ShortcutDef> = {
  // The ＋ New menu. A modifier-switch combo (Cmd/Ctrl+Alt), so it also fires while a terminal has focus; not
  // Cmd/Ctrl+N, which a browser keeps for a new window and a terminal's shell for the next history line.
  newSession:                 { label: 'New session or room',           section: 'Create',         combo: sw('n') },
  scrollToBottom:             { label: 'Scroll to bottom',              section: 'Terminal',      combo: isMac ? { key: 'b', altKey: true, metaKey: true } : { key: 'b', altKey: true, ctrlKey: true } },
  // Terminal toolbar buttons — unbound by default; the user assigns keys in Settings.
  terminalToggleAutoScroll:   { label: 'Toggle auto-scroll',            section: 'Terminal',      combo: null },
  terminalRefresh:            { label: 'Clear & replay output',         section: 'Terminal',      combo: null },
  terminalClone:              { label: 'Duplicate session',             section: 'Terminal',      combo: null },
  terminalFork:               { label: 'Branch (fork) session',         section: 'Terminal',      combo: null },
  terminalPopOut:             { label: 'Pop out into a window',         section: 'Terminal',      combo: null },
  switchLatestSession:        { label: 'Switch to previous session',    section: 'Session Switch', combo: isMac ? { key: 'p', shiftKey: true, metaKey: true } : { key: 'p', shiftKey: true, ctrlKey: true } },
  // Opens the "go to session #" box: type any badge number (1…9 only reach so far).
  jumpToSession:              { label: 'Go to session by number',       section: 'Session Switch', combo: sw('0') },
  // Cmd+K on a Mac, also from a focused terminal (Cmd never reaches the shell); Ctrl+K elsewhere, outside a
  // terminal only, where Ctrl+K is the shell's kill-line (Nov 18 2026). Plain `/` before: the terminal kept it.
  searchSessions:             { label: 'Search sessions',               section: 'Session Switch', combo: isMac ? { key: 'k', metaKey: true } : { key: 'k', ctrlKey: true } },
  // The devices panel's Switch part (plan 18). Cmd/Ctrl+Shift, not the Cmd/Ctrl+Alt of the keys around it: xterm
  // types nothing for Ctrl+Shift+S, while on Linux it sends ESC + a control character for Ctrl+Alt+letter (measured:
  // Ctrl+Alt+S is 1b 13), and on Windows Ctrl+Alt is AltGr. S for Switch: Option+Cmd+D is the macOS Dock's own key.
  switchDevice:               { label: 'Switch computer',               section: 'Session Switch', combo: isMac ? { key: 's', shiftKey: true, metaKey: true } : { key: 's', shiftKey: true, ctrlKey: true } },
  switchSession1:             { label: 'Switch to session 1',           section: 'Session Switch', combo: sw('1') },
  switchSession2:             { label: 'Switch to session 2',           section: 'Session Switch', combo: sw('2') },
  switchSession3:             { label: 'Switch to session 3',           section: 'Session Switch', combo: sw('3') },
  switchSession4:             { label: 'Switch to session 4',           section: 'Session Switch', combo: sw('4') },
  switchSession5:             { label: 'Switch to session 5',           section: 'Session Switch', combo: sw('5') },
  switchSession6:             { label: 'Switch to session 6',           section: 'Session Switch', combo: sw('6') },
  switchSession7:             { label: 'Switch to session 7',           section: 'Session Switch', combo: sw('7') },
  switchSession8:             { label: 'Switch to session 8',           section: 'Session Switch', combo: sw('8') },
  switchSession9:             { label: 'Switch to session 9',           section: 'Session Switch', combo: sw('9') },
  // Detail panel tabs: the digit is the tab's position (DetailTabs' BASE_TABS).
  switchTabProject:           { label: 'Switch to Project tab',         section: 'Detail Tabs',    combo: tb('1') },
  switchTabTerminal:          { label: 'Switch to Terminal tab',        section: 'Detail Tabs',    combo: tb('2') },
  switchTabCommands:          { label: 'Switch to Commands tab',        section: 'Detail Tabs',    combo: tb('3') },
  switchTabPrompts:           { label: 'Switch to Conversation tab',    section: 'Detail Tabs',    combo: tb('4') },
  switchTabAiPopups:          { label: 'Switch to AI Popups tab',       section: 'Detail Tabs',    combo: tb('5') },
  switchTabQueue:             { label: 'Switch to Queue tab',           section: 'Detail Tabs',    combo: tb('6') },
  switchTabAgents:            { label: 'Switch to Agents tab',          section: 'Detail Tabs',    combo: tb('7') },
  // File Browser — all unbound by default
  fileBrowserSearch:          { label: 'Search files',                  section: 'File Browser',  combo: null },
  fileBrowserNewFile:         { label: 'New file',                      section: 'File Browser',  combo: null },
  fileBrowserNewFolder:       { label: 'New folder',                    section: 'File Browser',  combo: null },
  fileBrowserRefresh:         { label: 'Refresh',                       section: 'File Browser',  combo: null },
  fileBrowserOpenNewTab:      { label: 'Open in new tab',               section: 'File Browser',  combo: null },
  fileBrowserFormat:          { label: 'Format file',                   section: 'File Browser',  combo: null },
  fileBrowserToggleOutline:   { label: 'Toggle outline',                section: 'File Browser',  combo: null },
  fileBrowserToggleBookmark:  { label: 'Bookmark',                      section: 'File Browser',  combo: null },
  fileBrowserToggleWordWrap:  { label: 'Toggle word wrap',              section: 'File Browser',  combo: null },
  fileBrowserFullscreen:      { label: 'Open in fullscreen',            section: 'File Browser',  combo: null },
  // Floating terminal window — act on the focused float. Modifier-switch combos
  // so they fire even while the float's terminal has focus.
  floatMinimize:              { label: 'Minimize floating window',       section: 'Floating Window', combo: sw('ArrowDown') },
  floatMaximize:              { label: 'Maximize floating window',       section: 'Floating Window', combo: sw('ArrowUp') },
  floatClose:                 { label: 'Close floating window',          section: 'Floating Window', combo: sw('w') },
};

/** All action IDs in display order. */
export const ACTION_IDS: ShortcutActionId[] = [
  'newSession',
  'scrollToBottom',
  'terminalToggleAutoScroll', 'terminalRefresh',
  'terminalClone', 'terminalFork', 'terminalPopOut',
  'switchLatestSession',
  'jumpToSession',
  'searchSessions',
  'switchDevice',
  'switchSession1', 'switchSession2', 'switchSession3',
  'switchSession4', 'switchSession5', 'switchSession6',
  'switchSession7', 'switchSession8', 'switchSession9',
  'switchTabProject', 'switchTabTerminal', 'switchTabCommands',
  'switchTabPrompts', 'switchTabAiPopups', 'switchTabQueue', 'switchTabAgents',
  'fileBrowserSearch', 'fileBrowserNewFile', 'fileBrowserNewFolder',
  'fileBrowserRefresh', 'fileBrowserOpenNewTab', 'fileBrowserFormat',
  'fileBrowserToggleOutline', 'fileBrowserToggleBookmark', 'fileBrowserToggleWordWrap',
  'fileBrowserFullscreen',
  'floatMinimize', 'floatMaximize', 'floatClose',
];

/** Section display order. */
export const SECTION_ORDER = ['Create', 'Session Switch', 'Detail Tabs', 'Terminal', 'Floating Window', 'File Browser'];

/** Build ShortcutBinding[] from defaults + optional overrides. */
export function buildBindings(
  overrides?: Partial<Record<ShortcutActionId, KeyCombo>>,
): ShortcutBinding[] {
  // Lite has no binding at all for an action it leaves out: the key passes through to the terminal,
  // and the shortcut lists skip it. The same goes for `switchDevice` in a window with no devices switcher
  // (a browser, a remote computer's window, a Client edition): asked on every build, never cached.
  const offered = (actionId: ShortcutActionId) =>
    (!IS_LITE || liteAllowsShortcut(actionId)) && (actionId !== 'switchDevice' || hasAccountChannels());
  const actions = ACTION_IDS.filter(offered);
  return actions.map((actionId) => {
    const def = DEFAULTS[actionId];
    return {
      actionId,
      label: def.label,
      section: def.section,
      combo: overrides?.[actionId] ?? def.combo,
      defaultCombo: def.combo,
    };
  });
}

// ---------------------------------------------------------------------------
// KeyCombo utilities
// ---------------------------------------------------------------------------

/** Convert a KeyCombo (or null) to a human-readable string like "Alt+F11" or "—" */
export function keyComboToString(combo: KeyCombo | null): string {
  if (combo === null) return '—';
  const parts: string[] = [];
  if (combo.ctrlKey) parts.push('Ctrl');
  if (combo.altKey) parts.push('Alt');
  if (combo.metaKey) parts.push('Cmd');
  if (combo.shiftKey) parts.push('Shift');

  // Friendly key name
  let keyName = combo.key;
  if (keyName === ' ') keyName = 'Space';
  else if (keyName === 'ArrowDown') keyName = '↓';
  else if (keyName === 'ArrowUp') keyName = '↑';
  else if (keyName === 'ArrowLeft') keyName = '←';
  else if (keyName === 'ArrowRight') keyName = '→';
  else if (keyName.length === 1) keyName = keyName.toUpperCase();

  parts.push(keyName);
  return parts.join('+');
}

/**
 * A short form for tight places such as a placeholder (Nov 18 2026): macOS key symbols in
 * Apple's order (⌃⌥⇧⌘K) on a Mac, the same text as `keyComboToString` elsewhere.
 */
export function keyComboToGlyphs(combo: KeyCombo | null, mac: boolean = isMac): string {
  if (combo === null || !mac) return keyComboToString(combo);
  const mods = `${combo.ctrlKey ? '⌃' : ''}${combo.altKey ? '⌥' : ''}${combo.shiftKey ? '⇧' : ''}${combo.metaKey ? '⌘' : ''}`;
  const key = keyComboToString({ key: combo.key });
  return `${mods}${key}`;
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

/** Check if two KeyCombos (or nulls) are equivalent. */
export function comboEquals(a: KeyCombo | null, b: KeyCombo | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return (
    normalizeKey(a.key) === normalizeKey(b.key) &&
    !!a.ctrlKey === !!b.ctrlKey &&
    !!a.metaKey === !!b.metaKey &&
    !!a.altKey === !!b.altKey &&
    !!a.shiftKey === !!b.shiftKey
  );
}

/** Check if a KeyboardEvent matches a KeyCombo binding. Returns false for null combos. */
export function comboMatchesEvent(combo: KeyCombo | null, e: KeyboardEvent): boolean {
  if (combo === null) return false;
  // Alt+digit (macOS: Alt+1 → ¡) and Shift+digit (Shift+1 → !) produce
  // special characters — fall back to e.code ("Digit1") for digit bindings
  // that require Alt or Shift.
  let keyMatch: boolean;
  const isDigitBinding = /^[0-9]$/.test(combo.key);
  const needsCodeFallback =
    isDigitBinding && ((combo.altKey && e.altKey) || (combo.shiftKey && e.shiftKey));
  if (needsCodeFallback) {
    keyMatch = e.code === `Digit${combo.key}`;
  } else {
    keyMatch = normalizeKey(combo.key) === normalizeKey(e.key);
    // Alt+letter on macOS types another character (Alt+B → ∫) or starts a dead key (Alt+N → "Dead"):
    // a letter binding that needs Alt also matches the physical key.
    if (!keyMatch && combo.altKey && e.altKey && /^[a-z]$/i.test(combo.key)) {
      keyMatch = e.code === `Key${combo.key.toUpperCase()}`;
    }
  }
  if (!keyMatch) return false;

  if (!!combo.ctrlKey !== e.ctrlKey) return false;
  if (!!combo.metaKey !== e.metaKey) return false;
  if (!!combo.altKey !== e.altKey) return false;

  // Special: '?' inherently requires Shift — don't require shiftKey flag in binding.
  // '/' does on many layouts (German Shift+7), and Shift+/ is '?' on US, so it is safe too.
  if (combo.key === '?' || combo.key === '/') return true;

  if (!!combo.shiftKey !== e.shiftKey) return false;
  return true;
}

/**
 * May this key, pressed in a focused terminal, reach the app's shortcuts (Nov 18 2026)? Cmd/Ctrl with Alt or
 * Shift (the session-switch and Win/Linux tab keys), Ctrl+Cmd (the Mac tab keys) and, on a Mac, Cmd alone
 * (⌘K: Cmd never reaches the shell). A bare Ctrl+key stays the terminal's: Ctrl+K kills the line, Ctrl+C stops.
 */
export function isTerminalPassThrough(
  e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  mac: boolean = isMac,
): boolean {
  if ((e.altKey || e.shiftKey) && (e.metaKey || e.ctrlKey)) return true;
  if (e.metaKey && e.ctrlKey) return true;
  return mac && e.metaKey;
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
