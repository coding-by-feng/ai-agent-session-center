import styles from '@/styles/modules/SavingOverlay.module.css';

export default function SavingOverlay() {
  return (
    <div className={styles.overlay}>
      <div className={styles.content}>
        <div className={styles.spinner} />
        <div className={styles.text}>SAVING WORKSPACE</div>
        <div className={styles.subtext}>Preserving sessions, rooms, and project tabs...</div>
      </div>
    </div>
  );
}
