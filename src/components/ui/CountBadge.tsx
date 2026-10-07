/**
 * CountBadge — a number in a pill: the AGENDA tab's open-task count, a group's
 * size in a SectionHeader. `accent` is filled (draws the eye — use it where the
 * number is news); `muted` is quiet (a group size you read, not notice).
 *
 * `label` describes the number for screen readers ("32 open tasks"); without it
 * the bare digits are read. It is real (visually hidden) text, not aria-label:
 * aria-label on a plain <span> is prohibited by ARIA 1.2 and ignored by some
 * screen readers.
 */
import styles from '@/styles/modules/Chip.module.css';

interface CountBadgeProps {
  count: number;
  tone?: 'accent' | 'muted';
  /** Show `${max}+` past this. */
  max?: number;
  label?: string;
  className?: string;
}

export default function CountBadge({ count, tone = 'muted', max, label, className }: CountBadgeProps) {
  const text = max !== undefined && count > max ? `${max}+` : String(count);
  const cls = [styles.badge, tone === 'accent' ? styles.badgeAccent : styles.badgeMuted, className]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} title={label}>
      <span aria-hidden={label ? true : undefined}>{text}</span>
      {label && <span className={styles.srOnly}> {label}</span>}
    </span>
  );
}
