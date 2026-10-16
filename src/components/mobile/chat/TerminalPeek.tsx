/**
 * TerminalPeek — the last lines of the session's terminal under the working strip
 * (AASC-41): three lines, twelve once tapped. It covers what the CLI prints before
 * it reaches the transcript (a reply is written there only once it is complete).
 * Plain text, colours dropped, no xterm: the chat holds the subscription
 * (useTerminalPeek) for as long as it is the screen on show, so the strip coming
 * and going every turn never makes the server replay the scrollback.
 *
 * Opened, it offers "Open terminal" (AASC-56): the terminal is no longer a tab but
 * a screen pushed over the chat.
 */
import { memo, useState } from 'react';
import { Button } from '../kit';
import { ChevronIcon } from './chatViewIcons';
import { TerminalIcon } from './chatIcons';
import styles from '@/styles/modules/mobile/Chat.module.css';

const COLLAPSED = 3;
const EXPANDED = 12;

export interface TerminalPeekProps {
  terminalId: string | null;
  lines: readonly string[];
  /** Opens the session's terminal screen (stable: the peek is memoised). */
  onOpenTerminal: () => void;
}

function TerminalPeek({ terminalId, lines, onOpenTerminal }: TerminalPeekProps) {
  const [open, setOpen] = useState(false);
  const shown = lines.slice(-(open ? EXPANDED : COLLAPSED));
  return (
    <>
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
    {open && terminalId && (
      <div className={styles.peekActions}>
        <Button small variant="secondary" icon={<TerminalIcon />} onClick={onOpenTerminal}>Open terminal</Button>
      </div>
    )}
    </>
  );
}

export default memo(TerminalPeek);
