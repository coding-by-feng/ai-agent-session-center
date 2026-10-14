/**
 * Predefined effort steps for the queue's before/after chains.
 *
 * A step is nothing special to the scheduler: it is an ordinary chain step whose
 * text is the `/effort <level>` slash command, so the picker only has to write
 * that text and nothing in the queue's storage or sync changes.
 *
 * Import-free apart from the shared level list, so the scheduler and the editor
 * can both depend on it without pulling in a store or a component.
 */
import { EFFORT_LEVELS } from '@/lib/remoteControlName';

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Marker attribute on any button that opens the effort picker — clicks on it are
 *  exempt from the picker's outside-click close, so the button keeps its toggle. */
export const EFFORT_TRIGGER_ATTR = 'data-effort-trigger';

/** Levels the picker offers, in the order the session modals list them.
 *  `ultracode` is included on purpose: only the `--effort` launch flag rejects
 *  it, the `/effort` slash command takes it. */
export const EFFORT_STEP_LEVELS: readonly EffortLevel[] = EFFORT_LEVELS;

/** The chain-step text that sets a level. */
export function effortStepText(level: EffortLevel): string {
  return `/effort ${level}`;
}

const EFFORT_COMMAND_RE = new RegExp(`^\\s*/effort\\s+(?:${EFFORT_LEVELS.join('|')})\\s*$`);

/**
 * True when `text` is exactly one `/effort <level>` command.
 *
 * Deliberately strict — a bare `/effort` opens a picker, an unknown level only
 * prints an error, and neither is the silent one-shot the scheduler may release
 * early. Anything else (extra words, a second line) is an ordinary prompt.
 */
export function isEffortCommand(text: string): boolean {
  return EFFORT_COMMAND_RE.test(text);
}

/**
 * Does `/effort <level>` also become the saved default for new sessions?
 *
 * Observed on Claude Code 2.1.296: `low`/`medium`/`high`/`xhigh` answer "saved as
 * your default for new sessions" and write `modelSettings.<model>.effortLevel`
 * into `~/.claude/settings.json`; `max` and `ultracode` answer "this session only".
 * The picker says so, because a before-step whose after-step never runs
 * (a deleted item, a cleared queue) would otherwise leave that default changed.
 */
export function effortLevelSavesDefault(level: EffortLevel): boolean {
  return level !== 'max' && level !== 'ultracode';
}
