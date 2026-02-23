/**
 * Combobox — custom dropdown input that replaces HTML5 <datalist>.
 * - Click arrow button → shows ALL items (no filtering)
 * - Type in input → filters items (case-insensitive substring)
 * - Arrow keys to navigate, Enter to select, Escape to close
 */
import { useState, useRef, useEffect, useMemo } from 'react';
import styles from '@/styles/modules/Combobox.module.css';

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
  const inputRef = useRef<HTMLInputElement>(null);

  // Click-outside to close
  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  const visibleItems = useMemo(() => {
    if (showAll || !value.trim()) return items;
    const lower = value.toLowerCase();
    return items.filter((item) => item.toLowerCase().includes(lower));
  }, [items, value, showAll]);

  // Reset highlight when list changes
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [visibleItems]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const el = listRef.current.children[highlightedIndex] as HTMLElement | undefined;
      el?.scrollIntoView({ block: 'nearest' });
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
      inputRef.current?.focus();
    }
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
          onClick={handleArrowClick}
          tabIndex={-1}
          aria-label="Toggle dropdown"
        >
          &#x25BE;
        </button>
      </div>
      {isOpen && visibleItems.length > 0 && (
        <ul ref={listRef} className={styles.dropdown} role="listbox">
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
      )}
      {isOpen && visibleItems.length === 0 && (
        <div className={styles.dropdown}>
          <div className={styles.empty}>No matches</div>
        </div>
      )}
    </div>
  );
}
