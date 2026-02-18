/**
 * SceneOverlay — 2D HUD overlay on top of the 3D Cyberdrome scene.
 * Shows status breakdown, session count, mute toggle, and room management.
 */
import { useMemo, useState, useCallback } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useCameraStore, DEFAULT_CAMERA_POSITION, DEFAULT_CAMERA_TARGET } from '@/stores/cameraStore';
import { computeRoomCameraTarget } from '@/lib/cyberdromeScene';
import { soundEngine } from '@/lib/soundEngine';

// ---------------------------------------------------------------------------
// Status Colors
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

// Shared button styling helper
const BTN_FONT: React.CSSProperties = {
  fontFamily: "'Share Tech Mono', 'JetBrains Mono', monospace",
  fontSize: 10,
  letterSpacing: 1.5,
  textTransform: 'uppercase',
  padding: '7px 12px',
  borderRadius: 2,
  cursor: 'pointer',
  transition: 'all 0.15s ease',
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SceneOverlayProps {
  sessionCount: number;
}

// ---------------------------------------------------------------------------
// Room Management Panel (collapsed by default)
// ---------------------------------------------------------------------------

function RoomPanel() {
  const rooms = useRoomStore((s) => s.rooms);
  const createRoom = useRoomStore((s) => s.createRoom);
  const renameRoom = useRoomStore((s) => s.renameRoom);
  const deleteRoom = useRoomStore((s) => s.deleteRoom);
  const removeSession = useRoomStore((s) => s.removeSession);
  const sessions = useSessionStore((s) => s.sessions);
  const flyTo = useCameraStore((s) => s.flyTo);

  const [expanded, setExpanded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const handleCreateRoom = useCallback(() => {
    const roomNum = rooms.length + 1;
    createRoom(`Room ${roomNum}`);
  }, [rooms.length, createRoom]);

  const startRename = useCallback((room: Room) => {
    setEditingId(room.id);
    setEditName(room.name);
  }, []);

  const commitRename = useCallback(() => {
    if (editingId && editName.trim()) {
      renameRoom(editingId, editName.trim());
    }
    setEditingId(null);
    setEditName('');
  }, [editingId, editName, renameRoom]);

  const handleRemoveSession = useCallback((roomId: string, sessionId: string) => {
    removeSession(roomId, sessionId);
  }, [removeSession]);

  const handleFocusRoom = useCallback((roomIndex: number) => {
    const cam = computeRoomCameraTarget(roomIndex);
    flyTo(cam.position, cam.lookAt);
  }, [flyTo]);

  const handleResetView = useCallback(() => {
    flyTo(DEFAULT_CAMERA_POSITION, DEFAULT_CAMERA_TARGET);
  }, [flyTo]);

  // Sort rooms by roomIndex for consistent display
  const sortedRooms = useMemo(
    () => [...rooms].sort((a, b) => (a.roomIndex ?? 999) - (b.roomIndex ?? 999)),
    [rooms],
  );

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid rgba(0,240,255,0.1)', paddingTop: 8 }}>
      {/* Toggle header */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          ...BTN_FONT,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          padding: '4px 0',
          border: 'none',
          background: 'none',
          color: 'rgba(0,240,255,0.5)',
          fontSize: 9,
          letterSpacing: 2,
        }}
      >
        <span>Rooms ({rooms.length})</span>
        <span style={{ fontSize: 10 }}>{expanded ? '\u25B4' : '\u25BE'}</span>
      </button>

      {expanded && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Overview (reset camera) button */}
          <button
            onClick={handleResetView}
            style={{
              ...BTN_FONT,
              width: '100%',
              border: '1px solid rgba(0,240,255,0.28)',
              background: 'rgba(0,240,255,0.06)',
              color: '#00f0ff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(0,240,255,0.16)';
              e.currentTarget.style.borderColor = 'rgba(0,240,255,0.5)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(0,240,255,0.06)';
              e.currentTarget.style.borderColor = 'rgba(0,240,255,0.28)';
            }}
          >
            Overview
          </button>

          {/* Existing rooms */}
          {sortedRooms.map((room) => (
            <div
              key={room.id}
              style={{
                padding: '6px 8px',
                borderRadius: 3,
                border: '1px solid rgba(0,240,255,0.2)',
                background: 'rgba(0,240,255,0.04)',
              }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 4,
              }}>
                {editingId === room.id ? (
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); }}
                    autoFocus
                    style={{
                      flex: 1,
                      background: 'rgba(0,0,0,0.3)',
                      border: '1px solid rgba(0,240,255,0.3)',
                      color: '#fff',
                      fontSize: 10,
                      fontFamily: "'JetBrains Mono', monospace",
                      padding: '2px 4px',
                      borderRadius: 2,
                      outline: 'none',
                    }}
                  />
                ) : (
                  <span style={{
                    fontSize: 10,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: '#ddd',
                    flex: 1,
                  }}>
                    {room.name}
                  </span>
                )}

                {editingId !== room.id && (
                  <div style={{ display: 'flex', gap: 2 }}>
                    {room.roomIndex != null && (
                      <button
                        onClick={() => handleFocusRoom(room.roomIndex!)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'rgba(0,240,255,0.5)',
                          cursor: 'pointer',
                          fontSize: 11,
                          padding: '0 2px',
                          lineHeight: 1,
                        }}
                        title="Zoom to room"
                      >
                        &#9673;
                      </button>
                    )}
                    <button
                      onClick={() => startRename(room)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'rgba(0,240,255,0.4)',
                        cursor: 'pointer',
                        fontSize: 10,
                        padding: '0 2px',
                      }}
                      title="Rename"
                    >
                      &#9998;
                    </button>
                    <button
                      onClick={() => deleteRoom(room.id)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'rgba(255,68,68,0.5)',
                        cursor: 'pointer',
                        fontSize: 10,
                        padding: '0 2px',
                      }}
                      title="Delete room"
                    >
                      &times;
                    </button>
                  </div>
                )}
              </div>

              {/* Sessions in this room */}
              {room.sessionIds.length > 0 && (
                <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {room.sessionIds.map((sid) => {
                    const s = sessions.get(sid);
                    if (!s) return null;
                    return (
                      <div
                        key={sid}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          fontSize: 9,
                          fontFamily: "'JetBrains Mono', monospace",
                          color: 'rgba(255,255,255,0.5)',
                          padding: '1px 4px',
                        }}
                      >
                        <span style={{
                          width: 5,
                          height: 5,
                          borderRadius: '50%',
                          background: STATUS_COLORS[s.status] ?? '#888',
                          flexShrink: 0,
                        }} />
                        <span style={{
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {s.projectName || 'Unnamed'}
                        </span>
                        <button
                          onClick={() => handleRemoveSession(room.id, sid)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'rgba(255,68,68,0.4)',
                            cursor: 'pointer',
                            fontSize: 9,
                            padding: 0,
                            lineHeight: 1,
                          }}
                          title="Remove from room"
                        >
                          &times;
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}

          {/* No rooms message */}
          {rooms.length === 0 && (
            <div style={{
              fontSize: 9,
              color: 'rgba(255,255,255,0.2)',
              textAlign: 'center',
              padding: '6px 0',
              fontFamily: "'Share Tech Mono', monospace",
            }}>
              No rooms yet
            </div>
          )}

          {/* Create New Room button */}
          <button
            onClick={handleCreateRoom}
            style={{
              ...BTN_FONT,
              width: '100%',
              border: '1px dashed rgba(0,255,136,0.3)',
              background: 'rgba(0,255,136,0.04)',
              color: '#00ff88',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(0,255,136,0.12)';
              e.currentTarget.style.borderColor = 'rgba(0,255,136,0.5)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(0,255,136,0.04)';
              e.currentTarget.style.borderColor = 'rgba(0,255,136,0.3)';
            }}
          >
            + New Room
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function SceneOverlay({ sessionCount }: SceneOverlayProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const soundEnabled = useSettingsStore((s) => s.soundSettings.enabled);
  const updateSoundSettings = useSettingsStore((s) => s.updateSoundSettings);

  // Status breakdown
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const session of sessions.values()) {
      counts[session.status] = (counts[session.status] || 0) + 1;
    }
    return counts;
  }, [sessions]);

  const toggleMute = () => {
    const newEnabled = !soundEnabled;
    updateSoundSettings({ enabled: newEnabled });
    if (newEnabled) {
      soundEngine.unlock();
    }
  };

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      zIndex: 10,
    }}>
      {/* Status breakdown (top left) */}
      {sessionCount > 0 && (
        <div style={{
          position: 'absolute',
          top: 16,
          left: 20,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          userSelect: 'none',
        }}>
          {Object.entries(statusCounts)
            .filter(([, count]) => count > 0)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([status, count]) => (
              <div
                key={status}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 10,
                  fontFamily: "'Share Tech Mono', 'JetBrains Mono', monospace",
                  color: STATUS_COLORS[status] ?? '#888',
                  letterSpacing: 1,
                }}
              >
                <span style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: STATUS_COLORS[status] ?? '#888',
                  boxShadow: `0 0 4px ${STATUS_COLORS[status] ?? '#888'}`,
                }} />
                {count}
              </div>
            ))}
        </div>
      )}

      {/* Bottom-right panel */}
      <div style={{
        position: 'absolute',
        bottom: 16,
        right: 20,
        background: 'color-mix(in srgb, var(--bg-panel) 85%, transparent)',
        backdropFilter: 'blur(20px)',
        border: '1px solid var(--border-accent)',
        borderRadius: 4,
        padding: '14px 18px',
        pointerEvents: 'all',
        minWidth: 200,
        maxWidth: 260,
        maxHeight: 'calc(100vh - 80px)',
        overflowY: 'auto',
        boxShadow: '0 0 12px var(--glow-accent), inset 0 0 24px var(--glow-accent)',
      }}>
        <div style={{
          fontSize: 9,
          letterSpacing: 2,
          color: 'rgba(0,240,255,0.4)',
          textTransform: 'uppercase',
          fontFamily: "'Share Tech Mono', 'JetBrains Mono', monospace",
        }}>
          Units Online
        </div>
        <div style={{
          fontFamily: "'Orbitron', 'JetBrains Mono', sans-serif",
          fontSize: 28,
          fontWeight: 700,
          color: '#fff',
          margin: '2px 0 10px',
          lineHeight: 1,
        }}>
          {sessionCount}
        </div>

        {/* Mute Toggle */}
        <button
          onClick={toggleMute}
          style={{
            ...BTN_FONT,
            width: '100%',
            border: `1px solid ${soundEnabled ? 'rgba(0,240,255,0.28)' : 'rgba(255,68,68,0.4)'}`,
            background: soundEnabled ? 'rgba(0,240,255,0.08)' : 'rgba(255,68,68,0.12)',
            color: soundEnabled ? '#00f0ff' : '#ff4444',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = soundEnabled
              ? 'rgba(0,240,255,0.16)'
              : 'rgba(255,68,68,0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = soundEnabled
              ? 'rgba(0,240,255,0.08)'
              : 'rgba(255,68,68,0.12)';
          }}
        >
          {soundEnabled ? 'Sound On' : 'Muted'}
        </button>

        {/* Room management panel */}
        <RoomPanel />

        <div style={{
          fontSize: 8,
          color: 'rgba(255,255,255,0.16)',
          marginTop: 10,
          lineHeight: 1.6,
          textAlign: 'center',
          fontFamily: "'Share Tech Mono', 'JetBrains Mono', monospace",
        }}>
          Drag to orbit &middot; Scroll to zoom
        </div>
      </div>
    </div>
  );
}
