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
  // Use source-array index (e/t/r + position in original array) as the stable key.
  // This must NOT include the sorted position: when a new item is prepended (newest-first
  // sort), all sorted indices shift, causing every key to change and React to unmount+remount
  // all DOM nodes — destroying the CSS scroll-anchor element and making the viewport jump.
  type KeyedItem = ActivityItem & { _key: string };
  const items: KeyedItem[] = [];

  events.forEach((e, i) => {
    items.push({ kind: 'event', type: e.type, detail: e.detail, timestamp: e.timestamp, _key: `e${i}` });
  });
  toolLog.forEach((t, i) => {
    items.push({ kind: 'tool', tool: t.tool, input: t.input, timestamp: t.timestamp, _key: `t${i}` });
  });
  responseLog.forEach((r, i) => {
    items.push({ kind: 'response', text: r.text, timestamp: r.timestamp, _key: `r${i}` });
  });

  items.sort((a, b) => b.timestamp - a.timestamp);

  const query = searchQuery?.toLowerCase() || '';

  if (items.length === 0) {
    return <div className={styles.tabEmpty}>No activity yet</div>;
  }

  return (
    <div>
      {items.map((item) => {
        const itemKey = item._key;
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
