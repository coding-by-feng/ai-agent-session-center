// tools/rooms.ts — the rooms toolset. P1: the room list (read only, here). P3: the room writes (roomWrite.ts).
//
// The list is `GET /api/rooms`, which answers this Mac the whole list of the rooms mirror. It is not a room or
// project central's to read whole: `visibleRooms` (define.ts) keeps a global central's list as it is, gives a room
// central its own room and a project central the rooms that hold a session it can see, and cuts every room but a
// global central's to the member sessions the central may see. Room names are the person's own words, not a
// session's: plain in `data`, inside one block in the text. From P3 a name can also be a central's words (room_create,
// room_rename), bounded by Ruling P3-12: 1–60 characters, no control or format character, no `<`, `>` or backtick.

import type { Room } from '../../../src/types/room.js';
import type { ToolDef } from '../registry.js';
import { defineTool, fence, plural, refOf, unwrap, visibleRooms } from './define.js';
import { roomWriteTools } from './roomWrite.js';
import { num, records, str, strings, whole } from './shape.js';

/** A room as the route describes it, read loosely; null for one with no id to name it by. */
function roomOf(raw: Record<string, unknown>): Room | null {
  const id = str(raw.id);
  if (id === null || id === '') return null;
  const listOrder = num(raw.listOrder);
  const color = str(raw.color);
  return {
    id,
    name: str(raw.name) ?? '',
    sessionIds: strings(raw.sessionIds),
    collapsed: raw.collapsed === true,
    createdAt: num(raw.createdAt) ?? 0,
    ...(listOrder === null ? {} : { listOrder }),
    ...(color === null || color === '' ? {} : { color }),
  };
}

const roomList = defineTool({
  name: 'room_list',
  toolset: 'rooms',
  title: 'List rooms',
  description:
    'Lists the rooms in your scope with their id, name, colour and the sessions in each (ids you can pass to any ' +
    'session tool). A global central sees every room; a room central its own room; a project central the rooms ' +
    'that hold a session of its project. A room shows only the member sessions you can see.',
  risk: 'read',
  phase: 1,
  input: {},
  async run(_args, ctx) {
    const body = unwrap<Record<string, unknown>>(await ctx.client.get('/rooms'));
    const fromRoute = records(body.rooms).flatMap((raw) => {
      const room = roomOf(raw);
      return room === null ? [] : [room];
    });
    // The route's list, judged by the same rule as every other room list: `visibleRooms` reads `ctx.rooms()`.
    const rooms = visibleRooms({ ...ctx, rooms: () => fromRoute });
    const data = {
      revision: whole(body.revision),
      count: rooms.length,
      rooms: rooms.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color ?? null,
        collapsed: r.collapsed,
        createdAt: r.createdAt,
        listOrder: r.listOrder ?? null,
        sessionCount: r.sessionIds.length,
        sessionIds: [...r.sessionIds],
      })),
    };
    if (rooms.length === 0) return { data, summary: 'No rooms in your scope.' };
    const ref = refOf(ctx);
    const rows = rooms.map((r) => {
      const members = r.sessionIds.length === 0 ? '' : `: ${r.sessionIds.map(ref).join(', ')}`;
      return `${JSON.stringify(r.name)} (${r.id}) · ${plural(r.sessionIds.length, 'session')}${members}`;
    });
    return { data, summary: `${plural(rooms.length, 'room')} in your scope.\n${fence('aasc', 'rooms', rows.join('\n'))}` };
  },
});

export const roomTools: readonly ToolDef[] = [roomList, ...roomWriteTools];
