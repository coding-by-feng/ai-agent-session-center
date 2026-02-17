import { useState, useEffect, useRef, useCallback } from 'react';

interface SearchInputProps {
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  debounceMs?: number;
  className?: string;
  inputClassName?: string;
}

export default function SearchInput({
  value: controlledValue,
  onChange,
  placeholder = 'Search...',
  debounceMs = 300,
  className,
  inputClassName,
}: SearchInputProps) {
  const [localValue, setLocalValue] = useState(controlledValue ?? '');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync with controlled value
  useEffect(() => {
    if (controlledValue !== undefined) {
      setLocalValue(controlledValue);
    }
  }, [controlledValue]);

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
  }

  return (
    <div className={className} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <input
        type="text"
        value={localValue}
        onChange={handleChange}
        placeholder={placeholder}
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
