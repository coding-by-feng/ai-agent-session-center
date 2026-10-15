// test/phonePromptBudget.test.ts — AASC-42: a paired phone may send 20 prompts a minute through
// the Mac (POST /sessions/:id/prompt), in the style of AASC-32's terminal budget: a stuck retry
// or a misbehaving app can't keep typing into a session. The Mac and password sign-ins are never
// limited, and the budget is separate from the terminal and upload budgets.
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

import {
  createPhoneProfile, phoneRuleFor, PHONE_PROMPTS_PER_MINUTE, PHONE_TERMINALS_PER_MINUTE,
} from '../server/mobile/phoneProfile.js';

let server: http.Server;
let port: number;
let clock: number;
let handled: number;
let home: string;
let project: string;

beforeEach(async () => {
  clock = 1_000_000;
  handled = 0;
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aasc42-home-')));
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
  // Stands in for the routes behind the profile.
  app.use('/api', (_req, res) => { handled++; res.status(202).json({ success: true }); });
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

const prompt = (phone: string | null, session = 's1') =>
  call('POST', `/sessions/${session}/prompt`, phone, { text: 'hi', key: 'k-12345678' });

describe('the prompt route on the allow-list', () => {
  it('is open to a phone under the prompt rule, POST only', () => {
    expect(phoneRuleFor('POST', '/sessions/abc/prompt')).toBe('prompt');
    expect(phoneRuleFor('GET', '/sessions/abc/prompt')).toBeNull();
    expect(phoneRuleFor('POST', '/sessions/abc/prompt/extra')).toBeNull();
  });
});

describe('a paired phone’s prompt budget', () => {
  it('sends up to 20 in a minute, then answers 429 with a plain message and sends nothing', async () => {
    expect(PHONE_PROMPTS_PER_MINUTE).toBe(20);
    for (let i = 0; i < PHONE_PROMPTS_PER_MINUTE; i++) expect((await prompt('phone-a')).status).toBe(202);
    const over = await prompt('phone-a');
    expect(over.status).toBe(429);
    expect(over.json.code).toBe('PHONE_PROMPT_LIMIT');
    expect(String(over.json.error)).toMatch(/wait a moment/i);
    expect(over.json.retryAfter).toBe(60);
    expect(handled).toBe(PHONE_PROMPTS_PER_MINUTE);
  });

  it('is per phone, across its sessions; the Mac and password sign-ins are never limited', async () => {
    for (let i = 0; i < PHONE_PROMPTS_PER_MINUTE; i++) await prompt('phone-a', i % 2 ? 's1' : 's2');
    expect((await prompt('phone-a', 's3')).status).toBe(429);
    expect((await prompt('phone-b')).status).toBe(202);
    for (let i = 0; i < PHONE_PROMPTS_PER_MINUTE * 2; i++) expect((await prompt(null)).status).toBe(202);
  });

  it('starts over after a minute', async () => {
    for (let i = 0; i <= PHONE_PROMPTS_PER_MINUTE; i++) await prompt('phone-a');
    clock += 45_000;
    const later = await prompt('phone-a');
    expect(later.status).toBe(429);
    expect(later.json.retryAfter).toBe(15);
    clock += 15_000;
    expect((await prompt('phone-a')).status).toBe(202);
  });

  it('is its own budget: prompts never use up the terminal budget, nor terminals the prompt budget', async () => {
    for (let i = 0; i < PHONE_PROMPTS_PER_MINUTE; i++) await prompt('phone-a');
    expect((await call('POST', '/sessions/s1/fork', 'phone-a', {})).status).toBe(202);
    for (let i = 1; i < PHONE_TERMINALS_PER_MINUTE; i++) await call('POST', '/sessions/s1/fork', 'phone-a', {});
    expect((await call('POST', '/sessions/s1/fork', 'phone-a', {})).status).toBe(429);
    expect((await prompt('phone-b')).status).toBe(202);
  });
});
