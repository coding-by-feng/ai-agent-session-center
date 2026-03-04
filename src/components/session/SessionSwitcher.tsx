/**
 * SessionSwitcher — Dropdown bar at the top of the DetailPanel that lets users
 * quickly switch between sessions without closing the panel first.
 * When headerCollapsed=true, also displays status badge, duration, and close/collapse buttons
 * so that the compact header and switcher are merged into one line.
 */
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Session } from '@/types';
import styles from '@/styles/modules/DetailPanel.module.css';

const STATUS_COLORS: Record<string, string> = {
  idle: 'var(--accent-green)',
  prompting: 'var(--accent-cyan)',
  working: 'var(--accent-orange)',
  waiting: 'var(--accent-cyan)',
  approval: 'var(--accent-orange)',
  input: 'var(--accent-purple)',
  ended: 'var(--accent-red)',
  connecting: 'var(--text-dim)',
};

const STATUS_ORDER: Record<string, number> = {
  working: 0, prompting: 1, approval: 2, input: 2,
  waiting: 3, idle: 4, connecting: 5, ended: 6,
};

interface Props {
  currentSession: Session;
  sessions: Map<string, Session>;
  onSwitch: (sessionId: string) => void;
  statusLabel?: string;
  duration?: string;
  isDisconnected?: boolean;
  onClose?: () => void;
  headerCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function SessionSwitcher({
  currentSession, sessions, onSwitch,
  statusLabel, duration, isDisconnected,
  onClose, headerCollapsed, onToggleCollapse,
}: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Read sidebar filter mode from localStorage to stay aligned with the agent list
  const getFilterMode = useCallback((): 'all' | 'ssh' | 'others' => {
    try {
      const val = localStorage.getItem('sidebar-filter-mode');
      if (val === 'ssh' || val === 'others') return val;
    } catch { /* ignore */ }
    return 'all';
  }, []);

  // Re-filter when dropdown opens so it always matches the sidebar's current filter
  const sortedSessions = useMemo(() => {
    const filterMode = getFilterMode();
    return [...sessions.values()]
      .filter((s) => {
        if (s.sessionId === currentSession.sessionId) return false;
        if (s.status === 'ended') return false;
        if (filterMode === 'ssh' && s.source !== 'ssh') return false;
        if (filterMode === 'others' && s.source === 'ssh') return false;
        return true;
      })
      .sort((a, b) => {
        const oa = STATUS_ORDER[a.status] ?? 5;
        const ob = STATUS_ORDER[b.status] ?? 5;
        if (oa !== ob) return oa - ob;
        return (a.title || a.projectName || '').localeCompare(b.title || b.projectName || '');
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, currentSession.sessionId, open]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open]);

  const handleSwitch = useCallback((sessionId: string) => {
    setOpen(false);
    onSwitch(sessionId);
  }, [onSwitch]);

  const displayName = currentSession.title || currentSession.projectName || '(untitled)';
  const currentColor = STATUS_COLORS[currentSession.status] ?? 'var(--text-dim)';

  return (
    <div className={styles.switcherBar} ref={containerRef}>
      <div className={styles.switcherToggle}>
        {/* Clickable session name area — opens dropdown */}
        <button
          className={styles.switcherNameBtn}
          onClick={() => setOpen((prev) => !prev)}
          type="button"
        >
          {/* Status dot */}
          <span
            className={styles.switcherDot}
            style={{ background: currentColor, boxShadow: `0 0 6px ${currentColor}` }}
          />
          {/* Display name */}
          <span className={styles.switcherName}>{displayName}</span>
          {/* Label badge */}
          {currentSession.label && (
            <span className={styles.switcherLabel}>{currentSession.label}</span>
          )}
          {/* Chevron */}
          <svg
            className={styles.switcherChevron}
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ transform: open ? 'rotate(180deg)' : undefined }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {/* Right side: status + duration + collapse + close (always shown) */}
        <div className={styles.switcherMeta}>
          {statusLabel && (
            <span
              className={`${styles.detailStatusBadge} ${isDisconnected ? 'disconnected' : currentSession.status}`}
            >
              {statusLabel}
            </span>
          )}
          {duration && (
            <span className={styles.detailDuration}>{duration}</span>
          )}
          {onToggleCollapse && (
            <button
              className={styles.switcherIconBtn}
              onClick={onToggleCollapse}
              title={headerCollapsed ? 'Expand header' : 'Collapse header'}
              type="button"
            >
              {headerCollapsed ? '\u25BC' : '\u25B2'}
            </button>
          )}
          {onClose && (
            <button
              className={styles.switcherIconBtn}
              onClick={onClose}
              title="Close"
              type="button"
            >
              &times;
            </button>
          )}
        </div>
      </div>

      {/* Dropdown */}
      {open && sortedSessions.length > 0 && (
        <div className={styles.switcherDropdown}>
          {sortedSessions.map((s) => {
            const color = STATUS_COLORS[s.status] ?? 'var(--text-dim)';
            const name = s.title || '(untitled)';
            return (
              <button
                key={s.sessionId}
                className={styles.switcherItem}
                onClick={() => handleSwitch(s.sessionId)}
                type="button"
              >
                <span
                  className={styles.switcherDot}
                  style={{ background: color, boxShadow: `0 0 6px ${color}` }}
                />
                <span className={styles.switcherItemText}>
                  <span className={styles.switcherItemName}>{name}</span>
                  {s.projectName && s.projectName !== name && (
                    <span className={styles.switcherItemProject}> — {s.projectName}</span>
                  )}
                </span>
                {s.label && (
                  <span className={styles.switcherLabel}>{s.label}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {open && sortedSessions.length === 0 && (
        <div className={styles.switcherDropdown}>
          <div className={styles.switcherEmpty}>No other sessions</div>
        </div>
      )}
    </div>
  );
}
