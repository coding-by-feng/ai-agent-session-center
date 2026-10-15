// test/promptRouter.test.ts — AASC-42: POST /api/sessions/:id/prompt. The phone sends intent
// (text, image ids, now or interrupt, a request key) and the Mac checks it the way it checks a
// terminal write: the session must be visible to the caller, a remote caller must be able to
// drive it (the control baton), and the agent must be the terminal's foreground program. Then
// it answers 202 at once and types the prompt in the background. The submitter is a fake here:
// nothing reaches a terminal.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false }));
vi.mock('../server/logger.js', () => ({ default: log }));

import { createPromptRouter, type PromptRouterSession } from '../server/promptRouter.js';
import type { PromptRequest, PromptOutcome } from '../server/promptSubmit.js';

let server: http.Server;
let port: number;
let sessions: Map<string, PromptRouterSession>;
let hidden: Set<string>;
let terminals: Set<string>;
let foreground: Map<string, string>;
let baton: Map<string, { clientId: string; label: string }>;
let images: Set<string>;
let submit: ReturnType<typeof vi.fn<(req: PromptRequest) => Promise<PromptOutcome>>>;

beforeEach(async () => {
  sessions = new Map([
    ['s1', { sessionId: 's1', terminalId: 'term-1', status: 'waiting' }],
    ['s2', { sessionId: 's2', terminalId: 'term-2', status: 'working' }],
  ]);
  hidden = new Set(['s-hidden']);
  terminals = new Set(['term-1', 'term-2']);
  foreground = new Map([['term-1', 'claude'], ['term-2', 'codex']]);
  baton = new Map();
  images = new Set(['queue-img-1-a.png', 'queue-img-2-b.jpg']);
  submit = vi.fn(async () => 'submitted' as const);
  log.error.mockClear();

  const app = express();
  app.use(express.json());
  app.use('/api', createPromptRouter({
    // Stands in for apiRouter's gate: 404 for a session the caller may not see.
    requireVisibleSession: (req: Request, res: Response, next: NextFunction) => {
      if (hidden.has(String(req.params.id))) { res.status(404).json({ error: 'Session not found' }); return; }
      next();
    },
    isLocal: (req) => req.headers['x-test-remote'] === undefined,
    clientIdOf: (req) => (typeof req.headers['x-test-client'] === 'string' ? req.headers['x-test-client'] : ''),
    getSession: (id) => sessions.get(id) ?? null,
    terminalExists: (id) => terminals.has(id),
    foregroundProcess: (id) => foreground.get(id) ?? null,
    noteControlActivity: (sessionId, clientId) => {
      const holder = baton.get(sessionId);
      if (holder && holder.clientId !== clientId) return false;
      baton.set(sessionId, { clientId, label: `device ${clientId}` });
      return true;
    },
    canControl: (sessionId, clientId) => {
      const holder = baton.get(sessionId);
      return !holder || holder.clientId === clientId;
    },
    controller: (sessionId) => {
      const holder = baton.get(sessionId);
      return holder ? { label: holder.label, online: true } : null;
    },
    resolveImage: (id) => (images.has(id) ? `/tmp/claude-queue-images/${id}` : null),
    submitter: { submit },
  }));
  // Anything the router doesn't own falls through to the rest of the API.
  app.use('/api', (_req, res) => { res.status(418).json({ fellThrough: true }); });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const REMOTE = (client?: string): Record<string, string> => ({ 'x-test-remote': '1', ...(client ? { 'x-test-client': client } : {}) });

function call(path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: `/api${path}`,
      headers: {
        ...headers,
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

const send = (session: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  call(`/sessions/${session}/prompt`, { key: 'key-00000001', text: 'fix the build', ...body }, headers);

describe('accepting a prompt', () => {
  it('answers 202 at once and hands the send to the submitter', async () => {
    const res = await send('s1', {});
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ success: true, data: { accepted: true, key: 'key-00000001' } });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({ sessionId: 's1', terminalId: 'term-1', text: 'fix the build', imagePaths: [], mode: 'now' });
  });

  it('hands over the session’s current id, not the one the phone used before a re-key', async () => {
    sessions.set('term-old-id', { sessionId: 's1', terminalId: 'term-1', status: 'waiting' });
    expect((await send('term-old-id', {})).status).toBe(202);
    expect(submit.mock.calls[0][0].sessionId).toBe('s1');
  });

  it('passes interrupt mode through', async () => {
    expect((await send('s2', { mode: 'interrupt' })).status).toBe(202);
    expect(submit.mock.calls[0][0]).toMatchObject({ terminalId: 'term-2', mode: 'interrupt' });
  });

  it('turns image ids into the paths it types, and refuses an image that is gone', async () => {
    expect((await send('s1', { images: ['queue-img-1-a.png', 'queue-img-2-b.jpg'] })).status).toBe(202);
    expect(submit.mock.calls[0][0].imagePaths).toEqual([
      '/tmp/claude-queue-images/queue-img-1-a.png', '/tmp/claude-queue-images/queue-img-2-b.jpg',
    ]);
    const gone = await send('s1', { key: 'key-00000002', images: ['queue-img-9-z.png'] });
    expect(gone.status).toBe(400);
    expect(gone.json).toMatchObject({ success: false, code: 'image_not_found' });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('types text, never control bytes: no Esc sequences, and Enter only where the Mac presses it', async () => {
    expect((await send('s1', { text: 'line one\r\nline two\rthree\x1b[2J\x07\x00 \tend\n\n' })).status).toBe(202);
    expect(submit.mock.calls[0][0].text).toBe('line one\nline two\nthree[2J \tend');
  });

  it.each([
    ['no text', { text: '' }],
    ['only control bytes and blanks', { text: '\x1b\x1b \r\n' }],
    ['text over 64 KB', { text: 'x'.repeat(65_537) }],
    ['five images', { images: ['a', 'b', 'c', 'd', 'e'].map((c) => `queue-img-1-${c}.png`) }],
    ['an unknown mode', { mode: 'later' }],
    ['a short key', { key: 'short' }],
    ['a key over 64 characters', { key: 'k'.repeat(65) }],
    ['a key with spaces', { key: 'key 0000 0001' }],
  ])('refuses %s with 400', async (_name, body) => {
    const res = await send('s1', body);
    expect(res.status).toBe(400);
    expect(res.json.success).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it('refuses a missing key with 400', async () => {
    const res = await call('/sessions/s1/prompt', { text: 'hi' });
    expect(res.status).toBe(400);
  });

  it('accepts 64 KB of text and four images', async () => {
    images.add('queue-img-3-c.png').add('queue-img-4-d.png');
    const res = await send('s1', {
      text: 'x'.repeat(65_536),
      images: ['queue-img-1-a.png', 'queue-img-2-b.jpg', 'queue-img-3-c.png', 'queue-img-4-d.png'],
    });
    expect(res.status).toBe(202);
  });

  it('owns only POST /sessions/:id/prompt', async () => {
    expect((await call('/sessions/s1/prompt', undefined, {}, 'GET')).status).toBe(418);
    expect((await call('/sessions/s1/queue', { items: [] }, {}, 'PUT')).status).toBe(418);
  });

  it('logs a send that fails in the background', async () => {
    submit.mockRejectedValueOnce(new Error('pty exploded'));
    expect((await send('s1', {})).status).toBe(202);
    await vi.waitFor(() => expect(log.error).toHaveBeenCalled());
    expect(String(log.error.mock.calls[0][1])).toContain('pty exploded');
  });
});

describe('the same request key twice', () => {
  it('sends once and answers the repeat with the first answer', async () => {
    const first = await send('s1', { key: 'retry-key-1', images: ['queue-img-1-a.png'] });
    const again = await send('s1', { key: 'retry-key-1', images: ['queue-img-1-a.png'] });
    expect(again.status).toBe(202);
    expect(again.json).toEqual(first.json);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('answers the repeat even once the session got busy or the image was swept: it was already sent', async () => {
    await send('s1', { key: 'retry-key-3', images: ['queue-img-1-a.png'] });
    sessions.set('s1', { sessionId: 's1', terminalId: 'term-1', status: 'approval' });
    images.clear();
    expect((await send('s1', { key: 'retry-key-3', images: ['queue-img-1-a.png'] })).status).toBe(202);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('refuses a key reused for a different prompt with 409, and sends nothing', async () => {
    await send('s1', { key: 'retry-key-4' });
    for (const body of [
      { key: 'retry-key-4', text: 'something else' },
      { key: 'retry-key-4', mode: 'interrupt' },
      { key: 'retry-key-4', images: ['queue-img-1-a.png'] },
    ]) {
      const res = await send('s1', body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(res.json).toMatchObject({ success: false, code: 'key_reused' });
    }
    expect((await send('s2', { key: 'retry-key-4' })).status).toBe(409);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('does not use up a key on a refused request', async () => {
    baton.set('s1', { clientId: 'mac', label: 'Mac' });
    expect((await send('s1', { key: 'retry-key-2' }, REMOTE('phone-a'))).status).toBe(423);
    baton.delete('s1');
    expect((await send('s1', { key: 'retry-key-2' }, REMOTE('phone-a'))).status).toBe(202);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('who may send', () => {
  it('answers 404 for a session the caller may not see, and for one that does not exist', async () => {
    const hiddenRes = await send('s-hidden', {}, REMOTE('phone-a'));
    expect(hiddenRes.status).toBe(404);
    const missing = await send('nope', {});
    expect(missing.status).toBe(404);
    expect(submit).not.toHaveBeenCalled();
  });

  it('answers 423 with the driver when another device holds the baton', async () => {
    baton.set('s1', { clientId: 'mac', label: 'Kason’s Mac' });
    const res = await send('s1', {}, REMOTE('phone-a'));
    expect(res.status).toBe(423);
    expect(res.json).toMatchObject({ success: false, code: 'control_held', driver: { label: 'Kason’s Mac', online: true } });
    expect(submit).not.toHaveBeenCalled();
  });

  it('refuses a remote caller that names no device, as a terminal write does', async () => {
    const res = await send('s1', {}, REMOTE());
    expect(res.status).toBe(423);
    expect(res.json).toMatchObject({ code: 'control_held', driver: null });
  });

  it('takes the free baton for the remote caller, and stops retries if it loses it', async () => {
    expect((await send('s1', {}, REMOTE('phone-a'))).status).toBe(202);
    expect(baton.get('s1')?.clientId).toBe('phone-a');
    const { mayDrive } = submit.mock.calls[0][0];
    expect(mayDrive?.('s1')).toBe(true);
    baton.set('s1', { clientId: 'mac', label: 'Mac' });
    expect(mayDrive?.('s1')).toBe(false);
  });

  it('never asks the Mac itself for the baton', async () => {
    baton.set('s1', { clientId: 'phone-a', label: 'Phone' });
    expect((await send('s1', {})).status).toBe(202);
    expect(submit.mock.calls[0][0].mayDrive).toBeUndefined();
  });

  it.each([
    ['the session has no terminal', () => { sessions.set('s1', { sessionId: 's1', terminalId: null, status: 'waiting' }); }],
    ['the terminal is gone', () => { terminals.delete('term-1'); }],
    ['the shell is in the foreground (the agent exited)', () => { foreground.set('term-1', 'zsh'); }],
    ['the foreground program is unknown', () => { foreground.delete('term-1'); }],
  ])('answers 409 agent_not_running when %s', async (_name, arrange) => {
    arrange();
    const res = await send('s1', {}, REMOTE('phone-a'));
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ success: false, code: 'agent_not_running' });
    expect(submit).not.toHaveBeenCalled();
    // A refused request takes no baton.
    expect(baton.has('s1')).toBe(false);
  });

  it('answers 409 agent_not_ready while the agent is still starting (a trust dialog fires no hook)', async () => {
    sessions.set('s1', { sessionId: 's1', terminalId: 'term-1', status: 'connecting' });
    for (const mode of ['now', 'interrupt']) {
      const res = await send('s1', { key: `key-start-${mode}`, mode });
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ success: false, code: 'agent_not_ready' });
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it('answers 409 agent_not_running for an ended session', async () => {
    sessions.set('s1', { sessionId: 's1', terminalId: 'term-1', status: 'ended' });
    const res = await send('s1', { mode: 'interrupt' });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('agent_not_running');
  });

  it('sends to a busy session (the CLI queues it) and interrupts one', async () => {
    expect((await send('s2', {})).status).toBe(202);
    expect((await send('s2', { key: 'key-00000005', mode: 'interrupt' })).status).toBe(202);
  });

  it('won’t type into an open dialog, where the text could pick an option; interrupt declines it first', async () => {
    sessions.set('s1', { sessionId: 's1', terminalId: 'term-1', status: 'approval' });
    const now = await send('s1', {});
    expect(now.status).toBe(409);
    expect(now.json).toMatchObject({ success: false, code: 'awaiting_answer' });
    sessions.set('s1', { sessionId: 's1', terminalId: 'term-1', status: 'input' });
    expect((await send('s1', { key: 'key-00000003' })).status).toBe(409);
    expect((await send('s1', { key: 'key-00000004', mode: 'interrupt' })).status).toBe(202);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
