/**
 * useSessionRoomDrag — drag a session into another room on the phone's Sessions
 * list (AASC-55), from a grip on its row.
 *
 * The grip is its own gesture, as the Queue tab's ≡ is: never the row's swipe,
 * never its long-press menu (the press is stopped here, and Android's
 * `contextmenu` on a hold is swallowed). A finger held still on it for
 * HOLD_MS picks the session up (moving first is a scroll and cancels); the row
 * then follows the finger and the room group under it is marked; letting go
 * over another group moves the session there. A tap (or Enter / Space) on the
 * grip opens "Move to room…" instead — the one-handed and accessible path.
 *
 * Group boxes are measured once, when the hold arms: the grip has
 * `touch-action: none`, so the list cannot scroll under a held session, and its
 * touch events stop at the grip, so the list's pull-to-refresh (which listens
 * to touch events) can't move it either. Moves and the release are heard on the
 * window, so a row that re-renders mid-drag can't leave the drag stuck.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type TouchEvent } from 'react';
import { roomDropTarget, type RoomGroupRect } from '@/lib/chat/roomsListModel';

/** A finger held this long on the grip picks the session up (the Queue grip's hold). */
export const SESSION_DRAG_HOLD_MS = 250;
const HOLD_SLOP_PX = 10;

export interface SessionDrag {
  sessionId: string;
  /** The room it is being dragged out of (null: no room). */
  fromRoomId: string | null;
  dy: number;
  /** The group under the finger; undefined while over none of them. */
  overRoomId: string | null | undefined;
}

interface Hold {
  sessionId: string;
  fromRoomId: string | null;
  x: number;
  y: number;
  pointer: number;
  timer: ReturnType<typeof setTimeout>;
  armed: boolean;
  rects: RoomGroupRect[];
  over: RoomGroupRect | null;
  /** Removes the window listeners this hold added. */
  detach: () => void;
}

export interface GripHandlers {
  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void;
  /** Touch events of a held grip never reach the list's pull-to-refresh (it listens to touch, not pointer, events). */
  onTouchStart: (e: TouchEvent<HTMLButtonElement>) => void;
  onTouchMove: (e: TouchEvent<HTMLButtonElement>) => void;
  onContextMenu: (e: MouseEvent<HTMLButtonElement>) => void;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
}

/**
 * @param onDrop  A held session was let go over `target` (null: over no group).
 * @param onTap   The grip was tapped (or pressed from the keyboard) without a drag.
 */
export function useSessionRoomDrag(
  onDrop: (sessionId: string, fromRoomId: string | null, target: RoomGroupRect | null) => void,
  onTap: (sessionId: string) => void,
) {
  const groups = useRef(new Map<string, { roomId: string | null; el: HTMLElement }>());
  const hold = useRef<Hold | null>(null);
  /** The click that follows a drag's release must not also open "Move to room…". */
  const swallowClick = useRef(false);
  const [drag, setDrag] = useState<SessionDrag | null>(null);

  const registerGroup = useCallback((key: string, roomId: string | null, el: HTMLElement | null) => {
    if (el) groups.current.set(key, { roomId, el });
    else groups.current.delete(key);
  }, []);

  const endHold = useCallback(() => {
    const h = hold.current;
    if (!h) return;
    clearTimeout(h.timer);
    h.detach();
    hold.current = null;
  }, []);

  // A list that unmounts mid-hold leaves no timer or listener behind.
  useEffect(() => endHold, [endHold]);

  const latest = useRef({ onDrop, onTap });
  useEffect(() => { latest.current = { onDrop, onTap }; }, [onDrop, onTap]);

  const gripFor = useCallback((sessionId: string, fromRoomId: string | null): GripHandlers => ({
    onPointerDown: (e) => {
      e.stopPropagation();
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        /* a pointer the browser no longer tracks: the window still hears it */
      }
      endHold();
      swallowClick.current = false;
      const { clientX: x, clientY: y, pointerId } = e;

      // On the window, not the grip: a row can re-render into another group (a
      // rooms_update from the Mac) or go mid-gesture, and its button with it.
      const onMove = (ev: globalThis.PointerEvent) => {
        const h = hold.current;
        if (!h || h.pointer !== ev.pointerId) return;
        const dy = ev.clientY - h.y;
        if (!h.armed) {
          if (Math.hypot(ev.clientX - h.x, dy) > HOLD_SLOP_PX) endHold();
          return;
        }
        h.over = roomDropTarget(h.rects, ev.clientY);
        setDrag({ sessionId: h.sessionId, fromRoomId: h.fromRoomId, dy, overRoomId: h.over?.roomId });
      };
      const onEnd = (ev: globalThis.PointerEvent) => {
        const h = hold.current;
        if (!h || h.pointer !== ev.pointerId) return;
        const { armed, over } = h;
        endHold();
        if (!armed) return;
        setDrag(null);
        if (ev.type === 'pointerup') latest.current.onDrop(h.sessionId, h.fromRoomId, over);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
      const detach = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
      };

      hold.current = {
        sessionId, fromRoomId, x, y, pointer: pointerId, armed: false, rects: [], over: null, detach,
        timer: setTimeout(() => {
          const h = hold.current;
          if (!h) return;
          h.rects = [...groups.current.values()].map(({ roomId, el }) => {
            const r = el.getBoundingClientRect();
            return { roomId, top: r.top, bottom: r.bottom };
          });
          h.over = roomDropTarget(h.rects, h.y);
          h.armed = true;
          swallowClick.current = true;
          navigator.vibrate?.(10);
          setDrag({ sessionId, fromRoomId, dy: 0, overRoomId: h.over?.roomId });
        }, SESSION_DRAG_HOLD_MS),
      };
    },
    onTouchStart: (e) => e.stopPropagation(),
    onTouchMove: (e) => e.stopPropagation(),
    onContextMenu: (e) => {
      // A held grip is a drag: not the row's long-press menu (Android fires contextmenu on a hold).
      e.preventDefault();
      e.stopPropagation();
    },
    onClick: (e) => {
      e.stopPropagation();
      if (swallowClick.current) {
        swallowClick.current = false;
        return;
      }
      latest.current.onTap(sessionId);
    },
  }), [endHold]);

  return { drag, registerGroup, gripFor };
}
