/**
 * StopButton — the phone's one Stop, a ■ beside the composer's send button while the agent
 * works (Nov 13 2026; it was on the working strip above the box). One tap writes Esc
 * (useAgentStop); it then holds "Stopping…" until the turn ends, a new one starts or 5 s pass.
 * None while Claude runs its Stop hooks: Esc there cancels them, and the answer is in.
 * A failed write goes to `onError`, which the composer shows under the box.
 */
import { useId } from 'react';
import type { Session } from '@/types';
import { SquareStopIcon } from './chatViewIcons';
import { useAgentStop } from './useAgentStop';
import { useWorkingStatus } from './useWorkingStatus';
import styles from '@/styles/modules/mobile/Composer.module.css';

export interface StopButtonProps {
  session: Session;
  /** Why the last Stop failed, or null when a new one starts. */
  onError: (message: string | null) => void;
}

export default function StopButton({ session, onError }: StopButtonProps) {
  const status = useWorkingStatus(session);
  const { stop, writing, disabledReason } = useAgentStop(session, status.turn);
  const reasonId = useId();
  if (!status.live || status.finishing) return null;

  const busy = writing || status.stopPending;
  const run = async () => {
    onError(null);
    onError(await stop());
  };
  return (
    <>
      <button
        type="button"
        className={`${styles.tool} ${styles.stop}`}
        aria-label={busy ? 'Stopping…' : 'Stop the agent (Esc)'}
        aria-busy={busy || undefined}
        aria-disabled={busy || disabledReason ? true : undefined}
        aria-describedby={disabledReason ? reasonId : undefined}
        onClick={() => { if (!busy && !disabledReason) void run(); }}
        data-testid="composer-stop"
      >
        {busy ? <span className={styles.stopSpinner} aria-hidden="true" /> : <SquareStopIcon size={18} />}
      </button>
      {disabledReason && <span id={reasonId} className={styles.srOnly}>{disabledReason}</span>}
    </>
  );
}
