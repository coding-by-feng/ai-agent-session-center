/**
 * BuiltinFrame — the session strip's built-in frames, CENTRAL, PINNED and RECENT. None
 * is a Room: each is worked out from the sessions (the central marker, the pin flag, recent work),
 * nothing stores it, and it takes no part in room reordering. So the header's
 * one control is the fold toggle: no grip, no ▲▼, no rename, no kill-all.
 *
 * The caller draws the cards, which are second listings: each session is also
 * in its own room, under the same number.
 */
import type { ReactNode } from 'react';
import { FrameCollapseIcon } from './SessionFrameIcons';
import styles from '@/styles/modules/DetailPanel.module.css';

interface Props {
  /** The name set into the frame's top edge ("Pinned", "Recent"). */
  label: string;
  /** Hover text: what the frame lists. */
  title: string;
  /** The frame's own class, which gives it its colour. */
  className: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** How many sessions it holds: the folded frame's count. */
  count: number;
  children: ReactNode;
}

export default function BuiltinFrame({ label, title, className, collapsed, onToggleCollapse, count, children }: Props) {
  const toggleName = collapsed ? `Expand ${label}` : `Collapse ${label}`;
  return (
    <div
      className={`${styles.sessionTabRoomGroup} ${className}${collapsed ? ` ${styles.sessionTabRoomGroupCollapsed}` : ''}`}
      title={title}
    >
      <span className={styles.sessionTabRoomGroupLabel}>{label}</span>
      <div className={styles.roomHeaderRow}>
        <button
          type="button"
          className={styles.roomCollapseToggle}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse();
          }}
          title={toggleName}
          aria-label={toggleName}
          aria-expanded={!collapsed}
        >
          <FrameCollapseIcon collapsed={collapsed} />
        </button>
        {collapsed && <span className={styles.roomCollapsedCount}>{count}</span>}
      </div>
      {!collapsed && children}
    </div>
  );
}
