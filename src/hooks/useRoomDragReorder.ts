/**
 * useRoomDragReorder — press-and-hold drag reordering for room frames in the
 * left-rail session switcher.
 *
 * Same gesture-timing shape as `useQueueDragReorder.ts` (hold-then-drag on
 * pointer events, so touch works — native HTML5 `draggable` never fires on
 * touch at all, which is why that hook replaced it for the queue in the first
 * place). Kept as its own hook rather than generalizing the queue one:
 * `RoomDragRect`/`computeRoomInsertIndex` are string-keyed and vertical-only,
 * a genuinely different (simpler) geometry than the queue's grid-or-list
 * axis-picking — see `roomDragReorder.ts`.
 *
 * The gesture takes ONE OF TWO PATHS, chosen by `pointerType`, because the
 * thing the hold protects against only exists on one of them:
 *
 *   touch (and anything unidentified)  — hold-first, exactly as before.
 *     HOLD_MS      — a press must dwell before it becomes a drag, so a tap on
 *                    the room name / collapse chevron / kill icon stays a tap.
 *     MOVE_CANCEL  — moving before the hold completes cancels the pending
 *                    drag, so a touch-scroll of the rail doesn't snag a frame.
 *
 *   mouse / pen — drag starts on movement, no dwell at all.
 *     MOUSE_DRAG_START_PX — a few px of travel IS the drag intent.
 *
 * Why the split: a mouse cannot scroll the rail by dragging (that is what the
 * wheel is for), so on a pointing device the hold defends against nothing and
 * costs everything. A real trackpad drag has travelled well past
 * MOVE_CANCEL_PX within a frame or two of the press, so hold-first read every
 * single desktop drag as a rail scroll and cancelled it — silently, with no
 * lift, no caret and no cursor change, i.e. indistinguishable from the
 * feature not existing. The hook's own tests missed it because they press
 * with `pointerType: 'touch'` and then hold perfectly still for HOLD_MS, a
 * gesture no hand performs with a pointing device.
 *
 * Unknown/empty `pointerType` deliberately takes the TOUCH path: the new
 * behaviour is opt-in for explicitly-identified precision pointers, so an
 * unrecognised device keeps the shipped contract rather than inheriting a
 * gesture that could hijack a scroll.
 *
 * What the user SEES while a room is in hand (the "carry" preview):
 *
 *   - the lifted room follows the pointer — its offset is written straight
 *     to the frame's `--room-drag-dy` CSS variable on every move, never
 *     through React state, because the switcher renders every session card
 *     and a render per pointermove (60-120 Hz) would re-render all of them;
 *   - the rooms it has passed slide aside to open the slot it will land in
 *     (`shifts`, from `computeRoomShifts`). That DOES go through React, but
 *     only when the indicated slot changes — a few renders per drag;
 *   - the drop is aimed by the carried room's LEADING edge (`roomDragHitY`),
 *     not by the pointer, which sits on the grip near the room's top;
 *   - on release every room that moved glides into its new slot — the
 *     carried one from where it was carried, a passed one from wherever its
 *     slide had got to.
 *
 * Every rect is still measured ONCE, at lift — after landing any settle still
 * gliding from the previous drop. The slides are transforms, and
 * `getBoundingClientRect` includes transforms, so re-measuring mid-drag would
 * read the slid boxes back into the hit test and make the slot flicker.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  computeRoomInsertIndex,
  applyRoomReorder,
  computeRoomShifts,
  clampRoomDragOffset,
  roomDragHitY,
  type RoomDragRect,
} from '@/lib/roomDragReorder';

/** How long a press must dwell before it becomes a drag. Same value as the
 *  queue's hook — no reason for rooms to feel different to hold. */
export const HOLD_MS = 350;
/** Movement (px) before the hold completes that cancels it as a scroll.
 *  Touch path only — on mouse/pen, movement starts the drag instead. */
export const MOVE_CANCEL_PX = 8;
/** Movement (px) on a mouse/pen press that promotes it into a drag. Small
 *  enough that a deliberate drag lifts instantly, large enough that the
 *  hand-jitter of an ordinary click never does. */
export const MOUSE_DRAG_START_PX = 4;
/** How long a drop takes to glide its rooms into their new slots. Inside the
 *  150-300 ms band, at the short end: it ends a gesture the user has already
 *  finished, so it must not make them wait. */
export const SETTLE_MS = 150;
/** How much the lifted room grows while carried. MUST match the `scale:` in
 *  `.roomGroupDragging` (DetailPanel.module.css) — the settle animation starts
 *  from this size, so a mismatch makes every drop begin with a visible pop.
 *  A test reads the stylesheet and pins the two together. */
export const LIFT_SCALE = 1.02;

/** The CSS variable carrying the lifted room's pointer offset. */
const CARRY_VAR = '--room-drag-dy';

const NO_SHIFTS: ReadonlyMap<string, number> = new Map();

/** Does this pointer need the hold-first gesture? Only an explicitly
 *  identified mouse or pen skips it — see the header comment on why unknown
 *  pointer types stay conservative. */
export function requiresHoldToDrag(pointerType: string | undefined): boolean {
  return !(pointerType === 'mouse' || pointerType === 'pen');
}

/** Where a room frame was on screen at the moment of the drop. */
interface DropPose {
  el: HTMLElement;
  /** Centre y, carry offset / in-flight slide included. */
  center: number;
  /** The carried room: it also comes down from LIFT_SCALE. */
  lifted: boolean;
}

/** On drop, glide every room from where it was on screen into wherever the
 *  re-render put it (a FLIP). That is the carried room coming down from where
 *  it was carried — also after a drop that changed nothing — and any passed
 *  room still mid-slide when a quick flick released: the drop removes the
 *  slide transition in the same render that commits the order, so without
 *  this it would jump the rest of the way. Measured by CENTRE, not top: the
 *  lifted room is scaled about its centre, the one point the scale leaves in
 *  place. Runs on the next frame, after React has committed the new order and
 *  before that frame paints, so no jump is ever visible. Started animations
 *  are added to `running` so the next lift can land them before measuring.
 *  Returns the scheduled frame, or null when nothing was scheduled. */
function settleInto(poses: DropPose[], running: Set<Animation>): number | null {
  if (poses.length === 0 || typeof requestAnimationFrame !== 'function') return null;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null;
  return requestAnimationFrame(() => {
    for (const { el, center, lifted } of poses) {
      if (!el.isConnected || typeof el.animate !== 'function') continue;
      const r = el.getBoundingClientRect();
      const dy = center - (r.top + r.height / 2);
      // A room that neither moved nor was lifted has nothing to settle.
      if (!lifted && Math.abs(dy) < 0.5) continue;
      const from = lifted ? `translateY(${dy}px) scale(${LIFT_SCALE})` : `translateY(${dy}px)`;
      const anim = el.animate(
        [{ transform: from }, { transform: 'none' }],
        { duration: SETTLE_MS, easing: 'ease-out' },
      );
      running.add(anim);
      const forget = () => running.delete(anim);
      anim.addEventListener('finish', forget);
      anim.addEventListener('cancel', forget);
    }
  });
}

export interface RoomDragState {
  /** Room currently lifted, or null. */
  draggingId: string | null;
  /** Slot the drop would land in, or null while not dragging. */
  insertIndex: number | null;
  /** How far (px) each room the lifted one has passed should slide to open
   *  its landing slot. Empty while not dragging and for no-op slots. */
  shifts: ReadonlyMap<string, number>;
  /** Attach to the drag-handle element (NOT the whole frame — a room frame
   *  contains session cards, the collapse chevron, and the kill button, and
   *  starting a drag from any of those would hijack them). */
  onPointerDown: (e: React.PointerEvent, id: string) => void;
}

/**
 * @param ids       Visible room ids, in display order (already filtered to
 *                  rooms that currently render a frame — a room with no
 *                  sessions passing the active filter has no frame to drag).
 * @param getRects  Reads the on-screen boxes of those frames. Called once
 *                  when a drag actually begins, not on every move.
 * @param onReorder Commit. Only called when the order genuinely changed.
 * @param getFrameEl The on-screen frame element for a room id — where the
 *                  carry offset is written and the drop settles. Optional:
 *                  without it the gesture and the slides still work, the
 *                  lifted room just doesn't follow the pointer.
 */
export function useRoomDragReorder(
  ids: string[],
  getRects: () => RoomDragRect[],
  onReorder: (nextIds: string[]) => void,
  getFrameEl?: (id: string) => HTMLElement | null | undefined,
): RoomDragState {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  /** The lift-time rects, as state so `shifts` can be derived in render. Set
   *  once per drag — the per-move hit test keeps reading the gesture's copy. */
  const [dragRects, setDragRects] = useState<RoomDragRect[] | null>(null);

  const gesture = useRef<{
    id: string;
    startX: number;
    startY: number;
    holdTimer: ReturnType<typeof setTimeout> | null;
    active: boolean;
    /** Which of the two paths above this gesture is on. */
    holdFirst: boolean;
    rects: RoomDragRect[];
    index: number | null;
    detach: () => void;
    /** See the identical field in `useQueueDragReorder.ts` — a native title
     *  tooltip already showing when the hold completes isn't reliably
     *  dismissed by this gesture's own `preventDefault()` on `pointermove`,
     *  so it can stay pinned over the rail for the whole drag. Cleared for
     *  the gesture's duration below, restored in `reset()`. */
    titledEl: HTMLElement | null;
    savedTitle: string | null;
    /** The lifted room's frame, resolved at lift; null without getFrameEl. */
    frameEl: HTMLElement | null;
    /** Every measured room's frame, resolved at lift, for the drop's settle. */
    frames: { id: string; el: HTMLElement }[];
  } | null>(null);
  /** Settle animations still gliding, and a settle frame not yet run. */
  const settling = useRef(new Set<Animation>());
  const settleFrame = useRef<number | null>(null);

  const reset = useCallback(() => {
    const g = gesture.current;
    if (g?.holdTimer) clearTimeout(g.holdTimer);
    if (g?.titledEl && g.savedTitle !== null) g.titledEl.setAttribute('title', g.savedTitle);
    g?.frameEl?.style.removeProperty(CARRY_VAR);
    g?.detach?.();
    gesture.current = null;
    setDraggingId(null);
    setInsertIndex(null);
    setDragRects(null);
  }, []);

  const latest = useRef({ ids, onReorder });
  useEffect(() => { latest.current = { ids, onReorder }; }, [ids, onReorder]);

  /** Promote the pending gesture into a live drag. Shared by both paths: the
   *  hold timer calls it on touch, the first qualifying move calls it on
   *  mouse/pen — so "what lifting means" has exactly one definition. */
  const lift = useCallback(() => {
    const g = gesture.current;
    if (!g || g.active) return;
    if (g.holdTimer) { clearTimeout(g.holdTimer); g.holdTimer = null; }
    g.active = true;
    // A drop's settle may still be gliding, and getBoundingClientRect
    // includes a running animation's transform — measuring now would freeze
    // a moving box into every slot and slide of this drag. Land it first.
    if (settleFrame.current !== null) {
      cancelAnimationFrame(settleFrame.current);
      settleFrame.current = null;
    }
    for (const anim of settling.current) anim.finish();
    settling.current.clear();
    g.rects = getRects();
    g.frameEl = getFrameEl?.(g.id) ?? null;
    g.frames = g.rects.flatMap(({ id }) => {
      const el = getFrameEl?.(id);
      return el ? [{ id, el }] : [];
    });
    if (g.titledEl) {
      g.savedTitle = g.titledEl.getAttribute('title');
      g.titledEl.setAttribute('title', '');
    }
    setDraggingId(g.id);
    setDragRects(g.rects);
  }, [getRects, getFrameEl]);

  const onPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    // The handle itself is a non-button span (see the component), but guard
    // anyway in case a future edit moves onPointerDown onto a richer element.
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select')) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (gesture.current) reset();

    const onMove = (ev: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      if (!g.active) {
        const dx = ev.clientX - g.startX;
        const dy = ev.clientY - g.startY;
        const travelled = dx * dx + dy * dy;
        if (g.holdFirst) {
          // Touch: moving before the hold completes is a rail scroll.
          if (travelled > MOVE_CANCEL_PX * MOVE_CANCEL_PX) reset();
          return;
        }
        // Mouse/pen: moving IS the drag. Fall through once lifted so this
        // same event also positions the drop slot and the carried room —
        // otherwise the first frame of every drag is spent lifting and both
        // lag a frame behind the pointer for the whole gesture.
        if (travelled <= MOUSE_DRAG_START_PX * MOUSE_DRAG_START_PX) return;
        lift();
        if (!g.active) return;
      }
      ev.preventDefault();
      // Straight to the element: this runs on every move, and a state update
      // here would re-render the whole switcher at the pointer's event rate.
      const dy = clampRoomDragOffset(g.rects, g.id, ev.clientY - g.startY);
      g.frameEl?.style.setProperty(CARRY_VAR, `${dy}px`);
      // Aim by what the user sees — the carried room's leading edge — not by
      // the pointer, which sits on the grip near the room's top.
      const idx = computeRoomInsertIndex(g.rects, roomDragHitY(g.rects, g.id, dy) ?? ev.clientY);
      g.index = idx;
      setInsertIndex(idx);
    };

    const onUp = () => {
      const g = gesture.current;
      // Where every room is on screen right now — carry offset and any
      // in-flight slide included — read before the commit re-renders them.
      const poses: DropPose[] = g?.active
        ? g.frames.map(({ id, el }) => {
          const r = el.getBoundingClientRect();
          return { el, center: r.top + r.height / 2, lifted: id === g.id };
        })
        : [];
      if (g?.active && g.index !== null) {
        const { ids: curIds, onReorder: commit } = latest.current;
        const next = applyRoomReorder(curIds, g.id, g.index);
        if (next !== curIds) commit(next);
      }
      reset();
      settleFrame.current = settleInto(poses, settling.current);
    };

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
    const holdFirst = requiresHoldToDrag(e.pointerType);
    gesture.current = {
      id, startX, startY, holdTimer: null, active: false, holdFirst,
      rects: [], index: null, detach,
      titledEl: target?.closest('[title]') ?? null, savedTitle: null,
      frameEl: null, frames: [],
    };

    if (holdFirst) {
      gesture.current.holdTimer = setTimeout(lift, HOLD_MS);
    } else {
      // Stop the browser starting a text selection at the press point: the
      // drag now begins on movement, and a mouse drag across the rail would
      // otherwise paint a selection over every session card it crosses. Safe
      // on this element specifically — the handle is a non-focusable
      // aria-hidden span with no click behaviour of its own.
      e.preventDefault();
    }
  }, [lift, reset]);  // getRects/getFrameEl are reached via lift(), not directly

  useEffect(() => reset, [reset]);

  const shifts = useMemo(
    () => (draggingId && dragRects ? computeRoomShifts(dragRects, draggingId, insertIndex) : NO_SHIFTS),
    [dragRects, draggingId, insertIndex],
  );

  return { draggingId, insertIndex, shifts, onPointerDown };
}
