/**
 * EmptyState — the one way a view says "nothing here", "loading" or "that
 * failed". An empty list is an invitation to act, so pass `action` when there
 * is a next step; an error says what went wrong and offers the retry.
 *
 *   <EmptyState title="No tasks yet" hint="Add your first task below." />
 *   <EmptyState busy title="Loading prompts…" />
 *   <EmptyState tone="error" title="Could not load prompts." action={<Button onClick={retry}>Retry</Button>} />
 *
 * `fill` grows it to the free height of a flex column (a view body); `compact`
 * is for a box inside a list.
 */
import type { ReactNode } from 'react';
import styles from '@/styles/modules/EmptyState.module.css';

interface EmptyStateProps {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  tone?: 'default' | 'error';
  busy?: boolean;
  fill?: boolean;
  compact?: boolean;
  className?: string;
}

export default function EmptyState({
  title,
  hint,
  action,
  icon,
  tone = 'default',
  busy,
  fill,
  compact,
  className,
}: EmptyStateProps) {
  const cls = [
    styles.empty,
    fill ? styles.fill : undefined,
    compact ? styles.compact : undefined,
    tone === 'error' ? styles.error : undefined,
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={cls} role={tone === 'error' ? 'alert' : 'status'} aria-busy={busy || undefined}>
      {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
      <p className={styles.title}>{title}</p>
      {hint && <p className={styles.hint}>{hint}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
