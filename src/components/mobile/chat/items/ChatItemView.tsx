/**
 * ChatItemView — one row of the phone chat (AASC-41), by kind. Memoised on the
 * item's `sig` (buildChatItems: it changes only when the row would draw
 * differently), so a refresh that appends a page redraws only the new rows and the
 * one whose result arrived.
 */
import { memo } from 'react';
import type { ChatItem, QueuedItem } from '@/lib/chat/buildChatItems';
import UserBubble from './UserBubble';
import AssistantText from './AssistantText';
import ThinkingRow from './ThinkingRow';
import ToolRow from './ToolRow';
import ToolGroupRow from './ToolGroupRow';
import TodoCard from './TodoCard';
import SubagentCard from './SubagentCard';
import QueuedBubble from './QueuedBubble';
import { CommandRow, DividerRow, NoticeRow } from './EventRows';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

export interface ChatItemViewProps {
  item: ChatItem;
  sessionId: string;
  expanded: boolean;
  /** A folded group's open calls, comma-joined (the chat holds them, so search can open one). */
  openMembers?: string;
  /** The search's current match. */
  current: boolean;
  /** `open`: what the row asks to become (a stable callback serves every row). */
  onToggle: (key: string, open: boolean) => void;
  onPullBack: (item: QueuedItem) => void;
}

interface BodyProps extends Omit<ChatItemViewProps, 'current' | 'onToggle'> {
  onToggle: (key: string) => void;
  onToggleMember: (key: string, open: boolean) => void;
}

function Body({ item, sessionId, expanded, openMembers, onToggle, onToggleMember, onPullBack }: BodyProps) {
  switch (item.kind) {
    case 'user': return <UserBubble item={item} expanded={expanded} onToggle={onToggle} />;
    case 'assistant': return <AssistantText item={item} sessionId={sessionId} />;
    case 'thinking': return <ThinkingRow item={item} />;
    case 'tool': return <ToolRow item={item} expanded={expanded} onToggle={onToggle} />;
    case 'tool-group': return <ToolGroupRow item={item} expanded={expanded} onToggle={onToggle} openMembers={openMembers ?? ''} onToggleMember={onToggleMember} />;
    case 'todo': return <TodoCard item={item} expanded={expanded} onToggle={onToggle} />;
    case 'subagent': return <SubagentCard item={item} expanded={expanded} onToggle={onToggle} />;
    case 'command': return <CommandRow item={item} />;
    case 'divider': return <DividerRow item={item} expanded={expanded} onToggle={onToggle} />;
    case 'notice': return <NoticeRow item={item} />;
    case 'queued': return <QueuedBubble item={item} onPullBack={onPullBack} />;
    default: return null;
  }
}

function ChatItemView({ item, sessionId, expanded, openMembers, current, onToggle, onPullBack }: ChatItemViewProps) {
  return (
    <div className={styles.item} data-chat-key={item.key} data-kind={item.kind} data-current={current ? '' : undefined}>
      <Body
        item={item}
        sessionId={sessionId}
        expanded={expanded}
        openMembers={openMembers}
        onToggle={(key) => onToggle(key, !expanded)}
        onToggleMember={onToggle}
        onPullBack={onPullBack}
      />
    </div>
  );
}

export default memo(ChatItemView, (a, b) =>
  a.item.key === b.item.key
  && a.item.kind === b.item.kind
  && a.item.sig === b.item.sig
  && a.expanded === b.expanded
  && a.openMembers === b.openMembers
  && a.current === b.current
  && a.sessionId === b.sessionId
  && a.onToggle === b.onToggle
  && a.onPullBack === b.onPullBack);
