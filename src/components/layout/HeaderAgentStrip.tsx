import { useCallback, useState } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { Session } from '@/types';
import styles from '@/styles/modules/Header.module.css';

const STATUS_COLORS: Record<string, string> = {
  idle: 'var(--accent-green)',
  prompting: 'var(--accent-cyan)',
  working: 'var(--accent-orange)',
  waiting: 'var(--accent-cyan)',
  approval: 'var(--accent-yellow)',
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

/** Detect CLI tool from session command */
function getCliBadge(session: Session): string | null {
  const cmd = (session.sshCommand || session.sshConfig?.command || '').toLowerCase();
  if (cmd.startsWith('claude') || cmd.includes('/claude')) return 'CLAUDE';
  if (cmd.startsWith('codex') || cmd.includes('/codex')) return 'CODEX';
  if (cmd.startsWith('gemini') || cmd.includes('/gemini')) return 'GEMINI';
  if (cmd.startsWith('aider') || cmd.includes('/aider')) return 'AIDER';
  if (session.backendType) {
    const bt = session.backendType.toLowerCase();
    if (bt.includes('claude')) return 'CLAUDE';
    if (bt.includes('codex')) return 'CODEX';
    if (bt.includes('gemini')) return 'GEMINI';
    if (bt.includes('aider')) return 'AIDER';
  }
  return null;
}

export default function HeaderAgentStrip() {
  const sessions = useSessionStore((s) => s.sessions);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const cardDisplayMode = useUiStore((s) => s.cardDisplayMode);
  const [expanded, setExpanded] = useState(false);

  const handleSelect = useCallback((sessionId: string) => {
    window.dispatchEvent(new CustomEvent('robot-select', { detail: { sessionId } }));
  }, []);

  const activeSessions = Array.from(sessions.values())
    .filter((s) => s.status !== 'ended')
    .sort((a, b) => {
      // Pinned first
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99);
    });

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
          displayMode={cardDisplayMode}
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
  displayMode,
}: {
  session: Session;
  isSelected: boolean;
  onSelect: (id: string) => void;
  displayMode: 'detailed' | 'compact';
}) {
  const color = STATUS_COLORS[session.status] ?? 'var(--text-dim)';
  const label = session.label || session.title || session.projectName || 'Agent';
  const badge = getCliBadge(session);
  const isCompact = displayMode === 'compact';

  const handlePinClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useSessionStore.getState().togglePin(session.sessionId);
  }, [session.sessionId]);

  return (
    <button
      className={`${styles.miniRobot}${isCompact ? ` ${styles.miniRobotCompact}` : ''}`}
      data-status={session.status}
      data-selected={isSelected ? 'true' : undefined}
      style={{ '--robot-color': color } as React.CSSProperties}
      onClick={() => onSelect(session.sessionId)}
      title={`${label} · ${session.status}${badge ? ` · ${badge}` : ''}`}
      aria-label={`${label} (${session.status})`}
      aria-pressed={isSelected}
    >
      {/* Pin icon */}
      <span
        className={`${styles.miniRobotPin}${session.pinned ? ` ${styles.pinned}` : ''}`}
        onClick={handlePinClick}
        title={session.pinned ? 'Unpin' : 'Pin'}
      >
        &#x1F4CC;
      </span>

      {isCompact ? (
        /* Compact: title only */
        <span className={styles.miniRobotTitle}>
          {session.title || session.projectName || 'Agent'}
        </span>
      ) : (
        /* Detailed: face + badge */
        <>
          <div className={styles.miniRobotFace}>
            <div className={styles.miniRobotEyes}>
              <div className={styles.miniRobotEye} />
              <div className={styles.miniRobotEye} />
            </div>
            <div className={styles.miniRobotMouth} />
          </div>
          {badge && <span className={styles.miniRobotBadge}>{badge}</span>}
        </>
      )}
      <div className={styles.miniRobotDot} />
    </button>
  );
}
