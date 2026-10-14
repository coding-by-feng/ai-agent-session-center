/**
 * ModelStepPicker — choose a Claude model to add as a before/after chain step.
 *
 * A pick does not change any setting itself: the host appends a normal chain step
 * whose text is `/model <name>` (see `lib/queueModel`). A BEFORE step runs the prompt
 * on that model; an AFTER step switches back.
 *
 * Placement, keyboard and close behaviour live in `ChainCommandPicker`, shared with
 * the "Set effort…" menu.
 */
import type { HorizontalAlign } from '@/lib/queueMovePlacement';
import {
  MODEL_STEP_OPTIONS,
  MODEL_TRIGGER_ATTR,
  isModelAlias,
  type ModelOption,
} from '@/lib/queueModel';
import ChainCommandPicker, { type ChainCommandItem } from './ChainCommandPicker';

interface ModelStepPickerProps {
  /** The button this menu hangs off. Placement is measured from its rect. */
  anchor: HTMLElement | null;
  /** Which trigger edge to line up with. */
  align?: HorizontalAlign;
  /** The chosen model. The picker closes itself after. */
  onPick: (model: ModelOption) => void;
  onClose: () => void;
}

const MODEL_ITEMS: readonly ChainCommandItem<ModelOption>[] = MODEL_STEP_OPTIONS.map((model) =>
  isModelAlias(model)
    ? { value: model, note: 'latest', title: `The newest ${model} model.` }
    : { value: model, note: 'pinned', title: `Exactly ${model}, even after newer models ship.` },
);

/**
 * Claude Code answers `/model` with "saved as your default for new sessions", so a
 * BEFORE step whose AFTER step never runs (a deleted item, a cleared queue) leaves
 * that default changed — the menu says so.
 */
const DEFAULT_NOTE = 'Also saved as your default for new sessions.';

export default function ModelStepPicker({ anchor, align = 'left', onPick, onClose }: ModelStepPickerProps) {
  return (
    <ChainCommandPicker
      anchor={anchor}
      align={align}
      label="Set model"
      items={MODEL_ITEMS}
      triggerAttr={MODEL_TRIGGER_ATTR}
      tone="model"
      footer={DEFAULT_NOTE}
      onPick={onPick}
      onClose={onClose}
    />
  );
}

/** Small chip glyph for the trigger — same footprint as `EffortIcon`. */
export function ModelIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </svg>
  );
}
