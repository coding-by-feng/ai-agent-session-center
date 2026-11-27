// test/authPassword.test.ts — POST /api/auth/password (Nov 27 2026): the devices panel sets or changes the
// dashboard password. Only this computer may; a change needs a session and the current password (which
// counts toward the login lockout); the hash is written atomically beside the other settings and used at
// once; a change ends every other password sign-in but keeps the caller's and every paired device's.
import { mkdtemp, readFile, rm, writeFile, chmod, stat } from 'node:fs/promises';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig: { passwordHash: string | null } = { passwordHash: null };
vi.mock('../server/serverConfig.js', () => ({ config: mockConfig }));
vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

type Auth = typeof import('../server/authManager.js');
let auth: Auth;
let dir: string;
let configPath: string;
let server: Server;
let url: string;
let local: boolean;
let hosted: boolean;
let ended: string[][];
let setCalls: boolean[];
let hookThrows: boolean;
let ipSeq = 0;
let ip: string;

const STRONG = 'Tr1cky-pass';
const STRONGER = 'N3w-and-better';

beforeEach(async () => {
  vi.resetModules();
  mockConfig.passwordHash = null;
  auth = await import('../server/authManager.js');
  const { createPasswordRouter } = await import('../server/authPassword.js');
  dir = await mkdtemp(join(tmpdir(), 'auth-password-'));
  configPath = join(dir, 'server-config.json');
  await writeFile(configPath, JSON.stringify({ port: 3333, showOnAccount: true }));
  local = true;
  hosted = false;
  ended = [];
  setCalls = [];
  hookThrows = false;
  ip = `10.9.9.${++ipSeq}`;
  const app = express();
  app.use(express.json());
  app.use('/api/auth/password', createPasswordRouter({
    configPath,
    isLocal: () => local,
    isHosted: () => hosted,
    clientIp: () => ip,
    onSessionsEnded: (lineages) => ended.push(lineages),
    onPasswordSet: (changed) => { setCalls.push(changed); if (hookThrows) throw new Error('advertiser down'); },
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/password`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
const cookieToken = (res: Response) => /auth_token=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? null;
const savedConfig = async () => JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;

describe('setting the first password', () => {
  it('refuses anything but this computer, and writes nothing', async () => {
    local = false;
    const res = await post({ password: STRONG });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('LOCAL_ONLY');
    expect((await savedConfig()).passwordHash).toBeUndefined();
    expect(auth.isPasswordEnabled()).toBe(false);
  });

  it('refuses a cross-site page, a non-JSON body, a hosted box and a weak password', async () => {
    expect((await post({ password: STRONG }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: STRONG })).status).toBe(415);
    const weak = await post({ password: 'short' });
    expect(weak.status).toBe(400);
    expect((await weak.json()).error).toMatch(/at least 8 characters/);
    hosted = true;
    expect((await post({ password: STRONG })).status).toBe(403);
    expect(auth.isPasswordEnabled()).toBe(false);
  });

  it('saves it beside the other settings, uses it at once, and signs this window in', async () => {
    const res = await post({ password: STRONG });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, passwordEnabled: true, changed: false });
    const saved = await savedConfig();
    expect(saved).toMatchObject({ port: 3333, showOnAccount: true });
    expect(auth.verifyPassword(STRONG, String(saved.passwordHash))).toBe(true);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(auth.isPasswordEnabled()).toBe(true);
    expect(auth.validateToken(cookieToken(res))).toBe(true);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/);
    expect(ended).toEqual([]);
    expect(setCalls).toEqual([false]);
  });

  it('still answers when what follows the save fails: the password is already in force', async () => {
    hookThrows = true;
    const res = await post({ password: STRONG });
    expect(res.status).toBe(200);
    expect(auth.isPasswordEnabled()).toBe(true);
  });

  it('keeps the old state when the settings file can’t be written', async () => {
    await chmod(dir, 0o500);
    try {
      const res = await post({ password: STRONG });
      expect(res.status).toBe(500);
      expect(auth.isPasswordEnabled()).toBe(false);
    } finally {
      await chmod(dir, 0o700);
    }
  });
});

describe('changing it', () => {
  let session: string;
  beforeEach(async () => {
    session = cookieToken(await post({ password: STRONG }))!;
  });
  const asSession = (token: string | null = session) => ({ Cookie: `auth_token=${token}` });

  it('needs a signed-in session', async () => {
    expect((await post({ current: STRONG, password: STRONGER })).status).toBe(401);
    expect(setCalls).toEqual([false]);
    expect(auth.verifyPassword(STRONG, mockConfig.passwordHash!)).toBe(true);
  });

  it('needs the current password, and wrong ones count toward the lockout', async () => {
    const wrong = await post({ current: 'Nope-1234', password: STRONGER }, asSession());
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).attemptsLeft).toBe(auth.LOGIN_MAX_ATTEMPTS - 1);
    let last: Response = wrong;
    for (let i = 1; i < auth.LOGIN_MAX_ATTEMPTS; i++) last = await post({ current: 'Nope-1234', password: STRONGER }, asSession());
    expect(last.status).toBe(429);
    // Locked: even the right password waits.
    expect((await post({ current: STRONG, password: STRONGER }, asSession())).status).toBe(429);
    expect(auth.verifyPassword(STRONG, mockConfig.passwordHash!)).toBe(true);
  });

  it('ends every other password sign-in but keeps the caller’s and the paired devices’', async () => {
    const other = auth.createToken();
    const otherLineage = auth.getTokenLineage(other);
    const phone = auth.createToken('phone-1');
    const computer = auth.createComputerToken('computer-1');
    const callerLineage = auth.getTokenLineage(session);

    const res = await post({ current: STRONG, password: STRONGER }, asSession());
    expect(res.status).toBe(200);
    expect((await res.json()).changed).toBe(true);
    expect(auth.verifyPassword(STRONGER, String((await savedConfig()).passwordHash))).toBe(true);
    expect(auth.verifyPassword(STRONGER, mockConfig.passwordHash!)).toBe(true);

    expect(auth.validateToken(other)).toBe(false);
    expect(ended).toEqual([[otherLineage]]);
    // The restart-time steps run now: old-password phones and computers are revoked by the hook.
    expect(setCalls).toEqual([false, true]);
    expect(auth.validateToken(phone)).toBe(true);
    expect(auth.validateToken(computer)).toBe(true);
    // The caller's session rotated in place: a new token, the same sign-in, so its socket stays.
    const fresh = cookieToken(res);
    expect(fresh).not.toBe(session);
    expect(auth.validateToken(fresh)).toBe(true);
    expect(auth.getTokenLineage(fresh)).toBe(callerLineage);
  });

  it('still refuses a remote caller, even signed in with the right password', async () => {
    local = false;
    expect((await post({ current: STRONG, password: STRONGER }, asSession())).status).toBe(403);
    expect(auth.verifyPassword(STRONG, mockConfig.passwordHash!)).toBe(true);
  });
});

describe('the real “this computer only” gate', () => {
  // Through the real isLocalRequest, not a stub: a rebinding Host, a foreign Origin, a forwarded request and a
  // same-site page are all refused before anything is written (security review, Nov 27 2026).
  let realServer: Server;
  let port: number;
  beforeEach(async () => {
    const { createPasswordRouter } = await import('../server/authPassword.js');
    const { isLocalRequest } = await import('../server/requestLocality.js');
    const app = express();
    app.use(express.json());
    app.use('/api/auth/password', createPasswordRouter({ configPath, isLocal: (req) => isLocalRequest(req), isHosted: () => false, clientIp: () => ip }));
    await new Promise<void>((resolve) => { realServer = app.listen(0, '127.0.0.1', () => resolve()); });
    port = (realServer.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise((resolve) => realServer.close(resolve));
  });

  function raw(headers: Record<string, string>): Promise<number> {
    const body = JSON.stringify({ password: STRONG });
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/password', headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...headers } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  it.each([
    ['a DNS-rebinding page (its own Host)', { Host: `evil.example:${0}` }],
    ['a foreign Origin', { Host: 'localhost', Origin: 'https://evil.example' }],
    ['a request a proxy forwarded', { Host: 'localhost', 'X-Forwarded-For': '203.0.113.9' }],
    ['a same-site page on another port', { Host: 'localhost', 'Sec-Fetch-Site': 'same-site' }],
  ])('refuses %s', async (_name, headers) => {
    expect(await raw(headers as Record<string, string>)).toBe(403);
    expect(auth.isPasswordEnabled()).toBe(false);
    expect((await savedConfig()).passwordHash).toBeUndefined();
  });

  it('lets this computer’s own page set it', async () => {
    expect(await raw({ Host: `localhost:${port}`, 'Sec-Fetch-Site': 'same-origin', Origin: `http://localhost:${port}` })).toBe(200);
    expect(auth.isPasswordEnabled()).toBe(true);
  });
});
