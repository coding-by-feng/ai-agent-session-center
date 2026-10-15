/**
 * @module roomOps
 * Room changes as one value (`RoomOp`, AASC-20), applied on the device that owns
 * the rooms and asked for from every other one.
 *
 * The Mac's main window (the workspace writer) owns the room list. On it, a
 * change is a room-store action, as it always was. Anywhere else — a remote
 * phone, a LAN browser, a pop-out — the change goes to the server
 * (`sendRoomOp`), which checks it against what that device may see and hands it
 * to the writer over its socket (`room_op`); the writer applies it here
 * (`applyRoomOp`) and its next push brings the result back to everyone.
 *
 * Only room-store actions are used, and never `setRoomIndex`: `roomIndex` is a
 * 3D world slot, and a colour is `Room.color`.
 */
import { useRoomStore } from '@/stores/roomStore';
import { ROOM_COLOR_PALETTE } from '@/lib/roomColor';
import type { RoomOp } from '@/types';

/** What a phone says when no Mac window is connected to apply a change. */
export const NO_WRITER_MESSAGE = 'Open AASC on your Mac to change rooms.';

/** Take a session out of every other room, then into `roomId` (null: no room). */
export function moveSessionToRoom(sessionId: string, roomId: string | null): void {
  const store = useRoomStore.getState();
  for (const r of store.rooms) {
    if (r.id !== roomId && r.sessionIds.includes(sessionId)) store.removeSession(r.id, sessionId);
  }
  if (roomId) store.addSession(roomId, sessionId);
}

const hasRoom = (roomId: string): boolean => useRoomStore.getState().rooms.some((r) => r.id === roomId);
const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * A room op as the server sent it, or null when it is not one. The server has
 * already validated it; this keeps a malformed message from reaching the store.
 */
export function readRoomOp(value: unknown): RoomOp | null {
  if (!value || typeof value !== 'object') return null;
  const op = value as Record<string, unknown>;
  switch (op.type) {
    case 'create':
      if (!isString(op.name)) return null;
      return op.sessionId === undefined ? { type: 'create', name: op.name }
        : isString(op.sessionId) ? { type: 'create', name: op.name, sessionId: op.sessionId } : null;
    case 'rename':
      return isString(op.roomId) && isString(op.name) ? { type: 'rename', roomId: op.roomId, name: op.name } : null;
    case 'color':
      if (!isString(op.roomId)) return null;
      if (op.color === null) return { type: 'color', roomId: op.roomId, color: null };
      return isString(op.color) && ROOM_COLOR_PALETTE.includes(op.color) ? { type: 'color', roomId: op.roomId, color: op.color } : null;
    case 'delete':
      return isString(op.roomId) ? { type: 'delete', roomId: op.roomId } : null;
    case 'move':
      if (!isString(op.sessionId)) return null;
      return op.roomId === null || isString(op.roomId) ? { type: 'move', sessionId: op.sessionId, roomId: op.roomId } : null;
    default:
      return null;
  }
}

/** Apply one change with the room store. A room this device doesn't have is skipped. */
export function applyRoomOp(op: RoomOp): void {
  const store = useRoomStore.getState();
  switch (op.type) {
    case 'create': {
      const id = store.createRoom(op.name);
      if (op.sessionId) moveSessionToRoom(op.sessionId, id);
      return;
    }
    case 'rename':
      if (hasRoom(op.roomId)) store.renameRoom(op.roomId, op.name);
      return;
    case 'color':
      if (hasRoom(op.roomId)) store.setRoomColor(op.roomId, op.color ?? undefined);
      return;
    case 'delete':
      if (hasRoom(op.roomId)) store.deleteRoom(op.roomId);
      return;
    case 'move':
      if (op.roomId === null || hasRoom(op.roomId)) moveSessionToRoom(op.sessionId, op.roomId);
      return;
  }
}

export type RoomOpOutcome = { ok: true } | { ok: false; message: string };

/** Words for a refused change, from the server's answer. */
function refusal(status: number, error: unknown): string {
  if (error === 'no-writer') return NO_WRITER_MESSAGE;
  if (error === 'room-has-hidden-sessions') {
    return 'This room holds sessions not shared with this device. Delete it on your Mac.';
  }
  if (status === 404) return 'That room or session is no longer here.';
  if (status === 429) return 'Too many room changes. Try again in a moment.';
  return 'Couldn’t change rooms. Try again.';
}

/** Ask the Mac for a room change. Resolves once the server has handed it to the Mac's window. */
export async function sendRoomOp(op: RoomOp): Promise<RoomOpOutcome> {
  try {
    const res = await fetch('/api/rooms/ops', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(op),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    return { ok: false, message: refusal(res.status, body?.error) };
  } catch {
    return { ok: false, message: 'Couldn’t reach your Mac. Rooms not changed.' };
  }
}
