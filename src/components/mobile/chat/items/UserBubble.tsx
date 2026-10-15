/**
 * UserBubble — your prompt (AASC-41): a bubble on the right with the text as you
 * typed it and how many images went with it. A very long prompt (a paste) shows
 * 12 lines with "Show all"; search opens it.
 */
import type { UserItem } from '@/lib/chat/buildChatItems';
import { plural } from '@/lib/chat/chatFormat';
import { ImageIcon } from '../chatIcons';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

const LONG_LINES = 12;
const LONG_CHARS = 1200;

export interface UserBubbleProps {
  item: UserItem;
  expanded: boolean;
  onToggle: (key: string) => void;
}

export default function UserBubble({ item, expanded, onToggle }: UserBubbleProps) {
  const long = item.text.length > LONG_CHARS || item.text.split('\n').length > LONG_LINES;
  return (
    <div className={styles.userRow}>
      {item.text && (
        <div className={`${styles.bubble}${long && !expanded ? ` ${styles.bubbleClamped}` : ''}`} data-ai-context="">
          {item.text}
        </div>
      )}
      {item.images > 0 && (
        <span className={styles.bubbleFacts}>
          <ImageIcon size={14} />
          {plural(item.images, 'image')}
        </span>
      )}
      {item.truncated && <span className={styles.bubbleFacts}>The phone received the first 16 KB of this prompt.</span>}
      {long && (
        <button type="button" className={`${styles.smallBtn} ${styles.plainBtn}`} onClick={() => onToggle(item.key)} aria-expanded={expanded}>
          {expanded ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}
