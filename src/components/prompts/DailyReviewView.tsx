/**
 * DailyReviewView — PROMPTS → Days (Nov 20 2026): one day of typed prompts at a time, grouped
 * project › room › session, under the day's summary. The day is the Mac's local day; the server
 * builds it from the `prompts` table (server/dailyReview.ts) and keeps each summary in SQLite.
 *
 * Shares the PROMPTS shell (container, header, toolbar, results box) so switching List ⇄ Days
 * moves nothing but the content.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import IconButton from '@/components/ui/IconButton';
import StaleNote from '@/components/ui/StaleNote';
import TextInput from '@/components/ui/TextInput';
import { useSessionStore } from '@/stores/sessionStore';
import { formatDayLabel, isDayKey, localDayKey, shiftDay } from '@/lib/dailyReview';
import { fetchDailyReview, requestDailySummary } from '@/lib/dailyReviewApi';
import { canRetry } from '@/lib/requestJson';
import type { DailyReview } from '@/types/dailyReview';
import DailySummaryCard from './DailySummaryCard';
import DailyReviewTree from './DailyReviewTree';
import promptStyles from '@/styles/modules/Prompts.module.css';
import styles from '@/styles/modules/DailyReview.module.css';

/** How often the day is read again while the server says a summary is being written. */
const SUMMARIZING_POLL_MS = 3_000;

const Chevron = ({ points }: { points: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points={points} />
  </svg>
);
const RefreshGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function DailyReviewView({ viewSwitch }: { viewSwitch: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const today = localDayKey(Date.now());
  const [day, setDay] = useState(today);
  const [asking, setAsking] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ day: string; message: string } | null>(null);

  const liveIdList = useSessionStore(useShallow((s) => Array.from(s.sessions.keys())));
  const liveIds = useMemo(() => new Set(liveIdList), [liveIdList]);
  const selectSession = useSessionStore((s) => s.selectSession);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['daily-review', day],
    queryFn: () => fetchDailyReview(day),
    refetchInterval: (query) => (query.state.data?.summarizing ? SUMMARIZING_POLL_MS : false),
  });
  const failedEmpty = isError && !data;

  const goTo = useCallback((next: string) => {
    if (isDayKey(next) && next <= localDayKey(Date.now())) setDay(next);
  }, []);

  const summarize = useCallback(async () => {
    const target = day;
    setAsking(target);
    setFailure(null);
    try {
      const written = await requestDailySummary(target);
      // Shown at once; the read that follows confirms it (and the server's own `summarizing` flag).
      queryClient.setQueryData<DailyReview>(['daily-review', target], (old) => (old ? { ...old, summary: written } : old));
    } catch (err: unknown) {
      setFailure({ day: target, message: err instanceof Error ? err.message : 'Could not summarize this day.' });
    } finally {
      setAsking(null);
      void queryClient.invalidateQueries({ queryKey: ['daily-review', target] });
    }
  }, [day, queryClient]);

  const openSession = useCallback((sessionId: string) => {
    selectSession(sessionId);
    navigate('/');
  }, [selectSession, navigate]);

  const busy = asking === day || Boolean(data?.summarizing);
  const summaryError = failure?.day === day ? failure.message : null;

  return (
    <div className={promptStyles.container} data-testid="prompts-days-view">
      <div className={promptStyles.header}>
        <div className={promptStyles.toolbar}>
          {viewSwitch}
          <div className={styles.dayPager}>
            <IconButton label="Previous day" onClick={() => goTo(shiftDay(day, -1))}>
              <Chevron points="15 18 9 12 15 6" />
            </IconButton>
            <TextInput type="date" aria-label="Day" className={styles.dayInput} value={day} max={today}
              onChange={(e) => goTo(e.target.value)} />
            <IconButton label="Next day" disabled={day >= today} onClick={() => goTo(shiftDay(day, 1))}>
              <Chevron points="9 18 15 12 9 6" />
            </IconButton>
          </div>
          {day !== today && <Button variant="quiet" onClick={() => setDay(today)}>Today</Button>}
          <div className={promptStyles.actions}>
            <Button
              className={isFetching ? promptStyles.refreshing : undefined}
              icon={<RefreshGlyph />}
              onClick={() => { if (!isFetching) void refetch(); }}
              aria-busy={isFetching || undefined}
              title="Read the day again: prompts are recorded as they are typed"
            >
              Refresh
            </Button>
          </div>
        </div>
        <p className={promptStyles.summary}>
          {formatDayLabel(day)}
          {data && data.day === day && data.promptCount > 0 &&
            ` · ${plural(data.promptCount, 'prompt')} in ${plural(data.sessionCount, 'session')} · ${plural(data.projectCount, 'project')}`}
        </p>
      </div>

      <div className={promptStyles.results}>
        {failedEmpty ? (
          <EmptyState fill tone="error" title="Could not load this day." hint={error?.message}
            action={canRetry(error) ? <Button onClick={() => refetch()}>Retry</Button> : undefined} />
        ) : isLoading || !data ? (
          <EmptyState fill busy title="Loading the day…" />
        ) : data.promptCount === 0 ? (
          <EmptyState fill title="Nothing typed on this day." />
        ) : (
          <div className={styles.dayBody}>
            {isError && <StaleNote onRetry={canRetry(error) ? () => refetch() : undefined} />}
            <DailySummaryCard summary={data.summary} busy={busy} error={summaryError} onSummarize={summarize} />
            {/* Keyed by day: folded and opened groups belong to the day they were opened on. */}
            <DailyReviewTree key={day} review={data} liveIds={liveIds} onOpen={openSession} />
          </div>
        )}
      </div>
    </div>
  );
}
