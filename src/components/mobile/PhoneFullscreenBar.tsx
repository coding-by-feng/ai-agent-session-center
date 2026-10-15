/**
 * PhoneFullscreenBar — the top bar of a phone's full-screen terminal (AASC-18):
 * its title and the way back. TerminalContainer draws the desktop toolbar there
 * instead, and loads this on a phone only (AASC-31).
 */
import { ExitFullscreenIcon } from './phoneIcons';
import styles from '@/styles/modules/PhoneSession.module.css';

export interface PhoneFullscreenBarProps {
  /** Leave full screen. */
  onExit: () => void;
}

export default function PhoneFullscreenBar({ onExit }: PhoneFullscreenBarProps) {
  return (
    <div className={styles.fsBar}>
      <span className={styles.fsTitle}>Terminal</span>
      <button
        type="button"
        className={styles.iconBtn}
        onClick={onExit}
        aria-label="Leave full screen"
      >
        <ExitFullscreenIcon />
      </button>
    </div>
  );
}
