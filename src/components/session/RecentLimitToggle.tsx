/**
 * RecentLimitToggle — the RECENT frame's 20 ↔ 10 header toggle (Nov 17 2026). RECENT lists the 20 sessions
 * with the newest work by default (Nov 18 2026); this folds it to 10 and back. Remembered in the ui store
 * (`recentRoomExpanded`). The caller shows it only when more than 10 sessions qualify.
 */
import { RECENT_EXPANDED_LIMIT, RECENT_LIMIT } from '@/lib/recentSessions';
import { useUiStore } from '@/stores/uiStore';
import { RecentLimitIcon } from './SessionFrameIcons';
import styles from '@/styles/modules/DetailPanel.module.css';

export default function RecentLimitToggle() {
  const expanded = useUiStore((s) => s.recentRoomExpanded);
  const toggle = useUiStore((s) => s.toggleRecentRoomExpanded);
  const name = expanded ? `Show only the ${RECENT_LIMIT} most recent` : `Show the ${RECENT_EXPANDED_LIMIT} most recent`;
  return (
    <button
      type="button"
      className={styles.roomCollapseToggle}
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
      title={name}
      aria-label={name}
      aria-pressed={expanded}
    >
      <RecentLimitIcon expanded={expanded} />
    </button>
  );
}
