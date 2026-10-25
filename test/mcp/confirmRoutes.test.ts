// test/mcp/confirmRoutes.test.ts — the person's side of a confirmation (server/mcp/confirmRoutes.ts, mounted by
// server/mcp/http.ts): GET /api/mcp/confirms, POST /api/mcp/confirm/:cardId, and the `mcp_confirm` /
// `mcp_confirm_resolved` feeds. Only this Mac's windows see a card, by its card id; the central's confirmId and the
// call's arguments never leave the server this way, and a central's own call can neither list nor answer one.
//
// The router is mounted on a real Express app on an ephemeral port, with the real `isLocalRequest`, over a real
// confirmation book. The AASC server is never started and nothing here reaches a terminal or a process.
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_CONFIRM, MCP_CONFIRM_RESOLVED } from '../../src/types/mcpConfirm.js';
import { createCentralRegistry, type CentralRegistry } from '../../server/mcp/centrals.js';
import { CONFIRM_TTL_MS, createConfirmBook, type ConfirmBook, type PendingConfirm } from '../../server/mcp/confirm.js';
import { confirmView } from '../../server/mcp/confirmRoutes.js';
import { createCentralsRouter, type CentralsFeedMessage, type CentralsRouterDeps } from '../../server/mcp/http.js';
import { globalInput, roomInput } from './centralFixtures.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const SECRET_ARG = 'central-argument-5d1e';
const SECRET_FINGERPRINT = 'snip-1|fingerprint-77b0';

interface Rig {
  port: number;
  registry: CentralRegistry;
  book: ConfirmBook;
  router: ReturnType<typeof createCentralsRouter>;
  sent: Array<[CentralsFeedMessage, null]>;
}

let server: Server | undefined;
const books: ConfirmBook[] = [];

async function rig(over: Partial<CentralsRouterDeps> = {}): Promise<Rig> {
  const registry = createCentralRegistry({ now: () => 1_700_000_000_000 });
  const book = createConfirmBook();
  books.push(book);
  const sent: Rig['sent'] = [];
  const router = createCentralsRouter({
    registry,
    sessions: () => [],
    broadcastByLocality: (local, remote) => {
      sent.push([local, remote]);
    },
    confirms: book,
    ...over,
  });
  const app = express();
  app.use('/api', router);
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, registry, book, router, sent };
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  for (const b of books.splice(0)) b.close();
  vi.useRealTimers();
});

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

function call(port: number, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, text, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const list = (r: Rig, headers: Record<string, string> = {}) => call(r.port, 'GET', '/api/mcp/confirms', undefined, headers);
const answer = (r: Rig, id: string, decision: unknown, headers: Record<string, string> = {}) =>
  call(r.port, 'POST', `/api/mcp/confirm/${encodeURIComponent(id)}`, JSON.stringify({ decision }), headers);

const open = (r: Rig, centralId = 'central-1'): PendingConfirm =>
  r.book.open({
    centralId,
    tool: 'snippet_delete',
    risk: 'ask',
    args: { id: 'snip-1', text: SECRET_ARG },
    summary: 'delete a saved prompt',
    detail: 'The saved prompt reads: tidy up',
    targetSessionId: 's1',
    fingerprint: SECRET_FINGERPRINT,
  });

/** Every key anywhere in a value. */
function keysOf(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, into);
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysOf(v, into);
    }
  }
  return into;
}

describe('GET /api/mcp/confirms', () => {
  it('GET /mcp/confirms lists pending views', async () => {
    const r = await rig();
    const a = open(r);
    const decided = open(r);
    r.book.answer(decided.cardId, 'deny');

    const got = await list(r);

    expect(got.status).toBe(200);
    expect(got.body).toEqual({
      ok: true,
      confirms: [
        {
          cardId: a.cardId,
          centralId: 'central-1',
          tool: 'snippet_delete',
          risk: 'ask',
          summary: 'delete a saved prompt',
          detail: 'The saved prompt reads: tidy up',
          targetSessionId: 's1',
          createdAt: a.createdAt,
          expiresAt: a.expiresAt,
        },
      ],
    });
  });

  it('the feed and the list carry no confirmId and no args', async () => {
    const r = await rig();
    const a = open(r);
    r.book.answer(a.cardId, 'allow');
    const b = open(r);

    const got = await list(r);
    const everything = [got.body, ...r.sent.map(([m]) => m)];
    const keys = keysOf(everything);
    const dump = JSON.stringify(everything);

    expect(keys.has('confirmId')).toBe(false);
    expect(keys.has('args')).toBe(false);
    expect(keys.has('fingerprint')).toBe(false);
    expect(dump).not.toContain(SECRET_FINGERPRINT);
    expect(dump).not.toContain(a.confirmId);
    expect(dump).not.toContain(b.confirmId);
    expect(dump).not.toContain(SECRET_ARG);
  });

  it('confirmView never copies the fingerprint (P5-3)', async () => {
    const r = await rig();
    const a = open(r);
    expect(a.fingerprint).toBe(SECRET_FINGERPRINT);

    const view = confirmView(a);

    expect(keysOf(view).has('fingerprint')).toBe(false);
    expect(JSON.stringify(view)).not.toContain(SECRET_FINGERPRINT);
  });
});

describe('POST /api/mcp/confirm/:cardId', () => {
  it('the POST route takes the card id and refuses the confirm id', async () => {
    const r = await rig();
    const a = open(r);

    const byConfirm = await answer(r, a.confirmId, 'allow');
    expect(byConfirm.status).toBe(404);
    expect(r.book.forCentral(a.confirmId, 'central-1')?.state).toBe('pending');
    expect(byConfirm.text).not.toContain(a.confirmId);

    expect((await answer(r, a.cardId, 'allow')).status).toBe(200);
  });

  it('allow and deny answer 200 with the state; a second answer is 409; an expired one 404', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const r = await rig();
    const a = open(r);
    const b = open(r);
    const c = open(r);

    expect(await answer(r, a.cardId, 'allow')).toMatchObject({ status: 200, body: { ok: true, state: 'allowed' } });
    expect(await answer(r, b.cardId, 'deny')).toMatchObject({ status: 200, body: { ok: true, state: 'denied' } });
    expect(await answer(r, a.cardId, 'deny')).toMatchObject({ status: 409, body: { ok: false, error: 'already-answered' } });
    expect(r.book.forCentral(a.confirmId, 'central-1')?.state).toBe('allowed');

    vi.advanceTimersByTime(CONFIRM_TTL_MS + 1);
    expect((await answer(r, c.cardId, 'allow')).status).toBe(404);
    expect((await answer(r, 'no-such-card', 'allow')).status).toBe(404);
  });

  it('an mcp: caller is 403 before the body is read', async () => {
    const r = await rig();
    const a = open(r);

    const posted = await call(r.port, 'POST', `/api/mcp/confirm/${a.cardId}`, '{not json', { 'x-aasc-client-id': 'mcp:central-1' });
    expect(posted.status).toBe(403);
    expect(posted.text).not.toContain('central-1');
    const allowed = await answer(r, a.cardId, 'allow', { 'x-aasc-client-id': 'MCP:central-1' });
    expect(allowed.status).toBe(403);
    expect((await list(r, { 'x-aasc-client-id': 'mcp:central-1' })).status).toBe(403);
    expect(r.book.forCentral(a.confirmId, 'central-1')?.state).toBe('pending');
  });

  it('a remote caller and mcp.enabled false get the same 404', async () => {
    const remote = await rig();
    const a = open(remote);
    const fromAfar = await answer(remote, a.cardId, 'allow', { 'x-forwarded-for': '203.0.113.9' });
    const listAfar = await list(remote, { 'x-forwarded-for': '203.0.113.9' });
    expect(remote.book.forCentral(a.confirmId, 'central-1')?.state).toBe('pending');
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    const off = await rig({ enabled: () => false });
    const b = open(off);
    const switchedOff = await answer(off, b.cardId, 'allow');
    const listOff = await list(off);

    for (const got of [fromAfar, listAfar, switchedOff, listOff]) {
      expect(got.status).toBe(404);
      expect(got.body).toEqual({ ok: false, error: 'Not found' });
    }
    expect(off.book.forCentral(b.confirmId, 'central-1')?.state).toBe('pending');
  });

  it('a bad body is 400 with fixed words', async () => {
    const r = await rig();
    const a = open(r);
    const words = 'The body must be JSON: { "decision": "allow" } or { "decision": "deny" }.';

    for (const body of ['{not json', JSON.stringify({ decision: 'allow_always' }), JSON.stringify({}), JSON.stringify({ decision: SECRET_ARG })]) {
      const got = await call(r.port, 'POST', `/api/mcp/confirm/${a.cardId}`, body);
      expect(got.status).toBe(400);
      expect(got.body).toEqual({ ok: false, error: words });
    }
    expect(r.book.forCentral(a.confirmId, 'central-1')?.state).toBe('pending');
  });
});

describe('the confirm feeds', () => {
  it('opening sends mcp_confirm and resolving sends mcp_confirm_resolved, through broadcastByLocality(msg, null)', async () => {
    const r = await rig();
    const a = open(r);
    r.book.answer(a.cardId, 'deny');

    const confirmMessages = r.sent.filter(([m]) => m.type === MCP_CONFIRM || m.type === MCP_CONFIRM_RESOLVED);
    expect(confirmMessages).toEqual([
      [
        {
          type: MCP_CONFIRM,
          confirm: {
            cardId: a.cardId,
            centralId: 'central-1',
            tool: 'snippet_delete',
            risk: 'ask',
            summary: 'delete a saved prompt',
            detail: 'The saved prompt reads: tidy up',
            targetSessionId: 's1',
            createdAt: a.createdAt,
            expiresAt: a.expiresAt,
          },
        },
        null,
      ],
      [{ type: MCP_CONFIRM_RESOLVED, cardId: a.cardId, state: 'denied' }, null],
    ]);
  });

  it('a central that leaves the registry has its pending confirmations denied', async () => {
    const r = await rig();
    const leaving = r.registry.mint(globalInput());
    const staying = r.registry.mint(roomInput('r1'));
    const mine = open(r, leaving.centralId);
    const theirs = open(r, staying.centralId);

    r.registry.revoke(leaving.centralId);

    expect(r.book.forCentral(mine.confirmId, leaving.centralId)?.state).toBe('denied');
    expect(r.book.forCentral(theirs.confirmId, staying.centralId)?.state).toBe('pending');
    expect(r.sent.some(([m]) => m.type === MCP_CONFIRM_RESOLVED && m.cardId === mine.cardId && m.state === 'denied')).toBe(true);
  });

  it('close() stops the confirm feeds', async () => {
    const r = await rig();
    r.router.close();
    const before = r.sent.length;

    const a = open(r);
    r.book.answer(a.cardId, 'allow');

    expect(r.sent.length).toBe(before);
  });
});
