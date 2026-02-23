/**
 * ActivityLog shows tool calls, events, and responses in reverse chronological order.
 * Supports search highlighting.
 * Ported from the activity tab in public/js/detailPanel.js.
 */
import type { ToolLogEntry, ResponseEntry, SessionEvent } from '@/types';
import styles from '@/styles/modules/DetailPanel.module.css';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

interface ActivityItem {
  kind: 'tool' | 'response' | 'event';
  timestamp: number;
  tool?: string;
  input?: string;
  text?: string;
  type?: string;
  detail?: string;
}

interface ActivityLogProps {
  events: SessionEvent[];
  toolLog: ToolLogEntry[];
  responseLog: ResponseEntry[];
  searchQuery?: string;
}

export default function ActivityLog({
  events,
  toolLog,
  responseLog,
  searchQuery,
}: ActivityLogProps) {
  const items: ActivityItem[] = [];

  for (const e of events) {
    items.push({ kind: 'event', type: e.type, detail: e.detail, timestamp: e.timestamp });
  }
  for (const t of toolLog) {
    items.push({ kind: 'tool', tool: t.tool, input: t.input, timestamp: t.timestamp });
  }
  for (const r of responseLog) {
    items.push({ kind: 'response', text: r.text, timestamp: r.timestamp });
  }

  items.sort((a, b) => b.timestamp - a.timestamp);

  const query = searchQuery?.toLowerCase() || '';

  if (items.length === 0) {
    return <div className={styles.tabEmpty}>No activity yet</div>;
  }

  return (
    <div>
      {items.map((item, i) => {
        // #9: Composite key to avoid collisions between items with same timestamp
        const itemKey = `${item.kind}-${item.timestamp}-${i}`;
        const content =
          item.kind === 'tool'
            ? `${item.tool} ${item.input}`
            : item.kind === 'response'
              ? item.text
              : `${item.type} ${item.detail}`;
        const highlighted = query && (content || '').toLowerCase().includes(query);

        if (item.kind === 'tool') {
          return (
            <div
              key={itemKey}
              className={`${styles.activityEntry} ${styles.activityTool}${highlighted ? ' search-highlight' : ''}`}
            >
              <span className={styles.activityTime}>{formatTime(item.timestamp)}</span>
              <span className={`${styles.activityBadge} ${styles.activityBadgeTool}`}>
                {item.tool}
              </span>
              <span className={styles.activityDetail}>{item.input}</span>
            </div>
          );
        }

        if (item.kind === 'response') {
          return (
            <div
              key={itemKey}
              className={`${styles.activityEntry} ${styles.activityResponse}${highlighted ? ' search-highlight' : ''}`}
            >
              <span className={styles.activityTime}>{formatTime(item.timestamp)}</span>
              <span className={`${styles.activityBadge} ${styles.activityBadgeResponse}`}>
                RESPONSE
              </span>
              <span className={styles.activityDetail}>{item.text}</span>
            </div>
          );
        }

        return (
          <div
            key={itemKey}
            className={`${styles.activityEntry} ${styles.activityEvent}${highlighted ? ' search-highlight' : ''}`}
          >
            <span className={styles.activityTime}>{formatTime(item.timestamp)}</span>
            <span className={`${styles.activityBadge} ${styles.activityBadgeEvent}`}>
              {item.type}
            </span>
            <span className={styles.activityDetail}>{item.detail}</span>
          </div>
        );
      })}
    </div>
  );
}
