/**
 * Combobox — custom dropdown input that replaces HTML5 <datalist>.
 * - Click arrow button → shows ALL items (no filtering); a mouse or pen also focuses the input, a finger
 *   doesn't (the soft keyboard would rise over the list it just opened)
 * - Type in input → filters items (case-insensitive substring)
 * - Arrow keys to navigate, Enter to select, Escape to close
 * - The list is portaled to <body> and placed like ui/Menu (`placeMenu`: below, else above, inside the
 *   viewport): inside a modal's scrolling body an absolute list was clipped, and an option past the clip
 *   could not be tapped (e2e run 5, F2).
 */
import { useState, useRef, useEffect, useLayoutEffect, useMemo, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { placeMenu, type MenuPosition } from '@/lib/menuPlacement';
import styles from '@/styles/modules/Combobox.module.css';

/** Fallback for the list's cap when --cb-cap can't be read (Combobox.module.css owns it). */
const LIST_MAX_HEIGHT = 200;

interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  items: string[];
  placeholder?: string;
  className?: string;
}

export default function Combobox({ value, onChange, items, placeholder, className }: ComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [showAll, setShowAll] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<(MenuPosition & { width: number }) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // How the ▾ was last pressed. A click with no pointer event before it (keyboard, assistive tech)
  // reads as '' and focuses, as before.
  const arrowPointerRef = useRef('');

  // Click-outside to close
  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapperRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setIsOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  // Place the list under the input (or above it), and keep it there while the page under it moves:
  // the modal body scrolls, and on a phone the soft keyboard resizes the window.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const place = () => {
      const anchor = wrapperRef.current?.getBoundingClientRect();
      const pop = popRef.current;
      if (!anchor || !pop) return;
      const width = anchor.right - anchor.left;
      // The list's own height: its content, up to the CSS cap (--cb-cap, smaller on a phone).
      const list = pop.firstElementChild instanceof HTMLElement ? pop.firstElementChild : pop;
      const cap = parseFloat(getComputedStyle(list).getPropertyValue('--cb-cap')) || LIST_MAX_HEIGHT;
      const height = Math.min(list.scrollHeight, cap);
      setPos({ ...placeMenu(anchor, { width, height }, { width: window.innerWidth, height: window.innerHeight }), width });
    };
    // A scroll inside the list is the user reading it, not the page moving under it.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && popRef.current?.contains(t)) return;
      place();
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [isOpen]);

  const visibleItems = useMemo(() => {
    if (showAll || !value.trim()) return items;
    const lower = value.trim().toLowerCase();
    return items.filter((item) => item.toLowerCase().includes(lower));
  }, [items, value, showAll]);

  // Reset highlight when list changes
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [visibleItems]);

  // Scroll highlighted item into view (within dropdown only, not ancestors)
  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const el = listRef.current.children[highlightedIndex] as HTMLElement | undefined;
      if (el) {
        const list = listRef.current;
        const elTop = el.offsetTop;
        const elBottom = elTop + el.offsetHeight;
        if (elTop < list.scrollTop) {
          list.scrollTop = elTop;
        } else if (elBottom > list.scrollTop + list.clientHeight) {
          list.scrollTop = elBottom - list.clientHeight;
        }
      }
    }
  }, [highlightedIndex]);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    onChange(e.target.value);
    setShowAll(false);
    if (!isOpen) setIsOpen(true);
  }

  function handleArrowClick() {
    if (isOpen) {
      setIsOpen(false);
    } else {
      setShowAll(true);
      setIsOpen(true);
      if (arrowPointerRef.current !== 'touch') inputRef.current?.focus();
    }
    arrowPointerRef.current = '';
  }

  function handleSelect(item: string) {
    onChange(item);
    setIsOpen(false);
    setHighlightedIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) {
        setShowAll(true);
        setIsOpen(true);
      }
      setHighlightedIndex((prev) =>
        prev < visibleItems.length - 1 ? prev + 1 : 0,
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) {
        setShowAll(true);
        setIsOpen(true);
      }
      setHighlightedIndex((prev) =>
        prev > 0 ? prev - 1 : visibleItems.length - 1,
      );
    } else if (e.key === 'Enter') {
      if (isOpen && highlightedIndex >= 0 && highlightedIndex < visibleItems.length) {
        e.preventDefault();
        handleSelect(visibleItems[highlightedIndex]);
      }
    } else if (e.key === 'Escape') {
      if (isOpen) {
        e.stopPropagation();
        setIsOpen(false);
      }
    }
  }

  return (
    <div ref={wrapperRef} className={`${styles.wrapper} ${className ?? ''}`}>
      <div className={styles.inputWrapper}>
        <input
          ref={inputRef}
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={styles.input}
          role="combobox"
          aria-expanded={isOpen}
          aria-activedescendant={
            highlightedIndex >= 0 ? `cb-item-${highlightedIndex}` : undefined
          }
          aria-autocomplete="list"
        />
        <button
          type="button"
          className={`${styles.arrowBtn}${isOpen ? ` ${styles.arrowBtnOpen}` : ''}`}
          onPointerDown={(e) => { arrowPointerRef.current = e.pointerType; }}
          onClick={handleArrowClick}
          tabIndex={-1}
          aria-label="Toggle dropdown"
        >
          &#x25BE;
        </button>
      </div>
      {isOpen && createPortal(
        <div
          ref={popRef}
          className={styles.popover}
          style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { visibility: 'hidden', top: 0, left: 0 }}
        >
          {visibleItems.length > 0 ? (
            <ul
              ref={listRef}
              className={styles.dropdown}
              style={pos ? ({ '--cb-room': `${pos.maxHeight}px` } as CSSProperties) : undefined}
              role="listbox"
            >
              {visibleItems.map((item, i) => (
                <li
                  key={item}
                  id={`cb-item-${i}`}
                  role="option"
                  aria-selected={i === highlightedIndex}
                  className={`${styles.item} ${i === highlightedIndex ? styles.itemHighlighted : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelect(item);
                  }}
                  onMouseEnter={() => setHighlightedIndex(i)}
                >
                  {item}
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles.dropdown}>
              <div className={styles.empty}>No matches</div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
