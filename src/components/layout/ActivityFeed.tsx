import { useState, useMemo } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import styles from '@/styles/modules/ActivityFeed.module.css';

interface FeedEntry {
  sessionId: string;
  projectName: string;
  type: string;
  detail: string;
  timestamp: number;
}

export default function ActivityFeed() {
  const sessions = useSessionStore((s) => s.sessions);
  const activityFeedOpen = useUiStore((s) => s.activityFeedOpen);
  const setActivityFeedOpen = useUiStore((s) => s.setActivityFeedOpen);
  const selectSession = useSessionStore((s) => s.selectSession);
  const [maxEntries] = useState(50);

  const entries = useMemo(() => {
    const all: FeedEntry[] = [];
    for (const session of sessions.values()) {
      for (const event of session.events) {
        all.push({
          sessionId: session.sessionId,
          projectName: session.projectName || 'Unknown',
          type: event.type,
          detail: event.detail,
          timestamp: event.timestamp,
        });
      }
    }
    all.sort((a, b) => b.timestamp - a.timestamp);
    return all.slice(0, maxEntries);
  }, [sessions, maxEntries]);

  return (
    <div className={`${styles.feed} ${!activityFeedOpen ? styles.collapsed : ''}`}>
      <div className={styles.feedHeader}>
        <span>ACTIVITY FEED ({entries.length})</span>
        <button
          className={styles.collapseBtn}
          onClick={() => setActivityFeedOpen(!activityFeedOpen)}
        >
          {activityFeedOpen ? '\u25BC' : '\u25B2'}
        </button>
      </div>

      {activityFeedOpen && (
        <div className={styles.feedEntries}>
          {entries.length === 0 && (
            <div className={styles.entry} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
              No activity yet
            </div>
          )}
          {entries.map((entry, idx) => (
            <div
              key={`${entry.sessionId}-${entry.timestamp}-${idx}`}
              onClick={() => selectSession(entry.sessionId)}
              className={styles.entry}
              style={{ cursor: 'pointer' }}
            >
              <span className={styles.feedTime}>
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
              <span className={styles.feedProject}>{entry.projectName}</span>
              <span className={styles.feedDetail}>
                [{entry.type}] {entry.detail}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
