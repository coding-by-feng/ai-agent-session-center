/**
 * ContextMenu — a long-press menu on the phone (AASC-38): rename, move, kill…
 *
 * Opens on a 500 ms touch hold (a finger that moves first is scrolling, not
 * holding), on `contextmenu` (right click; Android's own long press) and on
 * Shift+F10 / the Menu key for a keyboard. The release that ends a hold doesn't
 * also tap the row. The menu is portaled to <body>, placed at the press and
 * clamped inside the viewport (8px pad, flipped above the point when it would
 * run off the bottom), focused once placed; arrows move, Escape / a tap outside
 * close and give focus back to the row.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { LONG_PRESS_MS, VIEWPORT_PAD, clampMenuPosition } from './menuPosition';
import styles from '@/styles/modules/mobile/ContextMenu.module.css';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  disabledReason?: string;
  onSelect: () => void;
}

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
  const menuRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
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
    // Back to the row the menu was opened on (its first focusable child).
    const target = triggerRef.current?.querySelector<HTMLElement>('button, [href], [tabindex]') ?? triggerRef.current;
    target?.focus?.();
  }, []);

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
        setAt({ x, y });
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
    setAt({ x: e.clientX, y: e.clientY });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      const r = (e.target as HTMLElement).getBoundingClientRect();
      setAt({ x: r.left + VIEWPORT_PAD, y: r.bottom });
    }
  };

  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  // Place once measured, then focus the first item (a hidden element can't take focus).
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!at || !menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const { left, top } = clampMenuPosition(at.x, at.y, width, height, window.innerWidth, window.innerHeight);
    menu.style.setProperty('--menu-left', `${Math.round(left)}px`);
    menu.style.setProperty('--menu-top', `${Math.round(top)}px`);
    menu.dataset.placed = '';
    // After placing, in the next frame: a real browser drops focus given in the
    // same tick as the hidden render (ui-primitives.md; jsdom keeps it).
    const first = menu.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== first) first?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [at]);

  // Escape closes it wherever focus is (a tap can leave focus on <body>).
  useEffect(() => {
    if (!at) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [at, close]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    }
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
        aria-haspopup="menu"
        aria-expanded={at ? true : undefined}
        aria-controls={at ? menuId : undefined}
      >
        {children}
      </div>
      {at && createPortal(
        <div className={styles.layer} onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            className={styles.menu}
            onKeyDown={onMenuKey}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={`${styles.item}${item.destructive ? ` ${styles.destructive}` : ''}`}
                aria-disabled={item.disabledReason ? true : undefined}
                onClick={() => {
                  if (item.disabledReason) return;
                  close();
                  item.onSelect();
                }}
              >
                <span className={styles.itemText}>
                  <span>{item.label}</span>
                  {item.disabledReason && <span className={styles.reason}>{item.disabledReason}</span>}
                </span>
                {item.icon && <span className={styles.icon}>{item.icon}</span>}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
