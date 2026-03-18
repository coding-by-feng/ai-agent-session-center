/**
 * TitleBar — a fixed 28px draggable bar that sits at the very top of the window
 * on macOS Electron, covering the traffic-light zone with the app name.
 * z-index: 99999 ensures it sits above all overlays (DetailPanel, SetupWizard, etc.)
 * The native traffic-light buttons (OS-level) render above even this overlay.
 */
import styles from '@/styles/modules/TitleBar.module.css';

export default function TitleBar() {
  const isElectron = !!window.electronAPI;

  function handleExit() {
    window.electronAPI?.quitApp();
  }

  return (
    <div className={styles.titleBar}>
      <span className={styles.appName}>AI AGENT SESSION CENTER</span>
      {isElectron && (
        <button
          className={styles.exitBtn}
          onClick={handleExit}
          title="Save &amp; Quit"
          aria-label="Save and quit"
        >
          {/* Power / exit icon */}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M6 1v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M3.5 2.8A4.5 4.5 0 1 0 8.5 2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
          </svg>
        </button>
      )}
    </div>
  );
}
