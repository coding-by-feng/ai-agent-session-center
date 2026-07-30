/**
 * QueueMovePicker — dropdown that lists the other live sessions as move targets
 * for a queue item.
 *
 * Styled to match the shared `Select` dropdown (same surface, border, radius,
 * hover treatment) so it reads as part of the active theme rather than a raw
 * slab.
 *
 * **Portaled on purpose.** The queue rows live inside `.queueBody`, a 250px-tall
 * `overflow-y: auto` scroll box. An absolutely-positioned menu inside that box is
 * clipped by it on BOTH axes (per CSS overflow rules a `visible` axis computes to
 * `auto` when the other is `auto`), so the list could only ever render cropped —
 * and the usual guards were measuring the wrong boundary: `useDropdownFlipX`
 * against `window.innerWidth` and the flip-up against `window.innerHeight`, both
 * hundreds of px past the real 250px clip edge, so the flip never fired. Moving
 * the menu to `document.body` as `position: fixed` removes the clip entirely and
 * makes the viewport genuinely the containing block, so the measurements below
 * are correct rather than merely nominal. Same approach as `SelectionPopup`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { computeMovePickerPosition } from '@/lib/queueMovePlacement';
import styles from '@/styles/modules/Terminal.module.css';

/**
 * Marker attribute on the MOVE button. Clicks on any trigger are exempt from
 * the outside-click close so the button keeps its own open/close toggle (and so
 * another row's MOVE hands the picker over instead of just closing this one).
 */
export const MOVE_TRIGGER_ATTR = 'data-queue-move-trigger';

export interface QueueMoveTarget {
  id: string;
  projectName?: string;
  title?: string;
}

interface QueueMovePickerProps {
  /** The MOVE button this menu hangs off. Placement is measured from its rect. */
  anchor: HTMLElement | null;
  targets: QueueMoveTarget[];
  onSelect: (sessionId: string) => void;
  onClose: () => void;
}

export default function QueueMovePicker({
  anchor,
  targets,
  onSelect,
  onClose,
}: QueueMovePickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [highlighted, setHighlighted] = useState(-1);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Measure then place, before paint. Re-runs on scroll/resize so the menu stays
  // glued to its trigger while `.queueBody` scrolls under it. `capture: true` is
  // required: scroll events do not bubble, so a listener on window only sees
  // scrolling of that inner box during the capture phase.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;

    const place = () => {
      const a = anchor.getBoundingClientRect();
      const m = el.getBoundingClientRect();
      const next = computeMovePickerPosition(
        { top: a.top, bottom: a.bottom, right: a.right },
        { width: m.width, height: m.height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      // Bail out when nothing moved so a scroll burst does not re-render per event.
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
    // `targets.length` re-measures when the list (and so the menu height) changes.
  }, [anchor, targets.length]);

  // Close on outside click, but never on a MOVE trigger — that button owns the
  // toggle, and closing here first would make it immediately re-open.
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (target.closest(`[${MOVE_TRIGGER_ATTR}]`)) return;
      onClose();
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  // Escape closes from anywhere, even if focus has drifted out of the list.
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Focus the list on open so arrow-key navigation works without an extra click.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (targets.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlighted((prev) => (prev < targets.length - 1 ? prev + 1 : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlighted((prev) => (prev > 0 ? prev - 1 : targets.length - 1));
      } else if (e.key === 'Enter' && highlighted >= 0) {
        e.preventDefault();
        onSelect(targets[highlighted].id);
      }
    },
    [targets, highlighted, onSelect],
  );

  return createPortal(
    <div
      ref={ref}
      className={styles.queueMovePicker}
      // Geometry is computed, so it has to be inline — same exception the other
      // portaled overlays make. Hidden for the single pre-measure frame so the
      // menu never flashes at the top-left corner on open.
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
      role="listbox"
      aria-label="Move queue item to session"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.queueMovePickerLabel}>Move to</div>
      {targets.length === 0 ? (
        <div className={styles.queueMovePickerEmpty}>No other sessions</div>
      ) : (
        targets.map((target, idx) => (
          <button
            key={target.id}
            role="option"
            aria-selected={idx === highlighted}
            className={`${styles.queueMovePickerItem}${idx === highlighted ? ` ${styles.queueMovePickerItemActive}` : ''}`}
            onClick={() => onSelect(target.id)}
            onMouseEnter={() => setHighlighted(idx)}
            title={
              target.title
                ? `${target.projectName || target.id.slice(0, 8)} — ${target.title}`
                : target.projectName || target.id.slice(0, 8)
            }
          >
            {/* Inner span owns the truncation: Chromium ignores text-overflow
                on a <button>'s anonymous inner box, so the label would hard-cut
                mid-word instead of showing an ellipsis. */}
            <span className={styles.queueMovePickerRow}>
              <span className={styles.queueMovePickerProject}>
                {target.projectName || target.id.slice(0, 8)}
              </span>
              {target.title && (
                <span className={styles.queueMovePickerTitle}> — {target.title}</span>
              )}
            </span>
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
