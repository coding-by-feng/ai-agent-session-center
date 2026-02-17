/**
 * SummaryTab displays an AI-generated session summary.
 * Ported from the summary section in public/js/detailPanel.js.
 */
import styles from '@/styles/modules/DetailPanel.module.css';

interface SummaryTabProps {
  summary: string | undefined;
}

export default function SummaryTab({ summary }: SummaryTabProps) {
  if (!summary) {
    return (
      <div className={styles.tabEmpty}>
        No summary yet — click SUMMARIZE to generate one with AI
      </div>
    );
  }

  return (
    <div className={styles.summaryText}>
      {summary.split('\n').map((line, i) => (
        <span key={i}>
          {line}
          {i < summary.split('\n').length - 1 && <br />}
        </span>
      ))}
    </div>
  );
}
