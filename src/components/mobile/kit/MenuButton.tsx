/**
 * MenuButton — a title-bar icon button whose tap opens the kit menu (Nov 24 2026), so a screen
 * can fold several icons behind one (Sessions: Call AASC, Rooms, Search). The menu hangs under
 * the button, its right edge at the button's (MenuLayer keeps it inside the safe area). A
 * keyboard opening focuses the first item; closing gives focus back to the button. `pressed`
 * marks the button while something it opened is still on (Search's row under the title bar).
 */
import { useCallback, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import MenuLayer, { type ContextMenuItem, type MenuAt } from './MenuLayer';
import { useBackLayer } from '@/lib/backLayers';

export interface MenuButtonProps {
  /** The button's name ("More actions"). */
  label: string;
  /** The menu's name ("Session actions"). */
  menuLabel: string;
  items: ReadonlyArray<ContextMenuItem>;
  icon: ReactNode;
  className?: string;
  pressed?: boolean;
}

export default function MenuButton({ label, menuLabel, items, icon, className, pressed }: MenuButtonProps) {
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<MenuAt | null>(null);

  const close = useCallback(() => {
    setAt(null);
    buttonRef.current?.focus({ preventScroll: true });
  }, []);
  // Android's back closes the menu, not the screen under it.
  useBackLayer(at !== null, close);

  const open = (e: MouseEvent<HTMLButtonElement>) => {
    if (at) {
      setAt(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    // e.detail 0: Enter or Space, not a tap.
    setAt({ x: r.right, y: r.bottom, alignEnd: true, byKeyboard: e.detail === 0 });
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={className}
        onClick={open}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-controls={at ? menuId : undefined}
        data-pressed={pressed ? '' : undefined}
      >
        {icon}
      </button>
      {at && <MenuLayer at={at} id={menuId} label={menuLabel} items={items} onClose={close} />}
    </>
  );
}
