/**
 * SegmentedControl — two to four views of one thing (AASC-38): a session's
 * Chat · Changes · Terminal.
 *
 * A tab list (it switches what the screen shows): arrow keys / Home / End move
 * and select, one segment in the Tab order. A disabled segment says why in its
 * accessible description and is skipped by the arrows.
 */
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import styles from '@/styles/modules/mobile/SegmentedControl.module.css';

export interface Segment<T extends string> {
  value: T;
  label: string;
  /** A short extra after the label ("+42"). */
  badge?: ReactNode;
  disabledReason?: string;
}

export interface SegmentedControlProps<T extends string> {
  segments: ReadonlyArray<Segment<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Names the group ("Session view"). */
  label: string;
  /** The id of the panel the selected segment shows (aria-controls). */
  panelId?: string;
  /** Segment ids are `${idPrefix}-${value}`, so the panel can point back (aria-labelledby). */
  idPrefix?: string;
}

export default function SegmentedControl<T extends string>({ segments, value, onChange, label, panelId, idPrefix }: SegmentedControlProps<T>) {
  const autoId = useId();
  const groupId = idPrefix ?? autoId;
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const enabled = segments.filter((s) => !s.disabledReason);

  const move = (e: KeyboardEvent<HTMLButtonElement>) => {
    const at = enabled.findIndex((s) => s.value === value);
    let next: Segment<T> | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = enabled[(at + 1) % enabled.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    refs.current.get(next.value)?.focus();
  };

  return (
    <>
      <div className={styles.track} role="tablist" aria-label={label}>
        {segments.map((s) => {
          const selected = s.value === value;
          const reasonId = `${groupId}-${s.value}-reason`;
          return (
            <button
              key={s.value}
              ref={(el) => {
                if (el) refs.current.set(s.value, el);
                else refs.current.delete(s.value);
              }}
              type="button"
              role="tab"
              id={`${groupId}-${s.value}`}
              className={styles.segment}
              aria-selected={selected}
              aria-controls={selected ? panelId : undefined}
              aria-disabled={s.disabledReason ? true : undefined}
              aria-describedby={s.disabledReason ? reasonId : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => { if (!s.disabledReason && !selected) onChange(s.value); }}
              onKeyDown={move}
            >
              <span className={styles.label}>{s.label}</span>
              {s.badge != null && <span className={styles.badge}>{s.badge}</span>}
            </button>
          );
        })}
      </div>
      {/* Outside the tabs, so a reason describes its segment without joining its name. */}
      {segments.filter((s) => s.disabledReason).map((s) => (
        <span key={s.value} id={`${groupId}-${s.value}-reason`} hidden>{s.disabledReason}</span>
      ))}
    </>
  );
}
