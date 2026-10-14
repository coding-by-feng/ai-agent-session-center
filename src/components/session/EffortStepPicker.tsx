/**
 * EffortStepPicker — choose an effort level to add as a before/after chain step.
 *
 * A pick does not change any setting itself: the host appends a normal chain step
 * whose text is `/effort <level>` (see `lib/queueEffort`). Choosing a level in the
 * AFTER chain is how a prompt "resumes" the effort it had before.
 *
 * Placement, keyboard and close behaviour live in `ChainCommandPicker`, shared with
 * the "Set model…" menu.
 */
import type { HorizontalAlign } from '@/lib/queueMovePlacement';
import {
  EFFORT_STEP_LEVELS,
  EFFORT_TRIGGER_ATTR,
  effortLevelSavesDefault,
  type EffortLevel,
} from '@/lib/queueEffort';
import ChainCommandPicker, { type ChainCommandItem } from './ChainCommandPicker';

interface EffortStepPickerProps {
  /** The button this menu hangs off. Placement is measured from its rect. */
  anchor: HTMLElement | null;
  /** Which trigger edge to line up with. Left for a trigger at a wide container's left. */
  align?: HorizontalAlign;
  /** The chosen level. The picker closes itself after. */
  onPick: (level: EffortLevel) => void;
  onClose: () => void;
}

/** What the row's tooltip says about where the level lands. */
function rowTitle(level: EffortLevel): string {
  if (level === 'ultracode') {
    return 'Max effort plus dynamic workflows on every task. Lasts for this session only.';
  }
  return effortLevelSavesDefault(level)
    ? 'Also becomes your saved default for new sessions (per model).'
    : 'Lasts for this session only.';
}

const EFFORT_ITEMS: readonly ChainCommandItem<EffortLevel>[] = EFFORT_STEP_LEVELS.map((level) => ({
  value: level,
  note: effortLevelSavesDefault(level) ? 'saves default' : 'session only',
  title: rowTitle(level),
}));

export default function EffortStepPicker({ anchor, align = 'left', onPick, onClose }: EffortStepPickerProps) {
  return (
    <ChainCommandPicker
      anchor={anchor}
      align={align}
      label="Set effort"
      items={EFFORT_ITEMS}
      triggerAttr={EFFORT_TRIGGER_ATTR}
      tone="effort"
      onPick={onPick}
      onClose={onClose}
    />
  );
}

/** Small bolt glyph for the trigger — same footprint as `BookmarkStackIcon`. */
export function EffortIcon() {
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
      <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
    </svg>
  );
}
