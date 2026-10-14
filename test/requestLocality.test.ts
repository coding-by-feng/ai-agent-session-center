// test/requestLocality.test.ts — AASC-13: a tunnel on this machine must not make every visitor "the Mac".
//
// Every locality gate used to read only the TCP peer address. A reverse proxy or tunnel running here
// (Cloudflare Tunnel, ngrok, `tailscale serve`, Caddy) connects from 127.0.0.1, so its visitors got the
// password-free, see-everything treatment reserved for the desktop app. These tests pin the one rule that
// replaced the seven address checks, and each gate that now uses it.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const mockConfig = vi.hoisted(() => ({} as { passwordHash?: string }));
vi.mock('../server/serverConfig.js', () => ({ config: mockConfig }));
vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import {
  isLocalRequest, hasForwardingHeaders, FORWARDING_HEADERS, markRemoteOnlyServer,
} from '../server/requestLocality.js';
import { resolveRemoteListenerPort, startRemoteListener, REMOTE_LISTENER_HOST } from '../server/remoteListener.js';
import { authMiddleware, localhostOnlyMiddleware } from '../server/authManager.js';
import { isLocalResourceRequest } from '../server/resourceRouter.js';
import * as presence from '../server/presenceManager.js';

beforeEach(() => { delete mockConfig.passwordHash; });
afterEach(() => { vi.clearAllMocks(); });

function mkReq(ip: string, headers: Record<string, string> = {}): Request {
  return {
    ip,
    socket: { remoteAddress: ip },
    headers: { host: 'localhost:3333', ...headers },
    method: 'GET',
    originalUrl: '/api/sessions',
    query: {},
  } as unknown as Request;
}
function mkRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: { code?: string } };
}

describe('isLocalRequest', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('treats a direct loopback request from %s as local', (ip) => {
    expect(isLocalRequest(mkReq(ip))).toBe(true);
  });

  it.each(['192.168.1.50', '100.101.102.103', '203.0.113.9'])('treats %s as remote', (ip) => {
    expect(isLocalRequest(mkReq(ip))).toBe(false);
  });

  it('fails closed for an unknown or empty address', () => {
    expect(isLocalRequest({ headers: {} })).toBe(false);
    expect(isLocalRequest(mkReq(''))).toBe(false);
  });

  it.each(FORWARDING_HEADERS.map((h) => [h]))('treats loopback + %s as a proxied remote client', (header) => {
    expect(isLocalRequest(mkReq('127.0.0.1', { [header]: 'x' }))).toBe(false);
  });

  it('ignores headers that are not proxy headers', () => {
    expect(hasForwardingHeaders({ 'user-agent': 'curl', cookie: 'a=b' })).toBe(false);
    expect(isLocalRequest(mkReq('127.0.0.1', { 'user-agent': 'AASC-Desktop' }))).toBe(true);
  });
});

describe('auth gate with no password configured', () => {
  it('refuses a tunnelled request from 127.0.0.1 (X-Forwarded-For) with 403', () => {
    const next = vi.fn() as unknown as NextFunction;
    const res = mkRes();
    authMiddleware(mkReq('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('REMOTE_PASSWORD_REQUIRED');
  });

  it('refuses a Cloudflare Tunnel request (CF-Connecting-IP) with 403', () => {
    const next = vi.fn() as unknown as NextFunction;
    const res = mkRes();
    authMiddleware(mkReq('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('still lets the desktop app in without a password', () => {
    const next = vi.fn() as unknown as NextFunction;
    authMiddleware(mkReq('127.0.0.1'), mkRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('hook endpoint gate (localhostOnlyMiddleware)', () => {
  it('accepts the hook script posting directly to localhost', () => {
    const next = vi.fn() as unknown as NextFunction;
    localhostOnlyMiddleware(mkReq('::ffff:127.0.0.1'), mkRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('refuses a hook relayed through a tunnel, so nobody can forge session events from outside', () => {
    const next = vi.fn() as unknown as NextFunction;
    const res = mkRes();
    localhostOnlyMiddleware(mkReq('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe('RESOURCES gate', () => {
  it('refuses a loopback request that carries proxy headers', () => {
    expect(isLocalResourceRequest(mkReq('127.0.0.1'))).toBe(true);
    expect(isLocalResourceRequest(mkReq('127.0.0.1', { 'x-real-ip': '203.0.113.9' }))).toBe(false);
  });
});

describe('device presence', () => {
  it('lists a tunnelled device as remote even though its socket is 127.0.0.1', () => {
    const device = presence.registerClient({
      clientId: 'aasc13-tunnelled', label: 'Phone via tunnel', address: '127.0.0.1', isLocal: false,
    });
    expect(device.isLocal).toBe(false);
    presence.unregisterClient('aasc13-tunnelled');
  });

  it('keeps the address fallback for callers that do not decide locality themselves', () => {
    const device = presence.registerClient({ clientId: 'aasc13-desktop', label: 'Desktop', address: '::1' });
    expect(device.isLocal).toBe(true);
    presence.unregisterClient('aasc13-desktop');
  });
});

describe('resolveRemoteListenerPort', () => {
  it('is off by default', () => {
    expect(resolveRemoteListenerPort(undefined, undefined, 3333)).toBeNull();
    expect(resolveRemoteListenerPort('', null, 3333)).toBeNull();
  });

  it('reads the config value, and the env var wins over it', () => {
    expect(resolveRemoteListenerPort(undefined, 3334, 3333)).toBe(3334);
    expect(resolveRemoteListenerPort('4444', 3334, 3333)).toBe(4444);
  });

  it('refuses invalid ports and the main port', () => {
    expect(resolveRemoteListenerPort('abc', undefined, 3333)).toBeNull();
    expect(resolveRemoteListenerPort(undefined, 70000, 3333)).toBeNull();
    expect(resolveRemoteListenerPort(undefined, 3333, 3333)).toBeNull();
  });
});

// ── Real sockets: the same app served on the main port and on the remote-only listener ──────────────

interface Harness {
  mainPort: number;
  remotePort: number;
  wssLocality: boolean[];
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const app = express();
  app.use('/api', authMiddleware);
  app.get('/api/ping', (req, res) => { res.json({ local: isLocalRequest(req) }); });
  const wss = new WebSocketServer({ noServer: true });
  const wssLocality: boolean[] = [];
  wss.on('connection', (ws, req) => {
    const local = isLocalRequest(req);
    wssLocality.push(local);
    ws.send(local ? 'local' : 'remote');
  });

  const main = http.createServer(app);
  main.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise<void>((r) => main.listen(0, '127.0.0.1', r));
  const remote = await startRemoteListener(app, wss, 0);
  return {
    mainPort: (main.address() as AddressInfo).port,
    remotePort: (remote.address() as AddressInfo).port,
    wssLocality,
    async close() {
      wss.clients.forEach((c) => c.terminate());
      await new Promise<void>((r) => main.close(() => r()));
      await new Promise<void>((r) => remote.close(() => r()));
    },
  };
}

function get(port: number, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/ping', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

function wsFirstMessage(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    ws.once('message', (data) => { resolve(String(data)); ws.close(); });
    ws.once('error', reject);
  });
}

describe('remote-only listener (real sockets)', () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  it('binds loopback only', () => {
    expect(REMOTE_LISTENER_HOST).toBe('127.0.0.1');
  });

  it('serves the desktop app password-free on the main port', async () => {
    const res = await get(h.mainPort);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ local: true });
  });

  it('refuses the same request through the remote-only listener when no password is set', async () => {
    const res = await get(h.remotePort);
    expect(res.status).toBe(403);
    expect(res.body).toContain('REMOTE_PASSWORD_REQUIRED');
  });

  it('refuses a proxied request on the main port too', async () => {
    const res = await get(h.mainPort, { 'X-Forwarded-For': '203.0.113.9' });
    expect(res.status).toBe(403);
  });

  it('marks a WebSocket upgraded on the remote-only listener as remote', async () => {
    expect(await wsFirstMessage(h.remotePort)).toBe('remote');
    expect(await wsFirstMessage(h.mainPort)).toBe('local');
  });
});

describe('markRemoteOnlyServer', () => {
  it('only affects the server it marks', async () => {
    const marked = http.createServer((req, res) => res.end(String(isLocalRequest(req))));
    const plain = http.createServer((req, res) => res.end(String(isLocalRequest(req))));
    markRemoteOnlyServer(marked);
    await new Promise<void>((r) => marked.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
    const read = (srv: http.Server) => new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: (srv.address() as AddressInfo).port, path: '/' }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b));
      }).on('error', reject);
    });
    expect(await read(marked)).toBe('false');
    expect(await read(plain)).toBe('true');
    await new Promise<void>((r) => marked.close(() => r()));
    await new Promise<void>((r) => plain.close(() => r()));
  });
});
