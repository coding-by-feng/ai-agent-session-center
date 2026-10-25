// menuMark.ts — the menu-open marks key_send reads (P3 fix, finding D-I1): which terminals show a menu AASC knows of
// that no hook reports.
//
// command_run sets a terminal's mark when it types Codex's `/review` (`OPENS_MENU`: bare, it opens its preset menu;
// `/code-review` and the other built-ins set none, ruling P3-37) into an idle card: typed mid-turn, no menu opens
// (ruling P3-40). The keys route also ignores a mark while the card is mid-turn. The keys route (server/sessionKeysRouter.ts) then lets
// up, down, enter, tab and the digits through to that terminal, and refuses them elsewhere unless a dialog AASC tracks
// is open. The mark is used up by the first enter, digit or esc it alone lets through (`endMenuMark`): each picks,
// confirms or closes the menu, and after it up and enter would replay the prompt history. Only up, down and tab keep
// it. Keys a tracked dialog lets through leave it alone. A mark holds for
// `MENU_MARK_MS`, and ends as soon as the card has had a hook later than `MENU_MARK_GRACE_MS` after it was set: the
// card's `lastActivityAt` (which every hook bumps) is past mark + grace, so the menu was answered, closed or replaced by
// a turn. A hook inside the grace window does not count: it is most likely the command's own UserPromptSubmit as it is
// typed. Comparing the two times keeps the hook path untouched.
//
// In memory only, keyed by terminal (a re-key keeps the terminal): after a restart no menu is known open, and the
// central opens it again. No store, PTY or socket.

/** How long a mark holds when no hook comes. */
export const MENU_MARK_MS = 60_000;

/** A hook this soon after the mark is the command's own (its prompt hook as it is typed), and leaves the mark. */
export const MENU_MARK_GRACE_MS = 5_000;

const marks = new Map<string, number>();

/** command_run typed a run-only built-in into this terminal at `at`. */
export function markMenuOpen(terminalId: string, at: number): void {
  marks.set(terminalId, at);
}

/**
 * Is a menu known open in this terminal: a mark younger than `MENU_MARK_MS`, and no hook later than its grace window
 * (`lastHookAt`, the card's `lastActivityAt`, is not past mark + `MENU_MARK_GRACE_MS`)? A mark that no longer holds is
 * dropped.
 */
export function menuMarked(terminalId: string, lastHookAt: number, now: number): boolean {
  const at = marks.get(terminalId);
  if (at === undefined) return false;
  if (now - at >= MENU_MARK_MS || lastHookAt > at + MENU_MARK_GRACE_MS) {
    marks.delete(terminalId);
    return false;
  }
  return true;
}

/** The menu was answered or closed: its mark is used up. */
export function endMenuMark(terminalId: string): void {
  marks.delete(terminalId);
}

/** Forgets every mark (tests). */
export function clearMenuMarks(): void {
  marks.clear();
}
