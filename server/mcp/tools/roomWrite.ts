// tools/roomWrite.ts — the rooms toolset's writes (P3, Task 12): room_create, room_rename, room_set_color, room_delete,
// room_move_session and room_reorder. Each sends one op of src/types/room.ts `RoomOp` to `POST /rooms/ops`, which
// checks what the caller may see and hands the op to the workspace writer (the Mac's window); the window applies it
// and its next PUT shows the result in the mirror (`ctx.rooms()`).
//
// The rules, in the order each tool asks them:
//   * the rights table of Ruling P3-12, one pure function (`roomRight`): what each kind of central may do at all;
//   * the room must be one the central can see (`visibleRooms`): another is NOT_FOUND, as one that does not exist;
//   * a name is a central's own words, so it is bounded: 1–60 characters after the trim, no control or format
//     character, no `<`, `>` or backtick, and no other room the central can see may have it (any case);
//   * a session goes through `resolveTarget`, then `ctx.mayEdit` (scope; not a central's card, an ops shell, a
//     subagent, a floating popup, an external or SSH card; not hands-off). Nothing is typed, so the 60 s rule is not
//     asked (Ruling P3-7).
// The route answers 202 once the window has the op. A create carries no id: the window assigns it, so room_create
// watches the mirror for a new room of that name, every 250 ms for up to 10 s, and answers `pending` after that.
// No window is NO_WINDOW, a room with sessions the caller cannot see is DENIED (delete), past 20 ops in 10 s BUDGET.
// A refusal never repeats the name or an id the central sent; the activity log holds ids only, never a name.

import { z } from 'zod';
import { ROOM_COLOR_PALETTE } from '../../../src/lib/roomColor.js';
import type { Room, RoomOp } from '../../../src/types/room.js';
import type { InternalResponse } from '../client.js';
import type { ToolContext, ToolDef, ToolResult } from '../registry.js';
import { shortIdOf } from '../scope.js';
import { ToolError, type CentralKind } from '../types.js';
import { defineTool, isRecord, plain, refOf, resolveTarget, SESSION_REF, unwrap, visibleRooms } from './define.js';

/** room_create's wait for the window to report the new room (Ruling P3-12). */
export const ROOM_CREATE_WAIT_MS = 10_000;
export const ROOM_CREATE_POLL_MS = 250;

export const ROOM_NAME_MAX = 60;

/** The id of a room as the route takes it (roomsMirror.ts ROOM_LIMITS.id). */
const ROOM_ID = z.string().min(1).max(128).describe('A room’s id, as room_list shows it.');

/** What a central may do to rooms, by kind: anything in its scope, its own room only, or nothing. */
export type RoomRight = 'any' | 'own' | 'denied';

const RIGHTS: Readonly<Record<RoomOp['type'], Readonly<Record<CentralKind, RoomRight>>>> = {
  create: { global: 'any', room: 'denied', project: 'any' },
  rename: { global: 'any', room: 'own', project: 'denied' },
  color: { global: 'any', room: 'own', project: 'denied' },
  delete: { global: 'any', room: 'denied', project: 'denied' },
  move: { global: 'any', room: 'own', project: 'any' },
  reorder: { global: 'any', room: 'denied', project: 'denied' },
};

/**
 * The rights table of Ruling P3-12. `any` is bounded by what the central can see (a project central's rooms are those
 * holding one of its sessions); `own` is the room central's own room (for a move: into it, never out of it). A global
 * central's delete is also refused for a room a live room central serves (`room_delete`).
 */
export function roomRight(kind: CentralKind, op: RoomOp['type']): RoomRight {
  return RIGHTS[op][kind];
}

// ---------------------------------------------------------------------------
// The rules every tool shares
// ---------------------------------------------------------------------------

const denied = (what: string): ToolError =>
  new ToolError('DENIED', `A central of your kind does not ${what}.`, 'Ask the person to do it in AASC, or a global central.');

/** Refuses an op the table does not give this central; the right it has otherwise. */
function assertRight(ctx: ToolContext, op: RoomOp['type'], what: string): RoomRight {
  const right = roomRight(ctx.central.kind, op);
  if (right === 'denied') throw denied(what);
  return right;
}

const roomNotFound = (): ToolError =>
  new ToolError('NOT_FOUND', 'No room you can see has that id.', 'Call room_list for the rooms in your scope.');

/** The room `roomId` names among those the central can see; NOT_FOUND for any other. */
function visibleRoom(ctx: ToolContext, roomId: string): Room {
  const room = visibleRooms(ctx).find((r) => r.id === roomId);
  if (room === undefined) throw roomNotFound();
  return room;
}

/** A room central's own room only, for an `own` right. */
function assertOwnRoom(ctx: ToolContext, right: RoomRight, roomId: string | null, what: string): void {
  if (right === 'own' && roomId !== ctx.central.scopeRef) throw denied(what);
}

/** Control and format characters (bidi overrides, zero-width spaces), line and paragraph separators, and the three that could start markup or code. */
const BAD_NAME_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>`]/u;

/**
 * A room name a central wrote, trimmed; INVALID (never repeating it) when it breaks a rule of Ruling P3-12, or another
 * room the central can see (`exceptRoomId` aside) already has it in any case.
 */
function roomName(ctx: ToolContext, raw: string, exceptRoomId: string | null = null): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > ROOM_NAME_MAX || BAD_NAME_CHAR.test(name)) {
    throw new ToolError(
      'INVALID',
      `A room name is 1 to ${ROOM_NAME_MAX} characters, on one line, without <, > or a backtick.`,
      'Pass a short plain name.',
    );
  }
  const folded = name.toLowerCase();
  if (visibleRooms(ctx).some((r) => r.id !== exceptRoomId && r.name.trim().toLowerCase() === folded)) {
    throw new ToolError('INVALID', 'Another room already has that name.', 'Pick another name; room_list shows the rooms.');
  }
  return name;
}

/** The session a central files, after the card rails (Ruling P3-7). */
function cardOf(ctx: ToolContext, ref: string) {
  const session = resolveTarget(ctx, ref);
  ctx.mayEdit(session);
  return session;
}

/** The route's error word, when it gave one of its own. */
function routeError(r: InternalResponse<unknown>): string | null {
  const said = isRecord(r.data) ? r.data.error : undefined;
  return typeof said === 'string' ? said : null;
}

/** Sends one op; the route's refusals as a central reads them. */
async function sendOp(ctx: ToolContext, op: RoomOp): Promise<void> {
  const r = await ctx.client.post('/rooms/ops', op);
  if (r.ok) return;
  const error = routeError(r);
  if (r.status === 409 && error === 'no-writer') {
    throw new ToolError('NO_WINDOW', 'No AASC window is open on the Mac to apply room changes.', 'Ask the person to open AASC, then try again.');
  }
  if (r.status === 409 && error === 'room-has-hidden-sessions') {
    throw new ToolError('DENIED', 'That room holds sessions shown on this Mac only.', 'Ask the person to delete it in AASC.');
  }
  if (r.status === 429) throw new ToolError('BUDGET', 'Too many room changes in a short time.', 'Wait ten seconds, then try again.');
  if (r.status === 404) throw new ToolError('NOT_FOUND', 'AASC has no such room or session now.', 'Call room_list and session_list for the ids.');
  unwrap(r);
}

/** What a room write answers: its data, a line for the model, and one activity row of ids. */
function written(data: Record<string, unknown>, summary: string, row: string, detail: Record<string, string | number | null>, targetSessionId: string | null = null): ToolResult {
  return { data, summary, activity: [{ summary: row, targetSessionId, detail }] };
}

// ---------------------------------------------------------------------------
// room_create
// ---------------------------------------------------------------------------

/** Waits `ms`, or less when the call is cancelled. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** The id of a room that was not there before, with exactly `name`, once the mirror shows one; else null. */
async function awaitNewRoom(ctx: ToolContext, before: ReadonlySet<string>, name: string): Promise<string | null> {
  const polls = Math.floor(ROOM_CREATE_WAIT_MS / ROOM_CREATE_POLL_MS);
  for (let i = 0; i <= polls; i += 1) {
    const found = ctx.rooms().find((r) => !before.has(r.id) && r.name === name);
    if (found !== undefined) return found.id;
    if (i === polls || ctx.signal.aborted) return null;
    await pause(ROOM_CREATE_POLL_MS, ctx.signal);
  }
  return null;
}

const roomCreate = defineTool({
  name: 'room_create',
  toolset: 'rooms',
  title: 'Create a room',
  description:
    'Creates a room, and with firstSession files that session into it. A global or a project central may; a room ' +
    `central may not. The name is 1 to ${ROOM_NAME_MAX} characters after trimming, on one line, without <, > or a ` +
    'backtick, and no room you can see may have it already (any case). A project central sees only rooms that hold ' +
    'one of its sessions, so give it firstSession. A hands-off card, a central’s card, an ops shell, a subagent or ' +
    'an external card is not filed. The Mac’s AASC window makes the room: AASC waits up to 10 s for it and answers ' +
    'its roomId, or pending: true (room_list shows it later). NO_WINDOW when no window is open.',
  risk: 'write',
  phase: 3,
  input: {
    name: z.string().min(1).max(200).describe(`The room’s name (1 to ${ROOM_NAME_MAX} characters after trimming).`),
    firstSession: SESSION_REF.optional().describe('A session to file into the new room: its id or short id.'),
  },
  async run(args, ctx) {
    assertRight(ctx, 'create', 'create rooms');
    const name = roomName(ctx, args.name);
    const session = args.firstSession === undefined ? null : cardOf(ctx, args.firstSession);
    const before = new Set(ctx.rooms().map((r) => r.id));
    await sendOp(ctx, { type: 'create', name, ...(session === null ? {} : { sessionId: session.sessionId }) });
    const roomId = await awaitNewRoom(ctx, before, name);
    const filed = session === null ? '' : ` with ${refOf(ctx)(session.sessionId)} in it`;
    const summary =
      roomId === null
        ? `AASC's window has the new room${filed} but has not reported it yet (pending): room_list shows it once it does.`
        : `Created the room ${plain(roomId, 128)}${filed}.`;
    return written(
      { roomId, pending: roomId === null },
      summary,
      roomId === null ? 'Asked for a new room (pending).' : `Created the room ${plain(roomId, 128)}.`,
      { roomId },
      session?.sessionId ?? null,
    );
  },
});

// ---------------------------------------------------------------------------
// room_rename, room_set_color, room_delete
// ---------------------------------------------------------------------------

const roomRename = defineTool({
  name: 'room_rename',
  toolset: 'rooms',
  title: 'Rename a room',
  description:
    'Renames a room. A global central renames any room; a room central its own room only; a project central none. ' +
    `The name is 1 to ${ROOM_NAME_MAX} characters after trimming, on one line, without <, > or a backtick, and no ` +
    'other room you can see may have it (any case). NO_WINDOW when no AASC window is open on the Mac.',
  risk: 'write',
  phase: 3,
  idempotent: true,
  input: {
    roomId: ROOM_ID,
    name: z.string().min(1).max(200).describe(`The new name (1 to ${ROOM_NAME_MAX} characters after trimming).`),
  },
  async run(args, ctx) {
    const right = assertRight(ctx, 'rename', 'rename rooms');
    const room = visibleRoom(ctx, args.roomId);
    assertOwnRoom(ctx, right, room.id, 'rename a room other than its own');
    const name = roomName(ctx, args.name, room.id);
    await sendOp(ctx, { type: 'rename', roomId: room.id, name });
    const id = plain(room.id, 128);
    return written({ roomId: room.id, renamed: true }, `Renamed the room ${id}.`, `Renamed the room ${id}.`, { roomId: room.id });
  },
});

const roomSetColor = defineTool({
  name: 'room_set_color',
  toolset: 'rooms',
  title: 'Set a room’s colour',
  description:
    'Sets a room’s colour to one of AASC’s palette, or null for the colour of its slot. A global central sets any ' +
    'room’s; a room central its own room’s only; a project central none. The palette: ' +
    `${ROOM_COLOR_PALETTE.join(', ')}. NO_WINDOW when no AASC window is open on the Mac.`,
  risk: 'write',
  phase: 3,
  idempotent: true,
  input: {
    roomId: ROOM_ID,
    color: z.string().max(64).nullable().describe('A palette colour exactly as listed, or null for the slot colour.'),
  },
  async run(args, ctx) {
    const right = assertRight(ctx, 'color', 'colour rooms');
    const room = visibleRoom(ctx, args.roomId);
    assertOwnRoom(ctx, right, room.id, 'colour a room other than its own');
    if (args.color !== null && !ROOM_COLOR_PALETTE.includes(args.color)) {
      throw new ToolError('INVALID', 'That is not a colour of AASC’s palette.', `Pass one of: ${ROOM_COLOR_PALETTE.join(', ')}; or null.`);
    }
    await sendOp(ctx, { type: 'color', roomId: room.id, color: args.color });
    const id = plain(room.id, 128);
    const said = args.color === null ? 'its slot colour' : 'a palette colour';
    return written({ roomId: room.id, color: args.color }, `Set the room ${id} to ${said}.`, `Set the colour of the room ${id}.`, { roomId: room.id });
  },
});

const roomDelete = defineTool({
  name: 'room_delete',
  toolset: 'rooms',
  title: 'Delete a room',
  description:
    'Deletes a room; its sessions stay open and leave it. A global central only, and never a room a live room ' +
    'central serves (it would strand that central): DENIED. A room holding sessions shown on this Mac only is ' +
    'DENIED too. NO_WINDOW when no AASC window is open on the Mac.',
  risk: 'write',
  phase: 3,
  input: { roomId: ROOM_ID },
  async run(args, ctx) {
    assertRight(ctx, 'delete', 'delete rooms');
    const room = visibleRoom(ctx, args.roomId);
    if (ctx.centrals().some((c) => c.kind === 'room' && c.scopeRef === room.id)) {
      throw new ToolError('DENIED', 'A live room central serves that room.', 'Ask the person to close that central first, or keep the room.');
    }
    await sendOp(ctx, { type: 'delete', roomId: room.id });
    const id = plain(room.id, 128);
    return written({ roomId: room.id, deleted: true }, `Deleted the room ${id}; its sessions stay open.`, `Deleted the room ${id}.`, { roomId: room.id });
  },
});

// ---------------------------------------------------------------------------
// room_move_session, room_reorder
// ---------------------------------------------------------------------------

const roomMoveSession = defineTool({
  name: 'room_move_session',
  toolset: 'rooms',
  title: 'Move a session into a room',
  description:
    'Files a session into a room, or out of every room (roomId null). A global central moves any session in its ' +
    'scope into any room or none; a room central moves a session only into its own room; a project central moves ' +
    'its own sessions into a room it can see, or none. A hands-off card is HANDS_OFF; a central’s card, an ops ' +
    'shell, a subagent, a floating popup and an external or SSH card are never filed. NO_WINDOW when no AASC window ' +
    'is open on the Mac.',
  risk: 'write',
  phase: 3,
  idempotent: true,
  input: {
    sessionId: SESSION_REF,
    roomId: ROOM_ID.nullable().describe('The room to file it into, as room_list shows it; null takes it out of every room.'),
  },
  async run(args, ctx) {
    const right = assertRight(ctx, 'move', 'move sessions');
    assertOwnRoom(ctx, right, args.roomId, 'move a session anywhere but into its own room');
    const session = cardOf(ctx, args.sessionId);
    const roomId = args.roomId === null ? null : visibleRoom(ctx, args.roomId).id;
    await sendOp(ctx, { type: 'move', sessionId: session.sessionId, roomId });
    const ref = refOf(ctx)(session.sessionId);
    const where = roomId === null ? 'out of every room' : `into the room ${plain(roomId, 128)}`;
    return written(
      { id: session.sessionId, shortId: shortIdOf(session.sessionId), roomId },
      `Moved ${ref} ${where}.`,
      `Moved a session ${where}.`,
      { roomId },
      session.sessionId,
    );
  },
});

const roomReorder = defineTool({
  name: 'room_reorder',
  toolset: 'rooms',
  title: 'Reorder the rooms',
  description:
    'Sets the order of the room list: roomIds names every room room_list shows, each once, in the new order. A ' +
    'global central only. It changes the list order, never where a room stands in the 3D scene. NO_WINDOW when no ' +
    'AASC window is open on the Mac.',
  risk: 'write',
  phase: 3,
  idempotent: true,
  input: {
    roomIds: z.array(z.string().min(1).max(128)).min(1).max(200).describe('Every room’s id, each once, in the new order.'),
  },
  async run(args, ctx) {
    assertRight(ctx, 'reorder', 'reorder rooms');
    const visible = new Set(visibleRooms(ctx).map((r) => r.id));
    const named = new Set(args.roomIds);
    if (named.size !== args.roomIds.length || named.size !== visible.size || args.roomIds.some((id) => !visible.has(id))) {
      throw new ToolError('INVALID', 'A reorder names every room once.', 'Pass every id room_list shows, each once, in the new order.');
    }
    await sendOp(ctx, { type: 'reorder', roomIds: [...args.roomIds] });
    return written(
      { roomIds: [...args.roomIds] },
      `Reordered ${args.roomIds.length} rooms.`,
      `Reordered ${args.roomIds.length} rooms.`,
      { rooms: args.roomIds.length },
    );
  },
});

export const roomWriteTools: readonly ToolDef[] = [roomCreate, roomRename, roomSetColor, roomDelete, roomMoveSession, roomReorder];
