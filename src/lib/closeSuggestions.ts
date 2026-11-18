/**
 * "Sessions to close" (Nov 17 2026): the shapes and labels shared by the server's suggestion rule
 * (server/closeSuggestions.ts) and the dialog (CloseSuggestionsModal). One list of quiet-time
 * choices, so the picker can never offer a value the server refuses.
 */

/** Minutes a session must have been quiet before it is suggested. */
export const CLOSE_QUIET_CHOICES = [30, 60, 240, 1440] as const;
export const DEFAULT_CLOSE_QUIET_MINUTES = 60;

/** `idle`: it has run prompts and has been quiet since. `unused`: it was never given a prompt. */
export type CloseReason = 'idle' | 'unused';

export interface CloseSuggestion {
  sessionId: string;
  reason: CloseReason;
  /** How long since the person's last prompt, or since the start when it never had one (Nov 18 2026). */
  quietMs: number;
}

export interface CloseSuggestionsResponse {
  ok: true;
  at: number;
  quietMinutes: number;
  suggestions: CloseSuggestion[];
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
const MS_PER_MINUTE = 60_000;

export function isCloseQuietChoice(value: unknown): value is (typeof CLOSE_QUIET_CHOICES)[number] {
  return typeof value === 'number' && (CLOSE_QUIET_CHOICES as readonly number[]).includes(value);
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** A picker option: `30 min`, `1 hour`, `4 hours`, `1 day`. */
export function quietChoiceLabel(minutes: number): string {
  if (minutes < MINUTES_PER_HOUR) return `${minutes} min`;
  if (minutes < MINUTES_PER_DAY) return plural(minutes / MINUTES_PER_HOUR, 'hour');
  return plural(minutes / MINUTES_PER_DAY, 'day');
}

/** A quiet time for a row: `59 min`, `3 h 12 min`, `2 days 1 h` (minutes are dropped past a day). */
export function formatQuiet(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / MS_PER_MINUTE));
  if (totalMinutes < MINUTES_PER_HOUR) return `${totalMinutes} min`;
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  if (totalMinutes < MINUTES_PER_DAY) {
    const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
    return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
  }
  const days = Math.floor(totalMinutes / MINUTES_PER_DAY);
  const hours = Math.floor((totalMinutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  return hours === 0 ? plural(days, 'day') : `${plural(days, 'day')} ${hours} h`;
}

/** Why a row is listed: `Last prompt 3 h 12 min ago` or `No prompt yet · started 2 h ago`. */
export function closeReasonLabel(suggestion: Pick<CloseSuggestion, 'reason' | 'quietMs'>): string {
  const quiet = formatQuiet(suggestion.quietMs);
  return suggestion.reason === 'unused' ? `No prompt yet · started ${quiet} ago` : `Last prompt ${quiet} ago`;
}
