/**
 * MenuLayer — the phone kit's popup menu, shared by ContextMenu (a long press on a row) and
 * MenuButton (a tap on a title-bar button) since Nov 24 2026. Portaled to <body> over a dim
 * layer; placed by `placeMenuAtPoint` inside the safe area plus an 8px pad, below the point or
 * flipped above it. Once placed it takes focus: its first item when a keyboard opened it, the
 * menu itself otherwise (iOS draws a focus ring on an item focused after a touch). Arrows move,
 * Home/End jump, Escape, Tab and a tap outside close it.
 */
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { VIEWPORT_PAD, placeMenuAtPoint, type SafeInsets } from './menuPosition';
import styles from '@/styles/modules/mobile/ContextMenu.module.css';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  disabledReason?: string;
  onSelect: () => void;
}

/** Where the menu opens: a point, `gap` px clear of it; `alignEnd` puts the menu's right edge at x. */
export interface MenuAt {
  x: number;
  y: number;
  gap?: number;
  alignEnd?: boolean;
  /** A keyboard opened it: focus the first item rather than the menu. */
  byKeyboard?: boolean;
}

interface MenuLayerProps {
  at: MenuAt;
  id: string;
  label: string;
  items: ReadonlyArray<ContextMenuItem>;
  onClose: () => void;
  /** False drops an item's click (a long press's release); true by default. */
  canActivate?: (e: MouseEvent<HTMLButtonElement>) => boolean;
  onMenuPointerDown?: () => void;
}

/** The safe-area insets in px. `env()` can't be read through a custom property, so a probe measures them. */
function readSafeInsets(): SafeInsets {
  const probe = document.createElement('div');
  probe.className = styles.safeProbe;
  document.body.appendChild(probe);
  const s = getComputedStyle(probe);
  const px = (v: string) => Number.parseFloat(v) || 0;
  const insets = { top: px(s.paddingTop), right: px(s.paddingRight), bottom: px(s.paddingBottom), left: px(s.paddingLeft) };
  probe.remove();
  return insets;
}

export default function MenuLayer({ at, id, label, items, onClose, canActivate, onMenuPointerDown }: MenuLayerProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Primitives, so a parent's fresh `at` object on each render doesn't re-place or re-focus it.
  const { x: atX, y: atY, gap = 0, alignEnd = false, byKeyboard = false } = at;

  // Place once measured, then focus it (a hidden element can't take focus).
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const x = alignEnd ? atX - width : atX;
    const { left, top, maxHeight } = placeMenuAtPoint(
      x, atY, width, height, window.innerWidth, window.innerHeight, readSafeInsets(), VIEWPORT_PAD, gap,
    );
    menu.style.setProperty('--menu-left', `${Math.round(left)}px`);
    menu.style.setProperty('--menu-top', `${Math.round(top)}px`);
    menu.style.setProperty('--menu-max-height', `${Math.floor(maxHeight)}px`);
    menu.dataset.placed = '';
    // After placing, in the next frame too: a real browser drops focus given in the same tick as
    // the hidden render (ui-primitives.md; jsdom keeps it).
    const target = byKeyboard ? menu.querySelector<HTMLElement>('[role="menuitem"]') : menu;
    target?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== target) target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [atX, atY, gap, alignEnd, byKeyboard]);

  // Escape closes it wherever focus is (a tap can leave focus on <body>).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      // From the menu itself (a touch opened it), up goes to the last item.
      list[i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    }
  };

  return createPortal(
    <div className={styles.layer} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={menuRef}
        id={id}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        className={styles.menu}
        onKeyDown={onMenuKey}
        onPointerDown={onMenuPointerDown}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`${styles.item}${item.destructive ? ` ${styles.destructive}` : ''}`}
            aria-disabled={item.disabledReason ? true : undefined}
            onClick={(e) => {
              if (item.disabledReason || (canActivate && !canActivate(e))) return;
              onClose();
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
  );
}
