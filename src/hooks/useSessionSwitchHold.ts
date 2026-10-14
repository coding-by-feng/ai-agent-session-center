/**
 * useSessionSwitchHold — Cmd+Tab-style session switcher.
 *
 * Hold Cmd (macOS) / Ctrl (other) and tap E repeatedly to cycle a highlight
 * through recently-active sessions; releasing the modifier commits the
 * highlighted session. While the popup is open the Up / Down arrows move the
 * highlight too, in either direction (E only goes forward); both wrap.
 * Escape, or the window losing focus, cancels without switching.
 *
 * This is a genuinely different interaction shape from everything else in
 * useKeyboardShortcuts.ts — that hook is one-shot keydown dispatch with no
 * concept of a held modifier or a keyup-driven commit — so it owns an
 * independent pair of document-level listeners rather than a slot in the
 * static ACTION_IDS/dispatchAction table. Consequence: this gesture is NOT
 * currently rebindable via Settings > Shortcuts (see keyboard-shortcuts.md).
 *
 * Unlike most of useKeyboardShortcuts.ts's bindings, this listener is NOT
 * gated on isTyping()/xterm focus. The trigger always requires metaKey (Mac)
 * or ctrlKey (other), and no browser produces a plain "e" text keystroke
 * while that modifier is held — so there is nothing here that could collide
 * with normal typing, in a plain input or inside xterm's hidden textarea.
 *
 * Focus is deliberately never moved into the popup: the listeners are on
 * `document`, which sees keydown/keyup regardless of where DOM focus sits,
 * so yanking focus away from (say) an actively-typed terminal is never
 * necessary and would only be disruptive.
 *
 * The lost-focus cancel (below) listens to `blur`/`visibilitychange`
 * directly inside the same effect as the key listeners, rather than reading
 * `useWindowActivity()`'s derived `focused` boolean through a second
 * `useEffect([focused, ...])`. The derived-boolean shape calls `cancel()`
 * (a setState) synchronously in an effect body reacting to a dependency
 * change, which is exactly what the `react-hooks/set-state-in-effect` rule
 * flags — the same class of lint error CLAUDE.md already documents
 * resurfacing elsewhere in this codebase. Reacting to the raw DOM event
 * inside an addEventListener callback (like the keydown/keyup handlers
 * already do) keeps the setState call inside an async event callback
 * instead of the effect's synchronous body, which is the actual distinction
 * the rule cares about.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { sortSessionsByActivity } from '@/lib/sessionSort';
import { isMac } from '@/lib/shortcutKeys';
import type { Session } from '@/types';

export interface SessionSwitchHoldState {
  open: boolean;
  /** Recency-ordered candidates (pinned first, then most-recently-active),
   *  excluding the currently selected session and any that have ended. */
  items: Session[];
  highlightedIndex: number;
  /** Commit the item at `index` and close. Exposed so a row click can select
   *  directly, independent of the hold/release gesture. */
  commit: (index: number) => void;
  cancel: () => void;
}

export function useSessionSwitchHold(): SessionSwitchHoldState {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Session[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  // Mirror the state above in refs so the listener effect can stay mounted
  // once (no deps churn from `open`/`items`/`highlightedIndex` changing) while
  // still reading the latest values at event time.
  const itemsRef = useRef<Session[]>([]);
  const indexRef = useRef(0);
  const openRef = useRef(false);

  const close = useCallback(() => {
    openRef.current = false;
    setOpen(false);
  }, []);

  const commit = useCallback((index: number) => {
    const target = itemsRef.current[index];
    close();
    if (target) {
      useSessionStore.getState().selectSession(target.sessionId);
    }
  }, [close]);

  const cancel = useCallback(() => {
    close();
  }, [close]);

  useEffect(() => {
    /** Move the highlight by one row, wrapping at both ends. */
    function step(delta: 1 | -1) {
      const len = itemsRef.current.length;
      if (len === 0) return;
      indexRef.current = (indexRef.current + delta + len) % len;
      setHighlightedIndex(indexRef.current);
    }

    function openOrAdvance() {
      if (!openRef.current) {
        const { sessions, selectedSessionId } = useSessionStore.getState();
        const candidates = sortSessionsByActivity(
          [...sessions.values()].filter(
            (s) => s.status !== 'ended' && s.sessionId !== selectedSessionId,
          ),
        );
        if (candidates.length === 0) return; // nothing to switch to — no-op
        itemsRef.current = candidates;
        indexRef.current = 0;
        setItems(candidates);
        setHighlightedIndex(0);
        openRef.current = true;
        setOpen(true);
        return;
      }
      step(1);
    }

    function handleKeyDown(e: KeyboardEvent) {
      const modifierDown = isMac ? e.metaKey : e.ctrlKey;
      if (modifierDown && e.key.toLowerCase() === 'e') {
        if (e.repeat) return; // OS auto-repeat — only discrete taps advance
        e.preventDefault();
        openOrAdvance();
        return;
      }
      if (openRef.current && e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    }

    // Up / Down while the popup is open. Registered in the CAPTURE phase and
    // swallowed: the focused element runs before a bubbling `document` listener
    // (like handleKeyDown above), so by then a terminal has already been sent
    // the key (Ctrl+Up is `ESC[1;5A` to the PTY, the switcher's modifier off
    // macOS), a textarea has moved its caret, and AutocompleteTextarea / Select
    // / Combobox have moved their own selection. Whatever else is held with the
    // modifier does not matter: while the popup is up the arrows are its keys.
    // Unlike E, an auto-repeating arrow is deliberate (travelling a long list),
    // so `e.repeat` is not filtered. Closed popup: not touched, not prevented.
    //
    // Two edges. An IME candidate list (`isComposing`) owns the arrows, so they
    // are left to it. And an arrow still held when the modifier is released keeps
    // auto-repeating into whatever has focus AFTER the commit (the new session's
    // terminal, which would get `ESC[B`), without the modifier that used to mark
    // it: its repeats are swallowed until the next key that is not a repeat. Not
    // until its keyup: macOS sends none for a key released while Cmd is held.
    let swallowedArrow: string | null = null;
    function handleArrowKeys(e: KeyboardEvent) {
      const isArrow = e.key === 'ArrowDown' || e.key === 'ArrowUp';
      if (openRef.current && isArrow && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        swallowedArrow = e.key;
        step(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (swallowedArrow === null) return;
      if (isArrow && e.repeat && e.key === swallowedArrow) {
        e.preventDefault();
        e.stopPropagation();
      } else if (!e.repeat) {
        swallowedArrow = null;
      }
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (!openRef.current) return;
      const releasedModifier = isMac ? e.key === 'Meta' : e.key === 'Control';
      if (releasedModifier) {
        commit(indexRef.current);
      }
    }

    // Force-cancel if the window loses focus while open. Without this, a
    // keyup that fires outside this window — e.g. genuinely Cmd-Tabbing to
    // another app while E is still physically held — never reaches
    // handleKeyUp above, and the popup is stuck open forever with no way to
    // close it. Same hazard shape as the pop-out-terminal WebSocket race
    // elsewhere in this app: a mechanism that reacts to only one specific
    // event can be left waiting on an event that will never come.
    // `blur` covers losing OS focus to another app/window; `visibilitychange`
    // additionally covers minimize / switching virtual desktops / hiding the
    // tab, which don't always fire `blur`.
    function handleLostFocus() {
      if (openRef.current) cancel();
    }
    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden' && openRef.current) cancel();
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keydown', handleArrowKeys, true);
    document.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleLostFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keydown', handleArrowKeys, true);
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleLostFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [cancel, commit]);

  return { open, items, highlightedIndex, commit, cancel };
}
