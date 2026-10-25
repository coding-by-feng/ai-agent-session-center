// test/sharedPromptData.test.ts — AASC-20: saved prompts, the QUEUE badge record and the paused append,
// all kept on the Mac. The routers run on in-memory stores; the API-level checks (visibility, phones)
// go through the real apiRouter with an in-memory SQLite handle.
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import express from 'express';
import { createServer, type Server } from 'http';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPromptSnippetRouter, memorySnippetStore, MAX_SNIPPETS, type PromptSnippetList } from '../server/promptSnippets.js';
import { createQueueSentRouter, memoryQueueSentStore, QUEUE_SENT_KEEP } from '../server/queueSent.js';
import { appendPausedItem } from '../server/sessionQueueCodec.js';

const mem = vi.hoisted(() => ({ queues: new Map<string, { items: unknown[]; automation: unknown }>() }));

vi.mock('../server/db.js', () => ({
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

// better-sqlite3 here is built for Electron, so the API router gets the memory
// stores; the SQL itself is exercised below on node:sqlite, which shares its API.
vi.mock('../server/promptSnippets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/promptSnippets.js')>();
  return { ...actual, sqliteSnippetStore: () => actual.memorySnippetStore() };
});
vi.mock('../server/queueSent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/queueSent.js')>();
  return { ...actual, sqliteQueueSentStore: () => actual.memoryQueueSentStore() };
});

async function serve(router: express.Router): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  return { server, base: addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : '' };
}

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

describe('saved prompts on the Mac', () => {
  let server: Server;
  let base = '';
  let clock = 1_000;
  const broadcasts: PromptSnippetList[] = [];
  beforeAll(async () => {
    ({ server, base } = await serve(createPromptSnippetRouter({
      store: (() => { const s = memorySnippetStore(); return () => s; })(),
      broadcast: (list) => broadcasts.push(list),
      now: () => clock,
    })));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => { clock += 10; });

  it('saves trimmed text, answers with the whole list and broadcasts it', async () => {
    const res = await call(base, 'POST', '/snippets', { text: '  run the tests  ', label: ' tests ' });
    expect(res.status).toBe(200);
    expect(res.json.duplicate).toBe(false);
    expect((res.json.snippets as Array<{ text: string; label: string }>)[0]).toMatchObject({ text: 'run the tests', label: 'tests' });
    expect(broadcasts.at(-1)?.revision).toBe(res.json.revision);
  });

  it('reports a duplicate without writing or broadcasting', async () => {
    const before = broadcasts.length;
    const res = await call(base, 'POST', '/snippets', { text: 'run the tests' });
    expect(res.json.duplicate).toBe(true);
    expect(broadcasts).toHaveLength(before);
  });

  it('renames, counts uses and deletes; every change has a newer revision', async () => {
    const list = await call(base, 'GET', '/snippets');
    const id = (list.json.snippets as Array<{ id: number }>)[0].id;
    const r1 = await call(base, 'PATCH', `/snippets/${id}`, { label: 'renamed' });
    const r2 = await call(base, 'POST', `/snippets/${id}/use`);
    expect((r2.json.snippets as Array<{ useCount: number; label: string }>)[0]).toMatchObject({ useCount: 1, label: 'renamed' });
    const r3 = await call(base, 'DELETE', `/snippets/${id}`);
    expect(r3.json.snippets).toEqual([]);
    expect(Number(r1.json.revision)).toBeLessThan(Number(r2.json.revision));
    expect(Number(r2.json.revision)).toBeLessThan(Number(r3.json.revision));
    expect((await call(base, 'DELETE', `/snippets/${id}`)).status).toBe(200); // already gone is fine
  });

  it('refuses blank text, an over-long name and unknown ids', async () => {
    expect((await call(base, 'POST', '/snippets', { text: '   ' })).status).toBe(400);
    expect((await call(base, 'PATCH', '/snippets/1', { label: 'x'.repeat(121) })).status).toBe(400);
    expect((await call(base, 'POST', '/snippets/999/use')).status).toBe(404);
  });

  it('imports a browser’s old library once by text, keeping what the Mac already holds', async () => {
    await call(base, 'POST', '/snippets', { text: 'already here', label: 'mac' });
    const res = await call(base, 'POST', '/snippets/import', {
      snippets: [{ text: 'already here', label: 'browser' }, { text: 'from the browser', useCount: 3, createdAt: 5 }],
    });
    expect(res.json).toMatchObject({ added: 1, skipped: 0 });
    const texts = (res.json.snippets as Array<{ text: string; label: string }>);
    expect(texts.find((s) => s.text === 'already here')?.label).toBe('mac');
    expect(texts.find((s) => s.text === 'from the browser')).toBeTruthy();
    const again = await call(base, 'POST', '/snippets/import', { snippets: [{ text: 'from the browser' }] });
    expect(again.json.added).toBe(0);
  });

  it('caps the library', async () => {
    const store = memorySnippetStore();
    for (let i = 0; i < MAX_SNIPPETS; i++) store.insert({ text: `p${i}`, label: '', useCount: 0, lastUsedAt: null, createdAt: i });
    const { server: s2, base: b2 } = await serve(createPromptSnippetRouter({ store: () => store, broadcast: () => {} }));
    expect((await call(b2, 'POST', '/snippets', { text: 'one more' })).status).toBe(409);
    await new Promise<void>((r) => s2.close(() => r()));
  });
});

describe('the QUEUE badge record on the Mac', () => {
  it('stores the normalized head per session and reads it back across a re-key', async () => {
    const store = memoryQueueSentStore();
    const aliases = new Map([['term-1', 'uuid-1']]);
    const sent: unknown[] = [];
    const { server, base } = await serve(createQueueSentRouter({
      store: () => store,
      resolveSessionId: (id) => aliases.get(id) ?? id,
      broadcast: (m) => sent.push(m),
      now: () => 42,
    }));
    store.add({ sessionId: 'term-1', text: 'sent before the re-key', sentAt: 1 });
    await call(base, 'POST', '/sessions/uuid-1/queue/sent', { text: '  hello\n  world  ' });
    await call(base, 'POST', '/sessions/other/queue/sent', { text: 'elsewhere', sentAt: 7 });
    const res = await call(base, 'GET', '/sessions/uuid-1/queue/sent');
    expect(res.json.sent).toEqual([{ text: 'sent before the re-key', sentAt: 1 }, { text: 'hello world', sentAt: 42 }]);
    expect(sent).toEqual([{ sessionId: 'uuid-1', text: 'hello world', sentAt: 42 }, { sessionId: 'other', text: 'elsewhere', sentAt: 7 }]);
    expect((await call(base, 'POST', '/sessions/x/queue/sent', {})).status).toBe(400);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('appendPausedItem', () => {
  it('adds the prompt last, paused, with an id the queue doesn’t use', () => {
    const items = [{ id: 5_000, position: 0, text: 'a' }, { id: 9_000, position: 1, text: 'b' }];
    const out = appendPausedItem(items, 's1', 'shared text', 100);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ id: 9_001, sessionId: 's1', text: 'shared text', position: 2, createdAt: 100, disabled: true });
    expect(items).toHaveLength(2); // the stored list is not mutated
    expect((appendPausedItem([], 's1', 'x', 777)[0] as { id: number }).id).toBe(777);
  });
});

// ── Through the real API router: visibility and the paused append ─────────────────────────────

describe('through the API router', () => {
  let server: Server;
  let base = '';
  let store: typeof import('../server/sessionStore.js');
  const REMOTE: Record<string, string> = { 'X-Forwarded-For': '192.168.1.70' };

  beforeAll(async () => {
    store = await import('../server/sessionStore.js');
    const { createToken } = await import('../server/authManager.js');
    REMOTE.Authorization = `Bearer ${createToken()}`;
    await store.createTerminalSession('sh-shared', { host: 'localhost', workingDir: '/tmp/sh/s', command: 'claude' });
    await store.createTerminalSession('sh-hidden', { host: 'localhost', workingDir: '/tmp/sh/h', command: 'claude' });
    store.setSessionRemoteVisible('sh-shared', true);
    const { default: apiRouter } = await import('../server/apiRouter.js');
    ({ server, base } = await serve(apiRouter));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('a remote device reads and adds sent records only for shared sessions', async () => {
    await call(base, 'POST', '/sessions/sh-hidden/queue/sent', { text: 'secret prompt' });
    expect((await call(base, 'GET', '/sessions/sh-hidden/queue/sent', undefined, REMOTE)).status).toBe(404);
    expect((await call(base, 'POST', '/sessions/sh-hidden/queue/sent', { text: 'x' }, REMOTE)).status).toBe(404);
    await call(base, 'POST', '/sessions/sh-shared/queue/sent', { text: 'shared prompt' }, REMOTE);
    const res = await call(base, 'GET', '/sessions/sh-shared/queue/sent', undefined, REMOTE);
    expect((res.json.sent as Array<{ text: string }>).map((r) => r.text)).toEqual(['shared prompt']);
  });

  it('serves saved prompts to a remote device as the same library', async () => {
    await call(base, 'POST', '/snippets', { text: 'kept on the mac' });
    const res = await call(base, 'GET', '/snippets', undefined, REMOTE);
    expect((res.json.snippets as Array<{ text: string }>).map((s) => s.text)).toEqual(['kept on the mac']);
  });

  it('appends a shared prompt paused, and never for a hidden session from a remote device', async () => {
    mem.queues.set('sh-shared', { items: [{ id: 1, position: 0, text: 'existing' }], automation: { paused: false } });
    const res = await call(base, 'POST', '/sessions/sh-shared/queue/items', { text: '  from the share sheet ' }, REMOTE);
    expect(res.status).toBe(200);
    const q = mem.queues.get('sh-shared')!;
    expect(q.items).toHaveLength(2);
    expect(q.items[1]).toMatchObject({ text: 'from the share sheet', disabled: true, sessionId: 'sh-shared' });
    expect(q.automation).toEqual({ paused: false });
    expect((await call(base, 'POST', '/sessions/sh-hidden/queue/items', { text: 'x' }, REMOTE)).status).toBe(404);
    expect((await call(base, 'POST', '/sessions/sh-shared/queue/items', { text: '   ' }, REMOTE)).status).toBe(400);
  });

  it('appends shared images (paused), and refuses anything that isn’t a readable image', async () => {
    mem.queues.set('sh-shared', { items: [], automation: null });
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const res = await call(base, 'POST', '/sessions/sh-shared/queue/items', { images: [{ name: 'shot/../1.png', dataUrl: png }] }, REMOTE);
    expect(res.status).toBe(200);
    expect(mem.queues.get('sh-shared')!.items[0]).toMatchObject({ text: '', disabled: true, images: [{ name: 'shot..1.png', dataUrl: png }] });
    for (const images of [
      [{ name: 'x', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }],
      [{ name: 'x', dataUrl: 'data:text/html;base64,PGI+' }],
      Array.from({ length: 11 }, () => ({ name: 'x', dataUrl: png })), // 10 since Oct 21 2026 (was 4)
    ]) {
      expect((await call(base, 'POST', '/sessions/sh-shared/queue/items', { images }, REMOTE)).status).toBe(400);
    }
  });

  it('a queue_sent broadcast never reaches a device the session is hidden from', async () => {
    const ws = await import('../server/wsManager.js');
    class FakeSocket extends EventEmitter {
      readyState = 1; bufferedAmount = 0; sent: string[] = [];
      send = vi.fn((raw: string) => { this.sent.push(raw); });
      ping = vi.fn(); terminate = vi.fn(); close = vi.fn();
    }
    const remote = new FakeSocket();
    ws.handleConnection(remote as never, { clientId: 'ipad-sh', label: 'iPad', address: '192.168.1.70', isLocal: false, lineage: 'l-sh' });
    remote.sent.length = 0;
    ws.broadcast({ type: 'queue_sent', sessionId: 'sh-hidden', text: 'secret', sentAt: 1 });
    ws.broadcast({ type: 'queue_sent', sessionId: 'sh-shared', text: 'fine', sentAt: 1 });
    expect(remote.sent.some((m) => m.includes('secret'))).toBe(false);
    expect(remote.sent.some((m) => m.includes('fine'))).toBe(true);
    remote.emit('close');
  });
});

// ── The SQL, on node:sqlite (same exec / prepare / run / get / all API as better-sqlite3) ──────

const sqlite = (): Database.Database => new DatabaseSync(':memory:') as unknown as Database.Database;

describe('SQLite stores', () => {
  // The real factories: the vi.mock above replaces them for the rest of this file.
  const real = async () => ({
    snippets: (await vi.importActual<typeof import('../server/promptSnippets.js')>('../server/promptSnippets.js')).sqliteSnippetStore,
    sent: (await vi.importActual<typeof import('../server/queueSent.js')>('../server/queueSent.js')).sqliteQueueSentStore,
  });

  it('saved prompts: insert, find by text, rename, use, remove, newest first', async () => {
    const s = (await real()).snippets(sqlite());
    const a = s.insert({ text: 'a', label: '', useCount: 0, lastUsedAt: null, createdAt: 1 });
    const b = s.insert({ text: 'b', label: 'B', useCount: 2, lastUsedAt: 5, createdAt: 2 });
    expect(s.list().map((r) => r.text)).toEqual(['b', 'a']);
    expect(s.findByText('b')).toMatchObject({ id: b, label: 'B', useCount: 2, lastUsedAt: 5 });
    expect(s.setLabel(a, 'A')).toBe(true);
    expect(s.markUsed(a, 9)).toBe(true);
    expect(s.findByText('a')).toMatchObject({ label: 'A', useCount: 1, lastUsedAt: 9 });
    expect(s.remove(b)).toBe(true);
    expect(s.remove(b)).toBe(false);
    expect(s.count()).toBe(1);
    expect(() => s.insert({ text: 'a', label: '', useCount: 0, lastUsedAt: null, createdAt: 3 })).toThrow();
  });

  it('sent records: kept in order and pruned to the newest', async () => {
    const s = (await real()).sent(sqlite());
    for (let i = 0; i < QUEUE_SENT_KEEP + 5; i++) s.add({ sessionId: 's1', text: `p${i}`, sentAt: i });
    const all = s.all();
    expect(all).toHaveLength(QUEUE_SENT_KEEP);
    expect(all[0].text).toBe('p5');
    expect(all.at(-1)).toEqual({ sessionId: 's1', text: `p${QUEUE_SENT_KEEP + 4}`, sentAt: QUEUE_SENT_KEEP + 4 });
  });
});
