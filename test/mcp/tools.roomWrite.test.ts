// test/mcp/tools.roomWrite.test.ts — the rooms toolset's writes (server/mcp/tools/roomWrite.ts, Task 12): room_create,
// room_rename, room_set_color, room_delete, room_move_session and room_reorder. Each sends one op of
// src/types/room.ts `RoomOp` to POST /rooms/ops, after the rights table of Ruling P3-12 (`roomRight`), the name rules,
// and, for a session, `resolveTarget` then `ctx.mayEdit`. A fake client stands in for the route: nothing here reaches
// a window, a terminal or a process.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Room, RoomOp } from '../../src/types/room.js';
import { ROOM_COLOR_PALETTE } from '../../src/lib/roomColor.js';
import { ROOM_CREATE_POLL_MS, ROOM_CREATE_WAIT_MS, roomRight } from '../../server/mcp/tools/roomWrite.js';
import type { CentralKind } from '../../server/mcp/types.js';
import { fail, makeCentral, makeCtx, makeRoom, makeSession, ok, run, runRefused, type Answer, type CtxOptions } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

afterEach(() => {
  vi.useRealTimers();
});

const OPS = 'POST /rooms/ops';
const accepted: Answer = ok({ ok: true, opId: 'op-1' }, 202);

const s1 = makeSession('s1', { terminalId: 'term-s1' });
const s2 = makeSession('s2', { terminalId: 'term-s2' });
const other = makeSession('o1', { projectPath: '/b/other', terminalId: 'term-o1' });

const baseRooms = (): Room[] => [makeRoom('r1', ['s1'], 'Backend'), makeRoom('r2', ['s2'], 'Frontend'), makeRoom('r3', ['o1'], 'Other')];

/**
 * A central's world. By default the window applies a create at once (the room `r-new` appears in the mirror, as the
 * window's next PUT would put it there); `answer` replaces that route answer.
 */
function world(opts: Partial<CtxOptions> & { kind?: CentralKind; scopeRef?: string | null; answer?: Answer } = {}) {
  const { kind = 'global', scopeRef = null, answer, rooms = baseRooms(), ...rest } = opts;
  const windowApplies: Answer = (call) => {
    const op = call.body as RoomOp;
    if (op.type === 'create') rooms.push(makeRoom('r-new', op.sessionId === undefined ? [] : [op.sessionId], op.name));
    return accepted;
  };
  return makeCtx({
    central: makeCentral(kind, scopeRef),
    sessions: [s1, s2, other],
    rooms,
    routes: { [OPS]: answer ?? windowApplies },
    ...rest,
  });
}

const opsSent = (h: ReturnType<typeof world>): unknown[] => h.client.calls.filter((c) => c.path === '/rooms/ops').map((c) => c.body);

// ---------------------------------------------------------------------------
// The rights table (Ruling P3-12)
// ---------------------------------------------------------------------------

describe('roomRight: the rights table of Ruling P3-12', () => {
  it('gives each kind of central the rights the table names', () => {
    const table: Record<string, Record<CentralKind, string>> = {
      create: { global: 'any', room: 'denied', project: 'any' },
      rename: { global: 'any', room: 'own', project: 'denied' },
      color: { global: 'any', room: 'own', project: 'denied' },
      delete: { global: 'any', room: 'denied', project: 'denied' },
      move: { global: 'any', room: 'own', project: 'any' },
      reorder: { global: 'any', room: 'denied', project: 'denied' },
    };
    for (const [op, byKind] of Object.entries(table)) {
      for (const kind of ['global', 'room', 'project'] as const) {
        expect(roomRight(kind, op as Parameters<typeof roomRight>[1]), `${op} ${kind}`).toBe(byKind[kind]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The body each op sends
// ---------------------------------------------------------------------------

describe('the op each tool sends', () => {
  it('room_create sends a create with the trimmed name, and the session it files first', async () => {
    const h = world();
    const result = await run('room_create', { name: '  Ops  ', firstSession: 's1' }, h.ctx);
    expect(opsSent(h)).toEqual([{ type: 'create', name: 'Ops', sessionId: 's1' }]);
    expect(result.data).toEqual({ roomId: 'r-new', pending: false });
  });

  it('room_create without a first session sends no sessionId', async () => {
    const h = world();
    await run('room_create', { name: 'Ops2' }, h.ctx);
    expect(opsSent(h)).toEqual([{ type: 'create', name: 'Ops2' }]);
  });

  it('room_rename, room_set_color, room_delete, room_move_session and room_reorder send their op', async () => {
    const h = world();

    await run('room_rename', { roomId: 'r1', name: ' API ' }, h.ctx);
    await run('room_set_color', { roomId: 'r1', color: '#4a9eff' }, h.ctx);
    await run('room_set_color', { roomId: 'r1', color: null }, h.ctx);
    await run('room_delete', { roomId: 'r2' }, h.ctx);
    await run('room_move_session', { sessionId: 's1', roomId: 'r2' }, h.ctx);
    await run('room_move_session', { sessionId: 's1', roomId: null }, h.ctx);
    await run('room_reorder', { roomIds: ['r3', 'r1', 'r2'] }, h.ctx);

    expect(opsSent(h)).toEqual([
      { type: 'rename', roomId: 'r1', name: 'API' },
      { type: 'color', roomId: 'r1', color: '#4a9eff' },
      { type: 'color', roomId: 'r1', color: null },
      { type: 'delete', roomId: 'r2' },
      { type: 'move', sessionId: 's1', roomId: 'r2' },
      { type: 'move', sessionId: 's1', roomId: null },
      { type: 'reorder', roomIds: ['r3', 'r1', 'r2'] },
    ]);
  });

  it('room_move_session sends the session’s current id when the central named it by an older one', async () => {
    const h = world({ aliases: { 'old-s1': 's1' } });
    await run('room_move_session', { sessionId: 'old-s1', roomId: 'r2' }, h.ctx);
    expect(opsSent(h)).toEqual([{ type: 'move', sessionId: 's1', roomId: 'r2' }]);
  });

  it('room_set_color takes a palette colour only', async () => {
    const h = world();
    for (const color of ['red', 'url(javascript:x)', '#000000']) {
      expect((await runRefused('room_set_color', { roomId: 'r1', color }, h.ctx)).code, color).toBe('INVALID');
    }
    for (const color of ROOM_COLOR_PALETTE) await run('room_set_color', { roomId: 'r1', color }, h.ctx);
    expect(opsSent(h)).toHaveLength(ROOM_COLOR_PALETTE.length);
  });
});

// ---------------------------------------------------------------------------
// room_create's wait for the window
// ---------------------------------------------------------------------------

describe('room_create waits for the window to report the room', () => {
  it('room_create returns the new room’s id once the window has it', async () => {
    vi.useFakeTimers();
    const h = world({ answer: accepted });
    const done = run('room_create', { name: 'Ops' }, h.ctx);
    await vi.advanceTimersByTimeAsync(ROOM_CREATE_POLL_MS * 3);
    // A room of another name, and an old room renamed, are not the new room.
    h.rooms.push(makeRoom('r8', [], 'Not it'));
    h.rooms.push(makeRoom('r9', [], 'Ops'));
    await vi.advanceTimersByTimeAsync(ROOM_CREATE_POLL_MS);

    const result = await done;

    expect(result.data).toEqual({ roomId: 'r9', pending: false });
    expect(result.summary).toContain('r9');
    expect(result.summary).not.toContain('Ops');
  });

  it('room_create answers pending after 10 s', async () => {
    vi.useFakeTimers();
    const h = world({ answer: accepted });
    let settled = false;
    const done = run('room_create', { name: 'Ops' }, h.ctx).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(ROOM_CREATE_WAIT_MS - ROOM_CREATE_POLL_MS);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(ROOM_CREATE_POLL_MS * 2);

    expect(ROOM_CREATE_WAIT_MS).toBe(10_000);
    expect(ROOM_CREATE_POLL_MS).toBe(250);
    expect((await done).data).toEqual({ roomId: null, pending: true });
  });

  it('stops waiting when the call is cancelled, and answers pending', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const h = world({ signal: abort.signal, answer: accepted });
    const done = run('room_create', { name: 'Ops' }, h.ctx);
    await vi.advanceTimersByTimeAsync(ROOM_CREATE_POLL_MS);
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect((await done).data).toEqual({ roomId: null, pending: true });
  });
});

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

describe('the rights of each kind of central', () => {
  it('room_delete refuses a room a live room central serves', async () => {
    const roomCentral = makeCentral('room', 'r2', { centralId: 'central-r2', terminalId: 'term-c2' });
    const h = world({ centrals: [makeCentral(), roomCentral] });

    const err = await runRefused('room_delete', { roomId: 'r2' }, h.ctx);

    expect(err.code).toBe('DENIED');
    expect(err.message).not.toContain('r2');
    expect(opsSent(h)).toEqual([]);
    await run('room_delete', { roomId: 'r1' }, h.ctx);
    expect(opsSent(h)).toEqual([{ type: 'delete', roomId: 'r1' }]);
  });

  it('a room central moves only into its own room', async () => {
    const h = world({ kind: 'room', scopeRef: 'r1', rooms: [makeRoom('r1', ['s1', 's2'], 'Backend'), makeRoom('r2', [], 'Frontend')] });

    expect((await runRefused('room_move_session', { sessionId: 's2', roomId: 'r2' }, h.ctx)).code).toBe('DENIED');
    expect((await runRefused('room_move_session', { sessionId: 's2', roomId: null }, h.ctx)).code).toBe('DENIED');
    await run('room_move_session', { sessionId: 's2', roomId: 'r1' }, h.ctx);

    expect(opsSent(h)).toEqual([{ type: 'move', sessionId: 's2', roomId: 'r1' }]);
  });

  it('a room central cannot create, delete or reorder', async () => {
    const h = world({ kind: 'room', scopeRef: 'r1' });

    expect((await runRefused('room_create', { name: 'Mine' }, h.ctx)).code).toBe('DENIED');
    expect((await runRefused('room_delete', { roomId: 'r1' }, h.ctx)).code).toBe('DENIED');
    expect((await runRefused('room_reorder', { roomIds: ['r1'] }, h.ctx)).code).toBe('DENIED');
    expect(opsSent(h)).toEqual([]);
  });

  it('a room central renames and recolours its own room only', async () => {
    const h = world({ kind: 'room', scopeRef: 'r1' });

    await run('room_rename', { roomId: 'r1', name: 'API' }, h.ctx);
    await run('room_set_color', { roomId: 'r1', color: null }, h.ctx);
    // Another room is one it cannot see: not found, as for a room that does not exist.
    expect((await runRefused('room_rename', { roomId: 'r2', name: 'API' }, h.ctx)).code).toBe('NOT_FOUND');
    expect((await runRefused('room_set_color', { roomId: 'r2', color: null }, h.ctx)).code).toBe('NOT_FOUND');

    expect(opsSent(h)).toHaveLength(2);
  });

  it('a project central cannot rename', async () => {
    const h = world({ kind: 'project', scopeRef: '/a/proj' });

    expect((await runRefused('room_rename', { roomId: 'r1', name: 'API' }, h.ctx)).code).toBe('DENIED');
    expect((await runRefused('room_set_color', { roomId: 'r1', color: null }, h.ctx)).code).toBe('DENIED');
    expect((await runRefused('room_delete', { roomId: 'r1' }, h.ctx)).code).toBe('DENIED');
    expect((await runRefused('room_reorder', { roomIds: ['r1', 'r2'] }, h.ctx)).code).toBe('DENIED');
    expect(opsSent(h)).toEqual([]);
  });

  it('a project central moves its own cards into a room it can see, or out of every room, and creates rooms', async () => {
    const h = world({ kind: 'project', scopeRef: '/a/proj' });

    await run('room_move_session', { sessionId: 's1', roomId: 'r2' }, h.ctx);
    await run('room_move_session', { sessionId: 's1', roomId: null }, h.ctx);
    // r3 holds no session of its project: not one it can see.
    expect((await runRefused('room_move_session', { sessionId: 's1', roomId: 'r3' }, h.ctx)).code).toBe('NOT_FOUND');
    // o1 is another project's card.
    expect((await runRefused('room_move_session', { sessionId: 'o1', roomId: 'r2' }, h.ctx)).code).toBe('NOT_IN_SCOPE');
    const created = await run('room_create', { name: 'New', firstSession: 's1' }, h.ctx);

    expect(created.data).toEqual({ roomId: 'r-new', pending: false });
    expect(opsSent(h)).toEqual([
      { type: 'move', sessionId: 's1', roomId: 'r2' },
      { type: 'move', sessionId: 's1', roomId: null },
      { type: 'create', name: 'New', sessionId: 's1' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe('room names', () => {
  it('a name with <, a backtick or a control character is INVALID', async () => {
    const h = world();
    const bad = ['<b>x</b>', 'a > b', 'x`rm`', 'line\nbreak', 'tab\there', 'bell\u0007', 'del\u007f', 'c1\u0085', 'rtl‮override', 'zw​space', '   ', 'x'.repeat(61)];

    for (const name of bad) {
      const created = await runRefused('room_create', { name }, h.ctx);
      const renamed = await runRefused('room_rename', { roomId: 'r1', name }, h.ctx);
      for (const err of [created, renamed]) {
        expect(err.code, JSON.stringify(name)).toBe('INVALID');
        if (name.trim() !== '') expect(`${err.message} ${err.hint ?? ''}`).not.toContain(name.trim());
      }
    }
    expect(opsSent(h)).toEqual([]);
    // 60 characters after the trim is the most a name may be.
    await run('room_rename', { roomId: 'r1', name: ` ${'x'.repeat(60)} ` }, h.ctx);
    expect(opsSent(h)).toEqual([{ type: 'rename', roomId: 'r1', name: 'x'.repeat(60) }]);
  });

  it('a name with a line or paragraph separator (U+2028, U+2029) is INVALID, whatever else is in it (D-M6)', async () => {
    const h = world();

    for (const name of ['two\u2028lines', 'two\u2029paragraphs', 'Back\u2028end']) {
      expect((await runRefused('room_create', { name }, h.ctx)).code, JSON.stringify(name)).toBe('INVALID');
      expect((await runRefused('room_rename', { roomId: 'r1', name }, h.ctx)).code, JSON.stringify(name)).toBe('INVALID');
    }
    expect(opsSent(h)).toEqual([]);
  });

  it('a duplicate name is INVALID', async () => {
    const h = world();

    expect((await runRefused('room_create', { name: 'Backend' }, h.ctx)).code).toBe('INVALID');
    expect((await runRefused('room_create', { name: ' backend ' }, h.ctx)).code).toBe('INVALID');
    expect((await runRefused('room_rename', { roomId: 'r1', name: 'Frontend' }, h.ctx)).code).toBe('INVALID');
    expect(opsSent(h)).toEqual([]);
    // Its own name is not another room's.
    await run('room_rename', { roomId: 'r1', name: 'Backend' }, h.ctx);
    expect(opsSent(h)).toHaveLength(1);
  });

  it('judges a duplicate among the rooms the central can see only: another project’s room name is not told', async () => {
    const h = world({ kind: 'project', scopeRef: '/a/proj' });

    const result = await run('room_create', { name: 'Other', firstSession: 's1' }, h.ctx);

    expect(result.data).toEqual({ roomId: 'r-new', pending: false });
  });
});

// ---------------------------------------------------------------------------
// Cards and the route's answers
// ---------------------------------------------------------------------------

describe('the card rails and the route’s answers', () => {
  it('moving a hands-off card is HANDS_OFF', async () => {
    const h = world({ sessions: [makeSession('s1', { terminalId: 'term-s1', handsOff: true }), s2, other] });

    expect((await runRefused('room_move_session', { sessionId: 's1', roomId: 'r2' }, h.ctx)).code).toBe('HANDS_OFF');
    expect((await runRefused('room_create', { name: 'Ops', firstSession: 's1' }, h.ctx)).code).toBe('HANDS_OFF');
    expect(opsSent(h)).toEqual([]);
  });

  it('never files a central’s own card or an ops shell', async () => {
    const own = makeSession('c1', { terminalId: 'term-central' });
    const ops = makeSession('ops1', { terminalId: 'term-ops' });
    const h = world({ sessions: [own, ops, s1], isOpsTerminal: (t) => t === 'term-ops' });

    expect((await runRefused('room_move_session', { sessionId: 'c1', roomId: 'r1' }, h.ctx)).code).toBe('INVALID');
    expect((await runRefused('room_move_session', { sessionId: 'ops1', roomId: 'r1' }, h.ctx)).code).toBe('INVALID');
    expect(opsSent(h)).toEqual([]);
  });

  it('no writer is NO_WINDOW', async () => {
    const h = world({ answer: fail(409, 'no-writer') });

    for (const [name, args] of [
      ['room_create', { name: 'Ops' }],
      ['room_rename', { roomId: 'r1', name: 'API' }],
      ['room_move_session', { sessionId: 's1', roomId: 'r2' }],
    ] as const) {
      expect((await runRefused(name, args, h.ctx)).code, name).toBe('NO_WINDOW');
    }
  });

  it('turns the route’s other refusals into DENIED, BUDGET and NOT_FOUND', async () => {
    const hidden = world({ answer: fail(409, 'room-has-hidden-sessions') });
    const budget = world({ answer: fail(429, 'Too many room changes; try again in a moment') });
    const gone = world({ answer: fail(404, 'Room not found') });

    expect((await runRefused('room_delete', { roomId: 'r1' }, hidden.ctx)).code).toBe('DENIED');
    expect((await runRefused('room_delete', { roomId: 'r1' }, budget.ctx)).code).toBe('BUDGET');
    expect((await runRefused('room_delete', { roomId: 'r1' }, gone.ctx)).code).toBe('NOT_FOUND');
  });

  it('a room id nobody has is NOT_FOUND before anything is sent', async () => {
    const h = world();

    expect((await runRefused('room_rename', { roomId: 'nope', name: 'API' }, h.ctx)).code).toBe('NOT_FOUND');
    expect((await runRefused('room_delete', { roomId: 'nope' }, h.ctx)).code).toBe('NOT_FOUND');
    expect((await runRefused('room_move_session', { sessionId: 's1', roomId: 'nope' }, h.ctx)).code).toBe('NOT_FOUND');
    expect(opsSent(h)).toEqual([]);
  });

  it('reorder must name every visible room once', async () => {
    const h = world();

    for (const roomIds of [['r1', 'r2'], ['r1', 'r2', 'r3', 'r3'], ['r1', 'r2', 'r3', 'r4'], ['r1', 'r1', 'r2']]) {
      expect((await runRefused('room_reorder', { roomIds }, h.ctx)).code, roomIds.join()).toBe('INVALID');
    }
    expect(opsSent(h)).toEqual([]);
    await run('room_reorder', { roomIds: ['r2', 'r3', 'r1'] }, h.ctx);
    expect(opsSent(h)).toEqual([{ type: 'reorder', roomIds: ['r2', 'r3', 'r1'] }]);
  });

  it('writes AASC’s words and ids to the activity log, never the name the central wrote', async () => {
    const h = world();

    const renamed = await run('room_rename', { roomId: 'r1', name: 'Totally new name' }, h.ctx);
    const moved = await run('room_move_session', { sessionId: 's1', roomId: 'r2' }, h.ctx);

    expect(JSON.stringify(renamed.activity)).not.toContain('Totally new name');
    expect(renamed.activity?.[0]).toMatchObject({ detail: { roomId: 'r1' } });
    expect(moved.activity?.[0]).toMatchObject({ targetSessionId: 's1', detail: { roomId: 'r2' } });
  });
});
