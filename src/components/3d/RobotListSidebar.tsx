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
import { markUserClosing } from '@/lib/pinnedRespawn';
import { sortSessions } from '@/lib/sessionSort';
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


// ---------------------------------------------------------------------------
// Entry Component
// ---------------------------------------------------------------------------

function RobotEntry({
  session,
  isSelected,
  onSelect,
  onClose,
  onTogglePin,
}: {
  session: Session;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePin: (id: string) => void;
}) {
  const statusColor = STATUS_COLORS[session.status] ?? '#888';
  const needsAttention = session.status === 'approval' || session.status === 'input';
  const pinned = !!session.pinned;
  const title = session.title || 'Unnamed';

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
        boxShadow: [
          needsAttention
            ? `0 0 8px ${statusColor}, inset 0 0 4px color-mix(in srgb, ${statusColor} 10%, transparent)`
            : '',
          // Pinned sessions get a left accent bar so "fixed" is visible at a glance.
          pinned ? 'inset 3px 0 0 var(--accent-yellow)' : '',
        ].filter(Boolean).join(', ') || undefined,
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

      {/* Title + Status */}
      <div style={{ flex: 1, minWidth: 0 }}>
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

      {/* Pin toggle — pinned sessions stay fixed at the top and auto-recreate. */}
      <span
        role="button"
        tabIndex={-1}
        aria-pressed={pinned}
        title={pinned
          ? 'Pinned — stays in the list and auto-recreates on restart / if it dies. Click to unpin.'
          : 'Pin — keep this session fixed and auto-recreate it.'}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(session.sessionId);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.stopPropagation(); onTogglePin(session.sessionId); }
        }}
        style={{
          flexShrink: 0,
          width: 18,
          height: 18,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 2,
          fontSize: 11,
          lineHeight: 1,
          color: pinned ? 'var(--accent-yellow)' : 'var(--text-dim)',
          opacity: pinned ? 1 : 0.55,
          cursor: 'pointer',
          transition: 'all 0.15s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = '1';
          e.currentTarget.style.color = 'var(--accent-yellow)';
          e.currentTarget.style.background = 'color-mix(in srgb, var(--accent-yellow) 15%, transparent)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = pinned ? '1' : '0.55';
          e.currentTarget.style.color = pinned ? 'var(--accent-yellow)' : 'var(--text-dim)';
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 17v5" />
          <path d="M9 10.76V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v6.76a2 2 0 0 0 .59 1.41l1.7 1.7A1 1 0 0 1 17.59 16H6.41a1 1 0 0 1-.7-1.71l1.7-1.7A2 2 0 0 0 8 10.76" />
        </svg>
      </span>

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
  const togglePin = useSessionStore((s) => s.togglePin);
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
      // Floating popups (Explain/Translate PiP) belong to their parent session
      // and are rendered as draggable PiP windows, not as standalone agents.
      // Clone/fork sessions set isFork only and DO show here.
      if (s.isFloating) return false;
      if (!query) return true;
      const title = (s.title || 'Unnamed').toLowerCase();
      const project = (s.projectName || '').toLowerCase();
      const status = s.status.toLowerCase();
      return title.includes(query) || project.includes(query) || status.includes(query);
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

  const handleTogglePin = useCallback((sessionId: string) => {
    togglePin(sessionId);
  }, [togglePin]);

  const handleClose = useCallback((sessionId: string) => {
    // Closing a PINNED session is a deliberate "stop keeping this alive" — confirm,
    // then unpin (so it won't auto-recreate) and flag it so its death is not
    // treated as an unexpected crash to respawn.
    const session = useSessionStore.getState().sessions.get(sessionId);
    if (session?.pinned) {
      const ok = window.confirm(
        `"${session.title || 'This session'}" is pinned and auto-recreates.\n\nClose and unpin it?`,
      );
      if (!ok) return;
      markUserClosing(session);
      togglePin(sessionId);
    }
    // Kill the process and remove from view
    fetch(`/api/sessions/${sessionId}/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
    removeSession(sessionId);
  }, [removeSession, togglePin]);

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
                        onTogglePin={handleTogglePin}
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
