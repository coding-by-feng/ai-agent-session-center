/**
 * 12-hour time picker helpers.
 *
 * Internal storage everywhere in the queue code is `HH:MM` (24-hour). The UI
 * shows three dropdowns (hour 1-12, minute 0-59, AM/PM) backed by these
 * helpers. Keeping conversion in one place avoids the classic 12:00 AM / PM
 * off-by-one bug that home-grown converters introduce.
 *
 *   parseHHMM("13:45")  → { hour: 1,  minute: 45, ampm: 'PM' }
 *   formatHHMM(1, 45, 'PM') → "13:45"
 *
 *   00:00 ↔ 12:00 AM (midnight)
 *   12:00 ↔ 12:00 PM (noon)
 *   23:59 ↔ 11:59 PM
 */

export type Ampm = 'AM' | 'PM';

export interface TimeParts {
  hour: number;   // 1-12 (NOT 0-23)
  minute: number; // 0-59
  ampm: Ampm;
}

/**
 * Parse an HH:MM 24-hour string into 12-hour parts.
 * Returns null for empty / invalid input so callers can show the "unset"
 * placeholder state rather than guessing a default.
 */
export function parseHHMM(hhmm: string | undefined | null): TimeParts | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h24 = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h24) || !Number.isFinite(min)) return null;
  if (h24 < 0 || h24 > 23 || min < 0 || min > 59) return null;

  const ampm: Ampm = h24 < 12 ? 'AM' : 'PM';
  // Hour mapping:
  //   0  (12 AM, midnight)  → 12
  //   1..11                → 1..11
  //   12 (12 PM, noon)     → 12
  //   13..23               → 1..11
  let h12: number;
  if (h24 === 0) h12 = 12;
  else if (h24 === 12) h12 = 12;
  else if (h24 > 12) h12 = h24 - 12;
  else h12 = h24;

  return { hour: h12, minute: min, ampm };
}

/**
 * Format 12-hour parts as an HH:MM 24-hour string.
 * The inverse of `parseHHMM`.
 */
export function formatHHMM(hour: number, minute: number, ampm: Ampm): string {
  // Normalize hour to 1-12 just in case a caller passed 0 or 24.
  const h12 = ((hour - 1 + 12) % 12) + 1; // → 1..12
  // 12 AM (midnight) → 0, 12 PM (noon) → 12, 1-11 AM → 1-11, 1-11 PM → 13-23
  let h24: number;
  if (ampm === 'AM') {
    h24 = h12 === 12 ? 0 : h12;
  } else {
    h24 = h12 === 12 ? 12 : h12 + 12;
  }
  const min = Math.max(0, Math.min(59, Math.floor(minute)));
  return `${String(h24).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Pre-built option arrays so render code doesn't have to map() each time. */
export const HOUR_OPTIONS_12: number[] = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
export const MINUTE_OPTIONS: number[] = Array.from({ length: 60 }, (_, i) => i);
