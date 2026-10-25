// test/mcp/tools.rooms.test.ts — room_list (rooms toolset, server/mcp/tools/rooms.ts): the room list, cut to what
// the calling central may see. The Mac's whole list is not a room or project central's to read.
import { describe, expect, it, vi } from 'vitest';
import type { Room } from '../../src/types/room.js';
import { blocksIn, deepFreeze, everything, HOSTILE, outsideFences } from './readFixtures.js';
import { dataOf, fail, makeCentral, makeCtx, makeRoom, makeSession, ok, run, runRefused } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

interface RoomData {
  revision: number;
  count: number;
  rooms: Array<{ id: string; name: string; color: string | null; collapsed: boolean; createdAt: number; listOrder: number | null; sessionCount: number; sessionIds: string[] }>;
}

const mine = makeSession('s1', { title: 'Fix login' });
const mine2 = makeSession('s2', { projectPath: '/a/proj/sub' });
const theirs = makeSession('out-1', { projectPath: '/b/other', title: 'TOP SECRET' });
const rooms: Room[] = [
  { ...makeRoom('r1', ['s1', 's2', 'ghost'], 'Backend'), color: '#ff8800', listOrder: 2, createdAt: 77 },
  makeRoom('r2', ['out-1'], 'Hidden room'),
  makeRoom('r3', [], 'Empty'),
  makeRoom('r4', ['s1', 'out-1'], 'Mixed'),
];
const routes = { 'GET /rooms': ok({ ok: true, rooms, revision: 12 }) };

describe('room_list', () => {
  it('calls GET /rooms', async () => {
    const { ctx, client } = makeCtx({ sessions: [mine], rooms, routes });

    await run('room_list', {}, ctx);

    expect(client.calls).toEqual([{ method: 'GET', path: '/rooms' }]);
  });

  it('gives a global central every room whole, with the revision', async () => {
    const { ctx } = makeCtx({ sessions: [mine, mine2, theirs], rooms, routes });

    const data = await dataOf<RoomData>('room_list', {}, ctx);

    expect(data.revision).toBe(12);
    expect(data.count).toBe(4);
    expect(data.rooms.map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(data.rooms[0]).toEqual({
      id: 'r1', name: 'Backend', color: '#ff8800', collapsed: false, createdAt: 77, listOrder: 2, sessionCount: 3, sessionIds: ['s1', 's2', 'ghost'],
    });
    expect(data.rooms[2]).toMatchObject({ color: null, listOrder: null, sessionCount: 0, sessionIds: [] });
  });

  it('gives a room central its own room, cut to the sessions it may see (a member nobody has is not one)', async () => {
    const { ctx } = makeCtx({ central: makeCentral('room', 'r1'), sessions: [mine, mine2, theirs], rooms, routes });

    const result = await run('room_list', {}, ctx);
    const data = result.data as RoomData;

    expect(data.rooms.map((r) => r.id)).toEqual(['r1']);
    expect(data.rooms[0].sessionIds).toEqual(['s1', 's2']);
    expect(data.rooms[0].sessionCount).toBe(2);
    expect(everything(result)).not.toMatch(/out-1|ghost|Hidden room|Mixed|TOP SECRET/);
  });

  it('gives a project central the rooms that hold a session it can see, each cut to the sessions it can see', async () => {
    const { ctx } = makeCtx({ central: makeCentral('project', '/a/proj'), sessions: [mine, mine2, theirs], rooms, routes });

    const result = await run('room_list', {}, ctx);
    const data = result.data as RoomData;

    expect(data.rooms.map((r) => [r.id, r.sessionIds])).toEqual([['r1', ['s1', 's2']], ['r4', ['s1']]]);
    expect(everything(result)).not.toMatch(/out-1|ghost|Hidden room|Empty/);
  });

  it('keeps room names plain in the data and inside one block in the text', async () => {
    const evil = [makeRoom('r1', ['s1'], HOSTILE)];
    const { ctx } = makeCtx({ sessions: [mine], rooms: evil, routes: { 'GET /rooms': ok({ ok: true, rooms: evil, revision: 1 }) } });

    const result = await run('room_list', {}, ctx);

    expect((result.data as RoomData).rooms[0].name).toBe(HOSTILE);
    expect(blocksIn(result.summary)).toBe(1);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
    expect(result.summary).toMatch(/1 room/);
  });

  it('says so when there are no rooms', async () => {
    const { ctx } = makeCtx({ sessions: [mine], routes: { 'GET /rooms': ok({ ok: true, rooms: [], revision: 3 }) } });

    const result = await run('room_list', {}, ctx);

    expect(result.data).toMatchObject({ count: 0, rooms: [] });
    expect(result.summary).toMatch(/No rooms/);
  });

  it('tolerates a room the route describes loosely', async () => {
    const loose = { id: 'r9', name: 7, sessionIds: ['s1', 5], collapsed: 'yes' };
    const { ctx } = makeCtx({ sessions: [mine], routes: { 'GET /rooms': ok({ ok: true, rooms: [loose, null, 'x'], revision: 'later' }) } });

    const data = await dataOf<RoomData>('room_list', {}, ctx);

    expect(data.rooms).toHaveLength(1);
    expect(data.rooms[0]).toMatchObject({ id: 'r9', name: '', collapsed: false, sessionIds: ['s1'] });
    expect(data.revision).toBe(0);
  });

  it('turns a failed route into a refusal and changes nothing it reads', async () => {
    const down = makeCtx({ sessions: [mine], routes: { 'GET /rooms': fail(503, 'down') } });
    const frozen = makeCtx({ sessions: [mine], rooms, routes: { 'GET /rooms': ok(deepFreeze(JSON.parse(JSON.stringify({ ok: true, rooms, revision: 1 })))) } });

    expect((await runRefused('room_list', {}, down.ctx)).code).toBe('UNAVAILABLE');
    await expect(run('room_list', {}, frozen.ctx)).resolves.toBeDefined();
  });
});
