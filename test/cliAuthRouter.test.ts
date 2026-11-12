// test/cliAuthRouter.test.ts — GET /api/cli-auth and POST /api/cli-auth/:cli/login. The service and the
// terminal opener are fakes: no CLI runs and no PTY starts. Locality and the device id come from test headers.
import { createServer, type Server } from 'node:http';
import type { Request } from 'express';
import express from 'express';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCliAuthRouter, REMOTE_LOGIN_GAP_MS } from '../server/cliAuthRouter.js';
import type { CliAuthReport } from '../src/types/cliAuth.js';

const report: CliAuthReport = {
  host: 'mbp',
  clis: [{ cli: 'claude', state: 'logged-out', method: null, detail: null, checkedAt: 1 }],
};

let server: Server;
let base = '';
let now = 0;
let check: ReturnType<typeof vi.fn>;
let openLogin: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  now = 1_000_000;
  check = vi.fn(async () => report);
  openLogin = vi.fn(async () => ({ terminalId: 'term-1' }));
  const app = express();
  app.use(express.json());
  app.use('/api', createCliAuthRouter({
    service: { check },
    enabledClis: () => ['claude'],
    isLocal: (req: Request) => req.headers['x-test-remote'] !== '1',
    deviceKeyOf: (req: Request) => String(req.headers['x-test-device'] ?? ''),
    openLogin,
    now: () => now,
  }));
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const phone = (device: string) => ({ 'x-test-remote': '1', 'x-test-device': device });
const login = (cli: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/cli-auth/${cli}/login`, { method: 'POST', headers });

describe('GET /api/cli-auth', () => {
  it('returns the report, uncached by the browser', async () => {
    const res = await fetch(`${base}/cli-auth`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ success: true, data: report });
    expect(check).toHaveBeenCalledWith({ refresh: false });
  });

  it('passes ?refresh=1 through', async () => {
    await fetch(`${base}/cli-auth?refresh=1`, { headers: phone('p1') });
    expect(check).toHaveBeenCalledWith({ refresh: true });
  });

  it('answers 500 without detail when the check throws', async () => {
    check.mockRejectedValueOnce(new Error('boom /Users/secret'));
    const res = await fetch(`${base}/cli-auth`);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });
});

describe('POST /api/cli-auth/:cli/login', () => {
  it('opens a login terminal and says which', async () => {
    const res = await login('claude');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, data: { cli: 'claude', terminalId: 'term-1' } });
    expect(openLogin).toHaveBeenCalledWith('claude', expect.objectContaining({ isLocal: true }));
  });

  it('refuses an unknown CLI', async () => {
    expect((await login('bash')).status).toBe(400);
    expect(openLogin).not.toHaveBeenCalled();
  });

  it('refuses a CLI that is not enabled in the settings', async () => {
    expect((await login('codex')).status).toBe(409);
    expect(openLogin).not.toHaveBeenCalled();
  });

  it('tells the opener a remote caller is remote', async () => {
    await login('claude', phone('p1'));
    expect(openLogin).toHaveBeenCalledWith('claude', expect.objectContaining({ isLocal: false }));
  });

  it('lets one remote device open a login at most once per gap', async () => {
    expect((await login('claude', phone('p1'))).status).toBe(201);
    expect((await login('claude', phone('p1'))).status).toBe(429);
    expect((await login('claude', phone('p2'))).status).toBe(201);
    now += REMOTE_LOGIN_GAP_MS;
    expect((await login('claude', phone('p1'))).status).toBe(201);
    expect(openLogin).toHaveBeenCalledTimes(3);
  });

  it('does not limit this machine', async () => {
    expect((await login('claude')).status).toBe(201);
    expect((await login('claude')).status).toBe(201);
  });

  it('answers the opener refusing (capacity) with its status and words', async () => {
    openLogin.mockRejectedValueOnce(Object.assign(new Error('Too many terminals'), { status: 429 }));
    const res = await login('claude');
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ success: false, error: 'Too many terminals' });
  });
});
