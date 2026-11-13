// test/ownerToken.test.ts — the owner token (terminal-editions plan D7, §8.2).
//
// With a password set, every request needs a token, loopback included. The admin CLI on the box
// (and `aasc --ssh`) proves ownership with <data>/owner.token: 32 random bytes, hex, 0600, rewritten
// at every start. It is accepted ONLY on a request isLocalRequest calls local, and ONLY from the
// Authorization header. These tests pin both halves, because each is severe in its own direction:
//   · too loose and the token works through a tunnel, a proxy or another machine, which turns a
//     local file into a remote password;
//   · too strict and the box's own admin can't pair, list or revoke anything.
//
// Three layers: the token file (server/ownerToken.ts), the gate in authMiddleware with request
// doubles, and the real bundle on a temporary folder with the remote-only listener on.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { readFileSync, statSync, existsSync, writeFileSync, symlinkSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { networkInterfaces } from 'os';
import { EventEmitter } from 'events';
import type { Socket } from 'net';
import type { Request, Response } from 'express';
import WebSocket from 'ws';
import {
  ROOT, installKillGuard, scratch, cleanScratch, freePort, makeBox, pickRuntime, buildBundle,
  startBundle, waitReady, stop, type Run, type Runtime,
} from './helpers/headlessBundle.js';

const mockConfig: { passwordHash?: string } = {};
vi.mock('../server/serverConfig.js', () => ({ config: mockConfig }));
vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const restoreKill = installKillGuard('ownerToken.test');
afterAll(() => {
  restoreKill();
  cleanScratch();
});

// ---------------------------------------------------------------------------
// 0. Who writes one (security review L5): aasc-server, or a server that opted in
// ---------------------------------------------------------------------------

describe('ownerTokenWanted', () => {
  it('is on for aasc-server and off for the desktop app and dev servers', async () => {
    const { ownerTokenWanted } = await import('../server/ownerToken.js');
    expect(ownerTokenWanted({ AASC_HEADLESS: '1' }, {})).toBe(true);
    expect(ownerTokenWanted({ ELECTRON: '1' }, {})).toBe(false);
    expect(ownerTokenWanted({}, {})).toBe(false);
  });

  it('is opted into by AASC_OWNER_TOKEN=1 or "ownerToken": true, and the env var wins', async () => {
    const { ownerTokenWanted } = await import('../server/ownerToken.js');
    expect(ownerTokenWanted({ ELECTRON: '1', AASC_OWNER_TOKEN: '1' }, {})).toBe(true);
    expect(ownerTokenWanted({ ELECTRON: '1' }, { ownerToken: true })).toBe(true);
    expect(ownerTokenWanted({ ELECTRON: '1', AASC_OWNER_TOKEN: '0' }, { ownerToken: true })).toBe(false);
    expect(ownerTokenWanted({ AASC_HEADLESS: '1', AASC_OWNER_TOKEN: '0' }, {})).toBe(false);
    // Only a real true counts: a string in the config file is not an opt-in.
    expect(ownerTokenWanted({}, { ownerToken: 'yes' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1. The token file
// ---------------------------------------------------------------------------

describe('the owner token file', () => {
  let mod: typeof import('../server/ownerToken.js');
  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../server/ownerToken.js');
  });

  it('is 32 random bytes in hex, mode 0600', () => {
    const dir = scratch('owner');
    mod.writeOwnerToken(dir);
    const path = join(dir, 'owner.token');
    expect(readFileSync(path, 'utf8')).toMatch(/^[0-9a-f]{64}\n$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('is new on every start, and only the newest is accepted', () => {
    const dir = scratch('owner');
    mod.writeOwnerToken(dir);
    const first = readFileSync(join(dir, 'owner.token'), 'utf8').trim();
    mod.writeOwnerToken(dir);
    const second = readFileSync(join(dir, 'owner.token'), 'utf8').trim();
    expect(second).not.toBe(first);
    expect(mod.isOwnerToken(second)).toBe(true);
    expect(mod.isOwnerToken(first)).toBe(false);
  });

  it('replaces a symlink planted at the path instead of writing through it', () => {
    const dir = scratch('owner');
    const target = join(scratch('elsewhere'), 'victim');
    writeFileSync(target, 'untouched');
    symlinkSync(target, join(dir, 'owner.token'));
    mod.writeOwnerToken(dir);
    expect(readFileSync(target, 'utf8')).toBe('untouched');
    expect(statSync(join(dir, 'owner.token')).isFile()).toBe(true);
    // No temporary file is left behind.
    expect(readdirSync(dir)).toEqual(['owner.token']);
  });

  it('accepts nothing before one is written, and nothing malformed', () => {
    expect(mod.isOwnerToken('a'.repeat(64))).toBe(false);
    mod.writeOwnerToken(scratch('owner'));
    expect(mod.isOwnerToken(null)).toBe(false);
    expect(mod.isOwnerToken('')).toBe(false);
    expect(mod.isOwnerToken('zz')).toBe(false);
    expect(mod.isOwnerToken('a'.repeat(65))).toBe(false);
  });

  it('is removed at exit only while it is still this process\'s', () => {
    const dir = scratch('owner');
    mod.writeOwnerToken(dir);
    mod.removeOwnerToken(dir);
    expect(existsSync(join(dir, 'owner.token'))).toBe(false);
    mod.writeOwnerToken(dir);
    writeFileSync(join(dir, 'owner.token'), `${'b'.repeat(64)}\n`);
    mod.removeOwnerToken(dir);
    expect(existsSync(join(dir, 'owner.token'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. authMiddleware, with request doubles
// ---------------------------------------------------------------------------

describe('authMiddleware and the owner token', () => {
  let auth: typeof import('../server/authManager.js');
  let locality: typeof import('../server/requestLocality.js');
  let token: string;

  beforeEach(async () => {
    vi.resetModules();
    mockConfig.passwordHash = 'salt:hash';
    auth = await import('../server/authManager.js');
    locality = await import('../server/requestLocality.js');
    const owner = await import('../server/ownerToken.js');
    const dir = scratch('owner');
    owner.writeOwnerToken(dir);
    token = readFileSync(join(dir, 'owner.token'), 'utf8').trim();
  });

  function mkReq(opts: { ip?: string; headers?: Record<string, string>; socket?: Socket; url?: string } = {}): Request {
    const ip = opts.ip ?? '127.0.0.1';
    return {
      ip,
      socket: opts.socket ?? { remoteAddress: ip },
      headers: { host: '127.0.0.1:3333', ...opts.headers },
      url: opts.url ?? '/api/mobile/devices',
      method: 'GET',
      originalUrl: opts.url ?? '/api/mobile/devices',
    } as unknown as Request;
  }
  function run(req: Request): number {
    let status = 0;
    const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
    let passed = false;
    auth.authMiddleware(req, res, () => { passed = true; });
    return passed ? 200 : status;
  }
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  it('lets the box\'s own admin CLI through: loopback, Host 127.0.0.1, no Origin, no Sec-Fetch-Site', () => {
    expect(run(mkReq({ headers: bearer(token) }))).toBe(200);
    expect(run(mkReq({ ip: '::1', headers: { ...bearer(token), host: 'localhost:3333' } }))).toBe(200);
  });

  it('refuses it through the remote-only listener', () => {
    const fakeServer = new EventEmitter();
    locality.markRemoteOnlyServer(fakeServer as never);
    const socket = { remoteAddress: '127.0.0.1' } as unknown as Socket;
    fakeServer.emit('connection', socket);
    expect(run(mkReq({ socket, headers: bearer(token) }))).toBe(401);
  });

  it.each(['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'via'])('refuses it with %s', (header) => {
    expect(run(mkReq({ headers: { ...bearer(token), [header]: '203.0.113.7' } }))).toBe(401);
  });

  it('refuses it from a non-loopback address', () => {
    expect(run(mkReq({ ip: '192.168.1.40', headers: bearer(token) }))).toBe(401);
    expect(run(mkReq({ ip: '100.64.0.2', headers: bearer(token) }))).toBe(401);
  });

  it('refuses it from a page: a rebinding Host, a foreign Origin, a cross-site fetch', () => {
    expect(run(mkReq({ headers: { ...bearer(token), host: 'attacker.example' } }))).toBe(401);
    expect(run(mkReq({ headers: { ...bearer(token), origin: 'https://attacker.example' } }))).toBe(401);
    expect(run(mkReq({ headers: { ...bearer(token), 'sec-fetch-site': 'cross-site' } }))).toBe(401);
  });

  it('accepts it only from the Authorization header, never a cookie or ?token=', () => {
    expect(run(mkReq({ headers: { cookie: `auth_token=${token}` } }))).toBe(401);
    expect(run(mkReq({ url: `/api/mobile/devices?token=${token}` }))).toBe(401);
  });

  it('refuses a wrong or stale token', () => {
    expect(run(mkReq({ headers: bearer('0'.repeat(64)) }))).toBe(401);
    expect(run(mkReq({ headers: bearer(token.slice(0, 63)) }))).toBe(401);
  });

  it('leaves password sign-ins as they were', () => {
    const session = auth.createToken();
    expect(run(mkReq({ ip: '192.168.1.40', headers: bearer(session) }))).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 3. The real bundle
// ---------------------------------------------------------------------------

/** A non-loopback address of this machine, so a request to it arrives from a non-loopback peer. */
function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

describe('the bundle, started headless', () => {
  let bundle: string;
  let runtime: Runtime;
  const running: Run[] = [];

  beforeAll(async () => {
    bundle = await buildBundle('owner-token-test');
    runtime = pickRuntime();
  }, 120_000);

  afterEach(async () => {
    await Promise.all(running.splice(0).map(stop));
  }, 30_000);

  afterAll(() => {
    // The bundle copy is ours alone; dist/server-bundle.cjs is never touched.
    if (bundle && bundle !== join(ROOT, 'dist', 'server-bundle.cjs')) {
      rmSync(bundle, { force: true });
    }
  });

  async function boot(): Promise<{ box: ReturnType<typeof makeBox>; port: number; remotePort: number; run: Run }> {
    const box = makeBox();
    const port = await freePort();
    const remotePort = await freePort();
    const run = startBundle(bundle, runtime, box, port, { env: { AASC_REMOTE_LISTENER_PORT: String(remotePort) } });
    running.push(run);
    await waitReady(run, port);
    // The remote-only listener starts just after the main one.
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${remotePort}/api/auth/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    return { box, port, remotePort, run };
  }

  const readToken = (dataDir: string) => readFileSync(join(dataDir, 'owner.token'), 'utf8').trim();

  it('writes owner.token 0600 at start, rotates it on the next start, and never logs it', async () => {
    const { box, port, run } = await boot();
    const path = join(box.dataDir, 'owner.token');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const first = readToken(box.dataDir);
    await stop(run);
    expect(existsSync(path)).toBe(false);

    const again = startBundle(bundle, runtime, box, port);
    running.push(again);
    await waitReady(again, port);
    const second = readToken(box.dataDir);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    // The old one died with its process.
    expect((await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { authorization: `Bearer ${first}` } })).status).toBe(401);

    const logFile = join(box.dataDir, 'logs', 'server.log');
    const logged = (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '') + again.output() + run.output();
    expect(logged).not.toContain(first);
    expect(logged).not.toContain(second);
  }, 90_000);

  it('lets a local Bearer owner token reach the owner routes', async () => {
    const { box, port } = await boot();
    const headers = { authorization: `Bearer ${readToken(box.dataDir)}` };
    const devices = await fetch(`http://127.0.0.1:${port}/api/mobile/devices`, { headers });
    expect(devices.status).toBe(200);
    expect((await devices.json()).data.devices).toEqual([]);
    // Pairing is off in tests (no LAN advertising), so the route itself answers 409, past every gate.
    const pairing = await fetch(`http://127.0.0.1:${port}/api/mobile/pairing`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
    });
    expect(pairing.status).toBe(409);
    expect((await pairing.json()).code).toBe('PAIRING_NOT_OFFERED');
    expect((await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers })).status).toBe(200);
    // Without it, the password still applies on loopback.
    expect((await fetch(`http://127.0.0.1:${port}/api/sessions`)).status).toBe(401);
  }, 60_000);

  it('refuses it through the remote-only listener and with forwarding headers', async () => {
    const { box, port, remotePort } = await boot();
    const headers = { authorization: `Bearer ${readToken(box.dataDir)}` };
    expect((await fetch(`http://127.0.0.1:${remotePort}/api/sessions`, { headers })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { ...headers, 'x-forwarded-for': '203.0.113.7' } })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { ...headers, forwarded: 'for=203.0.113.7' } })).status).toBe(401);
  }, 60_000);

  const lan = lanAddress();
  (lan ? it : it.skip)('refuses it from a non-loopback address', async () => {
    const { box, port } = await boot();
    const res = await fetch(`http://${lan}:${port}/api/sessions`, { headers: { authorization: `Bearer ${readToken(box.dataDir)}` } });
    expect(res.status).toBe(401);
  }, 60_000);

  it('opens the WebSocket for a local owner, and closes it 4001 through the remote-only listener', async () => {
    const { box, port, remotePort } = await boot();
    const headers = { authorization: `Bearer ${readToken(box.dataDir)}` };
    const firstMessage = (url: string) => new Promise<{ type?: string } | { closed: number }>((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      ws.once('message', (raw) => { resolve(JSON.parse(String(raw))); ws.close(); });
      ws.once('close', (code) => resolve({ closed: code }));
      ws.once('error', reject);
    });
    expect(await firstMessage(`ws://127.0.0.1:${port}/?clientId=aasc-test&role=cli`)).toMatchObject({ type: 'snapshot' });
    expect(await firstMessage(`ws://127.0.0.1:${remotePort}/?clientId=aasc-test`)).toEqual({ closed: 4001 });
  }, 60_000);

  it('writes no owner.token when the server is not aasc-server and did not opt in, and drops a stale one', async () => {
    const box = makeBox();
    const port = await freePort();
    writeFileSync(join(box.dataDir, 'owner.token'), `${'a'.repeat(64)}\n`, { mode: 0o600 });
    // A dev-edition start: no AASC_HEADLESS, so the password rule and the token are the dev server's.
    const run = startBundle(bundle, runtime, box, port, { env: { AASC_HEADLESS: '' } });
    running.push(run);
    await waitReady(run, port);
    expect(existsSync(join(box.dataDir, 'owner.token'))).toBe(false);

    await stop(run);
    const opted = startBundle(bundle, runtime, box, port, { env: { AASC_HEADLESS: '', AASC_OWNER_TOKEN: '1' } });
    running.push(opted);
    await waitReady(opted, port);
    expect(readToken(box.dataDir)).toMatch(/^[0-9a-f]{64}$/);
  }, 90_000);

  it('is read by the admin CLI client, which reaches the server with it', async () => {
    const { box, port } = await boot();
    const { readOwnerToken, createAdminClient } = await import('../cli/server/http.js');
    const client = createAdminClient({ port, token: readOwnerToken(box.dataDir) });
    const res = await client.request('GET', '/api/mobile/devices');
    expect(res.status).toBe(200);
  }, 60_000);
});
