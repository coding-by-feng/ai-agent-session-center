/**
 * SessionSwitcher — bar at the top of the DetailPanel.
 * Top row: current session name + status badge + duration + display toggle + collapse/close buttons.
 * Below: always-visible horizontal tab strip showing all other active sessions
 *        as mini robot cards (icon + title + project name + label).
 */
import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useRoomStore } from '@/stores/roomStore';
import styles from '@/styles/modules/DetailPanel.module.css';

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

const STATUS_ORDER: Record<string, number> = {
  working: 0, prompting: 1, approval: 2, input: 2,
  waiting: 3, idle: 4, connecting: 5, ended: 6,
};

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

/** Room filter funnel icon */
function RoomFilterIcon({ active }: { active: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M1 2h10L7 6.5V10.5L5 9.5V6.5L1 2Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill={active ? 'currentColor' : 'none'}
        fillOpacity={active ? 0.3 : 0}
      />
    </svg>
  );
}

/** Two-column grid icon — shown in compact mode; click to switch to detailed */
function DetailedModeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** Horizontal list icon — shown in detailed mode; click to switch to compact */
function CompactModeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="2" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1" y="9" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

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
  // Track sessions that finished work (transitioned to "waiting") but haven't been viewed
  const [attentionIds, setAttentionIds] = useState<Set<string>>(new Set());
  const prevStatusRef = useRef(new Map<string, string>());

  useEffect(() => {
    let changed = false;
    const next = new Set(attentionIds);
    sessions.forEach((s) => {
      const prev = prevStatusRef.current.get(s.sessionId);
      // Detect transition TO "waiting" from an active status
      if (prev && prev !== 'waiting' && prev !== 'idle' && prev !== 'ended' && s.status === 'waiting') {
        // Don't mark the currently selected session
        if (s.sessionId !== currentSession.sessionId) {
          next.add(s.sessionId);
          changed = true;
        }
      }
      prevStatusRef.current.set(s.sessionId, s.status);
    });
    if (changed) setAttentionIds(next);
  }, [sessions, currentSession.sessionId, attentionIds]);

  const handleSwitch = useCallback((id: string) => {
    setAttentionIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    onSwitch(id);
  }, [onSwitch]);
  const cardDisplayMode = useUiStore((s) => s.cardDisplayMode);
  const toggleCardDisplayMode = useUiStore((s) => s.toggleCardDisplayMode);
  const rooms = useRoomStore((s) => s.rooms);

  const selectedRoomIds = useUiStore((s) => s.selectedRoomIds);
  const toggleRoomFilter = useUiStore((s) => s.toggleRoomFilter);
  const clearRoomFilter = useUiStore((s) => s.clearRoomFilter);
  const [roomDropdownOpen, setRoomDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!roomDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setRoomDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [roomDropdownOpen]);

  // Build globally indexed session list (all active, sorted), then split out "others"
  const { sortedSessions, sessionIndexMap, currentIndex } = useMemo(() => {
    const allActive = [...sessions.values()]
      .filter((s) => s.status !== 'ended')
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        const oa = STATUS_ORDER[a.status] ?? 5;
        const ob = STATUS_ORDER[b.status] ?? 5;
        if (oa !== ob) return oa - ob;
        return (a.title || a.projectName || '').localeCompare(b.title || b.projectName || '');
      });
    const indexMap = new Map<string, number>();
    let curIdx = -1;
    allActive.forEach((s, i) => {
      indexMap.set(s.sessionId, i + 1);
      if (s.sessionId === currentSession.sessionId) curIdx = i + 1;
    });
    const others = allActive.filter((s) => s.sessionId !== currentSession.sessionId);
    return { sortedSessions: others, sessionIndexMap: indexMap, currentIndex: curIdx };
  }, [sessions, currentSession.sessionId]);

  // Rooms that have at least one session in the current active list
  const activeSessionIds = useMemo(
    () => new Set([...sessions.values()].filter((s) => s.status !== 'ended').map((s) => s.sessionId)),
    [sessions],
  );
  const availableRooms = useMemo(
    () => rooms.filter((r) => r.sessionIds.some((id) => activeSessionIds.has(id))),
    [rooms, activeSessionIds],
  );

  // Apply room filter to the tab strip (current session is never filtered out)
  const filteredSessions = useMemo(() => {
    if (selectedRoomIds.size === 0) return sortedSessions;
    const allowedIds = new Set<string>();
    for (const roomId of selectedRoomIds) {
      const room = rooms.find((r) => r.id === roomId);
      if (room) room.sessionIds.forEach((id) => allowedIds.add(id));
    }
    return sortedSessions.filter((s) => allowedIds.has(s.sessionId));
  }, [sortedSessions, selectedRoomIds, rooms]);

  const selectedRoomNames = useMemo(() => {
    if (selectedRoomIds.size === 0) return '';
    return [...selectedRoomIds]
      .map((id) => rooms.find((r) => r.id === id)?.name)
      .filter(Boolean)
      .join(', ');
  }, [selectedRoomIds, rooms]);

  const toggleRoom = useCallback((roomId: string) => {
    toggleRoomFilter(roomId);
  }, [toggleRoomFilter]);

  const primaryName = currentSession.title || currentSession.projectName || '(untitled)';
  const secondaryName = currentSession.title && currentSession.projectName && currentSession.title !== currentSession.projectName
    ? currentSession.projectName
    : null;
  const currentColor = STATUS_COLORS[currentSession.status] ?? 'var(--text-dim)';
  const isCompact = cardDisplayMode === 'compact';

  return (
    <div className={styles.switcherBar}>
      {/* ── Top row: current session name + meta controls ── */}
      <div className={styles.switcherToggle}>
        <div className={styles.switcherNameDisplay}>
          <span
            className={styles.switcherDot}
            style={{ background: currentColor, boxShadow: `0 0 6px ${currentColor}` }}
          />
          {currentIndex > 0 && (
            <span className={styles.switcherIndex}>{currentIndex}</span>
          )}
          <span className={styles.switcherName}>{primaryName}</span>
          {secondaryName && (
            <span className={styles.switcherProject}>{secondaryName}</span>
          )}
          {currentSession.label && (
            <span className={styles.switcherLabel}>{currentSession.label}</span>
          )}
        </div>

        {/* Right side: status + duration + display toggle + collapse + close */}
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
          {/* Room filter dropdown (multi-select) */}
          {availableRooms.length > 0 && (
            <div className={styles.roomFilterWrap} ref={dropdownRef}>
              <button
                className={`${styles.displayModeToggle}${selectedRoomIds.size > 0 ? ` ${styles.roomFilterActive}` : ''}`}
                onClick={() => setRoomDropdownOpen((o) => !o)}
                title={selectedRoomIds.size > 0 ? `Filtering: ${selectedRoomNames}` : 'Filter by room'}
                type="button"
              >
                <RoomFilterIcon active={selectedRoomIds.size > 0} />
              </button>
              {roomDropdownOpen && (
                <div className={styles.roomFilterDropdown}>
                  <button
                    className={`${styles.roomFilterOption}${selectedRoomIds.size === 0 ? ` ${styles.roomFilterOptionActive}` : ''}`}
                    onClick={() => { clearRoomFilter(); setRoomDropdownOpen(false); }}
                    type="button"
                  >
                    All rooms
                  </button>
                  {availableRooms.map((r) => (
                    <button
                      key={r.id}
                      className={`${styles.roomFilterOption}${selectedRoomIds.has(r.id) ? ` ${styles.roomFilterOptionActive}` : ''}`}
                      onClick={() => toggleRoom(r.id)}
                      type="button"
                    >
                      {selectedRoomIds.has(r.id) && <span className={styles.roomFilterCheck}>&#x2713;</span>}
                      {r.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <button
            className={styles.displayModeToggle}
            onClick={toggleCardDisplayMode}
            title={isCompact ? 'Detailed view' : 'Compact view'}
            type="button"
          >
            {isCompact ? <DetailedModeIcon /> : <CompactModeIcon />}
          </button>
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
              title="Minimize"
              type="button"
            >
              &#x2012;
            </button>
          )}
        </div>
      </div>

      {/* ── Session tab strip ── */}
      {filteredSessions.length > 0 && (
        <div className={styles.sessionTabStrip}>
          {filteredSessions.map((s) => (
            <SessionTabCard
              key={s.sessionId}
              session={s}
              onSwitch={handleSwitch}
              isCompact={isCompact}
              index={sessionIndexMap.get(s.sessionId) ?? 0}
              needsAttention={attentionIds.has(s.sessionId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionTabCard({
  session,
  onSwitch,
  isCompact,
  index,
  needsAttention,
}: {
  session: Session;
  onSwitch: (id: string) => void;
  isCompact: boolean;
  index: number;
  needsAttention?: boolean;
}) {
  const color = STATUS_COLORS[session.status] ?? 'var(--text-dim)';
  const title = session.title || session.projectName || '(untitled)';
  const showProject = session.projectName && session.projectName !== session.title;
  const badge = getCliBadge(session);

  const handlePinClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useSessionStore.getState().togglePin(session.sessionId);
  }, [session.sessionId]);

  return (
    <button
      className={`${styles.sessionTabCard}${isCompact ? ` ${styles.sessionTabCardCompact}` : ''}${needsAttention ? ` ${styles.sessionTabAttention}` : ''}`}
      data-status={session.status}
      style={{ '--robot-color': color } as React.CSSProperties}
      onClick={() => onSwitch(session.sessionId)}
      title={[title, session.projectName, session.label, session.status].filter(Boolean).join(' · ')}
      type="button"
    >
      {/* Pin icon */}
      <span
        className={`${styles.sessionTabPin}${session.pinned ? ` ${styles.pinned}` : ''}`}
        onClick={handlePinClick}
        title={session.pinned ? 'Unpin' : 'Pin'}
      >
        &#x1F4CC;
      </span>

      {!isCompact && (
        <>
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
        </>
      )}

      {/* Sequence badge */}
      {index > 0 && <span className={styles.sessionTabIndex}>{index}</span>}

      {/* Text info */}
      <div className={styles.sessionTabTitle}>
        {title}
      </div>
      {!isCompact && showProject && (
        <div className={styles.sessionTabProject}>{session.projectName}</div>
      )}
      {!isCompact && badge && (
        <div className={styles.sessionTabBadge}>{badge}</div>
      )}
      {!isCompact && session.label && (
        <div className={styles.sessionTabLabel}>{session.label}</div>
      )}
    </button>
  );
}
