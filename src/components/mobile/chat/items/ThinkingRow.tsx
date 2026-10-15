/**
 * ThinkingRow — "Thought for 12 s" (AASC-41). Not a button: the thinking itself
 * is never sent to the phone, so there is nothing to open.
 */
import type { ThinkingItem } from '@/lib/chat/buildChatItems';
import { thoughtLabel } from '@/lib/chat/chatFormat';
import { ThoughtIcon } from '../chatViewIcons';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

export default function ThinkingRow({ item }: { item: ThinkingItem }) {
  return (
    <div className={styles.thinking}>
      <span className={styles.rowIcon}><ThoughtIcon size={18} /></span>
      <span>{thoughtLabel(item.durationMs)}</span>
    </div>
  );
}
