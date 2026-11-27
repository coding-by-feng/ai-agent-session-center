/**
 * RowBadges — the second line of a devices switcher row (Nov 27 2026): pills for state, connection and counts, then
 * the one reason they can't say. The row's sentence ("Online · Tailscale · 4 shared · 1 needs you") stays in the
 * markup for screen readers, and the pills are hidden from them, so nothing is read twice. A lone pill (or reason) that says
 * the whole sentence is the text itself.
 */
import type { RowBadge } from '@/lib/remoteComputerBadges';
import styles from '@/styles/modules/RowBadges.module.css';

export interface RowBadgesProps {
  badges: readonly RowBadge[];
  reason?: string | null;
  /** What the line says, read by screen readers in place of the pills. */
  sentence: string;
}

export default function RowBadges({ badges, reason = null, sentence }: RowBadgesProps) {
  if (badges.length === 0 && !reason) return null;
  // One piece that says the whole sentence ("Offline", "2 sessions", or only the words) is the text itself: no
  // hidden copy beside it.
  const pieces = [...badges.map((b) => b.label), ...(reason ? [reason] : [])];
  const pillIsSentence = pieces.length === 1 && pieces[0] === sentence;
  return (
    <span className={styles.line} data-testid="row-badges">
      {!pillIsSentence && <span className={styles.srOnly}>{sentence}</span>}
      <span className={styles.pills} aria-hidden={pillIsSentence ? undefined : true}>
        {badges.map((b) => (
          <span key={b.id} className={`${styles.pill} ${styles[b.tone] ?? ''}`} data-tone={b.tone}>{b.label}</span>
        ))}
        {reason && <span className={styles.reason}>{reason}</span>}
      </span>
    </span>
  );
}
