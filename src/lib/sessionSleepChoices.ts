/**
 * The "Sleep idle sessions" choices (Settings → ADVANCED), shared by the dropdown and the server's
 * allow-list (server/sessionSleep.ts), so a choice the menu offers is always one the server takes.
 * Minutes of quiet before a session's CLI is stopped; 0 is off. Day lengths added Nov 2 2026.
 */
export const SLEEP_CHOICES = [0, 15, 30, 60, 120, 240, 1440, 2880, 4320, 10080] as const;

const MINUTES_PER_DAY = 1440;

export function sleepChoiceLabel(minutes: number): string {
  if (minutes === 0) return 'Off — never';
  if (minutes < 60) return `After ${minutes} min idle`;
  if (minutes < MINUTES_PER_DAY) {
    const hours = minutes / 60;
    return `After ${hours} hour${hours === 1 ? '' : 's'} idle`;
  }
  const days = minutes / MINUTES_PER_DAY;
  return `After ${days} day${days === 1 ? '' : 's'} idle`;
}
