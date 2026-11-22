/**
 * DailySummaryCard — the day's summary at the top of PROMPTS → Days (Nov 20 2026).
 * Written only when asked (one `claude -p` run on the small model), then kept. One action at a time:
 * Summarize (none yet), Update (the day's prompts changed since), or a quiet Summarize again.
 */
import { useId, useMemo } from 'react';
import Button from '@/components/ui/Button';
import type { DailySummary } from '@/types/dailyReview';
import styles from '@/styles/modules/DailyReview.module.css';

const pad = (n: number) => String(n).padStart(2, '0');
/** The same 24-hour clock the session rows use. */
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** "• agent-manager: did X" → the project in bold before the colon, when the line has one. */
function SummaryLine({ line }: { line: string }) {
  const body = line.replace(/^•\s*/, '');
  const cut = body.indexOf(': ');
  if (cut <= 0 || cut > 60) return <li>{body}</li>;
  return (
    <li>
      <strong className={styles.summaryProject}>{body.slice(0, cut)}</strong>
      {body.slice(cut)}
    </li>
  );
}

export default function DailySummaryCard({
  summary,
  busy,
  error,
  onSummarize,
}: {
  summary: DailySummary | null;
  /** A summary is being written (this view's request, or one the server reports). */
  busy: boolean;
  error: string | null;
  onSummarize: () => void;
}) {
  const titleId = useId();
  const lines = useMemo(() => (summary ? summary.text.split('\n').filter(Boolean) : []), [summary]);

  // Busy, never disabled: disabling the button just pressed drops focus to <body>; a press while busy is ignored.
  // The default variant, not primary: the kit's primary label measured 3.85:1 on solarized and 4.45:1 on nord.
  const press = () => { if (!busy) onSummarize(); };
  const action = busy ? (
    <Button aria-busy="true" onClick={press}>Summarizing…</Button>
  ) : !summary ? (
    <Button onClick={press}>Summarize</Button>
  ) : summary.stale ? (
    <Button onClick={press} title="Write it again from the day as it is now">Update</Button>
  ) : (
    <Button variant="quiet" onClick={press}>Summarize again</Button>
  );

  return (
    <section className={styles.summaryCard} aria-labelledby={titleId}>
      <div className={styles.summaryHead}>
        <h2 id={titleId} className={styles.summaryTitle}>Summary</h2>
        {action}
      </div>
      {busy && !summary && <p className={styles.summaryNote} aria-live="polite">Writing the summary…</p>}
      {lines.length > 0 && (
        <ul className={styles.summaryList}>
          {lines.map((line, i) => <SummaryLine key={i} line={line} />)}
        </ul>
      )}
      {summary && (
        <p className={styles.summaryMeta}>
          {clock(summary.generatedAt)} · {summary.model} · from {summary.promptCount} prompt{summary.promptCount === 1 ? '' : 's'}
          {summary.stale && ' · the day has changed since'}
        </p>
      )}
      {error && <p className={styles.summaryError} role="alert">{error}</p>}
    </section>
  );
}
