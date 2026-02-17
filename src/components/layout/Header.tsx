import { useMemo } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { SettingsButton } from '@/components/settings/SettingsPanel';
import styles from '@/styles/modules/Header.module.css';

export default function Header() {
  const sessions = useSessionStore((s) => s.sessions);
  const connected = useWsStore((s) => s.connected);

  const stats = useMemo(() => {
    let active = 0;
    let totalToolCalls = 0;

    for (const session of sessions.values()) {
      if (session.status !== 'ended') active++;
      totalToolCalls += session.totalToolCalls || 0;
    }

    return { active, total: sessions.size, totalToolCalls };
  }, [sessions]);

  return (
    <header className={styles.header}>
      <div className={styles.title}>AI AGENT SESSION CENTER</div>

      <div className={styles.stats}>
        <span className={styles.stat}>
          Active: <strong className={styles.statValue}>{stats.active}</strong>
        </span>
        <span className={styles.stat}>
          Total: <strong className={styles.statValue}>{stats.total}</strong>
        </span>
        <span className={styles.stat}>
          Tools: <strong className={styles.statValue}>{stats.totalToolCalls}</strong>
        </span>
        <span
          className={`${styles.statDot} ${connected ? styles.connected : styles.disconnected}`}
          title={connected ? 'WebSocket connected' : 'WebSocket disconnected'}
        />
        <SettingsButton />
      </div>
    </header>
  );
}
