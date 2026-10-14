/**
 * StatusBadge — a session's status as one non-interactive mark: the status glyph
 * in its colour, then the status in words (AASC-11).
 *
 * The LIVE board's cards and the session panel header each drew their own
 * (a glyph + "Working" on one, a letter-spaced "WORKING" on the other), so the
 * same state looked different a click apart. This is the one look: no border and
 * no fill, so it never reads as a button; the colour is on the glyph, and the
 * words stay body-text colour, so they hold 4.5:1 in every theme.
 */
import type { CSSProperties } from 'react';
import { statusColor, statusLabel } from '@/lib/sessionStatusStyle';
import StatusGlyph from './StatusGlyph';
import styles from '@/styles/modules/StatusBadge.module.css';

interface StatusBadgeProps {
  status: string;
  /** Words to show instead of the status's own name. */
  label?: string;
  className?: string;
}

export default function StatusBadge({ status, label, className }: StatusBadgeProps) {
  return (
    <span
      className={`${styles.badge}${className ? ` ${className}` : ''}`}
      data-status={status}
      style={{ '--status-color': statusColor(status) } as CSSProperties}
    >
      <span className={styles.glyph} aria-hidden="true">
        <StatusGlyph status={status} />
      </span>
      <span className={styles.label}>{label ?? statusLabel(status)}</span>
    </span>
  );
}
