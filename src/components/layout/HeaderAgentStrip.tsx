import { useCallback, useState } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';
import styles from '@/styles/modules/Header.module.css';

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

const STATUS_PRIORITY: Record<string, number> = {
  working: 0,
  prompting: 1,
  approval: 2,
  input: 2,
  waiting: 3,
  idle: 4,
  connecting: 5,
  ended: 6,
};

const MAX_VISIBLE = 8;

export default function HeaderAgentStrip() {
  const sessions = useSessionStore((s) => s.sessions);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const [expanded, setExpanded] = useState(false);

  const handleSelect = useCallback((sessionId: string) => {
    window.dispatchEvent(new CustomEvent('robot-select', { detail: { sessionId } }));
  }, []);

  const activeSessions = Array.from(sessions.values())
    .filter((s) => s.status !== 'ended')
    .sort((a, b) => (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99));

  const overflow = activeSessions.length - MAX_VISIBLE;
  const visible =
    expanded || overflow <= 0 ? activeSessions : activeSessions.slice(0, MAX_VISIBLE);

  if (activeSessions.length === 0) return null;

  return (
    <div className={styles.agentStrip}>
      {visible.map((session) => (
        <MiniRobot
          key={session.sessionId}
          session={session}
          isSelected={session.sessionId === selectedSessionId}
          onSelect={handleSelect}
        />
      ))}
      {overflow > 0 && !expanded && (
        <button
          className={styles.overflowChip}
          onClick={() => setExpanded(true)}
          title="Show all agents"
        >
          +{overflow}
        </button>
      )}
      {expanded && overflow > 0 && (
        <button
          className={styles.overflowChip}
          onClick={() => setExpanded(false)}
          title="Collapse"
        >
          ↑
        </button>
      )}
    </div>
  );
}

function MiniRobot({
  session,
  isSelected,
  onSelect,
}: {
  session: Session;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const color = STATUS_COLORS[session.status] ?? 'var(--text-dim)';
  const label = session.label || session.title || session.projectName || 'Agent';

  return (
    <button
      className={styles.miniRobot}
      data-status={session.status}
      data-selected={isSelected ? 'true' : undefined}
      style={{ '--robot-color': color } as React.CSSProperties}
      onClick={() => onSelect(session.sessionId)}
      title={`${label} · ${session.status}`}
      aria-label={`${label} (${session.status})`}
      aria-pressed={isSelected}
    >
      <div className={styles.miniRobotFace}>
        <div className={styles.miniRobotEyes}>
          <div className={styles.miniRobotEye} />
          <div className={styles.miniRobotEye} />
        </div>
        <div className={styles.miniRobotMouth} />
      </div>
      <div className={styles.miniRobotDot} />
    </button>
  );
}
