/**
 * SessionSwitcher — bar at the top of the DetailPanel.
 * Top row: current session name + status badge + duration + collapse/close buttons.
 * Below: always-visible horizontal tab strip showing all other active sessions
 *        as mini robot cards (icon + title + project name + label).
 */
import { useMemo } from 'react';
import type { Session } from '@/types';
import { useUiStore } from '@/stores/uiStore';
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
  const filterMode = useUiStore((s) => s.sidebarFilterMode);

  const sortedSessions = useMemo(() => {
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
  }, [sessions, currentSession.sessionId, filterMode]);

  const primaryName = currentSession.title || currentSession.projectName || '(untitled)';
  const secondaryName = currentSession.title && currentSession.projectName && currentSession.title !== currentSession.projectName
    ? currentSession.projectName
    : null;
  const currentColor = STATUS_COLORS[currentSession.status] ?? 'var(--text-dim)';

  return (
    <div className={styles.switcherBar}>
      {/* ── Top row: current session name + meta controls ── */}
      <div className={styles.switcherToggle}>
        <div className={styles.switcherNameDisplay}>
          <span
            className={styles.switcherDot}
            style={{ background: currentColor, boxShadow: `0 0 6px ${currentColor}` }}
          />
          <span className={styles.switcherName}>{primaryName}</span>
          {secondaryName && (
            <span className={styles.switcherProject}>{secondaryName}</span>
          )}
          {currentSession.label && (
            <span className={styles.switcherLabel}>{currentSession.label}</span>
          )}
        </div>

        {/* Right side: status + duration + collapse + close */}
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

      {/* ── Session tab strip (hidden when header collapsed) ── */}
      {!headerCollapsed && sortedSessions.length > 0 && (
        <div className={styles.sessionTabStrip}>
          {sortedSessions.map((s) => {
            const color = STATUS_COLORS[s.status] ?? 'var(--text-dim)';
            const title = s.title || s.projectName || '(untitled)';
            const showProject = s.projectName && s.projectName !== s.title;
            return (
              <button
                key={s.sessionId}
                className={styles.sessionTabCard}
                data-status={s.status}
                style={{ '--robot-color': color } as React.CSSProperties}
                onClick={() => onSwitch(s.sessionId)}
                title={[title, s.projectName, s.label, s.status].filter(Boolean).join(' · ')}
                type="button"
              >
                {/* Mini robot face */}
                <div className={styles.switcherMiniRobotFace}>
                  <div className={styles.switcherMiniRobotEyes}>
                    <div className={styles.switcherMiniRobotEye} />
                    <div className={styles.switcherMiniRobotEye} />
                  </div>
                  <div className={styles.switcherMiniRobotMouth} />
                </div>
                {/* Status dot */}
                <div className={styles.switcherMiniRobotDot} />
                {/* Text info */}
                <div className={styles.sessionTabTitle}>{title}</div>
                {showProject && (
                  <div className={styles.sessionTabProject}>{s.projectName}</div>
                )}
                {s.label && (
                  <div className={styles.sessionTabLabel}>{s.label}</div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
