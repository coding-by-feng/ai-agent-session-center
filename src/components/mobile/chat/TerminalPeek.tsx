/**
 * TerminalPeek — the last lines of the session's terminal under the working strip
 * (AASC-41): three lines, twelve once tapped. It covers what the CLI prints before
 * it reaches the transcript (a reply is written there only once it is complete).
 * Plain text, colours dropped, no xterm: the chat holds the subscription
 * (useTerminalPeek) for as long as it is the screen on show, so the strip coming
 * and going every turn never makes the server replay the scrollback.
 */
import { memo, useState } from 'react';
import { ChevronIcon } from './chatViewIcons';
import styles from '@/styles/modules/mobile/Chat.module.css';

const COLLAPSED = 3;
const EXPANDED = 12;

function TerminalPeek({ terminalId, lines }: { terminalId: string | null; lines: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const shown = lines.slice(-(open ? EXPANDED : COLLAPSED));
  return (
    <button
      type="button"
      className={styles.peek}
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      data-testid="chat-terminal-peek"
    >
      <span className={styles.srOnly}>Terminal, last lines: </span>
      <span className={`${styles.peekChev}${open ? ` ${styles.peekChevOpen}` : ''}`} aria-hidden="true"><ChevronIcon size={14} /></span>
      {shown.length === 0
        ? <span className={`${styles.peekLine} ${styles.peekEmpty}`}>{terminalId ? 'Waiting for output…' : 'No terminal for this session'}</span>
        : shown.map((line, i) => <span key={i} className={styles.peekLine}>{line || ' '}</span>)}
    </button>
  );
}

export default memo(TerminalPeek);
