/**
 * useTextareaCaret — a textarea's focus and caret, followed through its own events
 * (React's onSelect misses a programmatic caret move), for the phone's suggestion
 * bar and the Chat composer's command list.
 *
 * A blur reports `focused: false` only after BLUR_SETTLE_MS (Oct 21 2026): a tap on a
 * button under the box blurs it first, and whatever hid at once with the focus (the
 * suggestion bar, 54 px) moved that button out from under the finger before the click
 * landed — the tap missed and had to be repeated. Focus coming back cancels it.
 */
import { useEffect, useState } from 'react';

/** Longer than a tap takes from touchstart to click; short enough to read as immediate. */
export const BLUR_SETTLE_MS = 350;

/** Follow a textarea's focus and caret through its own events. */
export function useTextareaCaret(textarea: HTMLTextAreaElement | null): {
  focused: boolean;
  caret: number | null;
  /** Where a programmatic edit left the caret (setting `value` fires no event of its own). */
  moveCaret: (at: number) => void;
} {
  // The box may already have focus when the bar mounts: the bar loads lazily
  // (AASC-31), and a quick tap can land before it does.
  const [state, setState] = useState<{ el: HTMLTextAreaElement | null; focused: boolean; caret: number | null }>(() =>
    textarea && document.activeElement === textarea
      ? { el: textarea, focused: true, caret: textarea.selectionStart }
      : { el: null, focused: false, caret: null });
  useEffect(() => {
    if (!textarea) return;
    let blurTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelBlur = () => {
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = null;
    };
    const sync = () => {
      // The box is ours again (or still): a settle in flight would hide what is in use.
      if (document.activeElement === textarea) cancelBlur();
      if (blurTimer) return;
      setState({ el: textarea, focused: document.activeElement === textarea, caret: textarea.selectionStart });
    };
    const blur = () => {
      cancelBlur();
      blurTimer = setTimeout(() => {
        blurTimer = null;
        setState((s) => ({ ...s, el: textarea, focused: false }));
      }, BLUR_SETTLE_MS);
    };
    const events = ['focus', 'input', 'keyup', 'click', 'select'] as const;
    for (const e of events) textarea.addEventListener(e, sync);
    textarea.addEventListener('blur', blur);
    const onSelection = () => {
      if (document.activeElement === textarea) sync();
    };
    document.addEventListener('selectionchange', onSelection);
    return () => {
      cancelBlur();
      for (const e of events) textarea.removeEventListener(e, sync);
      textarea.removeEventListener('blur', blur);
      document.removeEventListener('selectionchange', onSelection);
    };
  }, [textarea]);
  const moveCaret = (at: number) => setState({ el: textarea, focused: true, caret: at });
  // A swapped textarea starts over (focus and caret belonged to the old one).
  return state.el === textarea
    ? { focused: state.focused, caret: state.caret, moveCaret }
    : { focused: false, caret: null, moveCaret };
}
