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
 *                  instead of snagging a card. A MOUSE that moves this far
 *                  lifts the row instead (Oct 22 2026): a mouse cannot scroll
 *                  by dragging, and a hold before a mouse drag read as broken.
 *                  A click (released within the threshold) is still a click.
 *
 * ## Touch: the list must still scroll (AASC-18)
 *
 * On the desktop layout the rows are `touch-action: none`, so `pointermove`
 * always arrives — but a finger that lands on a row can then never scroll the
 * queue, and on a phone the rows ARE the queue. The phone layout makes rows
 * `touch-action: pan-y` instead, which hands a swipe to the browser (it scrolls
 * and sends `pointercancel`, which cancels the pending hold). What stops the
 * browser scrolling once a row HAS lifted is `scrollGuardRef`: a non-passive
 * `touchmove` listener on the list that cancels the move only while a drag is
 * live. It has to be registered before the touch starts — browsers decide at
 * `touchstart` whether a blocking listener covers the point, which is why it is
 * a ref on the list and not something attached at lift. Attach it to the list
 * element; without it a phone row lifts and then scrolls away under the finger.
 *
 * While a touch drag is live, a finger near the top or bottom edge of the
 * list's scroller scrolls it (`EDGE_PX`), so a prompt can travel further than
 * one screen. Hit-testing compensates for the scroll, since rects are measured
 * once, at lift.
 *
 * ## The carry (List layout, Oct 21 2026)
 *
 * Given `getItemEl`, a lifted row is carried the way the room strip carries a
 * room (`useRoomDragReorder`, whose geometry this reuses): it follows the
 * finger through the `--queue-drag-dy` variable written straight to the element
 * on every move (a React render per move would re-render the whole queue), the
 * rows it passes slide aside to open the slot it will land in (`shifts`, a
 * render only when the slot changes), the drop is aimed by the carried row's
 * leading edge (the whole row is the press target, so the finger can sit
 * anywhere on it), and on release every row that moved glides into place
 * (`settleInto`). Before it, a lift only faded the row in place and a 3 px line
 * marked the slot. Without `getItemEl` the row still only fades (`.dragging`),
 * and `insertIndex` reports the slot, but no layout draws the line any more.
 *
 * ## The Card grid's carry (Oct 22 2026)
 *
 * With `layout: 'card'` the carried card follows the pointer both ways
 * (`--queue-drag-dx` too), drawn no further than the box the cards cover. It
 * lands in the place of the card whose centre is nearest its own, aimed from
 * where the pointer took it rather than where the clamp drew it (an expanded
 * card many times taller than the rest could otherwise never reach the last
 * row), and the cards it passes step one cell toward its old place
 * (`cardShifts`): the last card of a row wraps to the start of the next, or back.
 * The geometry is `computeGridInsertIndex` / `computeGridShifts` /
 * `clampGridDragOffset` in `queueDragReorder.ts`; the settle glides both ways.
 * A grid only one column wide (a narrow panel) is carried exactly as List rows
 * are, `cardShifts` holding their vertical slides: stepping cell to cell is only
 * exact in rows of equal height, and every card of a column is its own row.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  computeInsertIndex,
  applyReorder,
  rebaseInsertIndex,
  computeGridInsertIndex,
  computeGridShifts,
  clampGridDragOffset,
  gridColumnCount,
  type DragRect,
  type GridShift,
} from '@/lib/queueDragReorder';
import { clampRoomDragOffset, computeRoomShifts, roomDragHitY } from '@/lib/roomDragReorder';
import { dropPoses, landSettle, settleInto } from '@/lib/dragSettle';

/** How long a press must dwell before it becomes a drag. */
export const HOLD_MS = 350;
/** Movement (px) before the hold completes that cancels it as a scroll. */
export const MOVE_CANCEL_PX = 8;
/** Distance (px) from the scroller's top/bottom edge where a touch drag auto-scrolls it. */
export const EDGE_PX = 48;
/** Fastest auto-scroll step (px per frame), reached at the very edge. */
const EDGE_MAX_STEP = 14;
/** How much a carried row grows. MUST match the `scale:` of
 *  `.queueList.queueListCarry .queueItem.dragging` (Terminal.module.css): the
 *  settle starts from this size, so a mismatch makes every drop pop. A test pins them. */
export const LIFT_SCALE = 1.02;
/** How long a drop takes to glide its rows into their new slots. */
export const SETTLE_MS = 150;
/** The CSS variable carrying the lifted row's offset. */
export const CARRY_VAR = '--queue-drag-dy';
/** The CSS variable carrying a lifted card's sideways offset (the Card grid). */
export const CARRY_X_VAR = '--queue-drag-dx';
/** The buzz each time the landing slot changes under a finger (the lift's is 10). */
export const SLOT_TICK_MS = 8;

const NO_SHIFTS: ReadonlyMap<number, number> = new Map();
const NO_CARD_SHIFTS: ReadonlyMap<number, GridShift> = new Map();

export interface QueueDragState {
  /** Item currently lifted, or null. */
  draggingId: number | null;
  /** Caret slot the drop would land in, or null while not dragging. */
  insertIndex: number | null;
  /** How far (px) each row the carried one has passed slides to open its slot.
   *  Empty without a carry (`getItemEl`), in the Card grid, while not dragging,
   *  and for no-op slots. */
  shifts: ReadonlyMap<number, number>;
  /** The Card grid's `shifts`: how far (px, both ways) each card the carried one
   *  has passed is drawn from its place. Empty in the List, and as `shifts` is. */
  cardShifts: ReadonlyMap<number, GridShift>;
  /** Attach to each draggable item's root element. */
  onPointerDown: (e: React.PointerEvent, id: number) => void;
  /** Attach to the element that contains the items (see "Touch" above). */
  scrollGuardRef: (el: HTMLElement | null) => (() => void) | undefined;
}

/** The nearest ancestor that actually scrolls vertically, or null. */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node = el;
  while (node && node !== document.body) {
    const { overflowY } = getComputedStyle(node);
    if (/(auto|scroll)/.test(overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

/** Auto-scroll step for a pointer at `y` inside `box`: negative scrolls up, 0 = not near an edge. */
export function edgeScrollStep(y: number, top: number, bottom: number): number {
  if (y < top + EDGE_PX) return -Math.ceil(EDGE_MAX_STEP * Math.min(1, (top + EDGE_PX - y) / EDGE_PX));
  if (y > bottom - EDGE_PX) return Math.ceil(EDGE_MAX_STEP * Math.min(1, (y - (bottom - EDGE_PX)) / EDGE_PX));
  return 0;
}

/**
 * @param ids       Current item ids, in display order.
 * @param getRects  Reads the on-screen boxes of those items. Called once when
 *                  a drag actually begins — not on every move — so layout is
 *                  measured a single time rather than thrashing.
 * @param onReorder Commit. Only called when the order genuinely changed.
 * @param getItemEl The on-screen element of an item: given, the lifted one is
 *                  carried (see "The carry"); omitted, it is faded in place.
 * @param layout    How the items are laid out: 'list' carries up and down,
 *                  'card' both ways (see "The Card grid's carry").
 */
export function useQueueDragReorder(
  ids: number[],
  getRects: () => DragRect[],
  onReorder: (nextIds: number[]) => void,
  getItemEl?: (id: number) => HTMLElement | null | undefined,
  layout: 'list' | 'card' = 'list',
): QueueDragState {
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  /** The lift-time rects of a carried drag, as state so `shifts` derive in render. */
  const [carryRects, setCarryRects] = useState<DragRect[] | null>(null);
  /** Settle glides still running, and a settle frame not yet run. */
  const settling = useRef(new Set<Animation>());
  const settleFrame = useRef<number | null>(null);
  /** The list element `scrollGuardRef` is attached to (the auto-scroll looks up from it). */
  const listEl = useRef<HTMLElement | null>(null);

  // Everything the in-flight gesture needs, in a ref: these are read from
  // window-level listeners that must not be re-bound on every pointer move.
  const gesture = useRef<{
    id: number;
    startX: number;
    startY: number;
    holdTimer: ReturnType<typeof setTimeout> | null;
    active: boolean;
    /** A finger, not a mouse or pen: auto-scroll and the haptic tick are touch-only. */
    touch: boolean;
    /** A mouse: moving it lifts the row without waiting out the hold. */
    mouse: boolean;
    /** A Card grid of two or more columns: a carried card moves both ways. Set at
     *  lift; one column of cards stacks like List rows and is carried like them. */
    grid: boolean;
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
    /** The list's scroller and its scrollTop at lift (any pointer); the last pointer and the frame (touch auto-scroll). */
    scroller: HTMLElement | null;
    scrollTopAtLift: number;
    lastX: number;
    lastY: number;
    frame: number | null;
    /** The carried row's element, resolved at lift; null when not carrying. */
    itemEl: HTMLElement | null;
    /** Every measured row's element, for the drop's settle. */
    frames: { id: number; el: HTMLElement }[];
    /** The last landing slot that buzzed; -1 = its own place (either no-op slot). */
    slot: number;
  } | null>(null);

  const reset = useCallback(() => {
    const g = gesture.current;
    if (g?.holdTimer) clearTimeout(g.holdTimer);
    if (g?.frame != null) cancelAnimationFrame(g.frame);
    // Restore BEFORE detach/null — g.titledEl is only reachable through g.
    if (g?.titledEl && g.savedTitle !== null) g.titledEl.setAttribute('title', g.savedTitle);
    g?.itemEl?.style.removeProperty(CARRY_VAR);
    g?.itemEl?.style.removeProperty(CARRY_X_VAR);
    g?.detach?.();
    gesture.current = null;
    setDraggingId(null);
    setInsertIndex(null);
    setCarryRects(null);
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

  /** Where the pointer points in lift-time coordinates: rects were measured at
   *  lift, and a scroll since then moved every item up by the scrolled amount.
   *  A carried row moves with it: its offset is the finger's travel plus that
   *  scroll, kept within the list, and its leading edge aims the drop. */
  const hitTest = useCallback((x: number, y: number) => {
    const g = gesture.current;
    if (!g) return;
    const scrolled = g.scroller ? g.scroller.scrollTop - g.scrollTopAtLift : 0;
    let idx: number;
    const own = g.rects.find((r) => r.id === g.id);
    if (g.itemEl && g.grid) {
      // The Card grid: drawn within the cards, aimed from where the pointer took it.
      const dx = x - g.startX;
      const dy = y - g.startY + scrolled;
      const shown = clampGridDragOffset(g.rects, g.id, dx, dy);
      g.itemEl.style.setProperty(CARRY_X_VAR, `${shown.x}px`);
      g.itemEl.style.setProperty(CARRY_VAR, `${shown.y}px`);
      idx = own
        ? computeGridInsertIndex(g.rects, g.id, (own.left + own.right) / 2 + dx, (own.top + own.bottom) / 2 + dy)
        : computeInsertIndex(g.rects, x, y + scrolled);
    } else if (g.itemEl) {
      const dy = clampRoomDragOffset(g.rects, g.id, y - g.startY + scrolled);
      g.itemEl.style.setProperty(CARRY_VAR, `${dy}px`);
      const cx = own ? (own.left + own.right) / 2 : x;
      idx = computeInsertIndex(g.rects, cx, roomDragHitY(g.rects, g.id, dy) ?? y + scrolled);
    } else {
      idx = computeInsertIndex(g.rects, x, y + scrolled);
    }
    g.index = idx;
    setInsertIndex(idx);
    // A light tick each time the landing place changes (a carried row or card only);
    // both no-op slots are "its own place".
    const from = g.rects.findIndex((r) => r.id === g.id);
    const slot = idx === from || idx === from + 1 ? -1 : idx;
    if (g.touch && g.itemEl && slot !== g.slot) {
      g.slot = slot;
      try { navigator.vibrate?.(SLOT_TICK_MS); } catch { /* not allowed here */ }
    }
  }, []);

  /** Edge auto-scroll for a touch drag: one frame per call, re-armed while the
   *  finger stays near an edge (and the scroller can still move). */
  const autoScroll = useCallback(() => {
    function frame() {
      const g = gesture.current;
      if (!g || !g.active || !g.scroller) return;
      g.frame = null;
      const box = g.scroller.getBoundingClientRect();
      const step = edgeScrollStep(g.lastY, box.top, box.bottom);
      if (step === 0) return;
      const before = g.scroller.scrollTop;
      g.scroller.scrollTop = before + step;
      if (g.scroller.scrollTop === before) return; // at the end: nothing more to scroll
      hitTest(g.lastX, g.lastY);
      g.frame = requestAnimationFrame(frame);
    }
    frame();
  }, [hitTest]);

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
        // Still waiting out the hold. A finger or pen that really moves is
        // scrolling, so the pending drag is abandoned; a mouse cannot scroll by
        // dragging, so its move IS the drag and lifts the row at once.
        const dx = ev.clientX - g.startX;
        const dy = ev.clientY - g.startY;
        if (dx * dx + dy * dy <= MOVE_CANCEL_PX * MOVE_CANCEL_PX) return;
        if (!g.mouse) { reset(); return; }
        lift();
        if (!gesture.current?.active) return;
      }
      // Dragging: suppress scrolling/selection for this gesture.
      ev.preventDefault();
      g.lastX = ev.clientX;
      g.lastY = ev.clientY;
      hitTest(ev.clientX, ev.clientY);
      if (g.touch && g.scroller && g.frame === null) autoScroll();
    };

    const onUp = () => {
      const g = gesture.current;
      // Where every carried-drag row is on screen right now — carry offset and
      // any in-flight slide included — read before the commit re-renders them.
      const poses = g?.active && g.itemEl
        ? dropPoses(g.frames.map(({ id: rowId, el }) => ({ el, lifted: rowId === g.id })))
        : [];
      if (g?.active && g.index !== null) {
        const { ids: curIds, onReorder: commit } = latest.current;
        // Before the row it was shown before, in the queue as it is NOW (it may have
        // changed under the drag); the dragged item gone means nothing to move.
        const at = rebaseInsertIndex(g.rects, g.id, g.index, curIds);
        const next = at === -1 ? curIds : applyReorder(curIds, g.id, at);
        // applyReorder returns the SAME array reference for a no-op drop, so
        // this skips a pointless store write and re-render.
        if (next !== curIds) commit(next);
      }
      reset();
      settleFrame.current = settleInto(poses, settling.current, { durationMs: SETTLE_MS, liftScale: LIFT_SCALE });
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
      id, startX, startY, holdTimer: null, active: false, touch: e.pointerType === 'touch', mouse: e.pointerType === 'mouse',
      grid: false,
      rects: [], index: null, detach,
      titledEl: target?.closest('[title]') ?? null, savedTitle: null,
      scroller: null, scrollTopAtLift: 0, lastX: startX, lastY: startY, frame: null,
      itemEl: null, frames: [], slot: -1,
    };
    gesture.current.holdTimer = setTimeout(lift, HOLD_MS);

    /** The hold completed, or a mouse moved: the row is in hand. */
    function lift() {
      const g = gesture.current;
      if (!g || g.active) return;
      if (g.holdTimer) clearTimeout(g.holdTimer);
      g.holdTimer = null;
      g.active = true;
      // A drop's settle may still be gliding, and a running animation's
      // transform is in getBoundingClientRect: land it before measuring.
      landSettle(settling.current, settleFrame);
      // Measure ONCE, at lift-off: the boxes cannot move during the drag
      // (nothing reflows until the drop commits; the carry and the slides are
      // transforms, and reading them back would make the slot flicker), and
      // re-measuring per move would read layout on every frame. A touch drag
      // that auto-scrolls is compensated in hitTest instead.
      g.rects = getRects();
      g.grid = layout === 'card' && gridColumnCount(g.rects) > 1;
      if (getItemEl) {
        g.itemEl = getItemEl(g.id) ?? null;
        g.frames = g.rects.flatMap(({ id: rowId }) => {
          const el = getItemEl(rowId);
          return el ? [{ id: rowId, el }] : [];
        });
        if (g.itemEl) setCarryRects(g.rects);
      }
      // Any pointer: a wheel scroll during a mouse drag moves the rows too (the
      // edge auto-scroll stays touch-only, in onMove).
      g.scroller = scrollParentOf(listEl.current);
      g.scrollTopAtLift = g.scroller?.scrollTop ?? 0;
      if (g.touch) {
        // The lift is otherwise silent under a finger that covers the row.
        try { navigator.vibrate?.(10); } catch { /* not allowed here */ }
      }
      // Clear the native tooltip for the gesture's duration — see the
      // `titledEl` doc comment on the gesture ref above. `reset()` restores
      // it (covers the drop, a cancel, and an unmount mid-drag alike).
      if (g.titledEl) {
        g.savedTitle = g.titledEl.getAttribute('title');
        g.titledEl.setAttribute('title', '');
      }
      setDraggingId(g.id);
    }
  }, [getRects, getItemEl, layout, reset, hitTest, autoScroll]);

  // See "Touch" in the header: cancel a touch's scroll only while a row is in
  // hand, and keep a long press from opening the image / text callout.
  const scrollGuardRef = useCallback((el: HTMLElement | null) => {
    listEl.current = el;
    if (!el) return undefined;
    const onTouchMove = (ev: TouchEvent) => {
      if (gesture.current?.active && ev.cancelable) ev.preventDefault();
    };
    const onContextMenu = (ev: Event) => {
      if (gesture.current?.touch) ev.preventDefault();
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('contextmenu', onContextMenu);
    return () => {
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('contextmenu', onContextMenu);
      if (listEl.current === el) listEl.current = null;
    };
  }, []);

  // Drop the hold timer if the component unmounts mid-press.
  useEffect(() => reset, [reset]);

  const shifts = useMemo(
    () => (draggingId !== null && carryRects && layout === 'list' ? computeRoomShifts(carryRects, draggingId, insertIndex) : NO_SHIFTS),
    [carryRects, draggingId, insertIndex, layout],
  );
  const cardShifts = useMemo(() => {
    if (draggingId === null || !carryRects || layout !== 'card') return NO_CARD_SHIFTS;
    if (gridColumnCount(carryRects) > 1) return computeGridShifts(carryRects, draggingId, insertIndex);
    // One column of cards stacks like List rows: slide by the carried card's pitch.
    const slides = computeRoomShifts(carryRects, draggingId, insertIndex);
    return new Map([...slides].map(([id, y]) => [id, { x: 0, y }]));
  }, [carryRects, draggingId, insertIndex, layout]);

  return { draggingId, insertIndex, shifts, cardShifts, onPointerDown, scrollGuardRef };
}
