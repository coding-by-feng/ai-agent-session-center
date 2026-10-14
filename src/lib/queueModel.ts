/**
 * Predefined model steps for the queue's before/after chains — the sibling of
 * `queueEffort.ts`.
 *
 * A step is an ordinary chain step whose text is the `/model <name>` slash command,
 * so the picker only writes text and nothing in the queue's storage or sync changes.
 *
 * Import-free apart from the shared model list, so the scheduler and the editor can
 * both depend on it without pulling in a store or a component.
 */
import { MODEL_OPTIONS } from '@/lib/remoteControlName';

export type ModelOption = (typeof MODEL_OPTIONS)[number];

/** Marker attribute on any button that opens the model picker — clicks on it are
 *  exempt from the picker's outside-click close, so the button keeps its toggle. */
export const MODEL_TRIGGER_ATTR = 'data-model-trigger';

/** Models the picker offers: the same list the session creation modals use, tier
 *  aliases first, then pinned IDs. */
export const MODEL_STEP_OPTIONS: readonly ModelOption[] = MODEL_OPTIONS;

/** The chain-step text that switches the session's model. */
export function modelStepText(model: string): string {
  return `/model ${model}`;
}

/** A tier alias (`opus`) follows the newest model in its tier; a full ID is pinned. */
export function isModelAlias(model: string): boolean {
  return !model.startsWith('claude-');
}

const MODEL_COMMAND_RE = /^\s*\/model\s+[A-Za-z0-9._[\]-]+\s*$/;

/**
 * True when `text` is exactly one `/model <name>` command.
 *
 * Any single name counts, not just the listed ones: a step can carry a pinned ID
 * typed by hand, and an unknown name only prints an error — either way no turn runs.
 * A bare `/model` is excluded on purpose: it opens an interactive picker, and the
 * scheduler must never release the next step into it.
 */
export function isModelCommand(text: string): boolean {
  return MODEL_COMMAND_RE.test(text);
}
