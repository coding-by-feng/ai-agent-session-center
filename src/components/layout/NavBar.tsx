import { NavLink } from 'react-router';
import { useUiStore } from '@/stores/uiStore';
import { useAgendaStore } from '@/stores/agendaStore';
import { useSessionStore } from '@/stores/sessionStore';
import WorkdirLauncher from './WorkdirLauncher';
import styles from '@/styles/modules/NavBar.module.css';

interface NavItem {
  to: string;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'LIVE' },
  { to: '/agenda', label: 'AGENDA' },
  { to: '/history', label: 'HISTORY' },
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

        {/* Shortcuts help button */}
        <button
          className={styles.shortcutsBtn}
          onClick={() => openModal('shortcuts')}
          title="Keyboard shortcuts (?)"
        >
          ?
        </button>
      </div>

      <div className={styles.spacer} />

      {NAV_ITEMS.map((item) => (
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
