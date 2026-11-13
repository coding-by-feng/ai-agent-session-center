/**
 * WorkingChip — the agent's live state at the bottom-left of the composer's chips row
 * (Nov 13 2026; it replaced the working strip above the box, giving that row back to the
 * chat): a pulsing mark and the elapsed time. Its spoken name carries the whole status
 * ("Working · Bash · for 0:42: show the terminal's last lines"); the open peek's header
 * shows it in words. A tap shows or hides the terminal's last lines above the box
 * (PeekPanel), the switch the strip's ⌄ was. Draws nothing while the agent isn't busy.
 */
import type { Session } from '@/types';
import { peekPanelId, usePeekOpen } from './usePeekOpen';
import { spokenStatus, useWorkingStatus } from './useWorkingStatus';
import styles from '@/styles/modules/mobile/Composer.module.css';

export default function WorkingChip({ session }: { session: Session }) {
  const status = useWorkingStatus(session);
  const [open, toggle] = usePeekOpen();
  if (!status.live) return null;
  return (
    <button
      type="button"
      className={`${styles.chip} ${styles.workingChip}`}
      data-tone={status.finishing ? 'quiet' : undefined}
      aria-expanded={open}
      aria-controls={open ? peekPanelId(session.sessionId) : undefined}
      aria-label={`${spokenStatus(status)}: ${open ? 'hide' : 'show'} the terminal’s last lines`}
      onClick={toggle}
      data-testid="composer-working-chip"
    >
      <span className={styles.workingMark} aria-hidden="true" />
      {status.elapsed && <span className={styles.workingTime}>{status.elapsed}</span>}
    </button>
  );
}
