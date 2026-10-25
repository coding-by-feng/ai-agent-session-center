/**
 * TerminalCommandMenu — the `/` command list inside a Claude or Codex session's
 * terminal. Typing `/` after other prompt text opens every matching slash
 * command and skill (the same index, groups and rows as the queue editor's
 * list) above the caret; ↑/↓ move, Tab types the rest of the name into the
 * terminal (so does Enter, once ↑/↓ picked a row), Esc closes the list only.
 *
 * Renders nothing itself until there are matches: it listens to the terminal
 * through `setInputTap` and decides with the pure rules in
 * `src/lib/terminalCommandTrigger.ts` (including why a `/` at the very start of
 * the input is left to the CLI's own list).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchCommandIndex } from '@/lib/commandIndex';
import { buildCommandMenu, terminalMenuKinds, type CommandMenuItem, type CommandMenuGroupSpan } from '@/lib/commandMenu';
import {
  advanceToken,
  completionKeys,
  ECHO_GRACE_MS,
  lastTypedAfter,
  placeMenuAtCaret,
  startsToken,
  type CaretRect,
  type TerminalToken,
} from '@/lib/terminalCommandTrigger';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import type { TerminalInputTap } from '@/hooks/useTerminal';
import CommandMenuDropdown from '@/components/ui/CommandMenuDropdown';

interface TerminalCommandMenuProps {
  cli: 'claude' | 'codex';
  projectPath?: string | null;
  setInputTap: (tap: TerminalInputTap | null) => void;
  getCaretRect: () => CaretRect | null;
  sendKeys: (data: string) => void;
}

interface OpenMenu {
  items: CommandMenuItem[];
  groups: CommandMenuGroupSpan[];
  selectedIdx: number;
  /** ↑/↓ chose a row since the list last changed: only then does Enter insert. */
  moved: boolean;
  style: React.CSSProperties;
}

export const TERMINAL_MENU_KEYS_HINT = '↑↓ move · Tab insert · Esc close';

export default function TerminalCommandMenu({
  cli,
  projectPath,
  setInputTap,
  getCaretRect,
  sendKeys,
}: TerminalCommandMenuProps) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  // The tap runs outside React (xterm's handlers), so it reads refs, never state.
  const menuRef = useRef<OpenMenu | null>(null);
  const tokenRef = useRef<TerminalToken | null>(null);
  /** The cell the `/` went into, captured at that keystroke. */
  const slashRef = useRef<CaretRect | null>(null);
  /** A keydown the menu took; its keypress/keyup must not reach xterm either. */
  const swallowRef = useRef<string | null>(null);
  /** The character typed last and when, for keystrokes that beat their echo. */
  const lastTypedRef = useRef<{ ch: string; at: number } | null>(null);
  const propsRef = useRef({ cli, projectPath, getCaretRect, sendKeys });
  useEffect(() => {
    propsRef.current = { cli, projectPath, getCaretRect, sendKeys };
  }, [cli, projectPath, getCaretRect, sendKeys]);

  const show = useCallback((next: OpenMenu | null) => {
    menuRef.current = next;
    setMenu(next);
  }, []);

  const close = useCallback(() => {
    tokenRef.current = null;
    slashRef.current = null;
    show(null);
  }, [show]);

  const refresh = useCallback(async (token: TerminalToken) => {
    const { cli: c, projectPath: path } = propsRef.current;
    let entries;
    try {
      entries = await fetchCommandIndex(c, path ?? null);
    } catch {
      return; // the index is a convenience; typing goes on without it
    }
    // A later keystroke already moved the token on (or ended it).
    if (tokenRef.current !== token) return;
    const notes = useSkillNotesStore.getState().notes;
    const { items, groupSpans } = buildCommandMenu(entries, token.query, 'command', c, notes, terminalMenuKinds());
    const slash = slashRef.current;
    if (items.length === 0 || !slash) {
      show(null);
      return;
    }
    const place = placeMenuAtCaret(slash, { width: window.innerWidth, height: window.innerHeight });
    show({
      items,
      groups: groupSpans,
      selectedIdx: 0,
      moved: false,
      style: {
        left: place.left,
        width: place.width,
        maxHeight: `${place.maxHeight}px`,
        ...(place.top !== undefined ? { top: place.top } : { bottom: place.bottom }),
      },
    });
  }, [show]);

  const accept = useCallback((item: CommandMenuItem) => {
    const token = tokenRef.current;
    if (!token) return;
    propsRef.current.sendKeys(completionKeys(token, item.insert));
    close();
    // The completion ends in a space: a `/` typed before its echo starts the next token.
    lastTypedRef.current = { ch: ' ', at: Date.now() };
  }, [close]);

  const tap = useMemo<TerminalInputTap>(() => ({
    onKey(e) {
      if (e.type !== 'keydown') {
        const mine = swallowRef.current === e.key;
        if (mine && e.type === 'keyup') swallowRef.current = null;
        return mine;
      }
      const open = menuRef.current;
      if (!open || e.isComposing) return false;
      const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
      const take = () => {
        swallowRef.current = e.key;
        return true;
      };
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const n = open.items.length;
        show({ ...open, selectedIdx: (open.selectedIdx + step + n) % n, moved: true });
        return take();
      }
      if (e.key === 'Escape') {
        close();
        return take();
      }
      if ((e.key === 'Tab' || e.key === 'Enter') && plain) {
        const item = open.items[open.selectedIdx];
        if (!item || !tokenRef.current) return false;
        // Untouched, Enter submits the prompt as typed: matching is substring-wide,
        // so a prompt ending in `/api` would otherwise turn into `/claude-api`.
        if (e.key === 'Enter' && !open.moved) {
          close();
          return false;
        }
        accept(item);
        return take();
      }
      return false;
    },
    onData(data, caret) {
      const now = Date.now();
      const last = lastTypedRef.current;
      const lastTyped = last && now - last.at < ECHO_GRACE_MS ? last.ch : null;
      const typed = lastTypedAfter(data);
      lastTypedRef.current = typed === null ? null : { ch: typed, at: now };
      const token = tokenRef.current;
      let next: TerminalToken | null;
      if (token) {
        next = advanceToken(token, data);
      } else if (startsToken(data, caret, lastTyped)) {
        next = { query: '' };
        slashRef.current = propsRef.current.getCaretRect();
      } else {
        return;
      }
      if (!next) {
        close();
        return;
      }
      tokenRef.current = next;
      void refresh(next);
    },
    onReset() {
      close();
      lastTypedRef.current = null;
    },
  }), [accept, close, refresh, show]);

  useEffect(() => {
    setInputTap(tap);
    return () => setInputTap(null);
  }, [setInputTap, tap]);

  if (!menu) return null;
  return (
    <CommandMenuDropdown
      items={menu.items}
      groups={menu.groups}
      selectedIdx={menu.selectedIdx}
      style={menu.style}
      onPick={accept}
      keysHint={TERMINAL_MENU_KEYS_HINT}
      ariaLabel="Commands and skills"
    />
  );
}
