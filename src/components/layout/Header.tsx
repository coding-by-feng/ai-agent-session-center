import { useWsStore } from '@/stores/wsStore';
import { SettingsButton } from '@/components/settings/SettingsPanel';
import styles from '@/styles/modules/Header.module.css';

export default function Header() {
  const connected = useWsStore((s) => s.connected);

  return (
    <header className={styles.header}>
      <div className={styles.title}>AI AGENT SESSION CENTER</div>

      <div className={styles.stats}>
        <span
          className={`${styles.statDot} ${connected ? styles.connected : styles.disconnected}`}
          title={connected ? 'WebSocket connected' : 'WebSocket disconnected'}
        />
        <SettingsButton />
      </div>
    </header>
  );
}
