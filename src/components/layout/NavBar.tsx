import { NavLink, useLocation } from 'react-router';
import { useAgendaStore } from '@/stores/agendaStore';
import { useSessionStore } from '@/stores/sessionStore';
import { usePresenceStore, isLocalDevice } from '@/stores/presenceStore';
import { getClientId } from '@/lib/deviceIdentity';
import { useIsMobile } from '@/lib/platform';
import { openLiveSession } from '@/lib/liveSession';
import { useLiveHint } from '@/hooks/useLiveBoard';
import CountBadge from '@/components/ui/CountBadge';
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
  /**
   * Shown only on a device the SERVER has confirmed is on this machine
   * (presence `isLocal`). For tabs whose routes answer loopback only — a phone
   * or a LAN browser would open a tab that can only 404. Deliberately not a
   * size or `electronAPI` check: a desktop browser on the LAN is remote too.
   */
  localOnly?: boolean;
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
  // Every Claude Code / Codex resource on this machine — reads ~/.claude and
  // ~/.codex, so /api/resources answers loopback only.
  { to: '/resources', label: 'RESOURCES', localOnly: true },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function NavBar() {
  const tasks = useAgendaStore((s) => s.tasks);
  const deselectSession = useSessionStore((s) => s.deselectSession);

  const incompleteCount = Array.from(tasks.values()).filter((t) => !t.completed).length;

  // Drop desktop-only tabs on a phone. `useIsMobile` (not an electronAPI
  // check) because this is a SIZE decision — a desktop browser must keep the
  // full nav. See src/lib/platform.ts for the rule.
  const isMobile = useIsMobile();
  // Unknown (presence not loaded yet) reads as not-local: the absent state is
  // the safe state, so a local-only tab appears once the server confirms it.
  const isLocal = usePresenceStore((s) => isLocalDevice(s.devices, getClientId()));
  const navItems = NAV_ITEMS.filter(
    (i) => !(isMobile && i.desktopOnly) && !(i.localOnly && !isLocal),
  );
  // The LIVE board's one-time tip ("…or press LIVE") marks this tab with a dot
  // while it is up. A LIVE click that opens a session is one of the things it
  // teaches, so it retires the tip; one that opens nothing (no sessions yet)
  // has taught nothing and leaves it for later. See lib/liveHint.ts.
  const liveHint = useLiveHint(useLocation().pathname === '/');

  const onTabClick = (to: string) => {
    if (to !== '/') {
      deselectSession();
      return;
    }
    if (openLiveSession()) liveHint.dismiss();
  };

  return (
    <nav className={styles.nav}>
      {/* The route tabs only. + NEW and DIRS used to lead the bar; starting a
          session now lives in the session panel's strip (+ and the recent-
          directories icon) and, with no session yet, on the LIVE page's card
          (Oct 2026). The `?` shortcuts button and <DevicePresenceChip /> live
          in Header's `.stats` cluster with the other icon-only controls. */}
      {navItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          // Switching to another tab closes the session panel so the target
          // view is visible (the panel overlays every route) and the dashboard
          // Header (hidden while a panel is open) returns. LIVE does the
          // opposite: it opens the panel on the session you had open — only
          // the panel's minimize (‒) hides it on LIVE. See lib/liveSession.ts.
          onClick={() => onTabClick(item.to)}
          className={({ isActive }) =>
            `${styles.navBtn} ${isActive ? styles.active : ''}`
          }
          // LiveHintCallout measures this tab to point its caret at it.
          data-live-tab={item.to === '/' ? '' : undefined}
        >
          {item.label}
          {item.to === '/' && liveHint.visible && (
            <span className={styles.liveCueDot} data-live-cue="" aria-hidden="true" />
          )}
          {item.to === '/agenda' && incompleteCount > 0 && (
            <CountBadge
              count={incompleteCount}
              tone="accent"
              max={999}
              label={`${incompleteCount} open task${incompleteCount === 1 ? '' : 's'}`}
            />
          )}
        </NavLink>
      ))}
    </nav>
  );
}
