import { NavLink } from 'react-router';
import { useUiStore } from '@/stores/uiStore';
import { showToast } from '@/components/ui/ToastContainer';
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
// Quick launch helper: fires a labeled session directly
// ---------------------------------------------------------------------------

async function quickLaunchLabeled(label: string) {
  try {
    const res = await fetch('/api/terminals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'localhost',
        workingDir: '~',
        command: 'claude',
        label,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`${label} session launched`, 'success');
    } else {
      showToast(data.error || `Failed to launch ${label} session`, 'error');
    }
  } catch {
    showToast('Network error', 'error');
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function NavBar() {
  const openModal = useUiStore((s) => s.openModal);

  return (
    <nav className={styles.nav}>
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

      <div className={styles.spacer} />

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

          <div className={styles.separator} />

          {/* Label-based one-click launchers */}
          <button
            className={`${styles.qaBtn} ${styles.oneoff}`}
            onClick={() => quickLaunchLabeled('ONEOFF')}
          >
            ONEOFF
          </button>
          <button
            className={`${styles.qaBtn} ${styles.heavy}`}
            onClick={() => quickLaunchLabeled('HEAVY')}
          >
            HEAVY
          </button>
          <button
            className={`${styles.qaBtn} ${styles.important}`}
            onClick={() => quickLaunchLabeled('IMPORTANT')}
          >
            IMPORTANT
          </button>
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
    </nav>
  );
}
