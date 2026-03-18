import { useUiStore } from '@/stores/uiStore';
import styles from '@/styles/modules/WorkspaceLoadingOverlay.module.css';

export default function WorkspaceLoadingOverlay() {
  const { active, total, done, currentTitle } = useUiStore((s) => s.workspaceLoad);
  if (!active) return null;

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className={styles.overlay}>
      <div className={styles.content}>
        <div className={styles.title}>LOADING WORKSPACE</div>
        <div className={styles.subtitle}>
          {currentTitle ? `Starting: ${currentTitle}` : 'Preparing sessions…'}
        </div>
        <div className={styles.barWrap}>
          <div className={styles.bar} style={{ width: `${pct}%` }} />
        </div>
        <div className={styles.counter}>{done} / {total} sessions</div>
      </div>
    </div>
  );
}
