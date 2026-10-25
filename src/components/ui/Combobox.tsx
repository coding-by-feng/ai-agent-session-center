/**
 * Combobox — custom dropdown input that replaces HTML5 <datalist>.
 * - Click arrow button → shows ALL items (no filtering); a mouse or pen also focuses the input, a finger
 *   doesn't (the soft keyboard would rise over the list it just opened)
 * - Type in input → filters items (case-insensitive substring)
 * - Arrow keys to navigate, Enter to select, Escape to close
 * - The list is portaled to <body> and placed like ui/Menu (`placeMenu`: below, else above, inside the
 *   viewport): inside a modal's scrolling body an absolute list was clipped, and an option past the clip
 *   could not be tapped (e2e run 5, F2).
 * - `searchable` (Oct 23 2026, the New Terminal Session's Working Directory): a search box at the top of
 *   the open list filters it — and marks the matches, "2 of 18" — without touching the field's value.
 *   One rule for rows, count and marks: `lib/textHighlight.ts`. A finger opening ▾ doesn't focus it.
 * - Rows break after each "/" (`<wbr>`), not mid-word: a long path wrapped as "exmout|h".
 */
import { useState, useRef, useEffect, useId, useLayoutEffect, useMemo, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { placeMenu, type MenuPosition } from '@/lib/menuPlacement';
import { matchesQuery, normalizeQuery, splitHighlight } from '@/lib/textHighlight';
import styles from '@/styles/modules/Combobox.module.css';

/** Fallback for the list's cap when --cb-cap can't be read (Combobox.module.css owns it). */
const LIST_MAX_HEIGHT = 200;

interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  items: string[];
  placeholder?: string;
  className?: string;
  /** A search box at the top of the open list that filters it without changing the value. */
  searchable?: boolean;
  /** The search box's name (and placeholder), e.g. "Search folders". */
  searchLabel?: string;
}

/** `text` with a line-break chance after every "/", so a path wraps between its folders. */
function withPathBreaks(text: string): ReactNode[] {
  // A plain split, not a lookbehind: older iOS WebViews can't parse `(?<=…)`.
  const parts = text.split('/');
  return parts.flatMap((part, i) => (i < parts.length - 1 ? [part, '/', <wbr key={i} />] : [part]));
}

export default function Combobox({ value, onChange, items, placeholder, className, searchable = false, searchLabel = 'Search' }: ComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const searchRowRef = useRef<HTMLDivElement>(null);
  // Focus the search box once it renders: on a mouse, pen or keyboard open, never a finger's.
  const focusSearchRef = useRef(false);
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

  const q = searchable ? normalizeQuery(query) : '';
  const visibleItems = useMemo(() => {
    if (q) return items.filter((item) => matchesQuery(item, q));
    if (showAll || !value.trim()) return items;
    const lower = value.trim().toLowerCase();
    return items.filter((item) => item.toLowerCase().includes(lower));
  }, [items, value, showAll, q]);

  // Place the list under the input (or above it), and keep it there while the page under it moves:
  // the modal body scrolls, and on a phone the soft keyboard resizes the window. Placed again when a
  // search changes how many rows there are, so a list placed above the field stays against it.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const place = () => {
      const anchor = wrapperRef.current?.getBoundingClientRect();
      const pop = popRef.current;
      if (!anchor || !pop) return;
      const width = anchor.right - anchor.left;
      // The list's own height: its content, up to the CSS cap (--cb-cap, smaller on a phone), plus
      // the search row above it; the list gets the room that is left after that row.
      const list = pop.querySelector<HTMLElement>('[data-cb-list]') ?? pop;
      const cap = parseFloat(getComputedStyle(list).getPropertyValue('--cb-cap')) || LIST_MAX_HEIGHT;
      const searchRow = searchRowRef.current?.offsetHeight ?? 0;
      const height = Math.min(list.scrollHeight, cap) + searchRow;
      const placed = placeMenu(anchor, { width, height }, { width: window.innerWidth, height: window.innerHeight });
      setPos({ ...placed, maxHeight: Math.max(0, placed.maxHeight - searchRow), width });
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
  }, [isOpen, visibleItems.length]);

  // Once placed: until then the popover is `visibility: hidden`, and a hidden input can't take focus
  // (jsdom doesn't care, a browser does — the first try ran in that window).
  useEffect(() => {
    if (!isOpen || !pos || !focusSearchRef.current) return;
    focusSearchRef.current = false;
    searchRef.current?.focus();
  }, [isOpen, pos]);

  /** Open the list, with an empty search each time. */
  function openList(all: boolean, focusSearch: boolean) {
    setShowAll(all);
    setQuery('');
    focusSearchRef.current = searchable && focusSearch;
    setIsOpen(true);
  }

  // Reset highlight when list changes (adjusted during render, not in an effect)
  const [shownItems, setShownItems] = useState(visibleItems);
  if (shownItems !== visibleItems) {
    setShownItems(visibleItems);
    setHighlightedIndex(-1);
  }

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
    if (!isOpen) openList(false, false);
  }

  function handleArrowClick() {
    if (isOpen) {
      setIsOpen(false);
    } else {
      const byFinger = arrowPointerRef.current === 'touch';
      openList(true, !byFinger);
      if (!byFinger && !searchable) inputRef.current?.focus();
    }
    arrowPointerRef.current = '';
  }

  function handleSelect(item: string) {
    onChange(item);
    setIsOpen(false);
    setHighlightedIndex(-1);
    // Picked from the search box: back to the field it filled.
    if (document.activeElement === searchRef.current) inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) openList(true, false);
      setHighlightedIndex((prev) =>
        prev < visibleItems.length - 1 ? prev + 1 : 0,
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) openList(true, false);
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
        if (document.activeElement === searchRef.current) inputRef.current?.focus();
      }
    } else if (e.key === 'Tab' && document.activeElement === searchRef.current) {
      // The search box is portaled out of any modal (and its focus trap): close the list and let
      // Tab carry on from the field, or it would leave the dialog with the list still open.
      setIsOpen(false);
      inputRef.current?.focus();
    }
  }

  /** A row: the matches marked (search only), with a break chance after each "/". */
  function rowContent(item: string): ReactNode {
    if (!q) return withPathBreaks(item);
    return splitHighlight(item, q).map((seg, i) => (seg.match
      ? <mark key={i} className={styles.match}>{withPathBreaks(seg.text)}</mark>
      : <span key={i}>{withPathBreaks(seg.text)}</span>));
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
          aria-controls={isOpen ? listId : undefined}
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
          className={`${styles.popover}${searchable ? ` ${styles.popoverSearchable}` : ''}`}
          style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { visibility: 'hidden', top: 0, left: 0 }}
        >
          {searchable && (
            <div ref={searchRowRef} className={styles.search}>
              <input
                ref={searchRef}
                type="search"
                className={styles.searchInput}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={searchLabel}
                aria-label={searchLabel}
                aria-controls={listId}
                aria-activedescendant={highlightedIndex >= 0 ? `cb-item-${highlightedIndex}` : undefined}
                autoComplete="off"
                spellCheck={false}
              />
              {q && <span className={styles.searchCount}>{visibleItems.length} of {items.length}</span>}
            </div>
          )}
          {visibleItems.length > 0 ? (
            <ul
              ref={listRef}
              id={listId}
              data-cb-list=""
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
                  <span className={styles.itemText}>{rowContent(item)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div id={listId} data-cb-list="" className={styles.dropdown}>
              <div className={styles.empty}>No matches</div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
