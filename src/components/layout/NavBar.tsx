import { NavLink } from 'react-router';
import { useUiStore } from '@/stores/uiStore';
import { useAgendaStore } from '@/stores/agendaStore';
import { useSessionStore } from '@/stores/sessionStore';
import WorkdirLauncher from './WorkdirLauncher';
import { useIsMobile } from '@/lib/platform';
import styles from '@/styles/modules/NavBar.module.css';

interface NavItem {
  to: string;
  label: string;
  /**
   * Hidden on phone-sized viewports. A DATA flag rather than an inline
   * `{!isMobile && …}` around one link, so "what is desktop-only" is one
   * readable list instead of conditionals scattered through the JSX — and so
   * adding the next one is an edit to this table, not new branching.
   *
   * Note this hides the TAB, not the ROUTE: `/agenda` still resolves if it is
   * deep-linked or restored from a workspace snapshot. That is deliberate —
   * silently redirecting a URL the user typed is worse than rendering a page
   * that merely isn't optimised for the width.
   */
  desktopOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'LIVE' },
  // Agenda is a planning surface built around a wide multi-column task board;
  // it is not a phone workflow, and it is the first thing to crowd the nav row.
  { to: '/agenda', label: 'AGENDA', desktopOnly: true },
  { to: '/history', label: 'HISTORY' },
  { to: '/prompts', label: 'PROMPTS' },
  { to: '/queue', label: 'QUEUE' },
  { to: '/review', label: 'REVIEW' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function NavBar() {
  const openModal = useUiStore((s) => s.openModal);
  const tasks = useAgendaStore((s) => s.tasks);
  const deselectSession = useSessionStore((s) => s.deselectSession);

  const incompleteCount = Array.from(tasks.values()).filter((t) => !t.completed).length;

  // Drop desktop-only tabs on a phone. `useIsMobile` (not an electronAPI
  // check) because this is a SIZE decision — a desktop browser must keep the
  // full nav. See src/lib/platform.ts for the rule.
  const isMobile = useIsMobile();
  const navItems = isMobile ? NAV_ITEMS.filter((i) => !i.desktopOnly) : NAV_ITEMS;

  return (
    <nav className={styles.nav}>
      <div className={styles.actions}>
        <div className={styles.actionsItems}>
          {/* New session (full form) */}
          <button
            className={`${styles.qaBtn} ${styles.terminal}`}
            onClick={() => openModal('new-session')}
          >
            + NEW
          </button>

          {/* Recent directories one-click launcher */}
          <WorkdirLauncher />
        </div>

      </div>

      {/* The `?` shortcuts button and <DevicePresenceChip /> used to sit here,
          with a flex `.spacer` shoving the chip to the far right. Both are
          icon-only controls, and at narrow widths that left a wide dead band
          between them while pushing the route tabs off-screen entirely. They
          now live in Header's `.stats` cluster alongside the other icon-only
          controls (export/import/settings/quit). The spacer went with them —
          without the chip there is nothing left to push right, and removing it
          is what lets the tabs start immediately after DIRS. */}

      {navItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          // Switching top-level tabs closes any open session detail panel so the
          // target view is actually visible (the panel overlays every route) and
          // the dashboard Header (hidden while a detail is open) returns.
          onClick={() => deselectSession()}
          className={({ isActive }) =>
            `${styles.navBtn} ${isActive ? styles.active : ''}`
          }
        >
          {item.label}
          {item.to === '/agenda' && incompleteCount > 0 && (
            <span className={styles.badge}>{incompleteCount}</span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
