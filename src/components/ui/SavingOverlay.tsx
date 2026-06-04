import styles from '@/styles/modules/SavingOverlay.module.css';

interface SavingOverlayProps {
  /** 0–100. Width of the filled bar. */
  progress?: number;
  /** Primary label, uppercased by CSS. */
  label?: string;
  /** Secondary detail line. */
  detail?: string;
}

export default function SavingOverlay({
  progress = 0,
  label = 'Quitting',
  detail = 'Saving workspace & config…',
}: SavingOverlayProps) {
  const clamped = Math.max(0, Math.min(100, progress));

  return (
    <div className={styles.overlay} role="alertdialog" aria-busy="true" aria-label={label}>
      <div className={styles.content}>
        <div className={styles.text}>{label}</div>
        <div
          className={styles.track}
          role="progressbar"
          aria-valuenow={Math.round(clamped)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={styles.bar} style={{ width: `${clamped}%` }} />
        </div>
        <div className={styles.detailRow}>
          <span className={styles.subtext}>{detail}</span>
          <span className={styles.percent}>{Math.round(clamped)}%</span>
        </div>
      </div>
    </div>
  );
}
