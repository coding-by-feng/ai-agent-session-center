/**
 * StaleNote — the line over a list whose last refresh failed while its rows
 * stayed on screen (a kept page, a polled list). It says the rows may be out of
 * date and offers Retry when asking again can help. A failure with nothing to
 * show is EmptyState's `tone="error"`, not this.
 *
 *   {isError && data && <StaleNote onRetry={canRetry(error) ? refetch : undefined} />}
 */
import type { ReactNode } from 'react';
import Button from '@/components/ui/Button';
import styles from '@/styles/modules/EmptyState.module.css';

interface StaleNoteProps {
  /** Omit when retrying cannot help (a refusal); the note then only informs. */
  onRetry?: () => void;
  children?: ReactNode;
}

export default function StaleNote({
  onRetry,
  children = "Couldn't refresh. Showing the last results.",
}: StaleNoteProps) {
  return (
    <div className={styles.staleNote} role="alert">
      <span>{children}</span>
      {onRetry && (
        <Button size="sm" variant="quiet" onClick={() => onRetry()}>
          Retry
        </Button>
      )}
    </div>
  );
}
