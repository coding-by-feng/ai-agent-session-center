/**
 * TerminalReader — the desktop terminal's Reader view (Nov 16 2026).
 *
 *   [toolbar … 📖 Reader …]
 *   ┌──────────────────────────────┐
 *   │  ## heading · lists · `code` │  the phone Chat's rows (ChatView), read-only:
 *   │  ┌────┬────┐ tables fit      │  formatted Markdown from the transcript
 *   └──────────────────────────────┘
 *
 * Drawn over the terminal area, never instead of it: xterm stays mounted and laid
 * out underneath, so the PTY width is never re-fitted from a hidden element.
 * The phone tokens (--ph-*) are remapped to the desktop theme in the module.
 */
import { lazy, Suspense } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import styles from '@/styles/modules/TerminalReader.module.css';

const ChatView = lazy(() => import('@/components/mobile/chat/ChatView'));

interface TerminalReaderProps {
  sessionId: string;
  /** Back to the live terminal (the chat's own "Open Terminal" buttons). */
  onTerminal: () => void;
}

export default function TerminalReader({ sessionId, onTerminal }: TerminalReaderProps) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  return (
    <div className={styles.reader} data-testid="terminal-reader">
      <div className={styles.column}>
        {session ? (
          <Suspense fallback={<div className={styles.note}>Loading…</div>}>
            <ChatView session={session} onTerminal={onTerminal} />
          </Suspense>
        ) : (
          <div className={styles.note}>This session is no longer available.</div>
        )}
      </div>
    </div>
  );
}
