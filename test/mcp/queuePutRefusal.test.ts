// test/mcp/queuePutRefusal.test.ts — Ruling 54's server stopgap. When the server refuses the AASC window's save of a
// queue (`PUT /sessions/:id/queue`: a list over the 8 MB cap, two pasted screenshots are enough), the window keeps its
// list and the server keeps an older one. A central's write is built from the server's row and told to every window,
// so it would replace the edits the window could not save and bring back prompts the window already sent. So the PUT
// route records the refusal (server/mcp/queuePutRefusals.ts) and the server's queue store refuses a central's write for
// that session, UNAVAILABLE in AASC's words, until a PUT of it succeeds again.
//
// The real API router and the real queue store (queueWiring.ts) run over an in-memory `session_queues`; the router gets
// the 50 MB body limit the server gives it (server/index.ts), so an oversized queue reaches the route as it does live.
import express from 'express';
import { createServer, type Server } from 'http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addItem, applyQueueOp } from '../../server/mcp/queueOps.js';
import { item, NOW } from './queueFixtures.js';

const mem = vi.hoisted(() => ({ queues: new Map<string, { items: unknown[]; automation: unknown }>() }));

vi.mock('../../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []),
  dbHandle: () => null,
  getSessionQueue: (id: string) => {
    const q = mem.queues.get(id);
    return q ? { sessionId: id, items: q.items, automation: q.automation, updatedAt: 1 } : null;
  },
  upsertSessionQueue: (id: string, items: unknown[], automation: unknown) => {
    mem.queues.set(id, { items, automation });
    return { sessionId: id, items, automation, updatedAt: Date.now() };
  },
  default: {},
}));

const UNSAVED = 'This queue’s last save from the AASC window failed, so AASC can’t change it safely.';
const FIX_FIRST = 'Open AASC and fix the queue first.';

/** Over the route's 8 MB cap, as two Retina screenshots pasted into one prompt would be. */
const SCREENSHOTS = 'x'.repeat(8 * 1024 * 1024 + 1);

let server: Server;
let base = '';

beforeAll(async () => {
  const { default: apiRouter } = await import('../../server/apiRouter.js');
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api', apiRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : '';
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** The window's save of a session's queue. */
async function windowSaves(sessionId: string, body: unknown): Promise<number> {
  const res = await fetch(`${base}/api/sessions/${sessionId}/queue`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

/** A central's `queue_add_item`, as its tool applies it: one read-modify-write on the server's own store. */
async function centralAdds(sessionId: string): Promise<void> {
  const { serverQueueStore } = await import('../../server/mcp/queueWiring.js');
  applyQueueOp(serverQueueStore(), sessionId, (state) => addItem(state, { sessionId, text: 'from a central', disabled: true }, NOW), 'mcp:central-1');
}

describe('a central write after the AASC window’s save was refused', () => {
  it('a central write is refused while the window’s last PUT was refused, and allowed after a good PUT', async () => {
    mem.queues.set('pq-1', { items: [item(1, { sessionId: 'pq-1' })], automation: null });

    const refused = await windowSaves('pq-1', { items: [item(1), item(2, { text: SCREENSHOTS, position: 1 })], originClientId: 'win-1' });
    expect(refused).toBe(400);

    const err = await centralAdds('pq-1').then(
      () => null,
      (e: unknown) => e as { code: string; message: string; hint: string },
    );
    expect(err).toMatchObject({ code: 'UNAVAILABLE', message: UNSAVED, hint: FIX_FIRST });
    expect(mem.queues.get('pq-1')?.items).toEqual([item(1, { sessionId: 'pq-1' })]); // nothing was written

    expect(await windowSaves('pq-1', { items: [item(1), item(2, { position: 1 })], originClientId: 'win-1' })).toBe(200);
    await centralAdds('pq-1');
    expect(mem.queues.get('pq-1')?.items).toHaveLength(3);
  });

  it('counts any refused save, not only an oversized one', async () => {
    expect(await windowSaves('pq-2', { items: 'not a list', originClientId: 'win-1' })).toBe(400);

    await expect(centralAdds('pq-2')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('holds back only the session whose save was refused', async () => {
    expect(await windowSaves('pq-3', { items: [item(1, { text: SCREENSHOTS })], originClientId: 'win-1' })).toBe(400);
    mem.queues.set('pq-4', { items: [], automation: null });

    await expect(centralAdds('pq-3')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await centralAdds('pq-4');
    expect(mem.queues.get('pq-4')?.items).toHaveLength(1);
  });

  it('lets a central write a session whose saves have only ever gone through', async () => {
    expect(await windowSaves('pq-5', { items: [item(1)], originClientId: 'win-1' })).toBe(200);

    await centralAdds('pq-5');

    expect(mem.queues.get('pq-5')?.items).toHaveLength(2);
  });

  it('another window’s good save does not clear the refused window’s mark (Ruling P4-32)', async () => {
    expect(await windowSaves('pq-6', { items: [item(1, { text: SCREENSHOTS })], originClientId: 'win-1' })).toBe(400);
    expect(await windowSaves('pq-6', { items: [item(1)], originClientId: 'win-2' })).toBe(200);

    await expect(centralAdds('pq-6')).rejects.toMatchObject({ code: 'UNAVAILABLE' });

    expect(await windowSaves('pq-6', { items: [item(1)], originClientId: 'win-1' })).toBe(200);
    await centralAdds('pq-6');
  });
});
