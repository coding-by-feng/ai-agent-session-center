/**
 * Glyphs shared by the session strip's frame headers (room, RECENT and project
 * frames). They live apart from SessionSwitcher so a frame header that is its
 * own component, like ProjectFrameHeader, can use them without importing the
 * switcher that renders it.
 */
import styles from '@/styles/modules/DetailPanel.module.css';

/** Filled disclosure triangle — folds/unfolds a frame. Turns -90deg when
 *  collapsed (`.frameCollapseIconFolded`), same as the chevron it replaced.
 *  Solid, not stroked: in a room header it has to read as a different KIND of
 *  control from the stroked reorder arrows beside it, and a filled mass does
 *  that at 10px where a thinner or wider chevron would not. */
export function FrameCollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className={`${styles.frameCollapseIcon}${collapsed ? ` ${styles.frameCollapseIconFolded}` : ''}`}
      width="9"
      height="9"
      viewBox="0 0 12 12"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M1.9 3.9h8.2a.55.55 0 0 1 .43.89l-4.1 4.6a.55.55 0 0 1-.86 0l-4.1-4.6a.55.55 0 0 1 .43-.89Z" />
    </svg>
  );
}
