// test/queuePutVersion.test.ts — PUT /sessions/:id/queue refuses a list built on an old copy.
//
// The shared queue is stored whole, so a device that missed an update (a phone whose socket died
// while it slept) and then saves an edit puts back everything it last saw. On Nov 7 2026 that
// brought back a prompt the Mac's queue had already sent, and it waited to be sent a second time.
// A save now names the version it was built on (`baseUpdatedAt`); a stale one gets 409 and the
// current list, and changes nothing.
import express from 'express';
import { createServer, type Server } from 'http';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const mem = vi.hoisted(() => ({
  queues: new Map<string, { items: unknown[]; automation: unknown; updatedAt: number }>(),
  clock: 1000,
}));

vi.mock('../server/db.js', async () => {
  const { nextQueueVersion } = await import('../server/sessionQueueCodec.js');
  return {
    upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
    updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
    insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
    deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []),
    dbHandle: () => null,
    getSessionQueue: (id: string) => {
      const q = mem.queues.get(id);
      return q ? { sessionId: id, ...q } : null;
    },
    upsertSessionQueue: (id: string, items: unknown[], automation: unknown) => {
      const updatedAt = nextQueueVersion(mem.queues.get(id)?.updatedAt, mem.clock);
      mem.queues.set(id, { items, automation, updatedAt });
      return { sessionId: id, items, automation, updatedAt };
    },
    default: {},
  };
});

vi.mock('../server/queueSent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/queueSent.js')>();
  return { ...actual, sqliteQueueSentStore: () => actual.memoryQueueSentStore() };
});

let server: Server;
let base = '';

async function put(sessionId: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/sessions/${sessionId}/queue`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const item = (id: number) => ({ id, sessionId: 'qv', text: `prompt ${id}`, position: id - 1, createdAt: 1 });

beforeAll(async () => {
  const store = await import('../server/sessionStore.js');
  await store.createTerminalSession('qv', { host: 'localhost', workingDir: '/tmp/qv', command: 'claude' });
  const { default: apiRouter } = await import('../server/apiRouter.js');
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : '';
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  mem.queues.clear();
  mem.clock = 1000;
});

describe('PUT /sessions/:id/queue with a base version', () => {
  it('writes when the base is the stored version, and answers with the new one', async () => {
    mem.queues.set('qv', { items: [item(1), item(2)], automation: null, updatedAt: 1000 });
    const res = await put('qv', { items: [item(2)], automation: null, originClientId: 'phone:1', baseUpdatedAt: 1000 });
    expect(res.status).toBe(200);
    expect(res.json.updatedAt).toBe(1001);
    expect(mem.queues.get('qv')!.items).toEqual([item(2)]);
  });

  it('refuses a list built on an older version: 409, the current list, nothing written', async () => {
    // The Mac's queue sent prompt 1 and saved [2, 3]; the phone still holds [1, 2, 3] from version 900.
    mem.queues.set('qv', { items: [item(2), item(3)], automation: { autoSend: true }, updatedAt: 1000 });
    const res = await put('qv', { items: [item(1), item(2)], automation: null, originClientId: 'phone:1', baseUpdatedAt: 900 });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({
      success: false,
      code: 'stale',
      queue: { items: [item(2), item(3)], automation: { autoSend: true }, updatedAt: 1000 },
    });
    expect(mem.queues.get('qv')!.items).toEqual([item(2), item(3)]);
  });

  it('a refused stale save does not hold back the central queue tools', async () => {
    // The refusal mark means "this window holds a list the server lacks"; a stale save is the
    // opposite, and a closing window's last save is never followed by one that would clear it.
    const { lastQueuePutRefused } = await import('../server/mcp/queuePutRefusals.js');
    mem.queues.set('qv', { items: [item(2)], automation: null, updatedAt: 1000 });
    const res = await put('qv', { items: [item(1), item(2)], automation: null, originClientId: 'phone:closing', baseUpdatedAt: 900 });
    expect(res.status).toBe(409);
    expect(lastQueuePutRefused('qv')).toBe(false);
  });

  it('writes as before when the save names no version', async () => {
    mem.queues.set('qv', { items: [item(1)], automation: null, updatedAt: 1000 });
    const res = await put('qv', { items: [item(9)], automation: null, originClientId: 'old:1' });
    expect(res.status).toBe(200);
    expect(mem.queues.get('qv')!.items).toEqual([item(9)]);
  });

  it('writes the first record whatever base it names', async () => {
    const res = await put('qv', { items: [item(1)], automation: null, originClientId: 'phone:1', baseUpdatedAt: 5 });
    expect(res.status).toBe(200);
    expect(mem.queues.get('qv')!.items).toEqual([item(1)]);
  });

  it('refuses a base that is not a whole number', async () => {
    const res = await put('qv', { items: [], automation: null, originClientId: 'phone:1', baseUpdatedAt: 'yesterday' });
    expect(res.status).toBe(400);
  });
});
