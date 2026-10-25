/**
 * RefusalReason — why a resource can't be saved or synced (Oct 26 2026). The first line is the
 * reason; any further lines are its details, one per line in mono (a "possible secret" refusal
 * names `SKILL.md · line 61: <masked line>`, server/resourcePackages/secretHits.ts). Spans only,
 * so it fits inside a sentence, a list item or an alert.
 */
import styles from '@/styles/modules/RefusalReason.module.css';

export default function RefusalReason({ reason }: { reason: string }) {
  const [headline, ...details] = reason.split('\n');
  return (
    <>
      {headline}
      {details.length > 0 && (
        <span className={styles.details}>
          {details.map((line, i) => (
            <span key={i} className={styles.line}>{line}</span>
          ))}
        </span>
      )}
    </>
  );
}
