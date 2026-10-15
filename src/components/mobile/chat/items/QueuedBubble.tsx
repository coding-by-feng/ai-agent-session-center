/**
 * QueuedBubble — a prompt waiting in this session's queue (AASC-41): dimmed, at
 * the end of the chat, "Queued · 2nd". The Mac's queue sends it when the agent is
 * free; "Pull back" takes it out of the queue and puts its text in your message.
 */
import type { QueuedItem } from '@/lib/chat/buildChatItems';
import { ordinal, plural } from '@/lib/chat/chatFormat';
import { UndoIcon } from '../chatIcons';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

export interface QueuedBubbleProps {
  item: QueuedItem;
  onPullBack: (item: QueuedItem) => void;
}

export default function QueuedBubble({ item, onPullBack }: QueuedBubbleProps) {
  return (
    <div className={styles.userRow}>
      <div className={styles.queuedBubble}>{item.text}</div>
      <div className={styles.queuedFacts}>
        <span>Queued · {ordinal(item.order)}{item.images > 0 ? ` · ${plural(item.images, 'image')}` : ''}</span>
        <button
          type="button"
          className={`${styles.smallBtn} ${styles.plainBtn}`}
          onClick={() => onPullBack(item)}
          aria-label={`Pull back the ${ordinal(item.order)} queued prompt into your message`}
        >
          <UndoIcon size={16} />
          Pull back
        </button>
      </div>
    </div>
  );
}
