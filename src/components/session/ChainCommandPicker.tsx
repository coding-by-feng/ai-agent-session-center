/**
 * ChainCommandPicker — the menu behind a queue item's "Set effort…" and "Set model…"
 * chain actions. A pick does not change any setting itself: the host appends a normal
 * chain step whose text is the picked slash command (see `lib/queueEffort`,
 * `lib/queueModel`).
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
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  computeMovePickerPosition,
  type HorizontalAlign,
} from '@/lib/queueMovePlacement';
import styles from '@/styles/modules/ChainCommandPicker.module.css';

export interface ChainCommandItem<T extends string> {
  value: T;
  /** Short right-hand note: where the choice lands ("saves default", "pinned"…). */
  note: string;
  /** Row tooltip. */
  title: string;
}

export interface ChainCommandPickerProps<T extends string> {
  /** The button this menu hangs off. Placement is measured from its rect. */
  anchor: HTMLElement | null;
  /** Which trigger edge to line up with. Left for a trigger at a wide container's left. */
  align?: HorizontalAlign;
  /** Accessible name of the menu ("Set effort"). */
  label: string;
  items: readonly ChainCommandItem<T>[];
  /** Attribute every trigger of this menu carries — a mousedown on one is not "outside". */
  triggerAttr: string;
  /** Accent of the hover/focus marker, matching the trigger's colour. */
  tone?: 'effort' | 'model';
  /** Optional note under the items. Not a menu item: the keyboard never stops on it. */
  footer?: string;
  /** The chosen value. The picker closes itself after. */
  onPick: (value: T) => void;
  onClose: () => void;
}

export default function ChainCommandPicker<T extends string>({
  anchor,
  align = 'left',
  label,
  items,
  triggerAttr,
  tone = 'effort',
  footer,
  onPick,
  onClose,
}: ChainCommandPickerProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const footerId = useId();

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
      if (target.closest(`[${triggerAttr}]`)) return;
      onClose();
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose, triggerAttr]);

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') closeToTrigger();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [closeToTrigger]);

  // Land on the first item so the menu works without a mouse. Only once it has been
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
    const buttons = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null);
    const current = buttons.findIndex((el) => el === (e.target as HTMLElement).closest('button'));
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = (current + 1) % buttons.length;
    else if (e.key === 'ArrowUp') next = (current - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    if (next === null) return;
    e.preventDefault();
    buttons[next]?.focus();
  }, [closeToTrigger]);

  const handlePick = useCallback(
    (value: T) => {
      onPick(value);
      closeToTrigger();
    },
    [onPick, closeToTrigger],
  );

  return createPortal(
    // The positioned box wraps the menu so an optional note can sit under it without
    // being an owned child of `role="menu"` (which may only hold menu items).
    <div
      ref={ref}
      className={tone === 'model' ? `${styles.picker} ${styles.toneModel}` : styles.picker}
      // `top`/`left` are written inline: they come from measuring the trigger. Hidden
      // for the single pre-measure frame so the menu never flashes in the top-left.
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <div
        className={styles.menu}
        role="menu"
        aria-label={label}
        aria-describedby={footer ? footerId : undefined}
        onKeyDown={handleKeyDown}
      >
        {items.map((item, i) => (
          <button
            key={item.value}
            ref={(el) => { itemRefs.current[i] = el; }}
            type="button"
            role="menuitem"
            className={styles.item}
            title={item.title}
            onClick={() => handlePick(item.value)}
          >
            <span className={styles.value}>{item.value}</span>
            <span className={styles.note}>{item.note}</span>
          </button>
        ))}
      </div>
      {footer && (
        <p id={footerId} className={styles.footer}>
          {footer}
        </p>
      )}
    </div>,
    document.body,
  );
}
