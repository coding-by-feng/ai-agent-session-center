/**
 * StatusStrip — full-screen Chat's status line while the agent works (AASC-41):
 * "● Working · Bash · 0:42  ⌄  ■ Stop", "● Compacting context · auto · 0:23  ■ Stop", or
 * "● Finishing up · Stop hooks · 0:12" (no Stop: Esc would cancel the user's own Stop hooks).
 * ⌄ shows the terminal's last lines under it (Oct 19 2026, remembered per phone), whose opened
 * face has "Open terminal" (AASC-56).
 *
 * Since Nov 13 2026 it shows only when no composer sits under the chat (full-screen Chat, ⤢).
 * With the composer, the status is the chip at the bottom-left of its chips row (WorkingChip),
 * Stop is the ■ beside its send button (StopButton) and the lines open above the box
 * (PeekPanel). The words come from useWorkingStatus and Stop from useAgentStop in every case.
 */
import { useId } from 'react';
import type { Session } from '@/types';
import { Button } from '../kit';
import TerminalPeek from './TerminalPeek';
import { ChevronIcon, SquareStopIcon } from './chatViewIcons';
import { useAgentStop } from './useAgentStop';
import { usePeekOpen } from './usePeekOpen';
import { useWorkingStatus } from './useWorkingStatus';
import styles from '@/styles/modules/mobile/Chat.module.css';

export interface StatusStripProps {
  session: Session;
  peek: readonly string[];
  /** Opens the session's terminal screen, from the opened peek (AASC-56). */
  onOpenTerminal: () => void;
}

export default function StatusStrip({ session, peek, onOpenTerminal }: StatusStripProps) {
  const status = useWorkingStatus(session);
  const { stop, writing, error, disabledReason } = useAgentStop(session, status.turn);
  const [peekOpen, togglePeek] = usePeekOpen();
  const peekId = useId();
  const { label, tool, elapsed, finishing, stopPending } = status;

  if (!status.live) return null;

  return (
    <div className={styles.strip} data-testid="chat-status-strip">
      <div className={styles.stripRow}>
        <span className={styles.stripDot} data-tone={finishing ? 'quiet' : undefined} aria-hidden="true" />
        {/* The time has its own box, so a long label truncates before the time does. */}
        <span className={styles.stripLabel}>
          <span className={styles.stripText}>
            {label}
            {tool && <> · <span className={styles.stripTool}>{tool}</span></>}
          </span>
          {elapsed && <span className={styles.stripTime}> · <span aria-label={`for ${elapsed}`}>{elapsed}</span></span>}
        </span>
        <button
          type="button"
          className={styles.stripToggle}
          data-open={peekOpen ? '' : undefined}
          aria-expanded={peekOpen}
          aria-controls={peekOpen ? peekId : undefined}
          aria-label="Show the terminal’s last lines"
          onClick={togglePeek}
        >
          <ChevronIcon size={18} />
        </button>
        {!finishing && <Button
          small
          variant="secondary"
          icon={<SquareStopIcon size={16} />}
          onClick={() => { void stop(); }}
          loading={writing || stopPending}
          loadingLabel="Stopping…"
          disabledReason={disabledReason}
          aria-label="Stop the agent (Esc)"
          className={styles.stripStop}
        >
          {writing || stopPending ? 'Stopping…' : 'Stop'}
        </Button>}
      </div>
      {error && <p className={styles.stripError} role="alert">{error}</p>}
      {peekOpen && (
        <div id={peekId}>
          <TerminalPeek terminalId={session.terminalId} lines={peek} onOpenTerminal={onOpenTerminal} />
        </div>
      )}
    </div>
  );
}
