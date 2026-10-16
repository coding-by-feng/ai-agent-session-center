/**
 * RoomSheets — rooms on a phone (AASC-20, features 10 and 11). The desktop
 * moves a session by dragging it between room frames or with the control
 * bar's room select, and manages rooms in the 3D scene's HUD; a phone has
 * neither, so both are sheets, opened from a session's Info → Room and from a
 * room's group menu on Sessions (AASC-40/46, AASC-55):
 *
 *  - MoveToRoomSheet: "No room", every room (colour, name, size, the current
 *    one ticked), and a new room made and moved into in one step.
 *  - ManageRoomsSheet: create, rename, colour and delete rooms.
 *  - RoomEditSheet / DeleteRoomConfirm: one room's rename, colour or delete,
 *    straight from its group's menu on Sessions (AASC-55).
 *
 * The Mac owns the rooms (lib/roomSync.ts). On the device that owns them — the
 * Mac's window at a phone's size, the workspace writer — the sheets use the
 * room store's actions, and never `setRoomIndex`: `roomIndex` is a 3D world
 * slot, and a colour is `Room.color`, not a slot change. On any other device (a
 * remote phone) they ask the Mac instead (lib/roomOps.ts) and leave the local
 * list alone: the Mac applies the change and its `rooms_update` brings it back.
 * The sheet says so.
 */
import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import BottomSheet, { ConfirmSheet } from '@/components/ui/BottomSheet';
import Button from '@/components/ui/Button';
import TextInput from '@/components/ui/TextInput';
import { showToast } from '@/components/ui/ToastContainer';
import { ROOM_COLOR_PALETTE, roomColor } from '@/lib/roomColor';
import { moveSessionToRoom, sendRoomOp } from '@/lib/roomOps';
import { roomsInListOrder } from '@/lib/roomOrder';
import { useIsRoomWriter } from '@/lib/roomSync';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import type { RoomOp } from '@/types';
import styles from '@/styles/modules/PhoneRooms.module.css';

const ROOM_NAME_MAX = 40;

/** Names for the palette's colours, in its order: a swatch is a button and needs words. */
const COLOR_NAMES: readonly string[] = ['Orange', 'Blue', 'Green', 'Purple', 'Yellow', 'Pink', 'Cyan', 'Coral'];


const sessionCount = (n: number) => `${n} session${n === 1 ? '' : 's'}`;

function Swatch({ color }: { color: string }) {
  return <span className={styles.swatch} style={{ '--swatch': color } as CSSProperties} aria-hidden="true" />;
}

/** Where the rooms live, on every device but the one that owns them. */
function RoomsFromMacNote() {
  const isWriter = useIsRoomWriter();
  if (isWriter) return null;
  return (
    <p className={styles.note}>
      Rooms come from your Mac, and changes you make here are saved there.
    </p>
  );
}

/**
 * Ask the Mac for a room change (a device that doesn't own the rooms). Toasts
 * the change as under way, or why it was refused. True when the Mac has it.
 */
async function askTheMac(op: RoomOp, underWay: string): Promise<boolean> {
  const outcome = await sendRoomOp(op);
  if (outcome.ok) showToast(underWay, 'info');
  else showToast(outcome.message, 'error');
  return outcome.ok;
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
  const isWriter = useIsRoomWriter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const open = !!sessionId && !!session;
  const current = sessionId ? rooms.find((r) => r.sessionIds.includes(sessionId)) : undefined;

  const moveTo = useCallback(async (roomId: string | null, label?: string) => {
    if (!sessionId) return;
    if (isWriter) {
      moveSessionToRoom(sessionId, roomId);
      showToast(roomId ? `Moved to ${label}` : 'Removed from its room', 'info');
      onClose();
      return;
    }
    setBusy(true);
    const sent = await askTheMac({ type: 'move', sessionId, roomId }, roomId ? `Moving to ${label}…` : 'Taking it out of its room…');
    setBusy(false);
    if (sent) onClose();
  }, [sessionId, onClose, isWriter]);

  const createAndMove = async () => {
    const trimmed = name.trim();
    if (!trimmed || !sessionId) return;
    if (isWriter) {
      const id = useRoomStore.getState().createRoom(trimmed);
      setName('');
      void moveTo(id, trimmed);
      return;
    }
    setBusy(true);
    const sent = await askTheMac({ type: 'create', name: trimmed, sessionId }, `Making "${trimmed}" and moving into it…`);
    setBusy(false);
    if (!sent) return;
    setName('');
    onClose();
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
                disabled={busy}
                onClick={() => (current ? void moveTo(null) : onClose())}
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
                    disabled={busy}
                    onClick={() => (here ? onClose() : void moveTo(room.id, room.name))}
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
              void createAndMove();
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
            <Button type="submit" disabled={!name.trim() || busy}>Create and move</Button>
          </form>
          {onManage && (
            <Button variant="quiet" className={styles.alignStart} onClick={onManage}>Manage rooms…</Button>
          )}
          <RoomsFromMacNote />
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
  const isWriter = useIsRoomWriter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Room | null>(null);
  const endDelete = useCallback(() => setDeleting(null), []);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (isWriter) {
      useRoomStore.getState().createRoom(trimmed);
      setName('');
      showToast(`Room "${trimmed}" created`, 'info');
      return;
    }
    setBusy(true);
    const sent = await askTheMac({ type: 'create', name: trimmed }, `Making room "${trimmed}"…`);
    setBusy(false);
    if (sent) setName('');
  };

  return (
    <>
      <BottomSheet open={open} onClose={onClose} title="Rooms" fullHeight>
        <div className={styles.sheet} data-testid="manage-rooms">
          <form
            className={styles.inlineForm}
            onSubmit={(e) => {
              e.preventDefault();
              void create();
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
            <Button type="submit" variant="primary" disabled={!name.trim() || busy}>Create</Button>
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
          <RoomsFromMacNote />
        </div>
      </BottomSheet>
      <DeleteRoomConfirm room={deleting} onDone={endDelete} />
    </>
  );
}

/**
 * "Delete room?" for one room (null = closed). Its sessions stay open and just
 * leave it. On the writer the store deletes it; elsewhere the Mac is asked (and
 * refuses a room holding sessions hidden from this device).
 */
export function DeleteRoomConfirm({ room, onDone }: { room: Room | null; onDone: () => void }) {
  const isWriter = useIsRoomWriter();
  const confirm = async () => {
    if (!room) return;
    onDone();
    if (isWriter) {
      useRoomStore.getState().deleteRoom(room.id);
      showToast(`Room "${room.name}" deleted`, 'info');
      return;
    }
    await askTheMac({ type: 'delete', roomId: room.id }, `Deleting room "${room.name}"…`);
  };
  return (
    <ConfirmSheet
      open={room !== null}
      title={room ? `Delete room "${room.name}"?` : 'Delete room?'}
      message={room && room.sessionIds.length > 0
        ? `Its ${sessionCount(room.sessionIds.length)} stay open; they just leave the room.`
        : 'The room is empty.'}
      confirmLabel="Delete room"
      danger
      onConfirm={() => void confirm()}
      onCancel={onDone}
    />
  );
}

type CardMode = 'view' | 'rename' | 'color';

/**
 * One room's sheet, opened straight on Rename or Colour from a room group's
 * menu on Sessions (AASC-55). `roomId` null = closed.
 */
export function RoomEditSheet({ roomId, mode, onClose }: { roomId: string | null; mode: 'rename' | 'color'; onClose: () => void }) {
  const room = useRoomStore((s) => (roomId ? s.rooms.find((r) => r.id === roomId) : undefined));
  const [deleting, setDeleting] = useState<Room | null>(null);
  const endDelete = useCallback(() => setDeleting(null), []);
  return (
    <>
      <BottomSheet open={!!room} onClose={onClose} title={mode === 'rename' ? 'Rename room' : 'Room colour'}>
        {room && (
          <div className={styles.sheet} data-testid="room-edit">
            <ul className={styles.rooms} role="list">
              <RoomCard key={`${room.id}-${mode}`} room={room} onDelete={setDeleting} initialMode={mode} onDone={onClose} />
            </ul>
            <RoomsFromMacNote />
          </div>
        )}
      </BottomSheet>
      <DeleteRoomConfirm room={deleting} onDone={() => { endDelete(); onClose(); }} />
    </>
  );
}

interface RoomCardProps {
  room: Room;
  onDelete: (room: Room) => void;
  initialMode?: CardMode;
  /** Called once a rename or colour is applied (or handed to the Mac). */
  onDone?: () => void;
}

function RoomCard({ room, onDelete, initialMode = 'view', onDone }: RoomCardProps) {
  const isWriter = useIsRoomWriter();
  const [mode, setMode] = useState<CardMode>(initialMode);
  const finish = () => {
    setMode('view');
    onDone?.();
  };
  const [draft, setDraft] = useState(room.name);
  const [busy, setBusy] = useState(false);
  const color = roomColor(room);

  const rename = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === room.name) {
      finish();
      return;
    }
    if (isWriter) {
      useRoomStore.getState().renameRoom(room.id, trimmed);
      finish();
      return;
    }
    setBusy(true);
    const sent = await askTheMac({ type: 'rename', roomId: room.id, name: trimmed }, `Renaming to "${trimmed}"…`);
    setBusy(false);
    if (sent) finish();
  };

  const pick = async (value: string | undefined) => {
    if (isWriter) {
      useRoomStore.getState().setRoomColor(room.id, value);
      finish();
      return;
    }
    setBusy(true);
    const sent = await askTheMac({ type: 'color', roomId: room.id, color: value ?? null }, `Changing the colour of ${room.name}…`);
    setBusy(false);
    if (sent) finish();
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
            void rename();
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
          <Button type="submit" variant="primary" disabled={!draft.trim() || busy}>Save</Button>
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
              disabled={busy}
              onClick={() => void pick(value)}
            />
          ))}
          <Button
            className={styles.paletteDefault}
            pressed={!room.color}
            disabled={busy}
            onClick={() => void pick(undefined)}
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
