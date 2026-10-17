/**
 * SceneOverlay — 2D HUD overlay on top of the 3D Cyberdrome scene (and the 3D-off
 * LIVE board): session count, sound and 3D toggles, and room management.
 *
 * All styling is in SceneOverlay.module.css (AASC-11): it used inline styles, so
 * hover was painted from JS and there was no keyboard focus or pressed state.
 */
import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useCameraStore, DEFAULT_CAMERA_POSITION, DEFAULT_CAMERA_TARGET } from '@/stores/cameraStore';
import { computeRoomCameraTarget } from '@/lib/roomGrid';
import { soundEngine } from '@/lib/soundEngine';
import styles from '@/styles/modules/SceneOverlay.module.css';

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
    <div className={styles.rooms}>
      <button
        type="button"
        className={styles.roomsToggle}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span>Rooms ({rooms.length})</span>
        <span aria-hidden="true">{expanded ? '\u25B4' : '\u25BE'}</span>
      </button>

      {expanded && (
        <div className={styles.roomList}>
          {/* Overview (reset camera) button */}
          <button type="button" className={styles.hudButton} onClick={handleResetView}>
            Overview
          </button>

          {sortedRooms.map((room) => {
            const activeCount = room.sessionIds.filter((id) => {
              const s = sessions.get(id);
              return s && s.status !== 'ended';
            }).length;
            const editing = editingId === room.id;

            return (
              <div key={room.id} className={styles.room}>
                {editing ? (
                  <input
                    className={styles.roomInput}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); }}
                    aria-label={`Room name for ${room.name}`}
                    autoFocus
                  />
                ) : (
                  // A real button (it was a clickable div): the camera move is
                  // reachable from the keyboard now.
                  <button
                    type="button"
                    className={styles.roomName}
                    aria-label={`Show room ${room.name}`}
                    onClick={() => { if (room.roomIndex != null) handleFocusRoom(room.roomIndex); }}
                  >
                    <span className={styles.roomLabel}>{room.name}</span>
                    {activeCount > 0 && (
                      <span className={styles.roomCount}>
                        {activeCount} session{activeCount !== 1 ? 's' : ''}
                      </span>
                    )}
                  </button>
                )}

                {!editing && (
                  <span className={styles.roomActions}>
                    <button
                      type="button"
                      className={styles.roomIcon}
                      onClick={() => startRename(room)}
                      title="Rename"
                      aria-label={`Rename room ${room.name}`}
                    >
                      &#9998;
                    </button>
                    <button
                      type="button"
                      className={`${styles.roomIcon} ${styles.roomIconDanger}`}
                      onClick={() => deleteRoom(room.id)}
                      title="Delete room"
                      aria-label={`Delete room ${room.name}`}
                    >
                      &times;
                    </button>
                  </span>
                )}
              </div>
            );
          })}

          {rooms.length === 0 && <div className={styles.empty}>No rooms yet</div>}

          <button type="button" className={`${styles.hudButton} ${styles.hudButtonNew}`} onClick={handleCreateRoom}>
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

  // The board below keeps clear of this panel with a bottom gutter
  // (--hud-clear-bottom on LiveView's .flatRoot, 232px by default). With the rooms
  // list open the panel grows up to 100vh - 80px, past that default, and covered
  // the last row's right card even at the scroll end (AASC-11 review). So the panel
  // publishes its real footprint — height + 16px from the edge + a 16px gap — on
  // its parent while it is mounted.
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = overlayRef.current?.parentElement;
    const panel = panelRef.current;
    if (!host || !panel || typeof ResizeObserver === 'undefined') return;
    const publish = () => {
      host.style.setProperty('--hud-clear-bottom', `${Math.ceil(panel.getBoundingClientRect().height) + 32}px`);
    };
    const ro = new ResizeObserver(publish);
    ro.observe(panel);
    publish();
    return () => {
      ro.disconnect();
      host.style.removeProperty('--hud-clear-bottom');
    };
  }, []);

  const toggleMute = () => {
    const newEnabled = !soundEnabled;
    updateSoundSettings({ enabled: newEnabled });
    if (newEnabled) {
      soundEngine.unlock();
    }
  };

  return (
    <div className={styles.overlay} ref={overlayRef}>
      {/* Bottom-right panel */}
      <div className={styles.panel} ref={panelRef}>
        <div className={styles.caption}>Units Online</div>
        <div className={styles.count}>{sessionCount}</div>

        {/* Sound and 3D are toggles: the label says the state, aria-pressed says it to a screen reader. */}
        <button
          type="button"
          className={`${styles.hudButton} ${soundEnabled ? '' : styles.hudButtonOffDanger}`}
          onClick={toggleMute}
          // A fixed name with aria-pressed: the visible label changes with the state,
          // and "Muted, not pressed" would contradict itself.
          aria-label="Sound"
          aria-pressed={soundEnabled}
        >
          {soundEnabled ? 'Sound On' : 'Muted'}
        </button>

        <button
          type="button"
          className={`${styles.hudButton} ${scene3dEnabled ? '' : styles.hudButtonOffWarning}`}
          onClick={() => setScene3dEnabled(!scene3dEnabled)}
          title={scene3dEnabled ? 'Disable 3D scene to save CPU/GPU' : 'Enable 3D scene'}
          aria-label="3D scene"
          aria-pressed={scene3dEnabled}
        >
          {scene3dEnabled ? '3D On' : '3D Off'}
        </button>

        <RoomPanel />
      </div>
    </div>
  );
}
