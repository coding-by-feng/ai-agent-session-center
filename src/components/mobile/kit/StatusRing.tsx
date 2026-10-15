/**
 * StatusRing — a session's state at a glance (AASC-38): a coloured ring with
 * the status glyph inside, so it never relies on colour alone, and the status in
 * words for screen readers (or beside it, `withLabel`). Working spins (not under
 * Reduce Motion).
 */
import StatusGlyph from '@/components/session/StatusGlyph';
import { phoneStatus } from '@/lib/chat/phoneStatus';
import { InterruptedIcon } from './kitIcons';
import styles from '@/styles/modules/mobile/StatusRing.module.css';

export interface StatusRingProps {
  status: string;
  interrupted?: boolean;
  size?: 'small' | 'regular';
  /** Show the words next to the ring (otherwise they are only spoken). */
  withLabel?: boolean;
}

export default function StatusRing({ status, interrupted, size = 'regular', withLabel }: StatusRingProps) {
  const { tone, label, glyph } = phoneStatus(status, interrupted);
  const ring = (
    <span
      className={`${styles.ring} ${size === 'small' ? styles.small : ''}`}
      data-tone={tone}
      data-spin={glyph === 'working' ? '' : undefined}
      role={withLabel ? undefined : 'img'}
      aria-label={withLabel ? undefined : label}
      aria-hidden={withLabel ? true : undefined}
    >
      <span className={styles.glyph}>
        {glyph === 'interrupted' ? <InterruptedIcon /> : <StatusGlyph status={glyph} />}
      </span>
    </span>
  );
  if (!withLabel) return ring;
  return (
    <span className={styles.labelled}>
      {ring}
      <span className={styles.label}>{label}</span>
    </span>
  );
}
