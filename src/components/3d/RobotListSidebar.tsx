/**
 * RobotListSidebar — Right-side panel listing all active robots.
 * Click an entry to select the session and fly the camera to that robot.
 */
import { useMemo, useCallback } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useCameraStore } from '@/stores/cameraStore';
import { robotPositionStore } from './robotPositionStore';
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

// Camera offset when flying to a robot
const FLY_OFFSET_Y = 8;
const FLY_OFFSET_Z = 10;
const FLY_OFFSET_X = 6;

// ---------------------------------------------------------------------------
// Entry Component
// ---------------------------------------------------------------------------

function RobotEntry({
  session,
  isSelected,
  onSelect,
}: {
  session: Session;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const statusColor = STATUS_COLORS[session.status] ?? '#888';
  const title = session.projectName || session.title || 'Unnamed';

  return (
    <button
      onClick={() => onSelect(session.sessionId)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '6px 10px',
        border: isSelected
          ? `1px solid ${statusColor}`
          : '1px solid rgba(255,255,255,0.06)',
        borderRadius: 3,
        background: isSelected
          ? `rgba(${hexToRgb(statusColor)},0.12)`
          : 'rgba(255,255,255,0.02)',
        cursor: 'pointer',
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
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: statusColor,
          boxShadow: `0 0 6px ${statusColor}`,
          flexShrink: 0,
        }}
      />

      {/* Title + status */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 10,
            color: isSelected ? '#fff' : 'rgba(255,255,255,0.7)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            lineHeight: 1.3,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 8,
            color: statusColor,
            letterSpacing: 1,
            textTransform: 'uppercase',
            lineHeight: 1.3,
          }}
        >
          {session.status}
        </div>
      </div>
    </button>
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
// Main Component
// ---------------------------------------------------------------------------

export default function RobotListSidebar() {
  const sessions = useSessionStore((s) => s.sessions);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  const flyTo = useCameraStore((s) => s.flyTo);

  const sessionArray = useMemo(() => {
    const arr = [...sessions.values()].filter(s => s.status !== 'ended');
    // Sort: active statuses first, then by name
    const statusOrder: Record<string, number> = {
      working: 0, prompting: 1, thinking: 1, approval: 2, input: 2,
      waiting: 3, idle: 4, connecting: 5, ended: 6,
    };
    arr.sort((a, b) => {
      const oa = statusOrder[a.status] ?? 5;
      const ob = statusOrder[b.status] ?? 5;
      if (oa !== ob) return oa - ob;
      return (a.projectName || a.title).localeCompare(b.projectName || b.title);
    });
    return arr;
  }, [sessions]);

  const handleSelect = useCallback((sessionId: string) => {
    selectSession(sessionId);
    // Fly camera to robot position
    const pos = robotPositionStore.get(sessionId);
    if (pos) {
      flyTo(
        [pos.x + FLY_OFFSET_X, pos.y + FLY_OFFSET_Y, pos.z + FLY_OFFSET_Z],
        [pos.x, pos.y + 1, pos.z],
      );
    }
  }, [selectSession, flyTo]);

  if (sessionArray.length === 0) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        right: 20,
        width: 200,
        maxHeight: 'calc(100vh - 100px)',
        overflowY: 'auto',
        background: 'color-mix(in srgb, var(--bg-panel) 85%, transparent)',
        backdropFilter: 'blur(20px)',
        border: '1px solid var(--border-accent)',
        borderRadius: 4,
        padding: '10px 8px',
        pointerEvents: 'all',
        zIndex: 11,
        boxShadow: '0 0 12px var(--glow-accent), inset 0 0 24px var(--glow-accent)',
      }}
    >
      {/* Header */}
      <div
        style={{
          fontSize: 9,
          letterSpacing: 2,
          color: 'rgba(0,240,255,0.4)',
          textTransform: 'uppercase',
          fontFamily: "'Share Tech Mono', 'JetBrains Mono', monospace",
          marginBottom: 8,
          paddingLeft: 2,
        }}
      >
        Agents ({sessionArray.length})
      </div>

      {/* Session list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {sessionArray.map((session) => (
          <RobotEntry
            key={session.sessionId}
            session={session}
            isSelected={selectedSessionId === session.sessionId}
            onSelect={handleSelect}
          />
        ))}
      </div>
    </div>
  );
}
