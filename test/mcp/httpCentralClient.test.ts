// test/mcp/httpCentralClient.test.ts — what the dashboard's GET routes (server/mcp/http.ts) do with a central's own
// calls (review finding C-M1). A central's tools call /api as `x-aasc-client-id: mcp:<centralId>`. The PUT of the
// hands-off switch refuses such a call with 403, and so do the three GETs: they hold every central's targets and task
// titles, ids that may be outside the calling central's scope, and no tool is meant to read them. Only this Mac's own
// windows are, and their client id is a device id.
//
// The router is mounted on a real Express app on an ephemeral port, with the real `isLocalRequest`. What sits behind
// it (the registry, the activity log, the ledger) is a stand-in that records every read, so a refused call is shown to
// have read nothing. Nothing here touches a session, a PTY or a process.
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCentralRegistry } from '../../server/mcp/centrals.js';
import { createCentralsRouter, type CentralsRouterDeps, type DashboardDeliver } from '../../server/mcp/http.js';
import { globalInput } from './centralFixtures.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

interface Rig {
  port: number;
  /** Every read the router made of what sits behind it. */
  reads: string[];
  centralId: string;
}

let server: Server | undefined;

async function rig(over: Partial<CentralsRouterDeps> = {}): Promise<Rig> {
  const reads: string[] = [];
  const registry = createCentralRegistry({ now: () => 1_700_000_000_000 });
  const minted = registry.mint(globalInput());
  const deliver: DashboardDeliver = {
    activity: {
      listActivity: () => {
        reads.push('activity');
        return [];
      },
      onActivity: () => () => undefined,
    },
    onTaskUpdate: () => () => undefined,
    ledger: {
      list: () => {
        reads.push('tasks');
        return [];
      },
    },
  };
  const router = createCentralsRouter({
    registry: {
      list: () => {
        reads.push('centrals');
        return registry.list();
      },
      onChange: (listener) => registry.onChange(listener),
    },
    sessions: () => [],
    broadcastByLocality: () => undefined,
    deliver,
    ...over,
  });
  const app = express();
  app.use('/api', router);
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, reads, centralId: minted.centralId };
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

/** One GET, with the headers a test chooses (`fetch` would not let it name another Host). */
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
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
    req.end();
  });
}

const ROUTES = [
  ['centrals', '/api/mcp/centrals'],
  ['activity', '/api/mcp/activity'],
  ['tasks', '/api/mcp/tasks'],
] as const;

describe('the dashboard’s GET routes and a central’s own calls', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  it('GET centrals/activity/tasks refuse an mcp: client', async () => {
    for (const [, path] of ROUTES) {
      const answer = await get(r.port, path, { 'x-aasc-client-id': `mcp:${r.centralId}` });

      expect(answer.status, path).toBe(403);
      expect(answer.body, path).toEqual({ ok: false, error: expect.stringMatching(/^A central cannot /) });
    }
    expect(r.reads).toEqual([]);
  });

  describe.each(ROUTES)('GET %s', (name, path) => {
    it('refuses a call whose client id is a central’s (mcp:<centralId>) with 403, in fixed words, and reads nothing', async () => {
      const answer = await get(r.port, path, { 'x-aasc-client-id': `mcp:${r.centralId}` });

      expect(answer.status).toBe(403);
      expect(answer.body.ok).toBe(false);
      // The same words as the PUT's: "A central cannot …".
      expect(answer.body.error).toMatch(/^A central cannot [a-z ]+\.$/);
      expect(Object.keys(answer.body).sort()).toEqual(['error', 'ok']);
      expect(answer.text).not.toContain(r.centralId);
      expect(r.reads).toEqual([]);
    });

    it('refuses the prefix in any case, around spaces, and a bare prefix', async () => {
      for (const id of ['MCP:abc', 'Mcp:abc', 'mcp:', ' mcp:abc ']) {
        const answer = await get(r.port, path, { 'x-aasc-client-id': id });
        expect(answer.status, id).toBe(403);
      }
      expect(r.reads).toEqual([]);
    });

    it('lets a dashboard window through (its client id is a device id, not mcp:)', async () => {
      const answer = await get(r.port, path, { 'x-aasc-client-id': '3b1c9a3e-7a0e-4f4e-8f43-2d6c8f1a9b10' });

      expect(answer.status).toBe(200);
      expect(answer.body.ok).toBe(true);
      expect(r.reads).toEqual([name]);
    });

    it('lets an unstamped local caller through (curl, an old client)', async () => {
      const answer = await get(r.port, path);

      expect(answer.status).toBe(200);
    });

    it('does not take "mcp:" in the middle of an id for a central', async () => {
      const answer = await get(r.port, path, { 'x-aasc-client-id': 'device-mcp:1' });

      expect(answer.status).toBe(200);
    });

    it('answers a remote caller the same 404 whatever its client id, so it learns nothing about centrals', async () => {
      const remote = { 'x-forwarded-for': '203.0.113.9' };
      const plain = await get(r.port, path, remote);
      const withCentralId = await get(r.port, path, { ...remote, 'x-aasc-client-id': `mcp:${r.centralId}` });

      for (const answer of [plain, withCentralId]) {
        expect(answer.status).toBe(404);
        expect(answer.body).toEqual({ ok: false, error: 'Not found' });
      }
      expect(r.reads).toEqual([]);
    });

    it('is not served with the feature off, to a central either', async () => {
      const off = await rig({ enabled: () => false });

      const answer = await get(off.port, path, { 'x-aasc-client-id': `mcp:${off.centralId}` });

      expect(answer.status).toBe(404);
      expect(answer.body).toEqual({ ok: false, error: 'Not found' });
    });
  });

  it('refuses a central even from a server that has no P2 runtime (403 comes before "no runtime")', async () => {
    const bare = await rig({ deliver: undefined });
    const headers = { 'x-aasc-client-id': `mcp:${bare.centralId}` };

    expect((await get(bare.port, '/api/mcp/activity', headers)).status).toBe(403);
    expect((await get(bare.port, '/api/mcp/tasks', headers)).status).toBe(403);
    // Without the mark the same server still answers 404, as before.
    expect((await get(bare.port, '/api/mcp/activity')).status).toBe(404);
  });

  it('keeps the PUT’s own refusal and its words', async () => {
    const answer = await new Promise<Answer>((resolve, reject) => {
      const body = JSON.stringify({ on: true });
      const req = request(
        {
          host: '127.0.0.1',
          port: r.port,
          path: '/api/mcp/sessions/s1/hands-off',
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(body)),
            'x-aasc-client-id': `mcp:${r.centralId}`,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text, body: JSON.parse(text) }));
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({ ok: false, error: 'A central cannot change hands-off.' });
  });
});
