/**
 * The hands-off switch end to end through the dashboard's route (FW-C's concern 3): `PUT /api/mcp/sessions/:id/hands-off`
 * on the real centrals router, handed the setter exactly as server/index.ts wires it, over the real store and hook
 * pipeline. handsOffBroadcastRace.test.ts calls the setter directly under fake timers; this file goes through HTTP,
 * so it runs on real timers (fake ones would stall the socket and body parser). A hook update held in
 * hookProcessor's 250 ms throttle must not put the old flag back after the route answered.
 *
 * Stand-ins: the database and the socket manager's broadcast. process.kill is guarded.
 */
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ broadcast: vi.fn() }));

vi.mock('../../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
}));

vi.mock('../../server/wsManager.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/wsManager.js')>();
  return { ...mod, broadcast: mocks.broadcast };
});

const realProcessKill = process.kill.bind(process);
vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`handsOffRoute.e2e.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

const { getSession, setSessionHandsOff } = await import('../../server/sessionStore.js');
const { processHookEvent, refreshPendingSessionUpdate } = await import('../../server/hookProcessor.js');
const { createHandsOffSetter } = await import('../../server/mcp/handsOffSetter.js');
const { createCentralsRouter } = await import('../../server/mcp/http.js');

let server: Server | undefined;
let port = 0;
let n = 0;
let id = '';

type Update = { type: string; session?: { sessionId: string; handsOff?: boolean; status?: string } };
const updatesFor = (sessionId: string): Update[] =>
  mocks.broadcast.mock.calls
    .map(([message]) => message as Update)
    .filter((m) => m.type === 'session_update' && m.session?.sessionId === sessionId);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One PUT from this Mac, as the window sends it. */
function put(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

beforeEach(async () => {
  const router = createCentralsRouter({
    registry: { list: () => [], onChange: () => () => undefined },
    sessions: () => [],
    broadcastByLocality: () => undefined,
    enabled: () => true,
    // The setter exactly as server/index.ts hands it over.
    setHandsOff: createHandsOffSetter(setSessionHandsOff, refreshPendingSessionUpdate),
  });
  const app = express();
  app.use('/api', router);
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  n += 1;
  id = `route-card-${n}`;
  processHookEvent({
    session_id: id,
    hook_event_name: 'SessionStart',
    cli_source: 'claude',
    cwd: `/tmp/route-${n}`,
    tty_path: `/dev/ttys05${n}`,
  } as never);
  await sleep(400); // the SessionStart update has gone out
  mocks.broadcast.mockClear();
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('PUT /api/mcp/sessions/:id/hands-off with a hook update still held', () => {
  it('the flip through the route is what every window ends on', async () => {
    processHookEvent({ session_id: id, hook_event_name: 'Stop', cli_source: 'claude' } as never); // held 250 ms
    await sleep(50);

    const answer = await put(`/api/mcp/sessions/${id}/hands-off`, { on: true });
    expect(answer).toEqual({ status: 200, body: { ok: true, handsOff: true } });
    await sleep(400); // past the throttle and the 20 ms batch

    const updates = updatesFor(id);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((u) => u.session?.handsOff === true)).toBe(true);
    expect(updates.at(-1)?.session?.status).toBe('waiting'); // the held hook's own change still lands
    expect(getSession(id)?.handsOff).toBe(true);
  });

  it('turning it off through the route is what every window ends on', async () => {
    await put(`/api/mcp/sessions/${id}/hands-off`, { on: true });
    await sleep(400);
    processHookEvent({ session_id: id, hook_event_name: 'Stop', cli_source: 'claude' } as never); // held with the flag on
    await sleep(50);
    mocks.broadcast.mockClear();

    const answer = await put(`/api/mcp/sessions/${id}/hands-off`, { on: false });
    expect(answer).toEqual({ status: 200, body: { ok: true, handsOff: false } });
    await sleep(400);

    const updates = updatesFor(id);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((u) => !('handsOff' in (u.session ?? {})))).toBe(true);
    expect(getSession(id)).not.toHaveProperty('handsOff');
  });

  it('a central cannot flip it, and nothing goes out', async () => {
    const answer = await put(`/api/mcp/sessions/${id}/hands-off`, { on: true }, { 'x-aasc-client-id': 'mcp:some-central' });

    expect(answer.status).toBe(403);
    await sleep(100);
    expect(updatesFor(id)).toEqual([]);
    expect(getSession(id)).not.toHaveProperty('handsOff');
  });
});
