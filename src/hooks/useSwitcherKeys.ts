/**
 * useSwitcherKeys — the devices switcher from the keyboard (plan 18 §5.4).
 *
 * **Where focus lands when the panel opens on Switch** (`focusOnOpen`): the search field when it is shown, else the
 * first row's primary action that can be pressed. The rows arrive in two steps (this app's own records in a few
 * milliseconds, the account's computers after a round trip to AASC Cloud), so focus is aimed when the first rows are
 * drawn and once more when the account answers, and only while the person has not moved it. With no row at all it
 * goes to the part's first control once the account has answered. Coming back to Switch by its tab is not an opening
 * and moves no focus.
 *
 * **↑ ↓ Home End** move between the rows' primary actions (`PRIMARY_ACTION`: Open, Connect, Dismiss) in the order
 * drawn, without wrapping. From the search field ↓ goes to the first row and ↑ from the first row goes back to it;
 * the field keeps ↑, Home and End for its caret. The keys are taken only from those two places: a rename field, the
 * pairing-link form, a row's ⋯ button, its open menu (which bubbles here through React although it is portaled to
 * <body>) and everything else keep their own. An arrow held with a modifier is someone else's key (⌥⌘↑ maximizes an
 * AI popup). Tab order is untouched: every action stays a tab stop.
 */
import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

/** Marks a row's primary action for the keys above. */
export const PRIMARY_ACTION = 'data-primary-action';

const PRESSABLE_ACTIONS = `[${PRIMARY_ACTION}]:not([disabled])`;
const FIRST_CONTROL = 'button:not([disabled]), a[href]';
const MOVES: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

export interface SwitcherKeysOptions {
  rootRef: RefObject<HTMLElement | null>;
  /** The search field's input; its `current` is null while the field is not shown. */
  searchRef: RefObject<HTMLInputElement | null>;
  /** The panel has just opened on this part. Read once, when the part mounts. */
  focusOnOpen: boolean;
  /** The first rows are drawn (this app's own records are read). */
  drawn: boolean;
  /** The account has answered, whatever it said: the list is whole. */
  settled: boolean;
}

function actionsIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(PRESSABLE_ACTIONS)];
}

export function useSwitcherKeys({ rootRef, searchRef, focusOnOpen, drawn, settled }: SwitcherKeysOptions): (e: KeyboardEvent) => void {
  /** What the opening focused last, and whether it has finished aiming. */
  const aim = useRef<{ target: HTMLElement | null; done: boolean }>({ target: null, done: !focusOnOpen });

  useEffect(() => {
    const state = aim.current;
    const root = rootRef.current;
    if (state.done || !drawn || !root) return;
    const active = document.activeElement;
    // Inside the part and not where the opening put it: the person moved it. Leave it, for good.
    if (active instanceof HTMLElement && root.contains(active) && active !== state.target) {
      state.done = true;
      return;
    }
    const next = searchRef.current ?? actionsIn(root)[0] ?? (settled ? root.querySelector<HTMLElement>(FIRST_CONTROL) : null);
    if (next && next !== active) next.focus();
    if (next) state.target = next;
    if (settled) state.done = true;
  });

  return (e) => {
    if (!MOVES.has(e.key) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return;
    const root = rootRef.current;
    const from = e.target;
    if (!root || !(from instanceof HTMLElement)) return;
    const actions = actionsIn(root);
    const search = searchRef.current;
    if (from === search) {
      if (e.key !== 'ArrowDown' || actions.length === 0) return;
      e.preventDefault();
      actions[0].focus();
      return;
    }
    const at = actions.indexOf(from);
    if (at < 0) return;
    // Taken even where nothing moves (↓ on the last row): the panel must not scroll under a key that moves focus.
    e.preventDefault();
    if (e.key === 'Home') actions[0].focus();
    else if (e.key === 'End') actions[actions.length - 1].focus();
    else if (e.key === 'ArrowDown') actions[at + 1]?.focus();
    else if (at > 0) actions[at - 1].focus();
    else search?.focus();
  };
}
