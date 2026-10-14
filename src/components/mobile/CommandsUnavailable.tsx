/**
 * CommandsUnavailable — the COMMANDS tab in the phone app (AASC-18). That tab is
 * a plain shell on the Mac, and a paired phone is never given one (AASC-28: the
 * server refuses ops shells to it, and their reconnect route), so the tab says
 * so instead of showing a terminal that can never connect. A phone browser
 * signed in with the dashboard password keeps the real tab.
 */
import styles from '@/styles/modules/PhoneSession.module.css';

export default function CommandsUnavailable() {
  return (
    <div className={styles.unavailable}>
      <p className={styles.unavailableTitle}>Commands stay on the Mac</p>
      <p className={styles.unavailableText}>
        This tab is a plain shell on your Mac, which the phone app cannot open. Type to the agent in TERMINAL,
        or open this session on the Mac to run commands.
      </p>
    </div>
  );
}
