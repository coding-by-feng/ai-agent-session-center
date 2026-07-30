/**
 * Trigger parsing for the queue prompt autocomplete.
 *
 * Three sigils are live inside a prompt textarea:
 *   `@name`  → project file reference   (every CLI)
 *   `/name`  → slash command            (every CLI)
 *   `$name`  → skill invocation         (Codex only — see `AutocompleteTextarea`)
 *
 * Codex addresses its skills as `$skill-name`, not `/skill-name`: its own TUI
 * opens a `$` popup, and the model's trigger rule is "if the user names a skill
 * with `$SkillName` … use that skill". A queued `/retouch-current-prompt` is a
 * no-op there, so the sigil is load-bearing, not cosmetic.
 *
 * Lifted out of `AutocompleteTextarea.tsx` so the precedence rule is unit
 * testable — it is the part that silently mis-fires when a sigil is added.
 */

export type TriggerType = 'command' | 'file' | 'skill';

export interface Trigger {
  type: TriggerType;
  /** Text between the sigil and the caret. Empty for a bare sigil. */
  query: string;
  /** Index of the sigil itself, used to splice the completion back in. */
  triggerStart: number;
}

const SIGILS: ReadonlyArray<{ char: string; type: TriggerType }> = [
  { char: '@', type: 'file' },
  { char: '/', type: 'command' },
  { char: '$', type: 'skill' },
];

/**
 * Find the active trigger for the caret at `pos`, or null when there is none.
 *
 * A sigil is only a trigger when it sits at the start of the text or directly
 * after whitespace (so `foo$bar`, `a/b` and `mail@example` stay inert), and
 * only while its fragment holds no whitespace (a completed `$skill do the
 * thing` has moved on — and a newline ends the token just as a space does).
 * The LAST qualifying sigil wins — checking them in a fixed order would let a
 * stale earlier sigil shadow the one being typed.
 */
export function parseTrigger(text: string, pos: number): Trigger | null {
  const before = text.slice(0, pos);
  let best: Trigger | null = null;

  for (const { char, type } of SIGILS) {
    const idx = before.lastIndexOf(char);
    if (idx < 0) continue;
    if (idx !== 0 && !/\s/.test(before[idx - 1])) continue;
    const frag = before.slice(idx + 1);
    if (/\s/.test(frag)) continue;
    if (!best || idx > best.triggerStart) {
      best = { type, query: frag, triggerStart: idx };
    }
  }

  return best;
}
