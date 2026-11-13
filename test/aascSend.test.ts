import { describe, it, expect, vi } from 'vitest';
import { sendNow, queuePrompt, type SendDeps, type SendTarget } from '../cli/client/send.js';
import { createRequester, unixSocketFetch, type Requester } from '../cli/client/http.js';
import { createServer, type IncomingMessage } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FetchLike } from '../electron/remote/remoteClient.js';

type Step = { kind: 'request'; method: string; path: string; body: unknown } | { kind: 'sleep'; ms: number };

/** A fake server answering every request with `answer`, and a log of requests and sleeps in order. */
function harness(answer: (method: string, path: string, body: unknown) => { status: number; data?: unknown } = () => ({ status: 200, data: { ok: true } })) {
  const steps: Step[] = [];
  const out: string[] = [];
  const confirm = vi.fn(async (_q: string) => false);
  const request: Requester = async (method, path, body) => {
    steps.push({ kind: 'request', method, path, body });
    const a = answer(method, path, body);
    return { status: a.status, data: a.data ?? null };
  };
  const deps: SendDeps = {
    request,
    sleep: async (ms: number) => { steps.push({ kind: 'sleep', ms }); },
    confirm,
    out: (line: string) => { out.push(line); },
  };
  return { deps, steps, out, confirm };
}

const idle: SendTarget = { ref: 'vps:2', session: { sessionId: 'sess-2', status: 'waiting', terminalId: 'term-9' } };
const busy: SendTarget = { ref: 'vps:2', session: { sessionId: 'sess-2', status: 'working', terminalId: 'term-9' } };

describe('aasc send', () => {
  it('writes the text, waits 1000 ms, then writes a standalone \\r', async () => {
    const h = harness();
    await expect(sendNow(h.deps, idle, 'yes, apply the migration', { force: false })).resolves.toBe(0);
    expect(h.steps).toEqual([
      { kind: 'request', method: 'POST', path: '/api/terminals/term-9/write', body: { data: 'yes, apply the migration' } },
      { kind: 'sleep', ms: 1000 },
      { kind: 'request', method: 'POST', path: '/api/terminals/term-9/write', body: { data: '\r' } },
    ]);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.out.join('\n')).toContain('✓ sent');
  });

  it('asks before typing into a session that is not sendable, and sends nothing on N', async () => {
    const h = harness();
    await expect(sendNow(h.deps, busy, 'hi', { force: false })).resolves.toBe(1);
    expect(h.confirm).toHaveBeenCalledWith('vps:2 is working. Send anyway?');
    expect(h.steps).toEqual([]);
  });

  it('sends after a y', async () => {
    const h = harness();
    h.confirm.mockResolvedValueOnce(true);
    await expect(sendNow(h.deps, busy, 'hi', { force: false })).resolves.toBe(0);
    expect(h.steps.filter((s) => s.kind === 'request')).toHaveLength(2);
  });

  it('--force skips the question', async () => {
    const h = harness();
    await expect(sendNow(h.deps, busy, 'hi', { force: true })).resolves.toBe(0);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.steps).toHaveLength(3);
  });

  it('treats idle, waiting and input as sendable, like the queue', async () => {
    for (const status of ['idle', 'waiting', 'input']) {
      const h = harness();
      await sendNow(h.deps, { ...idle, session: { ...idle.session, status } }, 'x', { force: false });
      expect(h.confirm, status).not.toHaveBeenCalled();
    }
  });

  it('sends no Enter when the text write fails, and says why', async () => {
    const h = harness(() => ({ status: 409, data: { code: 'CONTROL_HELD', error: 'This device was not recognised.' } }));
    const code = await sendNow(h.deps, idle, 'hi', { force: false });
    expect(code).not.toBe(0);
    expect(h.steps).toHaveLength(1);
    expect(h.out.join('\n')).toMatch(/not recognised/);
  });

  it('a session without a terminal is exit 4', async () => {
    const h = harness();
    const code = await sendNow(h.deps, { ...idle, session: { ...idle.session, terminalId: null } }, 'hi', { force: false });
    expect(code).toBe(4);
    expect(h.steps).toEqual([]);
  });

  it('a 404 from the server is exit 4 (gone, or not shared)', async () => {
    const h = harness(() => ({ status: 404, data: { error: 'Terminal not found' } }));
    await expect(sendNow(h.deps, idle, 'hi', { force: false })).resolves.toBe(4);
  });

  it('refuses empty text as a usage error', async () => {
    const h = harness();
    await expect(sendNow(h.deps, idle, '', { force: false })).resolves.toBe(1);
    expect(h.steps).toEqual([]);
  });

  it('escapes the terminal id in the path', async () => {
    const h = harness();
    await sendNow(h.deps, { ...idle, session: { ...idle.session, terminalId: 'a/b?c' } }, 'x', { force: true });
    expect((h.steps[0] as { path: string }).path).toBe('/api/terminals/a%2Fb%3Fc/write');
  });
});

describe('aasc queue', () => {
  it('posts the text to /queue/items as a paused item', async () => {
    const h = harness();
    await expect(queuePrompt(h.deps, idle, 'then deploy to test')).resolves.toBe(0);
    expect(h.steps).toEqual([
      { kind: 'request', method: 'POST', path: '/api/sessions/sess-2/queue/items', body: { text: 'then deploy to test' } },
    ]);
    expect(h.out.join('\n')).toContain('✓ queued (paused)');
  });

  it('a 404 is exit 4', async () => {
    const h = harness(() => ({ status: 404, data: { error: 'Session not found' } }));
    await expect(queuePrompt(h.deps, idle, 'x')).resolves.toBe(4);
  });
});

describe('REST identity headers', () => {
  it('every call carries the bearer, X-AASC-Client-Id, X-AASC-Role: cli, and never follows a redirect', async () => {
    const seen: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, init });
      return { status: 200, text: async () => JSON.stringify({ ok: true }) };
    };
    const request = createRequester({ fetch }, {
      origin: 'http://127.0.0.1:41234', bearer: 'tok_abcdefghijklmnop', clientId: 'aasc-1234', label: 'aasc on box',
    });
    const a = await request('POST', '/api/terminals/t/write', { data: 'x' });
    expect(a).toEqual({ status: 200, data: { ok: true } });
    expect(seen[0].url).toBe('http://127.0.0.1:41234/api/terminals/t/write');
    expect(seen[0].init.redirect).toBe('manual');
    expect(seen[0].init.headers).toMatchObject({
      Authorization: 'Bearer tok_abcdefghijklmnop',
      'X-AASC-Client-Id': 'aasc-1234',
      'X-AASC-Client-Label': 'aasc on box',
      'X-AASC-Role': 'cli',
      'Content-Type': 'application/json',
    });
    expect(seen[0].init.body).toBe(JSON.stringify({ data: 'x' }));
  });

  it('cuts off an oversized answer instead of buffering it', async () => {
    const fetch: FetchLike = async () => ({ status: 200, text: async () => 'x'.repeat(2048) });
    const request = createRequester({ fetch, maxBytes: 1024 }, { origin: 'http://127.0.0.1:1', bearer: 'b', clientId: 'c', label: 'l' });
    await expect(request('GET', '/api/sessions')).rejects.toThrow(/too large/);
  });
});

describe('HTTP over the tunnel’s Unix socket', () => {
  it('sends the request to the socket with Host: localhost and reads the answer, capped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aasc-http-'));
    const sock = join(dir, 's.sock');
    const seen: { req: IncomingMessage; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ req, body });
        res.setHeader('Content-Type', 'application/json');
        res.end(req.url === '/big' ? JSON.stringify({ pad: 'x'.repeat(4096) }) : JSON.stringify({ ok: true, url: req.url }));
      });
    });
    await new Promise<void>((r) => server.listen(sock, () => r()));
    try {
      const auth = { origin: 'http://localhost', bearer: 'tok_abcdefghijklmnop', clientId: 'aasc-1', label: 'aasc on box' };
      const request = createRequester({ fetch: unixSocketFetch(sock) }, auth);
      await expect(request('POST', '/api/terminals/t/write', { data: 'x' })).resolves.toEqual({ status: 200, data: { ok: true, url: '/api/terminals/t/write' } });
      expect(seen[0].req.headers.host).toBe('localhost');
      expect(seen[0].req.headers.authorization).toBe('Bearer tok_abcdefghijklmnop');
      expect(seen[0].req.headers['x-aasc-role']).toBe('cli');
      expect(seen[0].body).toBe(JSON.stringify({ data: 'x' }));
      const capped = createRequester({ fetch: unixSocketFetch(sock), maxBytes: 1024 }, auth);
      await expect(capped('GET', '/big')).rejects.toThrow(/too large/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
