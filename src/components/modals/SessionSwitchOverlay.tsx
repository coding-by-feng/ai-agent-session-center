/**
 * SessionSwitchOverlay — Cmd+Tab-style session switcher popup.
 * Hold Cmd (macOS) / Ctrl (other), tap E to cycle, release to switch.
 * Escape or a row click cancels/commits without waiting for release.
 *
 * Mounted unconditionally in App.tsx, same pattern as GlobalSearchModal /
 * RestorePickerModal — visibility is entirely owned by useSessionSwitchHold,
 * this component just renders whatever it reports.
 */
import { useEffect, useRef } from 'react';
import { useSessionSwitchHold } from '@/hooks/useSessionSwitchHold';
import { isMac } from '@/lib/shortcutKeys';
import type { Session } from '@/types';
import styles from '@/styles/modules/SessionSwitchOverlay.module.css';

const STATUS_COLORS: Record<string, string> = {
  idle: 'var(--accent-green)',
  prompting: 'var(--accent-cyan)',
  working: 'var(--accent-orange)',
  waiting: 'var(--accent-cyan)',
  approval: 'var(--accent-yellow)',
  input: 'var(--accent-purple)',
  ended: 'var(--accent-red)',
  connecting: 'var(--text-dim)',
};

const STATUS_LABELS: Record<string, string> = {
  idle: 'Idle',
  prompting: 'Prompting',
  working: 'Working',
  waiting: 'Waiting',
  approval: 'Approval',
  input: 'Input',
  ended: 'Disconnected',
  connecting: 'Connecting',
};

function sessionName(s: Session): string {
  return s.title || s.projectName || s.sessionId.slice(0, 8);
}

export default function SessionSwitchOverlay() {
  const { open, items, highlightedIndex, commit, cancel } = useSessionSwitchHold();
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Keep the highlighted row visible: the list is viewport-capped and
  // scrollable (see .module.css), so cycling past the visible edge must
  // scroll it back into view rather than highlighting an off-screen row.
  useEffect(() => {
    if (!open) return;
    rowRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [open, highlightedIndex]);

  if (!open) return null;

  return (
    <div className={styles.overlay} onMouseDown={cancel}>
      <div className={styles.panel} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span>SWITCH SESSION</span>
          <span className={styles.hint}>hold {isMac ? '⌘' : 'Ctrl'} &middot; tap E</span>
        </div>
        <div className={styles.list}>
          {items.map((session, index) => {
            const highlighted = index === highlightedIndex;
            const color = STATUS_COLORS[session.status] ?? 'var(--text-dim)';
            const name = sessionName(session);
            return (
              <button
                key={session.sessionId}
                ref={(el) => { rowRefs.current[index] = el; }}
                type="button"
                className={`${styles.row}${highlighted ? ` ${styles.rowHighlighted}` : ''}`}
                onClick={() => commit(index)}
                // Stop the overlay's own onMouseDown (cancel) from also
                // firing on the way up — otherwise a plain click would close
                // the popup before its own commit ran.
                onMouseDown={(e) => e.stopPropagation()}
                aria-label={`Switch to ${name}`}
                aria-current={highlighted}
              >
                <span
                  className={styles.dot}
                  style={{ background: color, boxShadow: `0 0 5px ${color}` }}
                  aria-hidden="true"
                />
                <span className={styles.title}>{name}</span>
                {session.projectName && session.projectName !== session.title && (
                  <span className={styles.project}>{session.projectName}</span>
                )}
                <span className={styles.status}>
                  {STATUS_LABELS[session.status] ?? session.status}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
