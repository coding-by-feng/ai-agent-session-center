/**
 * EmptyState — nothing to show, said plainly, with the way forward (AASC-38):
 * "No sessions shared with this phone yet." + what to do about it.
 */
import type { ReactNode } from 'react';
import styles from '@/styles/modules/mobile/EmptyState.module.css';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  message?: ReactNode;
  /** A kit Button (or two). */
  action?: ReactNode;
  /** `status`: a loading or waiting state screen readers should hear. */
  live?: boolean;
}

export default function EmptyState({ icon, title, message, action, live }: EmptyStateProps) {
  return (
    <div className={styles.empty} role={live ? 'status' : undefined}>
      {icon && <span className={styles.icon}>{icon}</span>}
      <p className={styles.title}>{title}</p>
      {message && <div className={styles.message}>{message}</div>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
