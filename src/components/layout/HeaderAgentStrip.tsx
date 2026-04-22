import { useCallback, useMemo, useState } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useRoomStore } from '@/stores/roomStore';
import type { Room } from '@/stores/roomStore';
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

// One color per room slot — cycles if more than 8 rooms exist
const ROOM_COLOR_PALETTE = [
  'var(--accent-orange)',
  '#4a9eff',
  'var(--accent-green)',
  'var(--accent-purple)',
  'var(--accent-yellow)',
  '#ff69b4',
  'var(--accent-cyan)',
  '#ff7043',
];

function getRoomColor(room: Room): string {
  const index = ((room.roomIndex ?? 0) % ROOM_COLOR_PALETTE.length + ROOM_COLOR_PALETTE.length) % ROOM_COLOR_PALETTE.length;
  return ROOM_COLOR_PALETTE[index];
}

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

type RenderItem =
  | { type: 'session'; session: Session }
  | { type: 'room'; room: Room; sessions: Session[]; color: string };

export default function HeaderAgentStrip() {
  const sessions = useSessionStore((s) => s.sessions);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const cardDisplayMode = useUiStore((s) => s.cardDisplayMode);
  const rooms = useRoomStore((s) => s.rooms);
  const [expanded, setExpanded] = useState(false);

  const handleSelect = useCallback((sessionId: string) => {
    window.dispatchEvent(new CustomEvent('robot-select', { detail: { sessionId } }));
  }, []);

  const activeSessions = useMemo(
    () =>
      Array.from(sessions.values())
        .filter((s) => s.status !== 'ended')
        .sort((a, b) => {
          if (a.pinned && !b.pinned) return -1;
          if (!a.pinned && b.pinned) return 1;
          return (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99);
        }),
    [sessions],
  );

  // Build render items: room groups appear where their first (highest-priority)
  // session would have appeared in the flat sorted list.
  const renderItems = useMemo((): RenderItem[] => {
    const sessionToRoom = new Map<string, Room>();
    for (const room of rooms) {
      for (const sid of room.sessionIds) {
        sessionToRoom.set(sid, room);
      }
    }

    const processedRooms = new Set<string>();
    const seenSessions = new Set<string>();
    const items: RenderItem[] = [];

    for (const session of activeSessions) {
      if (seenSessions.has(session.sessionId)) continue;
      seenSessions.add(session.sessionId);

      const room = sessionToRoom.get(session.sessionId);
      if (room && !processedRooms.has(room.id)) {
        processedRooms.add(room.id);
        const roomSessions = activeSessions.filter((s) =>
          room.sessionIds.includes(s.sessionId),
        );
        roomSessions.forEach((s) => seenSessions.add(s.sessionId));
        items.push({ type: 'room', room, sessions: roomSessions, color: getRoomColor(room) });
      } else if (!room) {
        items.push({ type: 'session', session });
      }
    }

    return items;
  }, [activeSessions, rooms]);

  // Overflow is based on render items (groups count as 1 each)
  const overflow = renderItems.length - MAX_VISIBLE;
  const visible = expanded || overflow <= 0 ? renderItems : renderItems.slice(0, MAX_VISIBLE);

  if (activeSessions.length === 0) return null;

  return (
    <div className={styles.agentStrip}>
      {visible.map((item) => {
        if (item.type === 'room') {
          return (
            <div
              key={item.room.id}
              className={styles.roomGroup}
              style={{ '--room-color': item.color } as React.CSSProperties}
              title={item.room.name}
            >
              <span className={styles.roomGroupLabel}>{item.room.name}</span>
              {item.sessions.map((session) => (
                <MiniRobot
                  key={session.sessionId}
                  session={session}
                  isSelected={session.sessionId === selectedSessionId}
                  onSelect={handleSelect}
                  displayMode={cardDisplayMode}
                />
              ))}
            </div>
          );
        }
        return (
          <MiniRobot
            key={item.session.sessionId}
            session={item.session}
            isSelected={item.session.sessionId === selectedSessionId}
            onSelect={handleSelect}
            displayMode={cardDisplayMode}
          />
        );
      })}
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
        <span className={styles.miniRobotTitle}>
          {session.title || session.projectName || 'Agent'}
        </span>
      ) : (
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
