// test/phoneTerminalBudget.test.ts — AASC-32: a paired phone may open only so many new
// agent terminals a minute (launch, resume, restart, reconnect, fork, clone, AI popup),
// so a stuck retry can't fill the Mac's terminal limit. The Mac is never limited.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { createPhoneProfile, opensTerminal, PHONE_TERMINALS_PER_MINUTE } from '../server/mobile/phoneProfile.js';

let server: http.Server;
let port: number;
let clock: number;
let handled: number;
let home: string;
let project: string;

beforeEach(async () => {
  clock = 1_000_000;
  handled = 0;
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aasc32-home-')));
  project = join(home, 'proj');
  mkdirSync(project);
  const app = express();
  app.use(express.json());
  app.use('/api', createPhoneProfile({
    phoneOf: (req) => (typeof req.headers['x-test-phone'] === 'string' ? req.headers['x-test-phone'] : null),
    sharedProjectPaths: () => [project],
    knownProjectPaths: () => [project],
    isOpsTerminal: () => false,
    isSharedSession: (id) => id === 's1',
    sessionOfTerminal: () => 's1',
    foregroundProcess: () => 'claude',
    home,
    now: () => clock,
  }));
  // Stands in for the routes behind the profile: every request that gets here "opens" one.
  app.use('/api', (_req, res) => { handled++; res.json({ ok: true }); });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(home, { recursive: true, force: true });
});

function call(method: string, path: string, phone: string | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: `/api${path}`,
      headers: {
        ...(phone ? { 'x-test-phone': phone } : {}),
        ...(payload !== undefined && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const fork = (phone: string | null) => call('POST', '/sessions/s1/fork', phone, {});

describe('opensTerminal', () => {
  it('names every way a phone opens a new agent terminal, and nothing else', () => {
    for (const [method, path] of [
      ['POST', '/terminals'],
      ['POST', '/sessions/s1/resume'],
      ['POST', '/sessions/s1/restart-terminal'],
      ['POST', '/sessions/s1/reconnect-terminal'],
      ['POST', '/sessions/s1/fork'],
      ['POST', '/sessions/s1/clone'],
      ['POST', '/sessions/spawn-floating'],
    ]) expect(opensTerminal(method, path), `${method} ${path}`).toBe(true);
    for (const [method, path] of [
      ['GET', '/terminals'],
      ['POST', '/terminals/t1/write'],
      ['POST', '/sessions/s1/kill'],
      ['POST', '/sessions/s1/queue/resume'],
      ['GET', '/sessions/s1/transcript'],
      ['DELETE', '/terminals/t1'],
    ]) expect(opensTerminal(method, path), `${method} ${path}`).toBe(false);
  });
});

describe('a paired phone’s terminal budget', () => {
  it('opens up to the limit in a minute, then answers 429 with a plain message and opens nothing', async () => {
    for (let i = 0; i < PHONE_TERMINALS_PER_MINUTE; i++) expect((await fork('phone-a')).status).toBe(200);
    const over = await fork('phone-a');
    expect(over.status).toBe(429);
    expect(over.json.code).toBe('PHONE_TERMINAL_LIMIT');
    expect(String(over.json.error)).toMatch(/wait a moment/i);
    expect(over.json.retryAfter).toBe(60);
    expect(handled).toBe(PHONE_TERMINALS_PER_MINUTE);
  });

  it('counts every way of opening one against the same budget', async () => {
    const ways: Array<[string, string, unknown]> = [
      ['POST', '/terminals', { command: 'claude', workingDir: project }],
      ['POST', '/sessions/s1/resume', {}],
      ['POST', '/sessions/s1/restart-terminal', {}],
      ['POST', '/sessions/s1/reconnect-terminal', {}],
      ['POST', '/sessions/s1/clone', {}],
      ['POST', '/sessions/spawn-floating', { originSessionId: 's1' }],
    ];
    for (const [method, path, body] of ways) expect((await call(method, path, 'phone-a', body)).status, path).toBe(200);
    for (let i = ways.length; i < PHONE_TERMINALS_PER_MINUTE; i++) expect((await fork('phone-a')).status).toBe(200);
    expect((await call('POST', '/sessions/spawn-floating', 'phone-a', { originSessionId: 's1' })).status).toBe(429);
    expect((await call('POST', '/terminals', 'phone-a', { command: 'claude', workingDir: project })).status).toBe(429);
  });

  it('is per phone; the Mac and password sign-ins are never limited', async () => {
    for (let i = 0; i <= PHONE_TERMINALS_PER_MINUTE; i++) await fork('phone-a');
    expect((await fork('phone-a')).status).toBe(429);
    expect((await fork('phone-b')).status).toBe(200);
    for (let i = 0; i < PHONE_TERMINALS_PER_MINUTE * 3; i++) expect((await fork(null)).status).toBe(200);
  });

  it('starts over after a minute', async () => {
    for (let i = 0; i <= PHONE_TERMINALS_PER_MINUTE; i++) await fork('phone-a');
    clock += 30_000;
    const later = await fork('phone-a');
    expect(later.status).toBe(429);
    expect(later.json.retryAfter).toBe(30);
    clock += 30_000;
    expect((await fork('phone-a')).status).toBe(200);
  });

  it('a refused request, or one that opens nothing, never uses it up', async () => {
    // An AI popup from a session that isn't shared is refused before it can count.
    for (let i = 0; i < 3; i++) expect((await call('POST', '/sessions/spawn-floating', 'phone-a', { originSessionId: 'hidden' })).status).toBe(404);
    for (let i = 0; i < 30; i++) expect((await call('GET', '/sessions/s1/transcript', 'phone-a')).status).toBe(200);
    for (let i = 0; i < PHONE_TERMINALS_PER_MINUTE; i++) expect((await fork('phone-a')).status).toBe(200);
  });
});
