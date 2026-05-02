/**
 * RobotListSidebar — Left-side panel listing all active robots grouped by room.
 * Click an entry to select the session and fly the camera to that robot.
 * Shows label, title, and status for each agent.
 */
import { useMemo, useCallback, useState } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { useUiStore } from '@/stores/uiStore';
import SearchInput from '@/components/ui/SearchInput';
import type { Session } from '@/types/session';

// ---------------------------------------------------------------------------
// Status Colors (matches SceneOverlay)
// ---------------------------------------------------------------------------

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

function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const oa = STATUS_ORDER[a.status] ?? 5;
    const ob = STATUS_ORDER[b.status] ?? 5;
    if (oa !== ob) return oa - ob;
    return (a.title || 'Unnamed').localeCompare(b.title || 'Unnamed');
  });
}

// ---------------------------------------------------------------------------
// Entry Component
// ---------------------------------------------------------------------------

function RobotEntry({
  session,
  isSelected,
  onSelect,
  onClose,
}: {
  session: Session;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const statusColor = STATUS_COLORS[session.status] ?? '#888';
  const needsAttention = session.status === 'approval' || session.status === 'input';
  const title = session.title || 'Unnamed';
  const label = session.label;

  return (
    <button
      data-session-id={session.sessionId}
      data-status={session.status}
      onClick={() => onSelect(session.sessionId)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '8px 10px',
        border: (isSelected || needsAttention)
          ? `${needsAttention ? '2px' : '1px'} solid ${statusColor}`
          : '1px solid var(--border-subtle)',
        borderRadius: 3,
        background: isSelected
          ? `color-mix(in srgb, ${statusColor} 12%, transparent)`
          : needsAttention
            ? `color-mix(in srgb, ${statusColor} 8%, transparent)`
            : 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: "'JetBrains Mono', monospace",
        transition: 'all 0.15s ease',
        boxShadow: needsAttention ? `0 0 8px ${statusColor}, inset 0 0 4px color-mix(in srgb, ${statusColor} 10%, transparent)` : undefined,
        animation: needsAttention ? 'sidebarApprovalPulse 1.2s ease-in-out infinite' : undefined,
      }}
      onMouseEnter={(e) => {
        if (!isSelected) {
          e.currentTarget.style.background = 'var(--bg-subtle)';
          e.currentTarget.style.borderColor = 'var(--border-subtle-strong)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.borderColor = 'var(--border-subtle)';
        }
      }}
    >
      {/* Status dot */}
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: statusColor,
          boxShadow: `0 0 6px ${statusColor}`,
          flexShrink: 0,
          alignSelf: 'flex-start',
          marginTop: 4,
        }}
      />

      {/* Label + Title + Status */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Label badge */}
        {label && (
          <span
            style={{
              display: 'inline-block',
              fontSize: 9,
              letterSpacing: 0.5,
              color: 'var(--accent-cyan)',
              background: 'var(--bg-accent)',
              border: '1px solid var(--border-accent)',
              borderRadius: 2,
              padding: '0px 4px',
              marginBottom: 2,
              lineHeight: 1.5,
              textTransform: 'uppercase',
            }}
          >
            {label}
          </span>
        )}

        {/* Title (read-only — used as the resume key for Claude Code sessions) */}
        <div
          style={{
            fontSize: 12,
            color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            lineHeight: 1.3,
          }}
        >
          {title}
        </div>

        {/* Status text */}
        <div
          style={{
            fontSize: 10,
            color: statusColor,
            letterSpacing: 1,
            textTransform: 'uppercase',
            lineHeight: 1.3,
          }}
        >
          {session.status}
        </div>
      </div>

      {/* Close button */}
      <span
        role="button"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onClose(session.sessionId);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.stopPropagation(); onClose(session.sessionId); }
        }}
        style={{
          flexShrink: 0,
          width: 18,
          height: 18,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 2,
          fontSize: 10,
          lineHeight: 1,
          color: 'var(--text-dim)',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--accent-red)';
          e.currentTarget.style.background = 'color-mix(in srgb, var(--accent-red) 15%, transparent)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--text-dim)';
          e.currentTarget.style.background = 'transparent';
        }}
      >
        ✕
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Room Group Header
// ---------------------------------------------------------------------------

function RoomGroupHeader({
  name,
  count,
  collapsed,
  onToggle,
}: {
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 4px 4px',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--text-dim)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          transition: 'transform 0.15s ease',
          transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          flexShrink: 0,
        }}
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <span
        style={{
          fontSize: 11,
          letterSpacing: 1.5,
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
          fontFamily: "'Share Tech Mono', 'JetBrains Mono', monospace",
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
      <span
        style={{
          fontSize: 10,
          color: 'var(--text-dim)',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {count}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Grouped data structure
// ---------------------------------------------------------------------------

interface SessionGroup {
  id: string;
  name: string;
  sessions: Session[];
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function RobotListSidebar() {
  const sessions = useSessionStore((s) => s.sessions);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const removeSession = useSessionStore((s) => s.removeSession);
  const rooms = useRoomStore((s) => s.rooms);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  // Build grouped session list: rooms first (sorted by roomIndex), then "Common Area"
  const groups = useMemo((): SessionGroup[] => {
    const query = searchQuery.toLowerCase().trim();
    const activeSessions = [...sessions.values()].filter(s => {
      if (s.status === 'ended') return false;
      if (!query) return true;
      const title = (s.title || 'Unnamed').toLowerCase();
      const label = (s.label || '').toLowerCase();
      const project = (s.projectName || '').toLowerCase();
      const status = s.status.toLowerCase();
      return title.includes(query) || label.includes(query) || project.includes(query) || status.includes(query);
    });
    const assignedIds = new Set<string>();
    const result: SessionGroup[] = [];

    // Sort rooms by roomIndex
    const sortedRooms = [...rooms]
      .filter(r => r.roomIndex != null)
      .sort((a, b) => (a.roomIndex ?? 0) - (b.roomIndex ?? 0));

    for (const room of sortedRooms) {
      const roomSessions = activeSessions.filter(s => room.sessionIds.includes(s.sessionId));
      if (roomSessions.length > 0) {
        for (const s of roomSessions) assignedIds.add(s.sessionId);
        result.push({
          id: room.id,
          name: room.name,
          sessions: sortSessions(roomSessions),
        });
      }
    }

    // Unassigned sessions → "Common Area"
    const unassigned = activeSessions.filter(s => !assignedIds.has(s.sessionId));
    if (unassigned.length > 0) {
      result.push({
        id: '__common__',
        name: 'Common Area',
        sessions: sortSessions(unassigned),
      });
    }

    return result;
  }, [sessions, rooms, searchQuery]);

  const totalCount = useMemo(
    () => groups.reduce((sum, g) => sum + g.sessions.length, 0),
    [groups],
  );

  const selectSession = useSessionStore((s) => s.selectSession);
  const detailPanelMinimized = useUiStore((s) => s.detailPanelMinimized);
  const restoreDetailPanel = useUiStore((s) => s.restoreDetailPanel);

  const handleSelect = useCallback((sessionId: string) => {
    // Always select in the store so the detail panel opens
    selectSession(sessionId);
    // If the panel is minimized, restore it (selectedSessionId may not change,
    // so the DetailPanel useEffect won't fire — we must restore it here).
    if (detailPanelMinimized) {
      restoreDetailPanel();
    }
    // Also dispatch event for 3D camera fly (no-op when scene is unmounted)
    window.dispatchEvent(
      new CustomEvent('robot-select', { detail: { sessionId } }),
    );
  }, [selectSession, detailPanelMinimized, restoreDetailPanel]);

  const handleClose = useCallback((sessionId: string) => {
    // Kill the process and remove from view
    fetch(`/api/sessions/${sessionId}/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
    removeSession(sessionId);
  }, [removeSession]);

  // Hide sidebar only when there are zero sessions at all
  const hasAnySessions = useMemo(
    () => sessions.size > 0,
    [sessions],
  );
  if (!hasAnySessions) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        left: 20,
        width: panelCollapsed ? 'auto' : 280,
        maxHeight: 'calc(100vh - 100px)',
        overflowY: panelCollapsed ? 'hidden' : 'auto',
        background: 'color-mix(in srgb, var(--bg-panel) 85%, transparent)',
        backdropFilter: 'blur(20px)',
        border: '1px solid var(--border-accent)',
        borderRadius: 4,
        padding: panelCollapsed ? '10px 12px' : '14px 12px',
        pointerEvents: 'all',
        zIndex: 11,
        boxShadow: '0 0 12px var(--glow-accent), inset 0 0 24px var(--glow-accent)',
        transition: 'width 0.2s ease, padding 0.2s ease',
      }}
    >
      {/* Header with collapse toggle */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          marginBottom: panelCollapsed ? 0 : 4,
          paddingLeft: 2,
          userSelect: 'none',
        }}
        onClick={() => setPanelCollapsed((c) => !c)}
      >
        <span
          style={{
            fontSize: 12,
            letterSpacing: 2,
            color: 'var(--text-dim)',
            textTransform: 'uppercase',
            fontFamily: "'Share Tech Mono', 'JetBrains Mono', monospace",
            flex: 1,
          }}
        >
          Agents ({totalCount})
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent-cyan)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transition: 'transform 0.2s ease',
            transform: panelCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* Search input */}
      {!panelCollapsed && (
        <div style={{ marginBottom: 6 }}>
          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search sessions..."
            debounceMs={150}
          />
        </div>
      )}

      {/* Grouped session list */}
      {!panelCollapsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {totalCount === 0 ? (
            <div style={{
              padding: '16px 8px',
              textAlign: 'center',
              fontSize: 11,
              color: 'var(--text-dim)',
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: 0.5,
            }}>
              No sessions
            </div>
          ) : groups.map((group) => {
            const isGroupCollapsed = collapsedGroups.has(group.id);
            return (
              <div key={group.id}>
                <RoomGroupHeader
                  name={group.name}
                  count={group.sessions.length}
                  collapsed={isGroupCollapsed}
                  onToggle={() => toggleGroup(group.id)}
                />
                {!isGroupCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingLeft: 4 }}>
                    {group.sessions.map((session) => (
                      <RobotEntry
                        key={session.sessionId}
                        session={session}
                        isSelected={selectedSessionId === session.sessionId}
                        onSelect={handleSelect}
                        onClose={handleClose}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
