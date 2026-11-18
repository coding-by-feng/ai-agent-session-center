/**
 * RoomManagerModal — create, rename and delete rooms from anywhere (Nov 17 2026).
 *
 * Before this the desktop could only do these in the LIVE page's bottom-right panel (SceneOverlay), which
 * meant minimizing the open session first. Opened from the ＋ New menu ("Manage rooms…"). Deleting a room
 * never ends a session: its sessions just leave the room, and the row says so before the second press.
 */
import { useMemo, useState } from 'react';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { deleteRoomMessage } from '@/lib/roomDeleteMessage';
import { ROOM_MANAGER_MODAL_ID } from '@/lib/quickCreate';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import styles from '@/styles/modules/RoomManager.module.css';

const ROOM_NAME_MAX = 60;

/** Rooms in the order the lists show them (`listOrder`, then creation order). */
function inListOrder(rooms: readonly Room[]): Room[] {
  return rooms
    .map((room, index) => ({ room, index }))
    .sort((a, b) => (a.room.listOrder ?? Infinity) - (b.room.listOrder ?? Infinity) || a.index - b.index)
    .map((entry) => entry.room);
}

export default function RoomManagerModal() {
  const rooms = useRoomStore((s) => s.rooms);
  const sessions = useSessionStore((s) => s.sessions);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const ordered = useMemo(() => inListOrder(rooms), [rooms]);
  const liveCount = (room: Room) => room.sessionIds.filter((id) => {
    const s = sessions.get(id);
    return s && s.status !== 'ended';
  }).length;

  const create = () => {
    const name = newName.trim().slice(0, ROOM_NAME_MAX);
    if (!name) return;
    useRoomStore.getState().createRoom(name);
    setNewName('');
  };

  const commitRename = () => {
    if (!editing) return;
    const name = editing.name.trim().slice(0, ROOM_NAME_MAX);
    if (name) useRoomStore.getState().renameRoom(editing.id, name);
    setEditing(null);
  };

  return (
    <Modal modalId={ROOM_MANAGER_MODAL_ID} title="Rooms" panelClassName={styles.panel}>
      <div className={styles.body}>
        <form className={styles.create} onSubmit={(e) => { e.preventDefault(); create(); }}>
          <input
            className={styles.input}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={ROOM_NAME_MAX}
            placeholder="New room name"
            aria-label="New room name"
          />
          <Button variant="primary" size="sm" type="submit" disabled={!newName.trim()}>Add room</Button>
        </form>

        {ordered.length === 0 ? (
          <p className={styles.empty}>No rooms yet.</p>
        ) : (
          <ul className={styles.list}>
            {ordered.map((room) => {
              const count = liveCount(room);
              if (deleting === room.id) {
                return (
                  <li key={room.id} className={styles.row}>
                    <span className={styles.confirm}>Delete “{room.name}”? {deleteRoomMessage(count)}</span>
                    <span className={styles.actions}>
                      <Button variant="danger" size="sm" onClick={() => { useRoomStore.getState().deleteRoom(room.id); setDeleting(null); }}>
                        Delete
                      </Button>
                      <Button size="sm" onClick={() => setDeleting(null)}>Keep</Button>
                    </span>
                  </li>
                );
              }
              if (editing?.id === room.id) {
                return (
                  <li key={room.id} className={styles.row}>
                    <form className={styles.rename} onSubmit={(e) => { e.preventDefault(); commitRename(); }}>
                      <input
                        className={styles.input}
                        value={editing.name}
                        onChange={(e) => setEditing({ id: room.id, name: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }}
                        maxLength={ROOM_NAME_MAX}
                        aria-label={`Room name for ${room.name}`}
                        autoFocus
                      />
                      <Button variant="primary" size="sm" type="submit" disabled={!editing.name.trim()}>Save</Button>
                      <Button size="sm" onClick={() => setEditing(null)}>Cancel</Button>
                    </form>
                  </li>
                );
              }
              return (
                <li key={room.id} className={styles.row}>
                  <span className={styles.name}>{room.name}</span>
                  <span className={styles.count}>{count} session{count === 1 ? '' : 's'}</span>
                  <span className={styles.actions}>
                    <Button size="sm" aria-label={`Rename room ${room.name}`} onClick={() => { setDeleting(null); setEditing({ id: room.id, name: room.name }); }}>
                      Rename
                    </Button>
                    <Button size="sm" aria-label={`Delete room ${room.name}`} onClick={() => { setEditing(null); setDeleting(room.id); }}>
                      Delete
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
