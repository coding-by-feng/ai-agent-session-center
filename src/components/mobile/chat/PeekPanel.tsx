/**
 * PeekPanel — the terminal's last lines above the composer while the agent works, opened from
 * the status chip under the box (Nov 13 2026; before, from the working strip's ⌄). Headed by
 * the status in words ("Working · Bash · 0:42"), which the chip shows only as a time. The lines
 * come from ChatView's one terminal subscription; the opened peek offers "Open terminal".
 */
import type { Session } from '@/types';
import TerminalPeek from './TerminalPeek';
import { peekPanelId, usePeekOpen } from './usePeekOpen';
import { useWorkingStatus } from './useWorkingStatus';
import styles from '@/styles/modules/mobile/Chat.module.css';

export interface PeekPanelProps {
  session: Session;
  peek: readonly string[];
  onOpenTerminal: () => void;
}

export default function PeekPanel(props: PeekPanelProps) {
  const [open] = usePeekOpen();
  return open ? <OpenPeekPanel {...props} /> : null;
}

function OpenPeekPanel({ session, peek, onOpenTerminal }: PeekPanelProps) {
  const { live, label, tool, elapsed, finishing } = useWorkingStatus(session);
  if (!live) return null;
  return (
    <div className={styles.strip} id={peekPanelId(session.sessionId)} data-testid="chat-peek-panel">
      <p className={styles.peekHeader}>
        <span className={styles.stripDot} data-tone={finishing ? 'quiet' : undefined} aria-hidden="true" />
        {/* As on the strip: the time has its own box, so a long label truncates before it does. */}
        <span className={styles.stripLabel}>
          <span className={styles.stripText}>
            {label}
            {tool && <> · <span className={styles.stripTool}>{tool}</span></>}
          </span>
          {elapsed && <span className={styles.stripTime}> · {elapsed}</span>}
        </span>
      </p>
      <TerminalPeek terminalId={session.terminalId} lines={peek} onOpenTerminal={onOpenTerminal} />
    </div>
  );
}
