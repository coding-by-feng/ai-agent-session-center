// test/mcp/sessionInterruptRouter.test.ts — POST /api/sessions/:id/interrupt (server/sessionInterruptRouter.ts, P5-7):
// the server submitter's Esc, pressed only mid-turn or at a dialog with the agent in front (the submitter decides that,
// and says whether it pressed). The route refuses in a fixed order: a remote caller (403), a body other than
// `{ confirm: true }` (400, a body-less POST included: a JSON body forces a preflight), no card or no terminal (404), and
// for a central (`mcp:`) a terminal AASC has not heard (409 not_started). A central's Esc is noted in the Esc book just
// before it is written (the submitter's `beforeEsc`), so the person's Esc hold is not triggered by it (Ruling 47); no
// Esc written, no note (a person's Esc soon after is theirs); the Mac's is not noted.
//
// The router is mounted on a real Express app on an ephemeral loopback port, with fake deps: no store, no PTY, no
// submitter, no process. A request is "remote" when it carries the test's own header, which the fake `isLocal` reads.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionInterruptRouter,
  type SessionInterruptDeps,
  type SessionInterruptSession,
} from '../../server/sessionInterruptRouter.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const REMOTE = 'x-test-remote';
const CLIENT = 'x-aasc-client-id';

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

const card = (over: Partial<SessionInterruptSession> = {}): SessionInterruptSession => ({
  sessionId: 's1',
  terminalId: 'term-s1',
  ...over,
});

interface Rig {
  base: string;
  /** In order: `note:<session>:<terminal>` and `press:<session>:<terminal>`. */
  log: string[];
}

async function rig(opts: { session?: SessionInterruptSession | null; heard?: boolean; pressed?: boolean } = {}): Promise<Rig> {
  const log: string[] = [];
  const session = opts.session === undefined ? card() : opts.session;
  const deps: SessionInterruptDeps = {
    isLocal: (req) => req.headers[REMOTE] === undefined,
    getSession: (id) => (session !== null && id === session.sessionId ? { ...session } : null),
    terminalHeard: () => opts.heard ?? true,
    isCentral: (req) => String(req.headers[CLIENT] ?? '').startsWith('mcp:'),
    // As the submitter does: `beforeEsc` runs just before the Esc is written, and only when it is.
    interrupt: async (t) => {
      const pressed = opts.pressed ?? true;
      if (pressed) {
        t.beforeEsc?.();
        log.push(`press:${t.sessionId}:${t.terminalId}`);
      }
      return pressed;
    },
    noteCentralEsc: (sessionId, terminalId) => {
      log.push(`note:${sessionId}:${terminalId}`);
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createSessionInterruptRouter(deps));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, log };
}

async function post(
  r: Rig,
  opts: { id?: string; body?: unknown; remote?: boolean; central?: boolean } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.remote) headers[REMOTE] = '1';
  if (opts.central) headers[CLIENT] = 'mcp:c1';
  const res = await fetch(`${r.base}/api/sessions/${opts.id ?? 's1'}/interrupt`, {
    method: 'POST',
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const CONFIRMED = { confirm: true };

describe('POST /api/sessions/:id/interrupt', () => {
  it('a remote caller is 403', async () => {
    const r = await rig();
    const res = await post(r, { body: CONFIRMED, remote: true });
    expect(res.status).toBe(403);
    expect(r.log).toEqual([]);
  });

  it('a remote caller is 403 before its body is read', async () => {
    const r = await rig();
    expect((await post(r, { remote: true })).status).toBe(403);
  });

  it('a body without confirm:true is 400 (a body-less POST included)', async () => {
    const r = await rig();
    for (const body of [undefined, {}, { confirm: false }, { confirm: 'true' }, [true]]) {
      const res = await post(r, { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(r.log).toEqual([]);
  });

  it('no card or no terminal is 404', async () => {
    const none = await rig({ session: null });
    expect((await post(none, { body: CONFIRMED })).status).toBe(404);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    const noTerminal = await rig({ session: card({ terminalId: null }) });
    expect((await post(noTerminal, { body: CONFIRMED })).status).toBe(404);
    expect(noTerminal.log).toEqual([]);
  });

  it('an unheard terminal is not_started for a central and allowed for the Mac', async () => {
    const r = await rig({ heard: false });
    const central = await post(r, { body: CONFIRMED, central: true });
    expect(central.status).toBe(409);
    expect(central.json.error).toBe('not_started');
    expect(r.log).toEqual([]);

    const mac = await post(r, { body: CONFIRMED });
    expect(mac.status).toBe(200);
    expect(mac.json).toEqual({ ok: true, pressed: true });
  });

  it('a card with the never-started marker is not_started for a central', async () => {
    const r = await rig({ session: card({ startHeard: false }) });
    const res = await post(r, { body: CONFIRMED, central: true });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('not_started');
  });

  it('a central’s Esc is noted before the press; the Mac’s is not', async () => {
    const r = await rig();
    expect((await post(r, { body: CONFIRMED, central: true })).json).toEqual({ ok: true, pressed: true });
    expect(r.log).toEqual(['note:s1:term-s1', 'press:s1:term-s1']);

    r.log.length = 0;
    expect((await post(r, { body: CONFIRMED })).json).toEqual({ ok: true, pressed: true });
    expect(r.log).toEqual(['press:s1:term-s1']);
  });

  it('pressed false when nothing ran', async () => {
    const r = await rig({ pressed: false });
    const res = await post(r, { body: CONFIRMED, central: true });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, pressed: false });
  });

  it('pressed false leaves no central Esc note', async () => {
    const r = await rig({ pressed: false });
    await post(r, { body: CONFIRMED, central: true });
    expect(r.log).toEqual([]);
  });
});
