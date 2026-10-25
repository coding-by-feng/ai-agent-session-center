// test/mcp/handsOff.test.ts — PUT /api/mcp/sessions/:id/hands-off (server/mcp/http.ts): the person's switch that
// keeps every central's hands off one session. Only this Mac may flip it, and never one of a central's own
// calls (`x-aasc-client-id: mcp:<centralId>`): a central must not be able to lift the rail that holds it.
//
// The router is mounted on a real Express app on an ephemeral port, with the real `isLocalRequest`. The store
// behind the route is a stand-in (`setHandsOff`), so nothing here touches a session, a PTY or a process.
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { createCentralRegistry } from '../../server/mcp/centrals.js';
import { createCentralsRouter, type CentralsRouterDeps } from '../../server/mcp/http.js';
import { phoneRuleFor } from '../../server/mobile/phoneProfile.js';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

type SetHandsOff = (sessionId: string, on: boolean) => Session | null;

interface Rig {
  port: number;
  /** Every call the router made to the store. */
  calls: Array<{ sessionId: string; on: boolean }>;
}

let server: Server | undefined;

/** The session store as a stand-in: every id exists except `gone`. */
const defaultStore: SetHandsOff = (sessionId, on) =>
  sessionId === 'gone' ? null : ({ sessionId, ...(on ? { handsOff: true } : {}) } as unknown as Session);

async function rig(over: Partial<CentralsRouterDeps> = {}, store: SetHandsOff = defaultStore): Promise<Rig> {
  const calls: Rig['calls'] = [];
  const router = createCentralsRouter({
    registry: createCentralRegistry({ now: () => 1_700_000_000_000 }),
    sessions: () => [],
    broadcastByLocality: () => undefined,
    setHandsOff: (sessionId, on) => {
      calls.push({ sessionId, on });
      return store(sessionId, on);
    },
    ...over,
  });
  const app = express();
  app.use('/api', router);
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, calls };
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** One request, with the headers a test chooses (`fetch` would not let it name another Host). */
function call(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) {
      headers['content-type'] ??= 'application/json';
      headers['content-length'] = String(Buffer.byteLength(options.body));
    }
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('end', () => {
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        resolve({ status: res.statusCode ?? 0, text, body });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const handsOff = (
  port: number,
  id: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Answer> =>
  call(port, 'PUT', `/api/mcp/sessions/${encodeURIComponent(id)}/hands-off`, {
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('PUT /api/mcp/sessions/:id/hands-off', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  describe('sets and clears the flag', () => {
    it('sets it through the store and answers the new state', async () => {
      const answer = await handsOff(r.port, 'sess-1', { on: true });

      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ ok: true, handsOff: true });
      expect(r.calls).toEqual([{ sessionId: 'sess-1', on: true }]);
    });

    it('clears it', async () => {
      const answer = await handsOff(r.port, 'sess-1', { on: false });

      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ ok: true, handsOff: false });
      expect(r.calls).toEqual([{ sessionId: 'sess-1', on: false }]);
    });

    it('is the same answer when it is already in that state (a switch, not a toggle)', async () => {
      await handsOff(r.port, 'sess-1', { on: true });
      const again = await handsOff(r.port, 'sess-1', { on: true });

      expect(again.status).toBe(200);
      expect(again.body).toEqual({ ok: true, handsOff: true });
    });

    it('hands the store the id as the URL gave it, decoded (the store follows a re-key)', async () => {
      await handsOff(r.port, 'term-abc_123', { on: true });

      expect(r.calls[0].sessionId).toBe('term-abc_123');
    });

    it('answers 404 for a session that does not exist, in fixed words', async () => {
      const answer = await handsOff(r.port, 'gone', { on: true });

      expect(answer.status).toBe(404);
      expect(answer.body).toEqual({ ok: false, error: 'Session not found' });
      expect(answer.text).not.toContain('gone');
    });

    it('answers 404 for an id too long to be a session id, without asking the store', async () => {
      const answer = await handsOff(r.port, 'x'.repeat(500), { on: true });

      expect(answer.status).toBe(404);
      expect(r.calls).toEqual([]);
    });
  });

  describe('refuses a body that is not { on: boolean }', () => {
    it.each([
      ['an empty object', {}],
      ['a string', { on: 'yes' }],
      ['a number', { on: 1 }],
      ['null', { on: null }],
      ['an array', [true]],
      ['the flag named another way', { handsOff: true }],
    ])('answers 400 for %s and changes nothing', async (_name, body) => {
      const answer = await handsOff(r.port, 'sess-1', body);

      expect(answer.status).toBe(400);
      expect(answer.body.ok).toBe(false);
      expect(r.calls).toEqual([]);
    });

    it('answers 400 for text that is not JSON, and changes nothing', async () => {
      const answer = await call(r.port, 'PUT', '/api/mcp/sessions/sess-1/hands-off', {
        body: '{not json',
        headers: { 'content-type': 'application/json' },
      });

      expect(answer.status).toBe(400);
      expect(r.calls).toEqual([]);
    });

    it('does not echo what it was sent', async () => {
      const answer = await handsOff(r.port, 'sess-1', { on: 'SECRET-VALUE-77' });

      expect(answer.text).not.toContain('SECRET-VALUE-77');
    });
  });

  describe('never for a central', () => {
    it('refuses a call whose client id is a central’s (mcp:<centralId>) with 403 and changes nothing', async () => {
      const answer = await handsOff(r.port, 'sess-1', { on: false }, { 'x-aasc-client-id': 'mcp:7d6c4c1e' });

      expect(answer.status).toBe(403);
      expect(answer.body.ok).toBe(false);
      expect(r.calls).toEqual([]);
    });

    it('refuses it for setting the flag too: a central has no say either way', async () => {
      const answer = await handsOff(r.port, 'sess-1', { on: true }, { 'x-aasc-client-id': 'mcp:7d6c4c1e' });

      expect(answer.status).toBe(403);
      expect(r.calls).toEqual([]);
    });

    it('refuses the prefix in any case, and a bare prefix', async () => {
      for (const id of ['MCP:abc', 'Mcp:abc', 'mcp:']) {
        const answer = await handsOff(r.port, 'sess-1', { on: false }, { 'x-aasc-client-id': id });
        expect(answer.status, id).toBe(403);
      }
      expect(r.calls).toEqual([]);
    });

    it('lets a dashboard window through (its client id is a device id, not mcp:)', async () => {
      const answer = await handsOff(
        r.port,
        'sess-1',
        { on: true },
        { 'x-aasc-client-id': '3b1c9a3e-7a0e-4f4e-8f43-2d6c8f1a9b10' },
      );

      expect(answer.status).toBe(200);
    });

    it('lets an unstamped local caller through (curl, an old client)', async () => {
      const answer = await handsOff(r.port, 'sess-1', { on: true });

      expect(answer.status).toBe(200);
    });

    it('does not take "mcp:" in the middle of an id for a central', async () => {
      const answer = await handsOff(r.port, 'sess-1', { on: true }, { 'x-aasc-client-id': 'device-mcp:1' });

      expect(answer.status).toBe(200);
    });
  });

  describe('is for this Mac only', () => {
    it('refuses a request relayed by a proxy (a forwarding header) with a 404 and changes nothing', async () => {
      const answer = await handsOff(r.port, 'sess-1', { on: true }, { 'x-forwarded-for': '203.0.113.9' });

      expect(answer.status).toBe(404);
      expect(answer.body).toEqual({ ok: false, error: 'Not found' });
      expect(r.calls).toEqual([]);
    });

    it('refuses a request that names another host (a page re-resolved to loopback)', async () => {
      const answer = await handsOff(r.port, 'sess-1', { on: true }, { host: 'attacker.example' });

      expect(answer.status).toBe(404);
      expect(r.calls).toEqual([]);
    });

    it('refuses a cross-site browser request', async () => {
      const answer = await handsOff(r.port, 'sess-1', { on: false }, { 'sec-fetch-site': 'cross-site' });

      expect(answer.status).toBe(404);
      expect(r.calls).toEqual([]);
    });

    it('answers a remote caller the same 404 whatever its client id or body, so it learns nothing', async () => {
      const remote = { 'x-forwarded-for': '203.0.113.9' };
      const withCentralId = await handsOff(r.port, 'sess-1', { on: true }, { ...remote, 'x-aasc-client-id': 'mcp:abc' });
      const badBody = await handsOff(r.port, 'sess-1', 'not json at all', remote);
      const noBody = await call(r.port, 'PUT', '/api/mcp/sessions/sess-1/hands-off', { headers: remote });

      for (const answer of [withCentralId, badBody, noBody]) {
        expect(answer.status).toBe(404);
        expect(answer.body).toEqual({ ok: false, error: 'Not found' });
      }
      expect(r.calls).toEqual([]);
    });

    it('is not on a paired phone’s allow-list: the phone profile (deny by default) refuses it first', () => {
      expect(phoneRuleFor('PUT', '/mcp/sessions/s1/hands-off')).toBeNull();
    });
  });

  describe('with an injected rule', () => {
    it('takes its answer from `isLocal`', async () => {
      let local = false;
      const custom = await rig({ isLocal: () => local });

      expect((await handsOff(custom.port, 'sess-1', { on: true })).status).toBe(404);
      local = true;
      expect((await handsOff(custom.port, 'sess-1', { on: true })).status).toBe(200);
    });

    it('is not served with the feature off (`mcp.enabled: false`)', async () => {
      let on = false;
      const custom = await rig({ enabled: () => on });

      expect((await handsOff(custom.port, 'sess-1', { on: true })).status).toBe(404);
      expect(custom.calls).toEqual([]);
      on = true;
      expect((await handsOff(custom.port, 'sess-1', { on: true })).status).toBe(200);
    });

    it('answers 404 when the server wired no store behind it', async () => {
      const bare = await rig({ setHandsOff: undefined });

      expect((await handsOff(bare.port, 'sess-1', { on: true })).status).toBe(404);
    });

    it('answers 500 in fixed words when the store throws, and never the error text', async () => {
      const custom = await rig({}, () => {
        throw new Error('disk SECRET-PATH exploded');
      });

      const answer = await handsOff(custom.port, 'sess-1', { on: true });

      expect(answer.status).toBe(500);
      expect(answer.body.ok).toBe(false);
      expect(answer.text).not.toContain('SECRET-PATH');
      expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('SECRET-PATH'));
    });
  });

  it('answers other methods on the path with the usual 404 of an unmatched route (no GET exposes the flag)', async () => {
    const answer = await call(r.port, 'GET', '/api/mcp/sessions/sess-1/hands-off');

    expect(answer.status).toBe(404);
  });
});
