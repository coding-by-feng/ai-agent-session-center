/**
 * RoomSheets — rooms on a phone (AASC-20, features 10 and 11). The desktop
 * moves a session by dragging it between room frames or with the control
 * bar's room select, and manages rooms in the 3D scene's HUD; a phone has
 * neither, so both are sheets, opened from a session's ⋯ sheet (the drawer
 * row's, and the session header's):
 *
 *  - MoveToRoomSheet: "No room", every room (colour, name, size, the current
 *    one ticked), and a new room made and moved into in one step.
 *  - ManageRoomsSheet: create, rename, colour and delete rooms.
 *
 * Rooms live in roomStore (this device's localStorage). Only its actions are
 * used, and never `setRoomIndex`: `roomIndex` is a 3D world slot, and a colour
 * is `Room.color`, not a slot change. A remote phone's rooms are seeded from
 * the Mac's workspace each time the app opens, so its changes stay on the
 * phone until then; the sheet says so.
 */
import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import BottomSheet, { ConfirmSheet } from '@/components/ui/BottomSheet';
import Button from '@/components/ui/Button';
import TextInput from '@/components/ui/TextInput';
import { showToast } from '@/components/ui/ToastContainer';
import { ROOM_COLOR_PALETTE, roomColor } from '@/lib/roomColor';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useIsHostDevice } from './views/hostAccess';
import styles from '@/styles/modules/PhoneRooms.module.css';

const ROOM_NAME_MAX = 40;

/** Names for the palette's colours, in its order: a swatch is a button and needs words. */
const COLOR_NAMES: readonly string[] = ['Orange', 'Blue', 'Green', 'Purple', 'Yellow', 'Pink', 'Cyan', 'Coral'];

/** The rooms in the drawer's order: `listOrder`, then the 3D slot. */
function roomsInListOrder(rooms: readonly Room[]): Room[] {
  const rank = (r: Room) => r.listOrder ?? r.roomIndex ?? Number.MAX_SAFE_INTEGER;
  return [...rooms].sort((a, b) => rank(a) - rank(b));
}

const sessionCount = (n: number) => `${n} session${n === 1 ? '' : 's'}`;

function Swatch({ color }: { color: string }) {
  return <span className={styles.swatch} style={{ '--swatch': color } as CSSProperties} aria-hidden="true" />;
}

/** The phone-only note: a remote phone's room changes are its own. */
function LocalRoomsNote() {
  const isHost = useIsHostDevice();
  if (isHost) return null;
  return (
    <p className={styles.note}>
      Rooms you change here stay on this phone. Your Mac&rsquo;s rooms replace them the next time the app opens.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Move to room…
// ---------------------------------------------------------------------------

interface MoveToRoomSheetProps {
  /** The session to move; null = closed. */
  sessionId: string | null;
  onClose: () => void;
  /** Opens the rooms manager (offered at the bottom). */
  onManage?: () => void;
}

export function MoveToRoomSheet({ sessionId, onClose, onManage }: MoveToRoomSheetProps) {
  const session = useSessionStore((s) => (sessionId ? s.sessions.get(sessionId) : undefined));
  const rooms = useRoomStore((s) => s.rooms);
  const ordered = useMemo(() => roomsInListOrder(rooms), [rooms]);
  const [name, setName] = useState('');
  const open = !!sessionId && !!session;
  const current = sessionId ? rooms.find((r) => r.sessionIds.includes(sessionId)) : undefined;

  const moveTo = useCallback((roomId: string | null, label?: string) => {
    if (!sessionId) return;
    const store = useRoomStore.getState();
    for (const r of store.rooms) {
      if (r.id !== roomId && r.sessionIds.includes(sessionId)) store.removeSession(r.id, sessionId);
    }
    if (roomId) store.addSession(roomId, sessionId);
    showToast(roomId ? `Moved to ${label}` : 'Removed from its room', 'info');
    onClose();
  }, [sessionId, onClose]);

  const createAndMove = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = useRoomStore.getState().createRoom(trimmed);
    setName('');
    moveTo(id, trimmed);
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="Move to room">
      {session && (
        <div className={styles.sheet} data-testid="move-to-room">
          <p className={styles.lead}>{sessionDisplayTitle(session)}</p>
          <ul className={styles.options} role="list">
            <li>
              <button
                type="button"
                className={styles.option}
                aria-pressed={!current}
                onClick={() => (current ? moveTo(null) : onClose())}
              >
                <span className={styles.swatchNone} aria-hidden="true" />
                <span className={styles.optionName}>No room</span>
                {!current && <span className={styles.optionState}>Current</span>}
              </button>
            </li>
            {ordered.map((room) => {
              const here = room.id === current?.id;
              return (
                <li key={room.id}>
                  <button
                    type="button"
                    className={styles.option}
                    aria-pressed={here}
                    onClick={() => (here ? onClose() : moveTo(room.id, room.name))}
                  >
                    <Swatch color={roomColor(room)} />
                    <span className={styles.optionName}>{room.name}</span>
                    <span className={styles.optionState}>{here ? 'Current' : sessionCount(room.sessionIds.length)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <form
            className={styles.inlineForm}
            onSubmit={(e) => {
              e.preventDefault();
              createAndMove();
            }}
          >
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New room"
              aria-label="New room name"
              maxLength={ROOM_NAME_MAX}
              className={styles.grow}
            />
            <Button type="submit" disabled={!name.trim()}>Create and move</Button>
          </form>
          {onManage && (
            <Button variant="quiet" className={styles.alignStart} onClick={onManage}>Manage rooms…</Button>
          )}
          <LocalRoomsNote />
        </div>
      )}
    </BottomSheet>
  );
}

// ---------------------------------------------------------------------------
// Manage rooms
// ---------------------------------------------------------------------------

export function ManageRoomsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rooms = useRoomStore((s) => s.rooms);
  const ordered = useMemo(() => roomsInListOrder(rooms), [rooms]);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<Room | null>(null);
  const cancelDelete = useCallback(() => setDeleting(null), []);

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    useRoomStore.getState().createRoom(trimmed);
    setName('');
    showToast(`Room "${trimmed}" created`, 'info');
  };

  const confirmDelete = () => {
    if (!deleting) return;
    useRoomStore.getState().deleteRoom(deleting.id);
    showToast(`Room "${deleting.name}" deleted`, 'info');
    setDeleting(null);
  };

  return (
    <>
      <BottomSheet open={open} onClose={onClose} title="Rooms" fullHeight>
        <div className={styles.sheet} data-testid="manage-rooms">
          <form
            className={styles.inlineForm}
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New room name"
              aria-label="New room name"
              maxLength={ROOM_NAME_MAX}
              className={styles.grow}
            />
            <Button type="submit" variant="primary" disabled={!name.trim()}>Create</Button>
          </form>
          {ordered.length === 0 ? (
            <p className={styles.note}>No rooms yet. A room groups sessions in the session list.</p>
          ) : (
            <ul className={styles.rooms} role="list">
              {ordered.map((room) => (
                <RoomCard key={room.id} room={room} onDelete={setDeleting} />
              ))}
            </ul>
          )}
          <LocalRoomsNote />
        </div>
      </BottomSheet>
      <ConfirmSheet
        open={deleting !== null}
        title={deleting ? `Delete room "${deleting.name}"?` : 'Delete room?'}
        message={deleting && deleting.sessionIds.length > 0
          ? `Its ${sessionCount(deleting.sessionIds.length)} stay open; they just leave the room.`
          : 'The room is empty.'}
        confirmLabel="Delete room"
        danger
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
    </>
  );
}

type CardMode = 'view' | 'rename' | 'color';

function RoomCard({ room, onDelete }: { room: Room; onDelete: (room: Room) => void }) {
  const [mode, setMode] = useState<CardMode>('view');
  const [draft, setDraft] = useState(room.name);
  const color = roomColor(room);

  const rename = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== room.name) useRoomStore.getState().renameRoom(room.id, trimmed);
    setMode('view');
  };

  const pick = (value: string | undefined) => {
    useRoomStore.getState().setRoomColor(room.id, value);
    setMode('view');
  };

  return (
    <li className={styles.room} style={{ '--room-color': color } as CSSProperties}>
      <div className={styles.roomHead}>
        <Swatch color={color} />
        <span className={styles.roomName}>{room.name}</span>
        <span className={styles.roomCount}>{sessionCount(room.sessionIds.length)}</span>
      </div>

      {mode === 'rename' ? (
        <form
          className={styles.inlineForm}
          onSubmit={(e) => {
            e.preventDefault();
            rename();
          }}
        >
          <TextInput
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`New name for ${room.name}`}
            maxLength={ROOM_NAME_MAX}
            className={styles.grow}
            autoFocus
          />
          <Button variant="quiet" onClick={() => { setDraft(room.name); setMode('view'); }}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!draft.trim()}>Save</Button>
        </form>
      ) : (
        <div className={styles.roomActions}>
          <Button onClick={() => { setDraft(room.name); setMode('rename'); }} aria-label={`Rename ${room.name}`}>Rename</Button>
          <Button
            aria-expanded={mode === 'color'}
            aria-label={`Colour of ${room.name}`}
            onClick={() => setMode(mode === 'color' ? 'view' : 'color')}
          >
            Colour
          </Button>
          <Button variant="danger" onClick={() => onDelete(room)} aria-label={`Delete ${room.name}`}>Delete</Button>
        </div>
      )}

      {mode === 'color' && (
        <div className={styles.palette} role="group" aria-label={`Colour of ${room.name}`}>
          {ROOM_COLOR_PALETTE.map((value, i) => (
            <button
              key={value}
              type="button"
              className={styles.paletteSwatch}
              style={{ '--swatch': value } as CSSProperties}
              aria-pressed={room.color === value}
              aria-label={COLOR_NAMES[i] ?? `Colour ${i + 1}`}
              onClick={() => pick(value)}
            />
          ))}
          <Button
            className={styles.paletteDefault}
            pressed={!room.color}
            onClick={() => pick(undefined)}
          >
            Default
          </Button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** The glyph for "rooms": a floor plan. 20px, decorative. */
export function RoomIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="12" x2="12" y2="12" />
      <line x1="12" y1="3" x2="12" y2="21" />
    </svg>
  );
}

/**
 * A session's room in its actions sheet (the drawer row's ⋯): where it is, and
 * the way to move it or to manage the rooms. The sheets open over the actions
 * sheet, which shows the new room when they close.
 */
export function RoomSection({ sessionId }: { sessionId: string }) {
  const room = useRoomStore((s) => s.rooms.find((r) => r.sessionIds.includes(sessionId)));
  const [sheet, setSheet] = useState<'move' | 'manage' | null>(null);
  const close = useCallback(() => setSheet(null), []);
  const manage = useCallback(() => setSheet('manage'), []);
  return (
    <section className={styles.section} aria-label="Room">
      <h3 className={styles.sectionHeading}>Room</h3>
      <p className={styles.current}>
        {room ? <><Swatch color={roomColor(room)} /> {room.name}</> : <><span className={styles.swatchNone} aria-hidden="true" /> No room</>}
      </p>
      <div className={styles.sectionButtons}>
        <Button onClick={() => setSheet('move')} aria-haspopup="dialog">Move to room…</Button>
        <Button onClick={manage} aria-haspopup="dialog">Manage rooms…</Button>
      </div>
      <MoveToRoomSheet sessionId={sheet === 'move' ? sessionId : null} onClose={close} onManage={manage} />
      <ManageRoomsSheet open={sheet === 'manage'} onClose={close} />
    </section>
  );
}

