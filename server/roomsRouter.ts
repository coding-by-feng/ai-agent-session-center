// roomsRouter.ts — the room list's routes (AASC-20). The list itself and who may
// see what are in roomsMirror.ts.
//
//   GET  /rooms      the list, cut for the caller (a remote device: shared sessions only)
//   PUT  /rooms      the workspace writer's whole list (409 not-workspace-writer for anyone else)
//   POST /rooms/ops  one change asked for by another device, handed to the writer over its socket
//                    (create, rename, color, delete, move, and reorder: list order only, AASC-55)
//
// The Mac stays the owner of rooms: nothing here changes the list on another
// device's behalf. An op is checked against what the caller may see, then sent
// to the writer as `room_op`; the writer applies it with its room store and its
// next PUT carries the result to everyone as `rooms_update`.

import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import log from './logger.js';
import { canSeeSession } from './sessionVisibility.js';
import {
  createRoomsMirror, hiddenSessionCount, parseRoomList, parseRoomOp, roomsViewFor,
  type RoomSessionRef,
} from './roomsMirror.js';
import type { Room, RoomOp } from '../src/types/room.js';

/** Room changes one device may ask for per window. A person tapping through sheets makes a few. */
export const ROOM_OPS_PER_WINDOW = 20;
export const ROOM_OPS_WINDOW_MS = 10_000;

export interface RoomsUpdatePayload {
  type: 'rooms_update';
  revision: number;
  rooms: Room[];
}

export interface RoomOpPayload {
  type: 'room_op';
  opId: string;
  op: RoomOp;
}

export interface RoomsServiceDeps {
  /** The saved workspace snapshot's rooms, read once when the mirror is first used. */
  seed: () => Room[];
  /** Is the request from this machine? Must be `isLocalRequest`, like every other visibility gate. */
  isLocal: (req: Request) => boolean;
  /** The caller's device id ('' when anonymous or refused), as `clientIdFromRequest` gives it. */
  clientId: (req: Request) => string;
  /** May this device set the list? The workspace writer's rule (`presence.canWriteWorkspace`). */
  canWriteRooms: (clientId: string) => boolean;
  /** The device that applies room changes, or null when none is connected that could. */
  roomOwner: () => Promise<string | null> | string | null;
  /** A session by any id it has gone by (aliases resolved), or null. */
  getSession: (sessionId: string) => RoomSessionRef | null;
  /** Send the list to every client: this machine's copy, and remote devices' cut. */
  publish: (local: RoomsUpdatePayload, remote: RoomsUpdatePayload) => Promise<void> | void;
  /** Deliver a message to every open socket of one device; how many got it. */
  sendToClient: (clientId: string, msg: RoomOpPayload) => Promise<number> | number;
  newOpId?: () => string;
  now?: () => number;
}

export interface RoomsService {
  router: Router;
  /** Broadcast every device's cut again under a new revision: what a remote device may see changed. */
  republish: () => void;
  /** The Mac's whole room list as the mirror holds it (no device's cut), as a new array. */
  current: () => Room[];
}

function respondNotFound(res: Response, what: 'Session' | 'Room'): void {
  res.status(404).json({ ok: false, error: `${what} not found` });
}

export function createRoomsService(deps: RoomsServiceDeps): RoomsService {
  const router = Router();
  const mirror = createRoomsMirror(deps.seed);
  const now = deps.now ?? Date.now;
  const newOpId = deps.newOpId ?? randomUUID;
  const opBuckets = new Map<string, { windowStart: number; count: number }>();

  const viewFor = (isLocal: boolean): Room[] => roomsViewFor(mirror.get().rooms, isLocal, deps.getSession);

  function payload(isLocal: boolean, revision: number): RoomsUpdatePayload {
    return { type: 'rooms_update', revision, rooms: viewFor(isLocal) };
  }

  async function publish(revision: number): Promise<void> {
    try {
      await deps.publish(payload(true, revision), payload(false, revision));
    } catch (err) {
      log.warn('rooms', `Room broadcast failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function overOpBudget(key: string): boolean {
    const t = now();
    // Forget windows long over, so the map can't grow with every device ever seen.
    for (const [k, b] of opBuckets) if (t - b.windowStart >= ROOM_OPS_WINDOW_MS) opBuckets.delete(k);
    const bucket = opBuckets.get(key);
    if (!bucket) {
      opBuckets.set(key, { windowStart: t, count: 1 });
      return false;
    }
    bucket.count += 1;
    return bucket.count > ROOM_OPS_PER_WINDOW;
  }

  router.get('/rooms', (req: Request, res: Response) => {
    res.json({ ok: true, rooms: viewFor(deps.isLocal(req)), revision: mirror.get().revision });
  });

  router.put('/rooms', async (req: Request, res: Response) => {
    // The writer's rule, as for /workspace/save: a device that has not seen the
    // Mac's rooms would otherwise replace them with its own.
    if (!deps.canWriteRooms(deps.clientId(req))) {
      res.status(409).json({ ok: false, error: 'not-workspace-writer' });
      return;
    }
    const rooms = parseRoomList(req.body);
    if (!rooms) {
      res.status(400).json({ ok: false, error: 'Invalid room list' });
      return;
    }
    const { changed, revision } = mirror.set(rooms);
    if (changed) await publish(revision);
    res.json({ ok: true, revision });
  });

  router.post('/rooms/ops', async (req: Request, res: Response) => {
    const isLocal = deps.isLocal(req);
    const clientId = deps.clientId(req);
    // A remote device with no id of its own watches; it never changes shared state.
    if (!isLocal && !clientId) {
      res.status(400).json({ ok: false, error: 'missing-client-id' });
      return;
    }
    if (overOpBudget(clientId || `ip:${req.ip ?? ''}`)) {
      res.status(429).json({ ok: false, error: 'Too many room changes; try again in a moment' });
      return;
    }
    const op = parseRoomOp(req.body);
    if (!op) {
      res.status(400).json({ ok: false, error: 'Invalid room change' });
      return;
    }

    // A session the caller can't see is "not found", the same answer as one that
    // doesn't exist (as under /sessions/:id). Forwarded under its current id.
    let forwarded: RoomOp = op;
    if ((op.type === 'move' || op.type === 'create') && op.sessionId !== undefined) {
      const session = deps.getSession(op.sessionId);
      if (!session || !canSeeSession(isLocal, session)) {
        respondNotFound(res, 'Session');
        return;
      }
      forwarded = { ...op, sessionId: session.sessionId };
    }

    // A room the caller can't see is "not found" too: its copy of the list is the
    // only one it may act on. A reorder names rooms only, every one of them checked.
    const visibleIds = new Set(viewFor(isLocal).map((r) => r.id));
    if (op.type === 'reorder' && !op.roomIds.every((id) => visibleIds.has(id))) {
      respondNotFound(res, 'Room');
      return;
    }
    const roomId = op.type === 'create' || op.type === 'reorder' ? null : op.roomId;
    if (roomId !== null) {
      if (!visibleIds.has(roomId)) {
        respondNotFound(res, 'Room');
        return;
      }
      // Deleting takes every session out of the room, the hidden ones too.
      const room = mirror.get().rooms.find((r) => r.id === roomId);
      if (op.type === 'delete' && room && hiddenSessionCount(room, isLocal, deps.getSession) > 0) {
        res.status(409).json({ ok: false, error: 'room-has-hidden-sessions' });
        return;
      }
    }

    const owner = await deps.roomOwner();
    const opId = newOpId();
    const delivered = owner ? await deps.sendToClient(owner, { type: 'room_op', opId, op: forwarded }) : 0;
    if (!delivered) {
      res.status(409).json({ ok: false, error: 'no-writer' });
      return;
    }
    res.status(202).json({ ok: true, opId });
  });

  return {
    router,
    republish: () => { void publish(mirror.touch()); },
    current: () => [...mirror.get().rooms],
  };
}
