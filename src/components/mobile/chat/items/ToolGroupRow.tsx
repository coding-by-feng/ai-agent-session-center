/**
 * ToolGroupRow — consecutive finished calls folded into one row (AASC-41): "Read 3
 * files, ran 2 commands ✓". Opened, it lists each call (each opens on its own) and
 * any thinking between them. Failed, open and edit calls never fold
 * (buildChatItems), so this row only ever holds calls that went through.
 */
import { memo, useId } from 'react';
import type { ToolGroupItem } from '@/lib/chat/buildChatItems';
import { formatDuration } from '@/lib/chat/chatFormat';
import ToolRow from './ToolRow';
import ThinkingRow from './ThinkingRow';
import { CheckIcon, ChevronIcon, StackIcon } from '../chatIcons';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

export interface ToolGroupRowProps {
  item: ToolGroupItem;
  expanded: boolean;
  onToggle: (key: string) => void;
  /** The calls opened inside it, comma-joined (held by the chat, so search can open one). */
  openMembers: string;
  onToggleMember: (key: string, open: boolean) => void;
}

function ToolGroupRow({ item, expanded, onToggle, openMembers, onToggleMember }: ToolGroupRowProps) {
  const listId = useId();
  const total = item.calls.reduce((ms, c) => ms + (c.call.durationMs ?? 0), 0);
  const time = formatDuration(total);
  const open = new Set(openMembers ? openMembers.split(',') : []);
  return (
    <div>
      <button
        type="button"
        className={styles.row}
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={() => onToggle(item.key)}
      >
        <span className={styles.rowIcon}><StackIcon size={18} /></span>
        <span className={`${styles.rowText} ${styles.target}`}>{item.summary}</span>
        <span className={styles.statusOk}>
          <CheckIcon size={14} />
          <span className={styles.srOnly}>all done</span>
          {time && <span className={styles.duration}>{time}</span>}
        </span>
        <span className={`${styles.chev}${expanded ? ` ${styles.chevOpen}` : ''}`}><ChevronIcon size={16} /></span>
      </button>
      {expanded && (
        <div id={listId} className={styles.members}>
          {item.members.map((m) => (m.kind === 'tool'
            ? <ToolRow key={m.key} item={m} expanded={open.has(m.key)} onToggle={(key) => onToggleMember(key, !open.has(key))} />
            : <ThinkingRow key={m.key} item={m} />))}
        </div>
      )}
    </div>
  );
}

export default memo(ToolGroupRow);
