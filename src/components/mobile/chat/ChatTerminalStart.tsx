/**
 * ChatTerminalStart — the Chat segment while the session has no conversation to show yet
 * (Oct 23 2026): a new session, a transcript AASC hasn't found, or a shell. Instead of an empty
 * state it shows the session's terminal, live, so a prompt sent from the phone shows what the CLI
 * prints at once; the conversation replaces it as soon as the transcript appears.
 *
 * The lines come from ChatView's one terminal subscription (useTerminalPeek), the same stream the
 * working strip's peek reads, so the switch to the conversation never resubscribes (each new
 * subscription makes the server resend its whole scrollback). Plain text, colours dropped, long
 * lines wrap: panning is the Terminal screen's job. The scroller is `column-reverse`, so it stays
 * pinned to the newest line and keeps its place while the reader scrolls up.
 */
import { Button } from '../kit';
import { TerminalIcon } from './chatIcons';
import styles from '@/styles/modules/mobile/Chat.module.css';

export interface ChatTerminalStartProps {
  title: string;
  message: string;
  lines: readonly string[];
  onTerminal: () => void;
}

export default function ChatTerminalStart({ title, message, lines, onTerminal }: ChatTerminalStartProps) {
  return (
    <div className={styles.terminalStart} data-testid="chat-terminal-start">
      <div className={styles.terminalStartHead}>
        <h2 className={styles.terminalStartTitle}>{title}</h2>
        <p className={styles.terminalStartMessage}>{message}</p>
      </div>
      <div className={styles.terminalStartScreen} role="log" aria-label="Terminal output" aria-live="polite">
        <div>
          {lines.length === 0
            ? <span className={styles.terminalStartEmpty}>Waiting for output…</span>
            : lines.map((line, i) => <span key={i} className={styles.terminalStartLine}>{line || ' '}</span>)}
        </div>
      </div>
      <div className={styles.terminalStartActions}>
        <Button variant="primary" icon={<TerminalIcon />} onClick={onTerminal}>Open Terminal</Button>
      </div>
    </div>
  );
}
