/**
 * ChatFooter — the bottom of a session's Chat (AASC-42/43): the waiting card,
 * when the session waits on you, above the composer.
 *
 * It sits under the chat in the session screen's column, so it rides the
 * keyboard: the phone app's WebView shrinks for it (Keyboard.resize 'native'),
 * and while the keyboard is up the home-indicator inset isn't added under it.
 * The card is server state (`session.pendingRequest`), so after a reconnect it
 * comes back by itself.
 */
import { useCallback, useMemo, useRef } from 'react';
import type { Session } from '@/types';
import { useSoftKeyboardOpen } from '../app/useSoftKeyboardOpen';
import { waitingCardModel } from '@/lib/chat/waitingCardModel';
import WaitingCard from './WaitingCard';
import Composer from './Composer';
import styles from '@/styles/modules/mobile/Composer.module.css';

export interface ChatFooterProps {
  session: Session;
  /** Switch the session screen to its Terminal segment. */
  onTerminal: () => void;
}

export default function ChatFooter({ session, onTerminal }: ChatFooterProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const keyboardOpen = useSoftKeyboardOpen();
  const card = useMemo(() => waitingCardModel(session), [session]);
  const focusComposer = useCallback(() => inputRef.current?.focus(), []);

  return (
    <div className={styles.footer} data-keyboard={keyboardOpen ? '' : undefined} data-testid="chat-footer">
      {card && (
        <div className={styles.cardSlot}>
          <WaitingCard
            key={`${session.sessionId}:${card.requestId ?? 'guess'}`}
            session={session}
            card={card}
            onTerminal={onTerminal}
            onTell={focusComposer}
          />
        </div>
      )}
      <Composer key={session.sessionId} session={session} card={card} inputRef={inputRef} />
    </div>
  );
}
