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
          {sortedRooms.map((room) => {
            const activeCount = room.sessionIds.filter(id => {
              const s = sessions.get(id);
              return s && s.status !== 'ended';
            }).length;

            return (
              <div
                key={room.id}
                onClick={() => {
                  if (editingId !== room.id && room.roomIndex != null) {
                    handleFocusRoom(room.roomIndex);
                  }
                }}
                style={{
                  padding: '6px 8px',
                  borderRadius: 3,
                  border: '1px solid rgba(0,240,255,0.2)',
                  background: 'rgba(0,240,255,0.04)',
                  cursor: editingId === room.id ? 'default' : 'pointer',
                }}
                onMouseEnter={(e) => {
                  if (editingId !== room.id) {
                    e.currentTarget.style.background = 'rgba(0,240,255,0.1)';
                    e.currentTarget.style.borderColor = 'rgba(0,240,255,0.4)';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(0,240,255,0.04)';
                  e.currentTarget.style.borderColor = 'rgba(0,240,255,0.2)';
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
                      onClick={(e) => e.stopPropagation()}
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
                      <button
                        onClick={(e) => { e.stopPropagation(); startRename(room); }}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'rgba(0,240,255,0.4)',
                          cursor: 'pointer',
                          fontSize: 10,
                          minWidth: 44,
                          minHeight: 44,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                        title="Rename"
                      >
                        &#9998;
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteRoom(room.id); }}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'rgba(255,68,68,0.5)',
                          cursor: 'pointer',
                          fontSize: 10,
                          minWidth: 44,
                          minHeight: 44,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                        title="Delete room"
                      >
                        &times;
                      </button>
                    </div>
                  )}
                </div>

                {/* Session count badge */}
                {activeCount > 0 && (
                  <div style={{
                    marginTop: 4,
                    fontSize: 9,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: 'rgba(255,255,255,0.35)',
                    padding: '1px 4px',
                  }}>
                    {activeCount} session{activeCount !== 1 ? 's' : ''}
                  </div>
                )}
              </div>
            );
          })}

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
  const soundEnabled = useSettingsStore((s) => s.soundSettings.enabled);
  const updateSoundSettings = useSettingsStore((s) => s.updateSoundSettings);
  const scene3dEnabled = useSettingsStore((s) => s.scene3dEnabled);
  const setScene3dEnabled = useSettingsStore((s) => s.setScene3dEnabled);

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

        {/* 3D Scene Toggle */}
        <button
          onClick={() => setScene3dEnabled(!scene3dEnabled)}
          title={scene3dEnabled ? 'Disable 3D scene to save CPU/GPU' : 'Enable 3D scene'}
          style={{
            ...BTN_FONT,
            width: '100%',
            marginTop: 6,
            border: `1px solid ${scene3dEnabled ? 'rgba(0,240,255,0.28)' : 'rgba(255,145,0,0.4)'}`,
            background: scene3dEnabled ? 'rgba(0,240,255,0.08)' : 'rgba(255,145,0,0.12)',
            color: scene3dEnabled ? '#00f0ff' : '#ff9100',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = scene3dEnabled
              ? 'rgba(0,240,255,0.16)'
              : 'rgba(255,145,0,0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = scene3dEnabled
              ? 'rgba(0,240,255,0.08)'
              : 'rgba(255,145,0,0.12)';
          }}
        >
          {scene3dEnabled ? '3D On' : '3D Off'}
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
