/**
 * ContextMenu — a long-press menu on the phone (AASC-38): rename, move, kill…
 *
 * Opens on a 500 ms touch hold (a finger that moves first is scrolling, not
 * holding), on `contextmenu` (right click; Android's own long press) and on
 * Shift+F10 / the Menu key for a keyboard. The release that ends a hold doesn't
 * also tap the row. The menu is portaled to <body> and placed at the press by
 * `placeMenuAtPoint` (Oct 24 2026): inside the safe area (status bar, home indicator,
 * notches) plus an 8px pad, below the point or flipped above it, else on the
 * roomier side with a scrolling list, so it never runs under the status bar.
 * Once placed it takes focus: its first item when a keyboard opened it, the menu
 * itself otherwise (iOS draws a focus ring on an item focused after a touch);
 * arrows move, Escape / a tap outside close and give focus back to the row.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { FINGER_GAP, LONG_PRESS_MS, VIEWPORT_PAD } from './menuPosition';
import MenuLayer, { type ContextMenuItem } from './MenuLayer';
import { useBackLayer } from '@/lib/backLayers';
import styles from '@/styles/modules/mobile/ContextMenu.module.css';

export type { ContextMenuItem } from './MenuLayer';

export interface ContextMenuProps {
  items: ReadonlyArray<ContextMenuItem>;
  /** Names the menu ("Actions for agent-manager-2"). */
  label: string;
  children: ReactNode;
}

const MOVE_CANCEL_PX = 10;

export default function ContextMenu({ items, label, children }: ContextMenuProps) {
  const menuId = useId();
  const triggerRef = useRef<HTMLDivElement>(null);
  /** Where it opened, and how: a finger hold (the finger is still down there) or a keyboard. */
  const [at, setAt] = useState<{ x: number; y: number; byHold?: boolean; byKeyboard?: boolean } | null>(null);
  // A hold-opened menu ignores item clicks until a fresh press inside it: on iOS
  // the click that follows the hold's release is hit-tested where the finger
  // lifts, which could be an item.
  const armed = useRef(true);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const swallowClick = useRef(false);

  const cancelPress = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }, []);

  useEffect(() => cancelPress, [cancelPress]);

  const close = useCallback(() => {
    setAt(null);
    // The hold's release lands on the menu layer, not the row, so no click may come to swallow.
    swallowClick.current = false;
    // Back to the row the menu was opened on (its first focusable child), without scrolling:
    // the row is where the finger was, and a jump would lose the reader's place in a long list.
    const target = triggerRef.current?.querySelector<HTMLElement>('button, [href], [tabindex]') ?? triggerRef.current;
    target?.focus?.({ preventScroll: true });
  }, []);
  // Android's back closes the menu, not the screen under it (AASC-48).
  useBackLayer(at !== null, close);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') return; // a mouse has a right button (contextmenu)
    cancelPress();
    swallowClick.current = false;
    const { clientX: x, clientY: y } = e;
    press.current = {
      x,
      y,
      timer: setTimeout(() => {
        press.current = null;
        swallowClick.current = true;
        armed.current = false;
        setAt({ x, y, byHold: true });
      }, LONG_PRESS_MS),
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_CANCEL_PX) cancelPress();
  };

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    cancelPress();
    if (at) return; // the hold already opened it (Android fires contextmenu on a hold too)
    armed.current = true;
    setAt({ x: e.clientX, y: e.clientY });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      const r = (e.target as HTMLElement).getBoundingClientRect();
      armed.current = true;
      setAt({ x: r.left + VIEWPORT_PAD, y: r.bottom, byKeyboard: true });
    }
  };

  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
      <div
        ref={triggerRef}
        className={styles.trigger}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        onClickCapture={onClickCapture}
      >
        {children}
      </div>
      {at && (
        <MenuLayer
          at={{ x: at.x, y: at.y, gap: at.byHold ? FINGER_GAP : 0, byKeyboard: at.byKeyboard }}
          id={menuId}
          label={label}
          items={items}
          onClose={close}
          // e.detail 0: a keyboard activation, never the hold's release.
          canActivate={(e) => armed.current || e.detail === 0}
          onMenuPointerDown={() => { armed.current = true; }}
        />
      )}
    </>
  );
}
