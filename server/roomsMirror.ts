// roomsMirror.ts — the Mac's room list, kept on the server for the other devices (AASC-20).
//
// Rooms live in each browser's localStorage, and the Mac's main window — the
// workspace writer (presenceManager) — owns them. A paired phone may not read the
// workspace snapshot at all, and every other device only read its rooms once at
// load, so phones had no rooms and viewers never saw the Mac's later changes.
// The writer now pushes its list here (PUT /api/rooms); everyone else reads it
// (GET /api/rooms) and gets every later change as `rooms_update`.
//
// A room is a list of session ids, so it is session data: a remote device must
// never learn about a session hidden from it (sessionVisibility.ts). Its copy
// keeps only the sessions it can see, and drops a room whose sessions are ALL
// hidden from it — the room's name would otherwise say what the hidden sessions
// are. A room with no sessions at all is kept. An id the server cannot resolve
// counts as hidden: an unknown id must not read differently from a hidden one,
// or a room's presence becomes an oracle for session ids. The writer pushes only
// ids of sessions it has, so a stale id is a transient, not a ghost room.
//
// Pure apart from the mirror's own state: the HTTP side is roomsRouter.ts.

import { z } from 'zod';
import { canSeeSession, type VisibilityCandidate } from './sessionVisibility.js';
import { ROOM_COLOR_PALETTE } from '../src/lib/roomColor.js';
import type { Room, RoomOp } from '../src/types/room.js';

export const ROOM_LIMITS = {
  rooms: 200,
  name: 100,
  id: 128,
  sessionsPerRoom: 500,
  sessionId: 200,
  /** Over all rooms: the writer's store holds at most a few hundred live ids. */
  sessionsTotal: 5_000,
} as const;

/** The fields of a session the mirror reads: its current id (aliases resolved) and its sharing flag. */
export interface RoomSessionRef extends VisibilityCandidate {
  sessionId: string;
}

/** Looks a session up by any id it has gone by; null when the server doesn't know it. */
export type RoomSessionLookup = (sessionId: string) => RoomSessionRef | null;

// ── Validation ──────────────────────────────────────────────────────────────────────────────────────────

const roomIdSchema = z.string().min(1).max(ROOM_LIMITS.id);
const sessionIdSchema = z.string().min(1).max(ROOM_LIMITS.sessionId);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/;

/** A name a device typed: trimmed, one line, not empty. */
const opNameSchema = z.string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(ROOM_LIMITS.name).refine((s) => !CONTROL_CHARS.test(s), 'one line, no control characters'));

const roomSchema = z.object({
  id: roomIdSchema,
  name: z.string().max(ROOM_LIMITS.name),
  sessionIds: z.array(sessionIdSchema).max(ROOM_LIMITS.sessionsPerRoom),
  collapsed: z.boolean().default(false),
  createdAt: z.number().finite().default(0),
  roomIndex: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  listOrder: z.number().finite().optional(),
  color: z.string().max(64).optional(),
});

const roomListSchema = z.object({ rooms: z.array(roomSchema).max(ROOM_LIMITS.rooms) })
  .refine((b) => new Set(b.rooms.map((r) => r.id)).size === b.rooms.length, 'room ids must be unique')
  .refine((b) => b.rooms.reduce((n, r) => n + r.sessionIds.length, 0) <= ROOM_LIMITS.sessionsTotal, 'too many sessions');

const paletteColor = z.string().refine((c) => ROOM_COLOR_PALETTE.includes(c), 'a palette colour');

const roomOpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), name: opNameSchema, sessionId: sessionIdSchema.optional() }).strict(),
  z.object({ type: z.literal('rename'), roomId: roomIdSchema, name: opNameSchema }).strict(),
  z.object({ type: z.literal('color'), roomId: roomIdSchema, color: paletteColor.nullable() }).strict(),
  z.object({ type: z.literal('delete'), roomId: roomIdSchema }).strict(),
  z.object({ type: z.literal('move'), sessionId: sessionIdSchema, roomId: roomIdSchema.nullable() }).strict(),
  // AASC-55: the rooms' LIST order (listOrder), never their 3D slot (roomIndex).
  z.object({
    type: z.literal('reorder'),
    roomIds: z.array(roomIdSchema).min(1).max(ROOM_LIMITS.rooms)
      .refine((ids) => new Set(ids).size === ids.length, 'room ids must be unique'),
  }).strict(),
]);

/** A pushed room list (`{ rooms }`), or null when it is malformed or over a limit. Unknown fields are dropped. */
export function parseRoomList(body: unknown): Room[] | null {
  const parsed = roomListSchema.safeParse(body);
  return parsed.success ? parsed.data.rooms.map(stripUndefined) : null;
}

/** One room change from another device, or null. Never carries `roomIndex`: that is a 3D slot (a reorder is list order only). */
export function parseRoomOp(body: unknown): RoomOp | null {
  const parsed = roomOpSchema.safeParse(body);
  return parsed.success ? (stripUndefined(parsed.data) as RoomOp) : null;
}

/** Zod writes optional keys back as `undefined`; a room store never has them, so equality checks stay exact. */
function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

// ── What a device may see ───────────────────────────────────────────────────────────────────────────────

/** One room as a client sees it, plus how many of its ids that client may not see. */
interface RoomCut {
  room: Room;
  hidden: number;
}

function cutRoom(room: Room, isLocal: boolean, lookup: RoomSessionLookup): RoomCut {
  const ids: string[] = [];
  let hidden = 0;
  for (const id of room.sessionIds) {
    const session = lookup(id);
    if (session && canSeeSession(isLocal, session)) ids.push(session.sessionId);
    else if (isLocal) ids.push(id); // the Mac sees everything, ids it can't resolve too
    else hidden++;
  }
  return { room: { ...room, sessionIds: [...new Set(ids)] }, hidden };
}

/**
 * The rooms a client may see. This machine gets every room; a remote device
 * gets only the sessions shared with it, under their current ids, and no room
 * whose sessions are all hidden from it. Never changes `rooms`.
 */
export function roomsViewFor(rooms: readonly Room[], isLocal: boolean, lookup: RoomSessionLookup): Room[] {
  const out: Room[] = [];
  for (const room of rooms) {
    const cut = cutRoom(room, isLocal, lookup);
    if (cut.hidden > 0 && cut.room.sessionIds.length === 0) continue;
    out.push(cut.room);
  }
  return out;
}

/** How many of a room's sessions a client may not see (0 for this machine). */
export function hiddenSessionCount(room: Room, isLocal: boolean, lookup: RoomSessionLookup): number {
  return cutRoom(room, isLocal, lookup).hidden;
}

// ── The mirror ──────────────────────────────────────────────────────────────────────────────────────────

export interface RoomsMirror {
  /** The writer's latest list and its revision. The first read seeds it from the saved snapshot. */
  get(): { rooms: Room[]; revision: number };
  /** Replace the list. Same list again: no change, no new revision. */
  set(rooms: Room[]): { changed: boolean; revision: number };
  /** A new revision for the same list: what devices may see changed (a session was shared or hidden). */
  touch(): number;
}

/**
 * The writer's latest room list. `seed` is read once, on first use, and only
 * when no list was pushed yet: the rooms of the last saved workspace, so a
 * phone that connects before the Mac's window still sees the room names.
 */
export function createRoomsMirror(seed: () => Room[]): RoomsMirror {
  let rooms: Room[] | null = null;
  let json = '';
  let revision = 0;

  function ensure(): Room[] {
    if (rooms) return rooms;
    let seeded: Room[] = [];
    try {
      seeded = seed();
    } catch {
      seeded = []; // an unreadable snapshot is no rooms, not a failed request
    }
    rooms = seeded;
    json = JSON.stringify(seeded);
    return rooms;
  }

  return {
    get: () => ({ rooms: ensure(), revision }),
    set: (next) => {
      const nextJson = JSON.stringify(next);
      if (rooms && nextJson === json) return { changed: false, revision };
      rooms = next;
      json = nextJson;
      revision += 1;
      return { changed: true, revision };
    },
    touch: () => {
      ensure();
      revision += 1;
      return revision;
    },
  };
}
