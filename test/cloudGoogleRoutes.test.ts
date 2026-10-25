import express from 'express';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudJsonParser, createCloudRouter } from '../server/cloud/router.js';
import { createCloudConnection } from '../server/cloud/connection.js';
import { createFileSecretStore } from '../server/cloud/secretStore.js';
import { createGoogleSignIn } from '../server/cloud/googleSignIn.js';
import { createGoogleCallbackRouter } from '../server/cloud/googleCallbackRouter.js';
import { isLocalNavigation } from '../server/requestLocality.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
const RETURN = 'http://127.0.0.1:3334/api/resources/cloud/google/callback';

async function harness() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-google-routes-')));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const cloud = await createCloudConnection({ directory: join(dir, 'cloud'), secrets: createFileSecretStore(join(dir, 'secrets')) });
  cleanup.push(() => cloud.stop());
  const connect = vi.fn(async () => ({
    backendOrigin: 'https://api.aasc.work',
    accountId: '00000000-0000-4000-8000-000000000001',
    deviceId: '00000000-0000-4000-8000-000000000002',
    deviceName: 'kason-mac',
    generation: 1,
  }));
  const signIn = createGoogleSignIn({ connect });
  const app = express();
  app.get('/api/resources/cloud/google/callback', createGoogleCallbackRouter(signIn));
  app.use('/cloud', cloudJsonParser());
  app.use('/cloud', createCloudRouter(cloud, (req) => req.get('sec-fetch-site') !== 'cross-site', { signIn, returnUrl: RETURN }));
  const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const port = (server.address() as { port: number }).port;
  return { signIn, connect, base: `http://127.0.0.1:${port}`, port };
}
/** A raw GET, so the Host and other headers are exactly what a test says. */
function rawGet(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const startBody = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
  body: JSON.stringify(body),
});

describe('Google sign-in routes on the Mac', () => {
  it('start is a same-origin JSON POST and answers the backend start URL', async () => {
    const h = await harness();
    expect((await fetch(`${h.base}/cloud/google/start`, startBody({}, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect(
      (await fetch(`${h.base}/cloud/google/start`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, body: 'x' })).status,
    ).toBe(415);
    const res = await fetch(`${h.base}/cloud/google/start`, startBody({ deviceName: 'kason-mac' }));
    expect(res.status).toBe(200);
    const url = new URL((await res.json()).data.url);
    expect(url.origin + url.pathname).toBe('https://api.aasc.work/v1/auth/google/start');
    expect(url.searchParams.get('return')).toBe(RETURN);
    expect(h.signIn.pending()).toBe(true);
  });

  it('start refuses a bad body', async () => {
    const h = await harness();
    expect((await fetch(`${h.base}/cloud/google/start`, startBody({ deviceName: 7 }))).status).toBe(400);
    expect((await fetch(`${h.base}/cloud/google/start`, startBody({ extra: true }))).status).toBe(400);
  });

  it('cancel drops the pending sign-in', async () => {
    const h = await harness();
    await fetch(`${h.base}/cloud/google/start`, startBody({}));
    expect((await fetch(`${h.base}/cloud/google/cancel`, startBody({}))).status).toBe(200);
    expect(h.signIn.pending()).toBe(false);
  });

  it('callback works as a cross-site navigation without the dashboard session cookie, and echoes nothing', async () => {
    const h = await harness();
    const start = await (await fetch(`${h.base}/cloud/google/start`, startBody({}))).json();
    const s = new URL(start.data.url).searchParams.get('s')!;
    const code = 'K'.repeat(22);
    const res = await rawGet(h.port, `/api/resources/cloud/google/callback?${new URLSearchParams({ code, state: s })}`, {
      host: `127.0.0.1:${h.port}`,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('Signed in');
    expect(res.body).not.toContain(code);
    expect(res.body).not.toContain(s);
    expect(h.connect).toHaveBeenCalledOnce();
  });

  it('callback with no pending sign-in or a wrong state does nothing', async () => {
    const h = await harness();
    const none = await rawGet(h.port, `/api/resources/cloud/google/callback?code=${'K'.repeat(22)}&state=${'s'.repeat(43)}`, {
      host: `127.0.0.1:${h.port}`,
    });
    expect(none.status).toBe(400);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('callback is 404 for a remote device, a forwarded request or a foreign Host', async () => {
    const h = await harness();
    for (const headers of [
      { host: `127.0.0.1:${h.port}`, 'x-forwarded-for': '203.0.113.9' },
      { host: 'attacker.example' },
      { host: `127.0.0.1:${h.port}`, origin: 'https://attacker.example' },
    ]) {
      const res = await rawGet(h.port, '/api/resources/cloud/google/callback?code=x&state=y', headers);
      expect(res.status, JSON.stringify(headers)).toBe(404);
    }
  });
});

describe('isLocalNavigation', () => {
  const socket = { remoteAddress: '127.0.0.1' };
  it('accepts a loopback top-level navigation even when the browser marks it cross-site', () => {
    expect(isLocalNavigation({ socket, headers: { host: 'localhost:3334', 'sec-fetch-site': 'cross-site' } })).toBe(true);
  });
  it('refuses a foreign Host, an Origin, forwarding headers or a remote peer', () => {
    expect(isLocalNavigation({ socket, headers: { host: 'evil.example' } })).toBe(false);
    expect(isLocalNavigation({ socket, headers: { host: 'localhost:3334', origin: 'http://localhost:3334' } })).toBe(false);
    expect(isLocalNavigation({ socket, headers: { host: 'localhost:3334', via: '1.1 proxy' } })).toBe(false);
    expect(isLocalNavigation({ socket: { remoteAddress: '192.168.1.9' }, headers: { host: 'localhost:3334' } })).toBe(false);
  });
});
