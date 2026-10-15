/**
 * terminalKeys.ts — the Terminal segment's key bar (AASC-45): what each key
 * writes, and the sticky Ctrl.
 *
 * Ctrl is a modifier a phone keyboard doesn't have. Tapping it arms it until the
 * next key: a key bar arrow becomes its Ctrl form (a word jump), and the next
 * character typed on the keyboard becomes its control code (Ctrl, then C sends
 * ^C). Either way it lets go after that one key. Pure: the segment owns the
 * state and the writes.
 */

export const KEY_BAR = ['esc', 'tab', 'ctrl', 'up', 'down', 'left', 'right', '1', '2', '3', 'enter'] as const;
export type KeyBarKey = (typeof KEY_BAR)[number];

/** What each key is called out loud (most faces are glyphs). */
export const KEY_LABELS: Readonly<Record<KeyBarKey, string>> = {
  esc: 'Escape',
  tab: 'Tab',
  ctrl: 'Control',
  up: 'Up arrow',
  down: 'Down arrow',
  left: 'Left arrow',
  right: 'Right arrow',
  '1': 'Choose 1',
  '2': 'Choose 2',
  '3': 'Choose 3',
  enter: 'Enter',
};

const PLAIN: Readonly<Record<KeyBarKey, string>> = {
  esc: '\x1b',
  tab: '\t',
  ctrl: '',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  '1': '1',
  '2': '2',
  '3': '3',
  enter: '\r',
};

/** xterm's Ctrl+arrow (CSI 1;5 X): a word jump in most line editors. */
const WITH_CTRL: Partial<Record<KeyBarKey, string>> = {
  up: '\x1b[1;5A',
  down: '\x1b[1;5B',
  right: '\x1b[1;5C',
  left: '\x1b[1;5D',
};

/** The bytes a key writes, with Ctrl held or not. Ctrl itself writes nothing. */
export function keySequence(key: KeyBarKey, ctrl: boolean): string {
  return (ctrl ? WITH_CTRL[key] : undefined) ?? PLAIN[key];
}

const PUNCTUATION: Readonly<Record<string, string>> = {
  ' ': '\x00',
  '@': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  _: '\x1f',
  '?': '\x7f',
};

/** The control code Ctrl turns one character into (c → ^C), or null when it has none. */
export function ctrlChar(ch: string): string | null {
  if (ch.length !== 1) return null;
  const lower = ch.toLowerCase();
  if (lower >= 'a' && lower <= 'z') return String.fromCharCode(lower.charCodeAt(0) - 96);
  return PUNCTUATION[ch] ?? null;
}

export interface CtrlState {
  ctrl: boolean;
}

/** A key bar tap: Ctrl toggles; any other key is sent (modified when armed) and Ctrl lets go. */
export function pressKey(state: CtrlState, key: KeyBarKey): { send: string | null; ctrl: boolean } {
  if (key === 'ctrl') return { send: null, ctrl: !state.ctrl };
  return { send: keySequence(key, state.ctrl), ctrl: false };
}

/**
 * A character typed on the keyboard while Ctrl may be armed. `consumed`: it
 * became a control code and must not also land in the input line.
 */
export function typeWithCtrl(state: CtrlState, typed: string): { send: string | null; ctrl: boolean; consumed: boolean } {
  if (!state.ctrl) return { send: null, ctrl: false, consumed: false };
  const code = ctrlChar(typed);
  return code === null ? { send: null, ctrl: false, consumed: false } : { send: code, ctrl: false, consumed: true };
}
