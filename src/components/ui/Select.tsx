/**
 * Select — custom styled dropdown replacement for native <select>.
 * - Click trigger to open/close
 * - Click outside to close
 * - Arrow keys to navigate, Enter to select, Escape to close
 * - Keyboard accessible with ARIA roles
 * - Auto-flips upward if near bottom of viewport
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import styles from '@/styles/modules/Select.module.css';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}

export default function Select({
  value,
  onChange,
  options,
  placeholder,
  className,
  style,
  title,
}: SelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [flipUp, setFlipUp] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Selected option label
  const selectedLabel = useMemo(() => {
    const opt = options.find((o) => o.value === value);
    return opt?.label ?? '';
  }, [options, value]);

  // Click-outside to close
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  // Reset highlight when opening
  useEffect(() => {
    if (isOpen) {
      const idx = options.findIndex((o) => o.value === value);
      setHighlightedIndex(idx >= 0 ? idx : 0);
    }
  }, [isOpen, options, value]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const el = listRef.current.children[highlightedIndex] as HTMLElement | undefined;
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex]);

  // Check if dropdown should flip upward
  const checkFlip = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    setFlipUp(spaceBelow < 220 && rect.top > 220);
  }, []);

  const handleToggle = useCallback(() => {
    if (!isOpen) checkFlip();
    setIsOpen((prev) => !prev);
  }, [isOpen, checkFlip]);

  const handleSelect = useCallback(
    (optValue: string) => {
      onChange(optValue);
      setIsOpen(false);
      triggerRef.current?.focus();
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!isOpen) {
          checkFlip();
          setIsOpen(true);
        } else {
          setHighlightedIndex((prev) =>
            prev < options.length - 1 ? prev + 1 : 0,
          );
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen) {
          checkFlip();
          setIsOpen(true);
        } else {
          setHighlightedIndex((prev) =>
            prev > 0 ? prev - 1 : options.length - 1,
          );
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (isOpen && highlightedIndex >= 0 && highlightedIndex < options.length) {
          handleSelect(options[highlightedIndex].value);
        } else if (!isOpen) {
          checkFlip();
          setIsOpen(true);
        }
      } else if (e.key === 'Escape') {
        if (isOpen) {
          e.stopPropagation();
          setIsOpen(false);
          triggerRef.current?.focus();
        }
      } else if (e.key === 'Tab') {
        setIsOpen(false);
      }
    },
    [isOpen, highlightedIndex, options, handleSelect, checkFlip],
  );

  return (
    <div
      ref={wrapperRef}
      className={`${styles.wrapper} ${className ?? ''}`}
      style={style}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger}${isOpen ? ` ${styles.triggerOpen}` : ''}`}
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        title={title}
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-activedescendant={
          isOpen && highlightedIndex >= 0 ? `sel-item-${highlightedIndex}` : undefined
        }
      >
        <span className={`${styles.triggerLabel}${!selectedLabel ? ` ${styles.placeholder}` : ''}`}>
          {selectedLabel || placeholder || '\u00A0'}
        </span>
        <span className={`${styles.caret}${isOpen ? ` ${styles.caretOpen}` : ''}`}>
          &#x25BE;
        </span>
      </button>

      {isOpen && options.length > 0 && (
        <ul
          ref={listRef}
          className={`${styles.dropdown}${flipUp ? ` ${styles.dropdownUp}` : ''}`}
          role="listbox"
        >
          {options.map((opt, i) => (
            <li
              key={opt.value}
              id={`sel-item-${i}`}
              role="option"
              aria-selected={opt.value === value}
              className={[
                styles.item,
                i === highlightedIndex ? styles.itemHighlighted : '',
                opt.value === value ? styles.itemSelected : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(opt.value);
              }}
              onMouseEnter={() => setHighlightedIndex(i)}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
