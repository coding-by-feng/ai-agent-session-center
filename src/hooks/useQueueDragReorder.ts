/**
 * useQueueDragReorder — press-and-hold drag reordering for the prompt queue.
 *
 * Replaces the native HTML5 drag (`draggable` + `onDragStart`) that List mode
 * used and Card mode never had. The reason is not tidiness: **native drag
 * events do not fire on touch at all**, so drag-to-reorder has never worked on
 * a phone in either layout. Pointer events cover mouse, pen and touch with one
 * code path, which is also why both layouts can now share it — the geometry
 * rule in `queueDragReorder.ts` picks its axis from the layout itself.
 *
 * ## The two thresholds, and why both are needed
 *
 * A queue card is covered in buttons (SEND / EDIT / MOVE / DEL / ★ / ▲▼).
 * Starting a drag on `pointerdown` would hijack every one of them.
 *
 *   HOLD_MS      — a press must dwell before it becomes a drag, so a tap stays
 *                  a tap. This is the "press to drag" gesture.
 *   MOVE_CANCEL  — moving further than this BEFORE the hold completes cancels
 *                  the pending drag, so a finger swipe scrolls the queue
 *                  instead of snagging a card.
 *
 * `touch-action: none` must be set in CSS on the draggable element, or the
 * browser claims the gesture for scrolling and `pointermove` never arrives.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { computeInsertIndex, applyReorder, type DragRect } from '@/lib/queueDragReorder';

/** How long a press must dwell before it becomes a drag. */
export const HOLD_MS = 350;
/** Movement (px) before the hold completes that cancels it as a scroll. */
export const MOVE_CANCEL_PX = 8;

export interface QueueDragState {
  /** Item currently lifted, or null. */
  draggingId: number | null;
  /** Caret slot the drop would land in, or null while not dragging. */
  insertIndex: number | null;
  /** Attach to each draggable item's root element. */
  onPointerDown: (e: React.PointerEvent, id: number) => void;
}

/**
 * @param ids       Current item ids, in display order.
 * @param getRects  Reads the on-screen boxes of those items. Called once when
 *                  a drag actually begins — not on every move — so layout is
 *                  measured a single time rather than thrashing.
 * @param onReorder Commit. Only called when the order genuinely changed.
 */
export function useQueueDragReorder(
  ids: number[],
  getRects: () => DragRect[],
  onReorder: (nextIds: number[]) => void,
): QueueDragState {
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);

  // Everything the in-flight gesture needs, in a ref: these are read from
  // window-level listeners that must not be re-bound on every pointer move.
  const gesture = useRef<{
    id: number;
    startX: number;
    startY: number;
    holdTimer: ReturnType<typeof setTimeout> | null;
    active: boolean;
    rects: DragRect[];
    index: number | null;
    detach: () => void;
    /** The nearest `[title]` ancestor (or self) of the press's `target` — e.g.
     *  the drag handle's dot-grid icon, or an image thumbnail grabbed
     *  directly. Native title tooltips are a browser-level overlay this app
     *  cannot reposition, restyle, or dismiss — and are not reliably
     *  dismissed by the gesture's own `preventDefault()` on `pointermove`, so
     *  one already showing when the hold completes can stay pinned over the
     *  list for the whole drag. Cleared for the gesture's duration below. */
    titledEl: HTMLElement | null;
    savedTitle: string | null;
  } | null>(null);

  const reset = useCallback(() => {
    const g = gesture.current;
    if (g?.holdTimer) clearTimeout(g.holdTimer);
    // Restore BEFORE detach/null — g.titledEl is only reachable through g.
    if (g?.titledEl && g.savedTitle !== null) g.titledEl.setAttribute('title', g.savedTitle);
    g?.detach?.();
    gesture.current = null;
    setDraggingId(null);
    setInsertIndex(null);
  }, []);

  // Kept in a ref so the window listeners below — attached once per gesture,
  // never re-bound — always see the latest committed values without the
  // effect-dependency churn that would re-attach them mid-drag.
  const latest = useRef({ ids, onReorder });
  // Synced in an effect, never assigned during render (writing a ref while
  // rendering is a React anti-pattern the compiler lint flags). Safe for this
  // use: a drop is a user gesture, which is always long after the effect for
  // the render that produced the values it commits.
  useEffect(() => { latest.current = { ids, onReorder }; }, [ids, onReorder]);

  const onPointerDown = useCallback((e: React.PointerEvent, id: number) => {
    // Never start a gesture from an interactive control inside the card —
    // otherwise a press on SEND/EDIT/DEL becomes a drag instead of a click.
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select')) return;
    // Secondary/middle buttons are not drags.
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    // A second press while one gesture is live would orphan the first.
    if (gesture.current) reset();

    const onMove = (ev: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      if (!g.active) {
        // Still waiting out the hold — a real move means the user is
        // scrolling, so abandon the pending drag.
        const dx = ev.clientX - g.startX;
        const dy = ev.clientY - g.startY;
        if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) reset();
        return;
      }
      // Dragging: suppress scrolling/selection for this gesture.
      ev.preventDefault();
      const idx = computeInsertIndex(g.rects, ev.clientX, ev.clientY);
      g.index = idx;
      setInsertIndex(idx);
    };

    const onUp = () => {
      const g = gesture.current;
      if (g?.active && g.index !== null) {
        const { ids: curIds, onReorder: commit } = latest.current;
        const next = applyReorder(curIds, g.id, g.index);
        // applyReorder returns the SAME array reference for a no-op drop, so
        // this skips a pointless store write and re-render.
        if (next !== curIds) commit(next);
      }
      reset();
    };

    // Attached HERE rather than in an effect. An effect keyed on drag state
    // would not run until a re-render, and `pointerdown` only writes a ref —
    // so the move listener would not exist during the hold window and the
    // scroll-cancel could never fire. (Found by a gesture test, not by
    // reading the code: the symptom is a card lifting mid-scroll.)
    //
    // `passive: false` is required — a passive listener cannot preventDefault,
    // and without that the page scrolls under the finger mid-drag.
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', reset);
    const detach = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', reset);
    };

    const startX = e.clientX;
    const startY = e.clientY;
    gesture.current = {
      id, startX, startY, holdTimer: null, active: false, rects: [], index: null, detach,
      titledEl: target?.closest('[title]') ?? null, savedTitle: null,
    };
    gesture.current.holdTimer = setTimeout(() => {
      const g = gesture.current;
      if (!g) return;
      g.active = true;
      // Measure ONCE, at lift-off: the boxes cannot move during the drag
      // (nothing reflows until the drop commits), and re-measuring per move
      // would read layout on every frame.
      g.rects = getRects();
      // Clear the native tooltip for the gesture's duration — see the
      // `titledEl` doc comment on the gesture ref above. `reset()` restores
      // it (covers the drop, a cancel, and an unmount mid-drag alike).
      if (g.titledEl) {
        g.savedTitle = g.titledEl.getAttribute('title');
        g.titledEl.setAttribute('title', '');
      }
      setDraggingId(g.id);
    }, HOLD_MS);
  }, [getRects, reset]);

  // Drop the hold timer if the component unmounts mid-press.
  useEffect(() => reset, [reset]);

  return { draggingId, insertIndex, onPointerDown };
}
