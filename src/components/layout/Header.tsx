import { SettingsButton } from '@/components/settings/SettingsPanel';
import styles from '@/styles/modules/Header.module.css';

export default function Header() {

  return (
    <header className={styles.header}>
      <div className={styles.title}>AI AGENT SESSION CENTER</div>

      <div className={styles.stats}>
        <SettingsButton />
      </div>
    </header>
  );
}
