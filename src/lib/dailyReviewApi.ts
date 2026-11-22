/**
 * @module dailyReviewApi
 * The PROMPTS Days view's two requests (Nov 20 2026). Both are host only on the server
 * (`requireLocalForHistory`); a remote device gets the server's own refusal through `readJson`.
 */
import { authFetch } from '@/hooks/useAuth';
import { readJson } from '@/lib/requestJson';
import type { DailyReview, DailySummary } from '@/types/dailyReview';

/** One day's typed prompts, grouped, with its kept summary. */
export async function fetchDailyReview(day: string): Promise<DailyReview> {
  return readJson<DailyReview>(
    await authFetch(`/api/daily-review?day=${encodeURIComponent(day)}`),
    'Could not load this day',
  );
}

/** Write the day's summary; resolves when it is written (up to two minutes). */
export async function requestDailySummary(day: string): Promise<DailySummary> {
  const body = await readJson<{ summary: DailySummary }>(
    await authFetch(`/api/daily-review/${encodeURIComponent(day)}/summary`, { method: 'POST' }),
    'Could not summarize this day',
  );
  return body.summary;
}
