/**
 * TitleBar — a fixed 28px draggable bar that sits at the very top of the window
 * on macOS Electron, covering the traffic-light zone with the app name.
 * z-index: 99999 ensures it sits above all overlays (DetailPanel, SetupWizard, etc.)
 * The native traffic-light buttons (OS-level) render above even this overlay.
 */
import styles from '@/styles/modules/TitleBar.module.css';

export default function TitleBar() {
  return (
    <div className={styles.titleBar}>
      <span className={styles.appName}>AI AGENT SESSION CENTER</span>
    </div>
  );
}
