import { useState, useEffect, useRef, useCallback } from 'react';
import IconButton from '@/components/ui/IconButton';
import styles from '@/styles/modules/FormControl.module.css';

interface SearchInputProps {
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  debounceMs?: number;
  className?: string;
  inputClassName?: string;
  /**
   * `field` is the shared toolbar look (FormControl.module.css: 32px, leading
   * magnifier, IconButton clear) used by the view tabs. `default` is the older
   * inline-styled box the LIVE sidebar still uses — kept as it was, so changing
   * the tabs' toolbars never moves LIVE.
   */
  variant?: 'default' | 'field';
  /** Accessible name; a placeholder is not a label. */
  ariaLabel?: string;
}

function SearchGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function ClearGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" aria-hidden="true">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

export default function SearchInput({
  value: controlledValue,
  onChange,
  placeholder = 'Search...',
  debounceMs = 300,
  className,
  inputClassName,
  variant = 'default',
  ariaLabel,
}: SearchInputProps) {
  const [localValue, setLocalValue] = useState(controlledValue ?? '');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Adopt a new controlled value during render (React's "adjusting state when
  // a prop changes"), not in an effect: an effect paints the stale text first,
  // then re-renders — the cascade react-hooks/set-state-in-effect rejects.
  const [syncedValue, setSyncedValue] = useState(controlledValue);
  if (controlledValue !== syncedValue) {
    setSyncedValue(controlledValue);
    if (controlledValue !== undefined) setLocalValue(controlledValue);
  }

  const debouncedOnChange = useCallback(
    (val: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onChange(val), debounceMs);
    },
    [onChange, debounceMs],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setLocalValue(val);
    debouncedOnChange(val);
  }

  function handleClear() {
    setLocalValue('');
    if (timerRef.current) clearTimeout(timerRef.current);
    onChange('');
    // The clear button unmounts with the text; keep focus in the box instead
    // of dropping it to <body>.
    inputRef.current?.focus();
  }

  if (variant === 'field') {
    return (
      <div className={className ? `${styles.search} ${className}` : styles.search}>
        <SearchGlyph className={styles.searchIcon} />
        <input
          ref={inputRef}
          type="text"
          data-search-input
          value={localValue}
          onChange={handleChange}
          placeholder={placeholder}
          aria-label={ariaLabel ?? placeholder}
          className={`${styles.control} ${styles.searchInput}${inputClassName ? ` ${inputClassName}` : ''}`}
        />
        {localValue && (
          <span className={styles.searchClear}>
            <IconButton label="Clear search" size="sm" tooltip={false} onClick={handleClear}>
              <ClearGlyph />
            </IconButton>
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={className} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <input
        type="text"
        data-search-input
        value={localValue}
        onChange={handleChange}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={inputClassName}
        style={inputClassName ? undefined : {
          width: '100%',
          padding: '8px 32px 8px 12px',
          background: 'var(--bg-primary, #0a0a1a)',
          border: '1px solid var(--border-subtle, rgba(255,255,255,0.06))',
          borderRadius: '6px',
          color: 'var(--text-primary, #e0e0ff)',
          fontSize: '0.85rem',
          fontFamily: 'var(--font-mono, monospace)',
          outline: 'none',
        }}
      />
      {localValue && (
        <button
          onClick={handleClear}
          aria-label="Clear search"
          style={{
            position: 'absolute',
            right: '8px',
            background: 'none',
            border: 'none',
            color: 'var(--text-secondary, #8888aa)',
            cursor: 'pointer',
            fontSize: '0.9rem',
            padding: '2px 4px',
            lineHeight: 1,
          }}
        >
          x
        </button>
      )}
    </div>
  );
}
