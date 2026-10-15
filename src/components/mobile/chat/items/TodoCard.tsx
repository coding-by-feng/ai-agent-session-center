/**
 * TodoCard — a plan update (AASC-41): "Plan · 3 of 4 done". The newest plan is a
 * card, open until you close it; earlier ones are a row that opens to the list as
 * it was then. Each step says its state in words as well as with a mark.
 */
import { useId } from 'react';
import type { TodoItem } from '@/lib/chat/buildChatItems';
import { CheckIcon, ChecklistIcon, ChevronIcon } from '../chatIcons';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

const STATE = {
  completed: { word: 'done', className: styles.todoDone },
  in_progress: { word: 'in progress', className: styles.todoActive },
} as const;

function Mark({ status }: { status: string }) {
  if (status === 'completed') return <CheckIcon size={16} />;
  if (status === 'in_progress') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export interface TodoCardProps {
  item: TodoItem;
  expanded: boolean;
  onToggle: (key: string) => void;
}

export default function TodoCard({ item, expanded, onToggle }: TodoCardProps) {
  const listId = useId();
  const title = item.latest ? 'Plan' : 'Updated the plan';
  const progress = `${item.done} of ${item.total} done`;
  const list = (
    <ul id={listId} className={styles.todoList}>
      {item.items.map((t, i) => {
        const state = STATE[t.status as keyof typeof STATE];
        return (
          <li key={i} className={`${styles.todoItem} ${state?.className ?? styles.todoPending}`}>
            <span className={styles.todoMark}><Mark status={t.status} /></span>
            <span>{t.text}</span>
            <span className={styles.todoState}>{state?.word ?? 'to do'}</span>
          </li>
        );
      })}
    </ul>
  );

  if (!item.latest) {
    return (
      <div>
        <button type="button" className={styles.row} aria-expanded={expanded} aria-controls={expanded ? listId : undefined} onClick={() => onToggle(item.key)}>
          <span className={styles.rowIcon}><ChecklistIcon size={18} /></span>
          <span className={styles.rowText}>
            <span className={styles.verb}>{title}</span>
          </span>
          <span className={styles.meta}>{progress}</span>
          <span className={`${styles.chev}${expanded ? ` ${styles.chevOpen}` : ''}`}><ChevronIcon size={16} /></span>
        </button>
        {expanded && <div className={styles.detail}>{list}</div>}
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <button type="button" className={styles.cardHead} aria-expanded={expanded} aria-controls={expanded ? listId : undefined} onClick={() => onToggle(item.key)}>
        <span className={styles.rowIcon}><ChecklistIcon size={20} /></span>
        <span className={styles.cardTitle}>
          <span className={styles.cardTitleMain}>{title}</span>
          <span className={styles.cardTitleSub}>{progress}</span>
        </span>
        <span className={`${styles.chev}${expanded ? ` ${styles.chevOpen}` : ''}`}><ChevronIcon size={16} /></span>
      </button>
      {expanded && <div className={styles.cardBody}>{list}</div>}
    </div>
  );
}
