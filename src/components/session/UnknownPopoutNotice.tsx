/**
 * UnknownPopoutNotice — the whole renderer when a window asks for a pop-out kind this
 * build has no view for (`?popout=<something else>`): a window opened by a newer or
 * older version of the app than the one serving it.
 *
 * It exists so that case does NOT fall through to the dashboard. A dashboard in a second
 * window ticks its own queue scheduler, and two schedulers send every queued prompt twice.
 */
import styles from '@/styles/modules/UnknownPopoutNotice.module.css';

/** Long enough to read a real kind name, short enough that a hostile URL cannot fill the window. */
const MAX_KIND_LENGTH = 40;

export default function UnknownPopoutNotice({ kind }: { kind: string }) {
  const shown = kind.length > MAX_KIND_LENGTH ? `${kind.slice(0, MAX_KIND_LENGTH)}…` : kind;
  return (
    <div className={styles.root}>
      <p role="status" className={styles.notice}>
        This window asked for a “{shown}” view, which this version of the app does not have.
        Close it and open it again from the main window.
      </p>
    </div>
  );
}
