/**
 * AssistantText — the agent's text (AASC-41), whole and formatted. Never
 * shortened or summarised: if the Mac's 16 KB cap cut it, the row says so and
 * points at the Terminal. The last reply of a turn (the answer) gets Copy and
 * Read aloud, and "Ask AI" (AASC-57) while AI popups are on for this chat: the
 * whole answer as the selection (explain it, translate it, your own prompt),
 * since selecting a long answer with the handles is slow on a phone.
 *
 * The Markdown renderer loads lazily; until it has, the same text shows plain, so
 * nothing is ever hidden while it loads.
 */
import { lazy, Suspense } from 'react';
import type { AssistantItem } from '@/lib/chat/buildChatItems';
import CopyButton from '../CopyButton';
import ReadAloudButton from '../../ReadAloudButton';
import { SparkIcon } from '../../phoneIcons';
import { usePhoneAiScopeOn, usePhoneAiStore } from '@/stores/phoneAiStore';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

const ChatMarkdown = lazy(() => import('./ChatMarkdown'));

export interface AssistantTextProps {
  item: AssistantItem;
  sessionId: string;
}

export default function AssistantText({ item, sessionId }: AssistantTextProps) {
  const canAsk = usePhoneAiScopeOn(sessionId);
  return (
    <div className={styles.assistant} data-ai-context="">
      <Suspense fallback={<p className={styles.plainText}>{item.text}</p>}>
        <ChatMarkdown text={item.text} />
      </Suspense>
      {item.truncated && (
        <p className={styles.note}>This reply is longer than the phone receives (16 KB). The rest is in the Terminal.</p>
      )}
      {item.isAnswer && (
        <div className={styles.answerActions}>
          <CopyButton text={item.text} className={styles.answerBtn} label="Copy this answer" />
          <ReadAloudButton speakKey={`chat:${sessionId}:${item.key}`} source={() => item.text} />
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
