// test/mcp/currentRooms.test.ts — the room list the /mcp endpoint scopes room centrals with
// (server/index.ts passes `currentRooms` as `McpDeps.rooms`): apiRouter's own rooms mirror, the list the
// dashboard reads from GET /api/rooms, never a copy of its own.
//
// The real apiRouter is imported after a data folder whose saved workspace has one room, as the central
// route tests do (centralRouteFixtures.ts). Nothing here starts a process or a PTY.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Room } from '../../src/types/room.js';
import type { Session } from '../../src/types/session.js';
import { isInScope } from '../../server/mcp/scope.js';
import { ROOM_ID, makeDataDir, startApi, type ApiServer } from './centralRouteFixtures.js';

vi.mock('node-pty', async () => (await import('./fakePty.js')).nodePtyModule);

// apiRouter opens SQLite through db.ts at import; the logger appends to a file on disk.
vi.mock('../../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
  getRecentSessions: vi.fn(() => []),
  getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(),
  default: {},
}));
vi.mock('../../server/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    debugJson: vi.fn(),
    isDebug: false,
  },
}));

let data: ReturnType<typeof makeDataDir>;
let previousDataDir: string | undefined;
let api: ApiServer;
let currentRooms: () => Room[];
let store: typeof import('../../server/sessionStore.js');

beforeAll(async () => {
  data = makeDataDir();
  previousDataDir = process.env.APP_USER_DATA;
  process.env.APP_USER_DATA = data.dir;
  api = await startApi();
  ({ currentRooms } = await import('../../server/apiRouter.js'));
  // The store broadcasts through wsManager; loaded first, as test/queueUpdateVisibility.test.ts does.
  await import('../../server/wsManager.js');
  store = await import('../../server/sessionStore.js');
});

afterAll(async () => {
  await api.close();
  if (previousDataDir === undefined) delete process.env.APP_USER_DATA;
  else process.env.APP_USER_DATA = previousDataDir;
  data.remove();
});

describe('currentRooms', () => {
  it("starts as the saved workspace's rooms, as the mirror does", () => {
    expect(currentRooms().map((room) => room.id)).toEqual([ROOM_ID]);
  });

  it('hands out a new array each time, so a caller cannot change the mirror', () => {
    const rooms = currentRooms();
    rooms.push({ id: 'stray', name: 'Stray', sessionIds: [], collapsed: false, createdAt: 0 });

    expect(currentRooms().map((room) => room.id)).toEqual([ROOM_ID]);
  });

  it("follows the mirror: the list the Mac's window sends with PUT /api/rooms is the next answer", async () => {
    const next = {
      rooms: [
        { id: ROOM_ID, name: 'Ops', sessionIds: ['s-1'] },
        { id: 'room-two', name: 'Two', sessionIds: [] },
      ],
    };

    expect((await api.call('PUT', '/rooms', next)).status).toBe(200);

    expect(currentRooms().map((room) => [room.id, room.sessionIds])).toEqual([
      [ROOM_ID, ['s-1']],
      ['room-two', []],
    ]);
  });

  it('lists a re-keyed member under its current id, as GET /api/rooms does for this Mac, so its room central keeps it', async () => {
    // The room was saved before its member was re-keyed (term-* to the CLI's own id): it lists the old id.
    await store.createTerminalSession('room-member-now', {
      host: 'localhost',
      workingDir: '/tmp/current-rooms/member',
      command: 'claude',
    });
    store.registerSessionAlias('room-member-before', 'room-member-now');
    const saved = {
      rooms: [{ id: ROOM_ID, name: 'Ops', sessionIds: ['room-member-before', 'room-member-gone'] }],
    };
    expect((await api.call('PUT', '/rooms', saved)).status).toBe(200);

    const rooms = currentRooms();

    // The live id, in place of the old one; an id nothing answers to stays as it was saved.
    expect(rooms.map((room) => [room.id, room.sessionIds])).toEqual([
      [ROOM_ID, ['room-member-now', 'room-member-gone']],
    ]);
    const { json } = await api.call('GET', '/rooms');
    expect(rooms).toEqual(json.rooms);

    const member = store.getSession('room-member-before');
    expect(member?.sessionId).toBe('room-member-now');
    const roomCentral = { centralId: 'central-of-ops', kind: 'room' as const, scopeRef: ROOM_ID };
    expect(isInScope(roomCentral, member as Session, rooms)).toBe(true);
  });
});
