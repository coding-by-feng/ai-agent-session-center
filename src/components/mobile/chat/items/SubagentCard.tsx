/**
 * SubagentCard — a subagent the agent started (AASC-41): "Agent · Explore", what
 * it was for, and whether it is running, done or failed. Opened inline (there is
 * no subagent screen on the phone yet): what it was asked, and its report once it
 * came back, formatted like any reply.
 */
import { lazy, Suspense, useId } from 'react';
import type { SubagentItem, SubagentStatus } from '@/lib/chat/buildChatItems';
import OutputBlock from './OutputBlock';
import { AgentIcon, ChevronIcon } from '../chatViewIcons';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

const ChatMarkdown = lazy(() => import('./ChatMarkdown'));

const STATUS: Record<SubagentStatus, { word: string; className: string }> = {
  running: { word: 'Running', className: styles.badgeWorking },
  done: { word: 'Done', className: styles.badgeDone },
  failed: { word: 'Failed', className: styles.badgeFailed },
  'no-report': { word: 'No report', className: '' },
};

export interface SubagentCardProps {
  item: SubagentItem;
  expanded: boolean;
  onToggle: (key: string) => void;
}

export default function SubagentCard({ item, expanded, onToggle }: SubagentCardProps) {
  const bodyId = useId();
  const status = STATUS[item.status];
  const kind = ['Agent', item.agentType, item.background ? 'background' : ''].filter(Boolean).join(' · ');
  return (
    <div className={styles.card}>
      <button type="button" className={styles.cardHead} aria-expanded={expanded} aria-controls={expanded ? bodyId : undefined} onClick={() => onToggle(item.key)}>
        <span className={styles.rowIcon}><AgentIcon size={20} /></span>
        <span className={styles.cardTitle}>
          <span className={styles.cardTitleSub}>{kind}</span>
          <span className={styles.cardTitleMain}>{item.description || 'Subagent'}</span>
        </span>
        <span className={`${styles.badge} ${status.className}`}>{status.word}</span>
        <span className={`${styles.chev}${expanded ? ` ${styles.chevOpen}` : ''}`}><ChevronIcon size={16} /></span>
      </button>
      {expanded && (
        <div id={bodyId} className={styles.cardBody}>
          <div className={styles.detailLabel}>Asked</div>
          <OutputBlock text={item.prompt || '(no prompt)'} prose label="What the subagent was asked" />
          {item.truncated && <p className={styles.note}>The phone received the first 16 KB of this prompt.</p>}
          <div className={styles.detailLabel}>Report</div>
          {item.report ? (
            <div data-ai-context="">
              <Suspense fallback={<p className={styles.plainText}>{item.report.output}</p>}>
                <ChatMarkdown text={item.report.output || '(empty report)'} />
              </Suspense>
              {item.report.truncated && <p className={styles.note}>The Mac sent the first 4 KB of this report.</p>}
            </div>
          ) : (
            <p className={styles.note}>{item.status === 'running' ? 'Still working.' : 'No report came back in this conversation.'}</p>
          )}
        </div>
      )}
    </div>
  );
}
