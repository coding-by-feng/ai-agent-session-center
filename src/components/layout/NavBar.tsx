import { NavLink } from 'react-router';
import { useUiStore } from '@/stores/uiStore';
import WorkdirLauncher from './WorkdirLauncher';
import styles from '@/styles/modules/NavBar.module.css';

interface NavItem {
  to: string;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'LIVE' },
  { to: '/history', label: 'HISTORY' },
  { to: '/timeline', label: 'TIMELINE' },
  { to: '/analytics', label: 'ANALYTICS' },
  { to: '/queue', label: 'QUEUE' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function NavBar() {
  const openModal = useUiStore((s) => s.openModal);

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

          {/* Quick launch (label picker) */}
          <button
            className={`${styles.qaBtn} ${styles.quick}`}
            onClick={() => openModal('quick-session')}
          >
            QUICK
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
          className={({ isActive }) =>
            `${styles.navBtn} ${isActive ? styles.active : ''}`
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
