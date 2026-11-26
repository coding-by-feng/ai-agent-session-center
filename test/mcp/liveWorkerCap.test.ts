// test/mcp/liveWorkerCap.test.ts — the live-worker cap is a setting (server/mcp/routerConfig.ts `liveWorkerCap`):
// `mcp.maxLiveWorkers` (default 8) and a room central's own `mcp.roomMaxLiveWorkers`. session_create's opener
// (openWorker.ts) refuses past it naming the setting and its value, and scope_get shows it. The per-minute open
// limit is untouched. server-config.json is replaced by an in-memory object; nothing reaches a disk or a process.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { MAX_OPENS_PER_MINUTE, openWorker, type OpenWorkerDeps } from '../../server/mcp/openWorker.js';
import {
  LIVE_WORKERS_DEFAULT,
  LIVE_WORKERS_MAX,
  liveWorkerCap,
} from '../../server/mcp/routerConfig.js';
import { ToolError, type CentralRecord } from '../../server/mcp/types.js';
import { createWorkerRegistry, type WorkerRegistry } from '../../server/mcp/workers.js';
import { dataOf, makeCentral, makeCtx, makeRoom, makeSession, NOW, ok, run } from './toolHarness.js';

const fileConfig = vi.hoisted(() => ({ mcp: {} as Record<string, unknown> }));

vi.mock('../../server/serverConfig.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/serverConfig.js')>()),
  config: fileConfig,
}));

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const HOME = '/home/u';
const KNOWN = `${HOME}/known`;
const PIPELINE = 'room-pipeline';
const OTHER = 'room-other';
const ROOMS = [makeRoom(PIPELINE, [], 'Content Pipeline'), makeRoom(OTHER, [], 'Backend')];

beforeEach(() => {
  fileConfig.mcp = {};
});

// ---------------------------------------------------------------------------
// The setting itself
// ---------------------------------------------------------------------------

describe('liveWorkerCap', () => {
  const room = (id: string) => ({ kind: 'room', scopeRef: id });
  const global = { kind: 'global', scopeRef: null };

  it('is 8 from mcp.maxLiveWorkers when nothing is set', () => {
    expect(LIVE_WORKERS_DEFAULT).toBe(8);
    expect(liveWorkerCap(global, ROOMS, undefined)).toEqual({ max: 8, setting: 'mcp.maxLiveWorkers' });
    expect(liveWorkerCap(room(PIPELINE), ROOMS, {})).toEqual({ max: 8, setting: 'mcp.maxLiveWorkers' });
  });

  it('takes the global value, and a room’s own value only for that room’s central', () => {
    const mcp = { maxLiveWorkers: 10, roomMaxLiveWorkers: { [PIPELINE]: 15 } };
    expect(liveWorkerCap(room(PIPELINE), ROOMS, mcp)).toEqual({ max: 15, setting: 'mcp.roomMaxLiveWorkers' });
    expect(liveWorkerCap(room(OTHER), ROOMS, mcp)).toEqual({ max: 10, setting: 'mcp.maxLiveWorkers' });
    expect(liveWorkerCap(global, ROOMS, mcp)).toEqual({ max: 10, setting: 'mcp.maxLiveWorkers' });
    expect(liveWorkerCap({ kind: 'project', scopeRef: PIPELINE }, ROOMS, mcp).max).toBe(10);
  });

  it('a room may be named instead of its id, unless two rooms share the name', () => {
    const mcp = { roomMaxLiveWorkers: { 'Content Pipeline': 15 } };
    expect(liveWorkerCap(room(PIPELINE), ROOMS, mcp).max).toBe(15);
    expect(liveWorkerCap(room(OTHER), ROOMS, mcp).max).toBe(8);
    const twins = [...ROOMS, makeRoom('room-twin', [], 'Content Pipeline')];
    expect(liveWorkerCap(room(PIPELINE), twins, mcp).max).toBe(8);
    // The id wins over a name.
    expect(liveWorkerCap(room(PIPELINE), ROOMS, { roomMaxLiveWorkers: { 'Content Pipeline': 15, [PIPELINE]: 12 } }).max).toBe(12);
  });

  it('whole sessions from 1 to 50; anything else counts as unset', () => {
    const cap = (v: unknown) => liveWorkerCap(global, ROOMS, { maxLiveWorkers: v } as never).max;
    expect(cap(15.9)).toBe(15);
    expect(cap(500)).toBe(LIVE_WORKERS_MAX);
    for (const bad of [0, -3, 0.5, Number.NaN, '15', null, true]) expect(cap(bad)).toBe(8);
    const roomCap = (v: unknown) => liveWorkerCap(room(PIPELINE), ROOMS, { maxLiveWorkers: 9, roomMaxLiveWorkers: v } as never);
    expect(roomCap({ [PIPELINE]: 'many' })).toEqual({ max: 9, setting: 'mcp.maxLiveWorkers' });
    expect(roomCap([15])).toEqual({ max: 9, setting: 'mcp.maxLiveWorkers' });
  });

  it('reads server-config.json’s mcp when none is given', () => {
    fileConfig.mcp = { roomMaxLiveWorkers: { [PIPELINE]: 15 } };
    expect(liveWorkerCap(room(PIPELINE), ROOMS)).toEqual({ max: 15, setting: 'mcp.roomMaxLiveWorkers' });
  });
});

// ---------------------------------------------------------------------------
// session_create's opener and scope_get, with the setting in the file
// ---------------------------------------------------------------------------

/** A central whose card is live, a worker registry, and opens that each get a new terminal on a clock it moves. */
function harness(central: CentralRecord, workers: WorkerRegistry = createWorkerRegistry({ controller: () => null })) {
  const sessions: Session[] = [
    makeSession(`card-${central.centralId}`, {
      terminalId: central.terminalId,
      status: 'waiting',
      permissionMode: 'default',
      central: { centralId: central.centralId, kind: central.kind, scopeRef: central.scopeRef },
    }),
  ];
  let opened = 0;
  let clock = NOW;
  const h = makeCtx({
    central,
    sessions,
    rooms: ROOMS,
    workers,
    routes: {
      'POST /terminals': () => {
        opened += 1;
        return ok({ ok: true, terminalId: `term-${central.centralId}-${opened}` });
      },
      'POST /rooms/ops': ok({ ok: true, opId: 'op' }, 202),
    },
  });
  const deps: OpenWorkerDeps = {
    knownProjects: async () => [KNOWN],
    home: HOME,
    realpath: async (p) => p,
    planWindowPct: () => null,
    now: () => clock,
    workers,
  };
  /** Opens one worker a while after the last (so the minute's limit never refuses) and puts its card on the board. */
  async function openOne(): Promise<void> {
    clock += 7_000;
    const w = await openWorker(h.ctx, { cli: 'claude', folder: KNOWN, title: `Worker ${opened + 1}` }, deps);
    sessions.push(makeSession(w.terminalId, { terminalId: w.terminalId, status: 'waiting' }));
  }
  return { ...h, deps, workers, openOne, opens: () => opened };
}

async function refusal(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('a ToolError was expected');
}

const roomCentral = (id: string, centralId: string) => makeCentral('room', id, { centralId, terminalId: `term-${centralId}` });

describe('the cap when a central opens its own sessions', () => {
  it('stays 8 by default: the 9th is refused naming mcp.maxLiveWorkers = 8', async () => {
    const h = harness(makeCentral('global', null, { terminalId: 'term-c' }));
    for (let i = 0; i < 8; i += 1) await h.openOne();
    const err = await refusal(h.openOne());
    expect(err).toMatchObject({
      code: 'BUDGET',
      message: 'You keep at most 8 sessions of your own open (setting mcp.maxLiveWorkers = 8).',
    });
    expect(h.opens()).toBe(8);
  });

  it('a room set to 15 allows 15 and refuses the 16th, naming the room setting and its value', async () => {
    fileConfig.mcp = { roomMaxLiveWorkers: { [PIPELINE]: 15 } };
    const h = harness(roomCentral(PIPELINE, 'central-pipeline'));
    for (let i = 0; i < 15; i += 1) await h.openOne();
    expect(h.workers.liveCount('central-pipeline', h.ctx.sessions())).toBe(15);

    const err = await refusal(h.openOne());
    expect(err).toMatchObject({
      code: 'BUDGET',
      message: 'You keep at most 15 sessions of your own open (setting mcp.roomMaxLiveWorkers for your room = 15).',
    });
    expect(h.opens()).toBe(15);
  });

  it('other rooms are unaffected: their central still stops at 8', async () => {
    fileConfig.mcp = { roomMaxLiveWorkers: { [PIPELINE]: 15 } };
    const workers = createWorkerRegistry({ controller: () => null });
    const pipeline = harness(roomCentral(PIPELINE, 'central-pipeline'), workers);
    const other = harness(roomCentral(OTHER, 'central-other'), workers);
    for (let i = 0; i < 10; i += 1) await pipeline.openOne();
    for (let i = 0; i < 8; i += 1) await other.openOne();
    expect((await refusal(other.openOne())).message).toBe(
      'You keep at most 8 sessions of your own open (setting mcp.maxLiveWorkers = 8).',
    );
    // The pipeline's 11th still opens: the other room's full cap is not its own.
    await pipeline.openOne();
    expect(pipeline.opens()).toBe(11);
  });

  it('keeps the per-minute open limit whatever the cap', async () => {
    fileConfig.mcp = { roomMaxLiveWorkers: { [PIPELINE]: 15 } };
    const h = harness(roomCentral(PIPELINE, 'central-pipeline'));
    for (let i = 0; i < MAX_OPENS_PER_MINUTE; i += 1) {
      await openWorker(h.ctx, { cli: 'claude', folder: KNOWN, title: `Burst ${i}` }, h.deps);
    }
    const err = await refusal(openWorker(h.ctx, { cli: 'claude', folder: KNOWN, title: 'One more' }, h.deps));
    expect(err).toMatchObject({ code: 'BUDGET', message: `A central opens at most ${MAX_OPENS_PER_MINUTE} sessions a minute.` });
  });
});

describe('scope_get shows the cap', () => {
  interface OwnWorkers {
    ownWorkers: { live: number; max: number; setting: string };
  }

  it('a room set to 15 reads 15 from mcp.roomMaxLiveWorkers, with its own open count', async () => {
    fileConfig.mcp = { roomMaxLiveWorkers: { [PIPELINE]: 15 } };
    const h = harness(roomCentral(PIPELINE, 'central-pipeline'));
    for (let i = 0; i < 3; i += 1) await h.openOne();
    const data = await dataOf<OwnWorkers>('scope_get', {}, h.ctx);
    expect(data.ownWorkers).toEqual({ live: 3, max: 15, setting: 'mcp.roomMaxLiveWorkers' });
    expect((await run('scope_get', {}, h.ctx)).summary).toContain('Your own sessions open: 3 of at most 15 (mcp.roomMaxLiveWorkers).');
  });

  it('any other central reads the global setting', async () => {
    fileConfig.mcp = { maxLiveWorkers: 6, roomMaxLiveWorkers: { [PIPELINE]: 15 } };
    for (const central of [roomCentral(OTHER, 'central-other'), makeCentral('global', null, { terminalId: 'term-g' })]) {
      const data = await dataOf<OwnWorkers>('scope_get', {}, harness(central).ctx);
      expect(data.ownWorkers).toEqual({ live: 0, max: 6, setting: 'mcp.maxLiveWorkers' });
    }
  });
});
