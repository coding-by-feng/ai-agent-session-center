/**
 * Chip — a filter or a choice in a sideways row (AASC-38): "Needs you 3".
 *
 * A toggle button (`aria-pressed`) when it filters, a plain button when it acts,
 * a label when it does neither. The pill is 32px; the button around it is 44px
 * tall so the touch target holds.
 */
import { useId, type ReactNode } from 'react';
import styles from '@/styles/modules/mobile/Chip.module.css';

export interface ChipProps {
  label: string;
  /** A filter's state; omit for an action chip. */
  selected?: boolean;
  count?: number;
  icon?: ReactNode;
  onClick?: () => void;
  disabledReason?: string;
}

export default function Chip({ label, selected, count, icon, onClick, disabledReason }: ChipProps) {
  const reasonId = useId();
  const pill = (
    <span className={styles.pill}>
      {icon}
      <span>{label}</span>
      {count != null && <span className={styles.count}>{count}</span>}
    </span>
  );
  if (!onClick) return <span className={styles.static}>{pill}</span>;
  return (
    <button
      type="button"
      className={styles.chip}
      aria-pressed={selected === undefined ? undefined : selected}
      aria-label={count != null ? `${label} ${count}` : undefined}
      aria-disabled={disabledReason ? true : undefined}
      aria-describedby={disabledReason ? reasonId : undefined}
      onClick={() => { if (!disabledReason) onClick(); }}
    >
      {pill}
      {disabledReason && <span id={reasonId} className={styles.srOnly}>{disabledReason}</span>}
    </button>
  );
}
