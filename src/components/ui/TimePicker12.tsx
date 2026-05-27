/**
 * TimePicker12 — three-dropdown 12-hour time picker (Hour 1-12, Minute 0-59, AM/PM).
 *
 * Backs the queue's daily-start clamp and exclude-window editors. Reads/writes
 * the same `HH:MM` 24-hour string format already in use everywhere downstream
 * (db.ts, queueScheduler, snapshots) — only the rendering surface is 12-hour.
 *
 *   <TimePicker12 value="13:45" onChange={setX} />
 *
 *   ─── allowEmpty=true ───
 *   When the field is optional (e.g. the "first fire each day" clamp), passing
 *   `allowEmpty` puts a "—" sentinel at the top of each dropdown. Picking "—"
 *   anywhere clears the value to undefined, which the parent treats as "no
 *   clamp set."
 */

import {
  parseHHMM,
  formatHHMM,
  HOUR_OPTIONS_12,
  MINUTE_OPTIONS,
  type Ampm,
} from '@/lib/timePicker';
import styles from '@/styles/modules/TimePicker12.module.css';

interface TimePicker12Props {
  /** Current value as HH:MM 24-hour. `undefined` / empty string = unset. */
  value: string | undefined;
  /** Called with the new HH:MM. When `allowEmpty` is true the user can clear
   *  the field, which fires `onChange(undefined)`. */
  onChange: (next: string | undefined) => void;
  /** When true, each dropdown gains a leading "—" option that clears the
   *  whole field. Default false (the picker always has a concrete value). */
  allowEmpty?: boolean;
  /** Disable all three dropdowns. */
  disabled?: boolean;
  /** Optional `aria-label` applied to the wrapping element. */
  ariaLabel?: string;
}

const EMPTY_SENTINEL = '__empty__';

export default function TimePicker12({
  value,
  onChange,
  allowEmpty = false,
  disabled = false,
  ariaLabel,
}: TimePicker12Props) {
  const parts = parseHHMM(value);

  // Display values: when parts is null AND allowEmpty, every select shows "—".
  // When parts is null AND !allowEmpty, default to 12:00 AM (00:00) for
  // display but DON'T fire an onChange — caller is expected to pass a value
  // when the field is required.
  const displayHour: number | typeof EMPTY_SENTINEL =
    parts ? parts.hour : allowEmpty ? EMPTY_SENTINEL : 12;
  const displayMinute: number | typeof EMPTY_SENTINEL =
    parts ? parts.minute : allowEmpty ? EMPTY_SENTINEL : 0;
  const displayAmpm: Ampm | typeof EMPTY_SENTINEL =
    parts ? parts.ampm : allowEmpty ? EMPTY_SENTINEL : 'AM';

  // When the field is unset and the user picks ONE dropdown, fill the other
  // two with sensible defaults (minute=0, ampm=AM) so the field becomes set
  // immediately rather than requiring all three picks. Picking "—" on any
  // dropdown clears the whole field — that's the explicit unset gesture.
  const emit = (
    nextHour: number | typeof EMPTY_SENTINEL,
    nextMinute: number | typeof EMPTY_SENTINEL,
    nextAmpm: Ampm | typeof EMPTY_SENTINEL,
    changedField: 'hour' | 'minute' | 'ampm',
  ) => {
    const cleared =
      (changedField === 'hour' && nextHour === EMPTY_SENTINEL) ||
      (changedField === 'minute' && nextMinute === EMPTY_SENTINEL) ||
      (changedField === 'ampm' && nextAmpm === EMPTY_SENTINEL);
    if (cleared) {
      onChange(undefined);
      return;
    }
    const hour = nextHour === EMPTY_SENTINEL ? 12 : nextHour;
    const minute = nextMinute === EMPTY_SENTINEL ? 0 : nextMinute;
    const ampm: Ampm = nextAmpm === EMPTY_SENTINEL ? 'AM' : nextAmpm;
    onChange(formatHHMM(hour, minute, ampm));
  };

  return (
    <span className={styles.group} aria-label={ariaLabel}>
      <select
        className={styles.select}
        disabled={disabled}
        value={String(displayHour)}
        onChange={(e) => {
          const v = e.target.value;
          emit(
            v === EMPTY_SENTINEL ? EMPTY_SENTINEL : Number(v),
            displayMinute,
            displayAmpm,
            'hour',
          );
        }}
        aria-label="Hour"
      >
        {allowEmpty && <option value={EMPTY_SENTINEL}>—</option>}
        {HOUR_OPTIONS_12.map((h) => (
          <option key={h} value={String(h)}>
            {String(h).padStart(2, '0')}
          </option>
        ))}
      </select>
      <span className={styles.colon}>:</span>
      <select
        className={styles.select}
        disabled={disabled}
        value={String(displayMinute)}
        onChange={(e) => {
          const v = e.target.value;
          emit(
            displayHour,
            v === EMPTY_SENTINEL ? EMPTY_SENTINEL : Number(v),
            displayAmpm,
            'minute',
          );
        }}
        aria-label="Minute"
      >
        {allowEmpty && <option value={EMPTY_SENTINEL}>—</option>}
        {MINUTE_OPTIONS.map((m) => (
          <option key={m} value={String(m)}>
            {String(m).padStart(2, '0')}
          </option>
        ))}
      </select>
      <select
        className={`${styles.select} ${styles.ampm}`}
        disabled={disabled}
        value={String(displayAmpm)}
        onChange={(e) => {
          const v = e.target.value;
          emit(
            displayHour,
            displayMinute,
            v === EMPTY_SENTINEL ? EMPTY_SENTINEL : (v as Ampm),
            'ampm',
          );
        }}
        aria-label="AM or PM"
      >
        {allowEmpty && <option value={EMPTY_SENTINEL}>—</option>}
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </span>
  );
}
