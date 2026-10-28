/**
 * Menu — the shared dropdown menu (AASC-11): a trigger button and a list of
 * radio / checkbox / action items, grouped into captioned sections.
 *
 *   <Menu
 *     label="View"                       // the menu's name (role="menu")
 *     triggerLabel="View options"        // the trigger's accessible name
 *     triggerText="View" triggerIcon={<ViewIcon />}
 *     sections={[{ id: 'group', title: 'Group', items: [
 *       { kind: 'radio', id: 'room', label: 'Rooms', checked, onSelect },
 *     ] }]}
 *   />
 *
 * What it owns, so no caller re-rolls it:
 * - **Position.** Portaled to <body> (`--z-portal-menu`), so a scroller or a
 *   transformed ancestor can never clip it; placed under the trigger, flipped
 *   above when there is no room below, clamped 8px inside the viewport, and
 *   given the remaining height to scroll in. Re-measured on resize and scroll.
 * - **Keyboard.** Opens with focus on the checked item (else the first);
 *   ↑/↓ wrap, Home/End jump, Escape closes and hands focus back to the trigger
 *   without reaching the panel's own Escape; items stay out of the Tab order and
 *   Tab-ing away closes it.
 * - **Pointer.** A click outside the trigger and the menu closes it. Radio and
 *   action items close it; checkbox items keep it open (several can be ticked).
 *
 * `footer` is extra, non-interactive content under the items (a colour legend):
 * it sits inside the popover but outside role="menu".
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import Button from '@/components/ui/Button';
import IconButton from '@/components/ui/IconButton';
import { CheckIcon, ChevronDownIcon } from '@/components/ui/icons';
import { useClickOutside } from '@/hooks/useClickOutside';
import { placeMenu, type MenuPosition } from '@/lib/menuPlacement';
import styles from '@/styles/modules/Menu.module.css';

interface MenuItemBase {
  id: string;
  label: string;
  /** One line shown as the item's tooltip. */
  hint?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export type MenuItem =
  | (MenuItemBase & { kind: 'radio'; checked: boolean; onSelect: () => void })
  | (MenuItemBase & { kind: 'checkbox'; checked: boolean; onSelect: () => void })
  | (MenuItemBase & { kind: 'action'; onSelect: () => void });

export interface MenuSection {
  id: string;
  /** Visible caption; also names the group for assistive technology. */
  title?: string;
  items: MenuItem[];
}

/** A trigger of the caller's own look, drawn as a plain <button>. */
export interface MenuPlainTrigger {
  className: string;
  content: ReactNode;
  title?: string;
  /** Held: aria-disabled (focus stays put, unlike `disabled`) and the menu does not open. */
  held?: boolean;
  busy?: boolean;
}

export interface MenuProps {
  /** The menu's accessible name. */
  label: string;
  /** The trigger's accessible name (an icon-only trigger's tooltip too). */
  triggerLabel: string;
  /** Visible trigger text. Without it the trigger is an icon-only IconButton. */
  triggerText?: ReactNode;
  triggerIcon?: ReactNode;
  /** A second tooltip line on an icon-only trigger, or the text trigger's title. */
  triggerDescription?: string;
  /** Lit trigger: the menu holds a non-default choice (a filter is on). */
  active?: boolean;
  size?: 'sm' | 'md';
  sections: MenuSection[];
  footer?: ReactNode;
  /** Which trigger edge the menu lines up with before clamping. */
  align?: 'start' | 'end';
  className?: string;
  /**
   * A trigger of the caller's own look (a project frame's launch chip), in place
   * of the Button / IconButton, with this menu's placement, keyboard and
   * outside-click handling all the same.
   */
  plainTrigger?: MenuPlainTrigger;
}

const ITEM_SELECTOR = '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemradio"]:not([aria-disabled="true"]), [role="menuitemcheckbox"]:not([aria-disabled="true"])';

export default function Menu({
  label,
  triggerLabel,
  triggerText,
  triggerIcon,
  triggerDescription,
  active = false,
  size = 'sm',
  sections,
  footer,
  align = 'start',
  className,
  plainTrigger,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPosition | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setPos(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const outsideRefs = useMemo(() => [wrapRef, popRef], []);
  const onOutside = useCallback(() => close(false), [close]);
  useClickOutside(outsideRefs, onOutside, open);

  // Place it, and keep it placed while the page under it moves.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      const m = popRef.current;
      if (!t || !m) return;
      // scrollHeight is the full content height even while maxHeight caps the box.
      // (Never clear maxHeight on the node to measure: when the new position equals
      // the old, React does not write the style back and the cap is lost.)
      setPos(placeMenu(t, { width: m.offsetWidth, height: m.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }, align));
    };
    // A scroll inside the list is the user reading it, not the page moving under it.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && popRef.current?.contains(t)) return; // window is not a Node
      place();
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, align, sections]);

  // Opening moves focus to the checked item, else the first, so the menu is
  // usable from the keyboard straight away. Only once it is placed: until then it
  // is visibility: hidden, and a hidden element cannot take focus (a real browser
  // drops the call; jsdom does not, so only a render shows this). Once per opening.
  const placed = pos !== null;
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!open) { focusedRef.current = false; return; }
    if (!placed || focusedRef.current) return;
    const pop = popRef.current;
    if (!pop) return;
    focusedRef.current = true;
    const items = [...pop.querySelectorAll<HTMLElement>(ITEM_SELECTOR)];
    (items.find((el) => el.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
  }, [open, placed]);

  // Escape is caught on the document (capture) while open, not only on the wrapper:
  // a click on a caption or the footer can leave focus on <body>, outside both, and
  // the panel's own window-level Escape (exit maximize / minimize) must never fire
  // for the press that only meant to close this menu.
  useEffect(() => {
    if (!open) return;
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close(true);
    };
    document.addEventListener('keydown', onEscape, true);
    return () => document.removeEventListener('keydown', onEscape, true);
  }, [open, close]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Tab' && popRef.current?.contains(document.activeElement)) {
      // The list is portaled to the end of <body>, so Tab from it would leave the
      // page's order. Hand focus back to the trigger first: Tab then goes on from
      // there, Shift+Tab stays on it.
      if (e.shiftKey) e.preventDefault();
      triggerRef.current?.focus();
      setOpen(false);
      setPos(null);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = [...(popRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = at + 1 >= items.length ? 0 : at + 1;
    else next = at <= 0 ? items.length - 1 : at - 1;
    items[next].focus();
  };

  // Tab out to another control: close. Only when focus lands somewhere known and
  // outside — a null relatedTarget (a click on nothing focusable; Safari never
  // focuses a clicked button) is the outside-click handler's business, and
  // closing here would swallow the click on an item.
  const onBlur = (e: FocusEvent) => {
    if (!open) return;
    const next = e.relatedTarget as Node | null;
    if (!next) return;
    if (wrapRef.current?.contains(next) || popRef.current?.contains(next)) return;
    close(false);
  };

  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    if (item.kind === 'checkbox') {
      item.onSelect();
      return;
    }
    // The item is about to unmount with the menu; without this, focus falls to <body>.
    close(true);
    item.onSelect();
  };

  const toggle = () => (open ? close(false) : setOpen(true));
  const triggerProps = {
    ref: triggerRef,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: toggle,
  };

  return (
    <div className={`${styles.wrap}${className ? ` ${className}` : ''}`} ref={wrapRef} onKeyDown={onKeyDown} onBlur={onBlur}>
      {plainTrigger ? (
        <button
          {...triggerProps}
          type="button"
          className={plainTrigger.className}
          onClick={plainTrigger.held ? undefined : toggle}
          aria-label={triggerLabel}
          aria-disabled={plainTrigger.held || undefined}
          aria-busy={plainTrigger.busy || undefined}
          title={plainTrigger.title}
        >
          {plainTrigger.content}
        </button>
      ) : triggerText ? (
        <Button
          {...triggerProps}
          size={size}
          icon={triggerIcon}
          aria-label={triggerLabel}
          title={triggerDescription}
          className={`${styles.trigger}${active ? ` ${styles.triggerActive}` : ''}`}
        >
          {triggerText}
          <span className={styles.chevron} aria-hidden="true"><ChevronDownIcon /></span>
        </Button>
      ) : (
        <IconButton
          {...triggerProps}
          label={triggerLabel}
          description={triggerDescription}
          size={size}
          className={active ? styles.triggerActive : undefined}
        >
          {triggerIcon}
        </IconButton>
      )}
      {open && createPortal(
        <div
          ref={popRef}
          // Focusable itself, so a click on a caption or the footer keeps focus here.
          tabIndex={-1}
          className={styles.popover}
          style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { visibility: 'hidden', top: 0, left: 0 }}
          data-menu-popover=""
        >
          <div id={menuId} role="menu" aria-label={label} className={styles.menu}>
            {sections.map((section) => (
              <MenuGroup key={section.id} section={section} onChoose={choose} />
            ))}
          </div>
          {footer && <div className={styles.footer}>{footer}</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}

function MenuGroup({ section, onChoose }: { section: MenuSection; onChoose: (item: MenuItem) => void }) {
  const captionId = useId();
  if (section.items.length === 0) return null;
  return (
    <div role="group" aria-labelledby={section.title ? captionId : undefined} className={styles.group}>
      {section.title && <div id={captionId} className={styles.caption}>{section.title}</div>}
      {section.items.map((item) => {
        const role = item.kind === 'radio' ? 'menuitemradio' : item.kind === 'checkbox' ? 'menuitemcheckbox' : 'menuitem';
        const checked = item.kind === 'action' ? undefined : item.checked;
        return (
          <button
            key={item.id}
            type="button"
            role={role}
            aria-checked={checked}
            aria-disabled={item.disabled || undefined}
            // Arrow keys move between items; Tab leaves the menu (and closes it).
            tabIndex={-1}
            title={item.hint}
            className={styles.item}
            onClick={() => onChoose(item)}
          >
            {/* Reserved even when unchecked, so labels never shift (and align). */}
            {item.kind !== 'action' && (
              <span className={styles.check} aria-hidden="true">{checked && <CheckIcon />}</span>
            )}
            {item.icon && <span className={styles.itemIcon} aria-hidden="true">{item.icon}</span>}
            <span className={styles.itemLabel}>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
