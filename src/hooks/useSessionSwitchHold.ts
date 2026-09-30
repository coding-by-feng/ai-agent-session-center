/**
 * useSessionSwitchHold — Cmd+Tab-style session switcher.
 *
 * Hold Cmd (macOS) / Ctrl (other) and tap E repeatedly to cycle a highlight
 * through recently-active sessions; releasing the modifier commits the
 * highlighted session. Escape, or the window losing focus, cancels without
 * switching.
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
      const len = itemsRef.current.length;
      if (len === 0) return;
      indexRef.current = (indexRef.current + 1) % len;
      setHighlightedIndex(indexRef.current);
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
    document.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleLostFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleLostFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [cancel, commit]);

  return { open, items, highlightedIndex, commit, cancel };
}
