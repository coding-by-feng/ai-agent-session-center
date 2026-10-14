/**
 * EffortStepPicker — choose an effort level to add as a before/after chain step.
 *
 * A pick does not change any setting itself: the host appends a normal chain step
 * whose text is `/effort <level>` (see `lib/queueEffort`). Choosing a level in the
 * AFTER chain is how a prompt "resumes" the effort it had before.
 *
 * **Portaled on purpose**, exactly like `PromptSnippetPicker`: the triggers sit in
 * `.chainModalBody`, a scroll box that clips an absolutely positioned child on both
 * axes, and the flip/clamp maths measure the window — a boundary far outside the
 * real clip edge. Portal to <body>, `position: fixed`, place from the trigger's
 * viewport rect (`computeMovePickerPosition`). The AFTER trigger is the lowest
 * control in the modal, so the flip-up case is the common one here, not the edge.
 *
 * Hosts with a document-level Escape handler (`QueueItemEditModal`) must skip their
 * own close while this is open — stopPropagation cannot order two listeners on the
 * same node.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  computeMovePickerPosition,
  type HorizontalAlign,
} from '@/lib/queueMovePlacement';
import {
  EFFORT_STEP_LEVELS,
  EFFORT_TRIGGER_ATTR,
  effortLevelSavesDefault,
  type EffortLevel,
} from '@/lib/queueEffort';
import styles from '@/styles/modules/EffortStepPicker.module.css';

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

export default function EffortStepPicker({
  anchor,
  align = 'left',
  onPick,
  onClose,
}: EffortStepPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // ---- Placement --------------------------------------------------------
  // Measure then place, before paint; re-run on scroll/resize so the menu stays
  // glued to its trigger. `capture: true`: scroll events do not bubble.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;

    const place = () => {
      const a = anchor.getBoundingClientRect();
      const m = el.getBoundingClientRect();
      const next = computeMovePickerPosition(
        { top: a.top, bottom: a.bottom, right: a.right, left: a.left },
        { width: m.width, height: m.height },
        { width: window.innerWidth, height: window.innerHeight },
        align,
      );
      setPos((prev) =>
        prev && prev.top === next.top && prev.left === next.left ? prev : next,
      );
    };

    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor, align]);

  /** Close, and hand focus back to the trigger — for the paths the keyboard owns
   *  (Escape, a pick). An outside click leaves focus wherever the user put it. */
  const closeToTrigger = useCallback(() => {
    onClose();
    if (anchor?.isConnected) anchor.focus();
  }, [onClose, anchor]);

  // Close on outside click, but never on a trigger — that button owns the toggle,
  // and closing here first would make it immediately re-open.
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (target.closest(`[${EFFORT_TRIGGER_ATTR}]`)) return;
      onClose();
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') closeToTrigger();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [closeToTrigger]);

  // Land on the first level so the menu works without a mouse. Only once it has been
  // placed: until then it is `visibility: hidden`, and a browser silently refuses to
  // focus a hidden element (jsdom does not, which is how this hid from the unit tests).
  const placed = pos !== null;
  useEffect(() => {
    if (placed) itemRefs.current[0]?.focus();
  }, [placed]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Tab leaves a menu: close it and put focus back on the trigger BEFORE the default
    // action runs, so Tab continues from the trigger instead of from a node portaled to
    // the end of <body> (where it would jump out of the dialog).
    if (e.key === 'Tab') {
      closeToTrigger();
      return;
    }
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null);
    const current = items.findIndex((el) => el === (e.target as HTMLElement).closest('button'));
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  }, [closeToTrigger]);

  const handlePick = useCallback(
    (level: EffortLevel) => {
      onPick(level);
      closeToTrigger();
    },
    [onPick, closeToTrigger],
  );

  return createPortal(
    <div
      ref={ref}
      className={styles.picker}
      // `top`/`left` are written inline: they come from measuring the trigger. Hidden
      // for the single pre-measure frame so the menu never flashes in the top-left.
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
      role="menu"
      aria-label="Set effort"
      onKeyDown={handleKeyDown}
    >
      {EFFORT_STEP_LEVELS.map((level, i) => (
        <button
          key={level}
          ref={(el) => { itemRefs.current[i] = el; }}
          type="button"
          role="menuitem"
          className={styles.item}
          title={rowTitle(level)}
          onClick={() => handlePick(level)}
        >
          <span className={styles.level}>{level}</span>
          <span className={styles.scope}>
            {effortLevelSavesDefault(level) ? 'saves default' : 'session only'}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** Small gauge glyph for the trigger — same footprint as `BookmarkStackIcon`. */
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
