/**
 * Highlighted — `text` with every case-insensitive hit of `query` marked, by the
 * shared rule (lib/textHighlight). The project search's hit lines use it.
 */
import { normalizeQuery, splitHighlight } from '@/lib/textHighlight';
import styles from '@/styles/modules/PhoneProject.module.css';

export default function Highlighted({ text, query }: { text: string; query: string }) {
  const segments = splitHighlight(text, normalizeQuery(query));
  if (segments.length === 1 && !segments[0].match) return <>{text || ' '}</>;
  return (
    <>
      {segments.map((seg, i) =>
        seg.match ? <mark key={i} className={styles.mark}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}
