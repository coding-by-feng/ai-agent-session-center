/**
 * AssistantText — the agent's text (AASC-41), whole and formatted. Never
 * shortened or summarised: if the Mac's 16 KB cap cut it, the row says so and
 * points at the Terminal. The last reply of a turn (the answer) gets Copy, Read
 * aloud (once Voice is set up on this phone) and "Ask AI" (AASC-57) while AI
 * popups are on for this chat: the whole answer as the selection (explain it,
 * translate it, your own prompt), since selecting a long answer with the handles
 * is slow on a phone.
 *
 * Only the newest answer shows them without asking (Oct 20 2026): a row under
 * every answer took a line each. An older one shows them when tapped, or from its
 * "Actions for this answer" button (hidden until focused) for keyboards and
 * screen readers. A tap on a link, a button or selected text is not that tap.
 *
 * The Markdown renderer loads lazily; until it has, the same text shows plain, so
 * nothing is ever hidden while it loads.
 */
import { lazy, Suspense, useState, type MouseEvent } from 'react';
import type { AssistantItem } from '@/lib/chat/buildChatItems';
import CopyButton from '../CopyButton';
import ReadAloudButton from '../../ReadAloudButton';
import { SparkIcon } from '../../phoneIcons';
import { usePhoneAiScopeOn, usePhoneAiStore } from '@/stores/phoneAiStore';
import { useReadAloudReady, useReadAloudSpeaking } from '@/hooks/useReadAloud';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

const ChatMarkdown = lazy(() => import('./ChatMarkdown'));

export interface AssistantTextProps {
  item: AssistantItem;
  sessionId: string;
}

/** Taps that mean something else: a link, a control, or the end of a text selection. */
function isOwnTap(e: MouseEvent<HTMLElement>): boolean {
  if ((e.target as HTMLElement).closest('a, button, input, summary, [data-file-link]')) return false;
  const selection = window.getSelection?.();
  return !selection || selection.isCollapsed;
}

export default function AssistantText({ item, sessionId }: AssistantTextProps) {
  const canAsk = usePhoneAiScopeOn(sessionId);
  const canRead = useReadAloudReady();
  const [revealed, setRevealed] = useState(false);
  const speakKey = `chat:${sessionId}:${item.key}`;
  // While this answer is read aloud its button stays, even once a newer answer takes over:
  // a read-aloud button that unmounts stops its own reading.
  const speaking = useReadAloudSpeaking(speakKey);
  const showActions = item.isAnswer && (item.latestAnswer || revealed || speaking);
  const reveal = item.isAnswer && !item.latestAnswer
    ? (e: MouseEvent<HTMLElement>) => { if (isOwnTap(e)) setRevealed((v) => !v); }
    : undefined;
  return (
    <div className={styles.assistant} data-ai-context="" onClick={reveal}>
      <Suspense fallback={<p className={styles.plainText}>{item.text}</p>}>
        <ChatMarkdown text={item.text} />
      </Suspense>
      {item.truncated && (
        <p className={styles.note}>This reply is longer than the phone receives (16 KB). The rest is in the Terminal.</p>
      )}
      {item.isAnswer && !item.latestAnswer && !revealed && (
        <button type="button" className={styles.revealActions} onClick={() => setRevealed(true)}>
          Actions for this answer
        </button>
      )}
      {showActions && (
        <div className={styles.answerActions}>
          <CopyButton text={item.text} className={styles.answerBtn} label="Copy this answer" />
          {canRead && <ReadAloudButton speakKey={speakKey} source={() => item.text} />}
          {canAsk && (
            <button
              type="button"
              className={styles.answerBtn}
              aria-label="Ask AI about this answer"
              onClick={() => usePhoneAiStore.getState().ask(sessionId, { text: item.text })}
            >
              <SparkIcon />
              <span>Ask AI</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
