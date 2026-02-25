/**
 * RobotListSidebar — Left-side panel listing all active robots grouped by room.
 * Click an entry to select the session and fly the camera to that robot.
 * Shows label, title, and status for each agent.
 */
import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import type { Session } from '@/types/session';

// ---------------------------------------------------------------------------
// Status Colors (matches SceneOverlay)
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  idle: '#00ff88',
  prompting: '#00e5ff',
  working: '#ff9100',
  waiting: '#00e5ff',
  approval: '#ffdd00',
  input: '#aa66ff',
  ended: '#ff4444',
  connecting: '#666',
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
  onTitleSave,
}: {
  session: Session;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onTitleSave: (id: string, title: string) => void;
}) {
  const statusColor = STATUS_COLORS[session.status] ?? '#888';
  const title = session.title || 'Unnamed';
  const label = session.label;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commitEdit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title) {
      onTitleSave(session.sessionId, trimmed);
    } else {
      setDraft(title);
    }
  };

  return (
    <button
      data-session-id={session.sessionId}
      data-status={session.status}
      onClick={() => { if (!editing) onSelect(session.sessionId); }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '8px 10px',
        border: isSelected
          ? `1px solid ${statusColor}`
          : '1px solid rgba(255,255,255,0.06)',
        borderRadius: 3,
        background: isSelected
          ? `rgba(${hexToRgb(statusColor)},0.12)`
          : 'rgba(255,255,255,0.02)',
        cursor: editing ? 'default' : 'pointer',
        textAlign: 'left',
        fontFamily: "'JetBrains Mono', monospace",
        transition: 'all 0.15s ease',
      }}
      onMouseEnter={(e) => {
        if (!isSelected) {
          e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected) {
          e.currentTarget.style.background = 'rgba(255,255,255,0.02)';
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)';
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
              color: 'rgba(0,240,255,0.9)',
              background: 'rgba(0,240,255,0.1)',
              border: '1px solid rgba(0,240,255,0.2)',
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

        {/* Title (editable) */}
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
              if (e.key === 'Escape') { setDraft(title); setEditing(false); }
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(0,240,255,0.4)',
              borderRadius: 2,
              color: '#fff',
              fontSize: 12,
              fontFamily: 'inherit',
              padding: '1px 4px',
              outline: 'none',
              lineHeight: 1.3,
            }}
          />
        ) : (
          <div
            style={{
              fontSize: 12,
              color: isSelected ? '#fff' : 'rgba(255,255,255,0.75)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              lineHeight: 1.3,
            }}
          >
            {title}
          </div>
        )}

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

      {/* Edit button */}
      {!editing && (
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            setDraft(title);
            setEditing(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.stopPropagation(); setDraft(title); setEditing(true); }
          }}
          style={{
            flexShrink: 0,
            width: 18,
            height: 18,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 2,
            color: 'rgba(255,255,255,0.2)',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'rgba(0,240,255,0.8)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'rgba(255,255,255,0.2)';
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
            <path d="m15 5 4 4"/>
          </svg>
        </span>
      )}

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
          color: 'rgba(255,255,255,0.25)',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = '#ff4444';
          e.currentTarget.style.background = 'rgba(255,68,68,0.15)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'rgba(255,255,255,0.25)';
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
        stroke="rgba(255,255,255,0.35)"
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
          color: 'rgba(255,255,255,0.4)',
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
          color: 'rgba(255,255,255,0.25)',
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

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `${r},${g},${b}`;
}

// ---------------------------------------------------------------------------
// Grouped data structure
// ---------------------------------------------------------------------------

interface SessionGroup {
  id: string;
  name: string;
  sessions: Session[];
}

// ---------------------------------------------------------------------------
// Filter persistence (localStorage)
// ---------------------------------------------------------------------------

type FilterMode = 'all' | 'ssh' | 'others';
const FILTER_KEY = 'sidebar-filter-mode';

function loadFilterMode(): FilterMode {
  try {
    const val = localStorage.getItem(FILTER_KEY);
    if (val === 'all' || val === 'ssh' || val === 'others') return val;
    return 'all';
  } catch {
    return 'all';
  }
}

function saveFilterMode(mode: FilterMode): void {
  try { localStorage.setItem(FILTER_KEY, mode); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function RobotListSidebar() {
  const sessions = useSessionStore((s) => s.sessions);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const removeSession = useSessionStore((s) => s.removeSession);
  const updateSession = useSessionStore((s) => s.updateSession);
  const rooms = useRoomStore((s) => s.rooms);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [filterMode, setFilterMode] = useState<FilterMode>(loadFilterMode);

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

  const handleFilterChange = useCallback((mode: FilterMode) => {
    setFilterMode(mode);
    saveFilterMode(mode);
  }, []);

  // Build grouped session list: rooms first (sorted by roomIndex), then "Common Area"
  const groups = useMemo((): SessionGroup[] => {
    const activeSessions = [...sessions.values()].filter(s => {
      if (s.status === 'ended') return false;
      if (filterMode === 'ssh' && s.source !== 'ssh') return false;
      if (filterMode === 'others' && s.source === 'ssh') return false;
      return true;
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
  }, [sessions, rooms, filterMode]);

  const totalCount = useMemo(
    () => groups.reduce((sum, g) => sum + g.sessions.length, 0),
    [groups],
  );

  const selectSession = useSessionStore((s) => s.selectSession);

  const handleSelect = useCallback((sessionId: string) => {
    // Always select in the store so the detail panel opens
    selectSession(sessionId);
    // Also dispatch event for 3D camera fly (no-op when scene is unmounted)
    window.dispatchEvent(
      new CustomEvent('robot-select', { detail: { sessionId } }),
    );
  }, [selectSession]);

  const handleClose = useCallback((sessionId: string) => {
    removeSession(sessionId);
    fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
  }, [removeSession]);

  const handleTitleSave = useCallback((sessionId: string, title: string) => {
    const session = sessions.get(sessionId);
    if (session) {
      updateSession({ ...session, title });
    }
    fetch(`/api/sessions/${sessionId}/title`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).catch(() => {});
  }, [sessions, updateSession]);

  // Hide sidebar only when there are zero active sessions across ALL filters
  const hasAnySessions = useMemo(
    () => [...sessions.values()].some(s => s.status !== 'ended'),
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
            color: 'rgba(0,240,255,0.4)',
            textTransform: 'uppercase',
            fontFamily: "'Share Tech Mono', 'JetBrains Mono', monospace",
            flex: 1,
          }}
        >
          Agents ({totalCount})
        </span>
        {/* Filter segmented control */}
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            display: 'flex',
            borderRadius: 3,
            overflow: 'hidden',
            border: '1px solid rgba(255,255,255,0.1)',
            marginRight: 6,
          }}
        >
          {(['all', 'ssh', 'others'] as const).map((mode) => {
            const active = filterMode === mode;
            const label = mode === 'all' ? 'ALL' : mode === 'ssh' ? 'SSH' : 'OTHERS';
            return (
              <button
                key={mode}
                onClick={() => handleFilterChange(mode)}
                style={{
                  fontSize: 9,
                  letterSpacing: 0.5,
                  padding: '2px 6px',
                  fontFamily: "'JetBrains Mono', monospace",
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  background: active ? 'rgba(0,240,255,0.15)' : 'transparent',
                  color: active ? 'rgba(0,240,255,0.9)' : 'rgba(255,255,255,0.3)',
                  border: 'none',
                  borderRight: mode !== 'others' ? '1px solid rgba(255,255,255,0.08)' : 'none',
                  lineHeight: 1.4,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgba(0,240,255,0.4)"
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

      {/* Grouped session list */}
      {!panelCollapsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {totalCount === 0 ? (
            <div style={{
              padding: '16px 8px',
              textAlign: 'center',
              fontSize: 11,
              color: 'rgba(255,255,255,0.25)',
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: 0.5,
            }}>
              No {filterMode === 'ssh' ? 'SSH' : filterMode === 'others' ? 'other' : ''} sessions
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
                        onTitleSave={handleTitleSave}
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
