import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Real HTTP and durable store behavior are exercised; no paid provider is involved.
const { createTrialClient, sanitizeTerminalText } = require('../bin/trial/client.cjs');
const nativeStatus = {
  available: true,
  mode: 'native_qa',
  policyVersion: 'native-qa-v1',
  runtime: 'claude-code',
  client: 'aasc',
  turnLimit: 3,
  inputLimit: 600,
  contextTokenLimit: 2500,
  outputTokenLimit: 800,
  historyPairs: 2,
  timeoutMs: 45000,
  concurrentTurns: 1,
};
const initialSession = {
  id: 'session-1',
  state: 'active',
  remaining: 3,
  completed: 0,
  reserved: 0,
  expiresAt: Date.now() + 86400000,
  transcriptExpiresAt: Date.now() + 86400000 * 30,
  turns: [] as any[],
};
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});
async function service(
  handler: (req: IncomingMessage, res: ServerResponse, body: any) => void | Promise<void>,
) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    await handler(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}
function json(res: ServerResponse, value: unknown, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
function store() {
  let value: any = null;
  return {
    load: () => (value ? structuredClone(value) : null),
    save: (next: any) => {
      value = structuredClone(next);
    },
  };
}
function status(res: ServerResponse, value: any = nativeStatus) {
  res.setHeader(
    'Set-Cookie',
    'aasc_trial=test-private-credential; HttpOnly; Path=/; SameSite=Strict',
  );
  json(res, value);
}

describe('native trial client', () => {
  it('persists its trial-only cookie before activation and never exposes it in snapshots', async () => {
    const storage = store();
    let activated = false;
    const origin = await service((req, res, body) => {
      if (req.url?.endsWith('/status')) return status(res);
      expect(req.headers.origin).toBe(origin);
      expect(req.headers.cookie).toBe('aasc_trial=test-private-credential');
      expect(storage.load()?.cookie).toBe('aasc_trial=test-private-credential');
      expect(body).toEqual({ code: 'test-code' });
      activated = true;
      json(res, { ...initialSession, secret: 'must-not-escape' });
    });
    const client = createTrialClient({ origin, store: storage });
    const result = await client.activate(' test-code ');
    expect(activated).toBe(true);
    expect(result.session?.remaining).toBe(3);
    expect(JSON.stringify(result)).not.toMatch(/credential|secret|cookie/);
    result.session.remaining = 0;
    expect(client.getSnapshot().session.remaining).toBe(3);
  });

  it.each([
    { mode: 'qa_only', policyVersion: 'qa-v1' },
    { runtime: 'api' },
    { client: 'web' },
    { available: 1 },
    { turnLimit: 4 },
    { inputLimit: 601 },
    { outputTokenLimit: 801 },
    { contextTokenLimit: 2501 },
    { timeoutMs: 45001 },
    { concurrentTurns: 2 },
    { historyPairs: 3 },
  ])('refuses to activate an incompatible native runtime %j', async (change) => {
    let posts = 0;
    const origin = await service((req, res) => {
      if (req.method === 'POST') posts++;
      status(res, { ...nativeStatus, ...change });
    });
    const client = createTrialClient({ origin, store: store() });
    await expect(client.activate('code')).rejects.toMatchObject({ code: 'runtime_unavailable' });
    expect(posts).toBe(0);
    expect(client.getSnapshot().status).toBeNull();
  });

  it('keeps a durable request after a lost response and reconciles it on a restarted client without a second POST', async () => {
    const storage = store();
    let session = structuredClone(initialSession);
    let posts = 0;
    const origin = await service((req, res, body) => {
      if (req.url?.endsWith('/status')) return status(res);
      if (req.url?.endsWith('/session')) return json(res, session);
      if (req.url?.endsWith('/turns')) {
        posts++;
        expect(storage.load()?.pending).toEqual(body);
        session = {
          ...session,
          remaining: 2,
          completed: 1,
          turns: [
            { id: 'turn-1', ...body, answer: '已回答', status: 'completed', createdAt: Date.now() },
          ],
        };
        res.destroy();
      }
    });
    const client = createTrialClient({ origin, store: storage, randomUUID: () => 'request-1' });
    await expect(client.ask('解释闭包')).rejects.toMatchObject({ code: 'network_error' });
    expect(client.getSnapshot().pending).toEqual({ requestKey: 'request-1', prompt: '解释闭包' });
    await expect(client.ask('另一个问题')).rejects.toMatchObject({ code: 'turn_pending' });
    const restarted = createTrialClient({ origin, store: storage });
    const result = await restarted.retry();
    expect(result.session?.turns[0].answer).toBe('已回答');
    expect(result.pending).toBeNull();
    expect(storage.load()?.pending).toBeNull();
    expect(posts).toBe(1);
  });

  it('manually retries an unacknowledged request with the exact persisted identity', async () => {
    const storage = store();
    const bodies: any[] = [];
    let session = structuredClone(initialSession);
    const origin = await service((req, res, body) => {
      if (req.url?.endsWith('/status')) return status(res);
      if (req.url?.endsWith('/session')) return json(res, session);
      bodies.push(body);
      if (bodies.length === 1) return res.destroy();
      session = {
        ...session,
        remaining: 2,
        reserved: 1,
        turns: [{ id: 'turn-1', ...body, answer: null, status: 'pending', createdAt: Date.now() }],
      };
      json(res, session);
    });
    const client = createTrialClient({ origin, store: storage, randomUUID: () => 'request-fixed' });
    await expect(client.ask('什么是闭包')).rejects.toMatchObject({ code: 'network_error' });
    expect(bodies).toHaveLength(1);
    const result = await createTrialClient({ origin, store: storage }).retry();
    expect(bodies).toEqual([
      { requestKey: 'request-fixed', prompt: '什么是闭包' },
      { requestKey: 'request-fixed', prompt: '什么是闭包' },
    ]);
    expect(result.pending).toBeNull();
    expect(result.session?.reserved).toBe(1);
  });

  it.each([
    ['rate_limited', 429],
    ['runtime_busy', 503],
    ['daily_budget_exhausted', 429],
    ['unknown\u001b[2J', 500],
  ])('retains pending identity on ambiguous %s responses', async (error, code) => {
    const storage = store();
    const origin = await service((req, res) => {
      if (req.url?.endsWith('/status')) return status(res);
      if (req.url?.endsWith('/session')) return json(res, initialSession);
      json(res, { error, detail: 'provider-secret' }, code as number);
    });
    const client = createTrialClient({ origin, store: storage, randomUUID: () => 'retain-me' });
    await expect(client.ask('解释变量')).rejects.not.toMatchObject({
      message: expect.stringContaining('provider-secret'),
    });
    expect(client.getSnapshot().pending?.requestKey).toBe('retain-me');
  });

  it('clears a fresh preadmission refusal but retains an earlier ambiguous identity on a later scope refusal', async () => {
    const storage = store();
    let refusal = true;
    const origin = await service((req, res) => {
      if (req.url?.endsWith('/status')) return status(res);
      if (req.url?.endsWith('/session')) return json(res, initialSession);
      if (!refusal) return res.destroy();
      json(res, { error: 'trial_scope_restricted' }, 403);
    });
    const client = createTrialClient({ origin, store: storage, randomUUID: () => 'scope-test' });
    await expect(client.ask('运行命令')).rejects.toMatchObject({ code: 'trial_scope_restricted' });
    expect(client.getSnapshot().pending).toBeNull();
    refusal = false;
    await expect(client.ask('解释变量')).rejects.toMatchObject({ code: 'network_error' });
    refusal = true;
    await expect(client.retry()).rejects.toMatchObject({ code: 'trial_scope_restricted' });
    expect(client.getSnapshot().pending?.requestKey).toBe('scope-test');
  });

  it('honours the server input limit and blocks spent or uncertain sessions before POST', async () => {
    let session = structuredClone(initialSession);
    let posts = 0;
    const origin = await service((req, res) => {
      if (req.url?.endsWith('/status')) return status(res, { ...nativeStatus, inputLimit: 4 });
      if (req.method === 'POST') posts++;
      json(res, session);
    });
    const client = createTrialClient({ origin, store: store() });
    await expect(client.ask('12345')).rejects.toMatchObject({ code: 'invalid_prompt' });
    session = { ...session, remaining: 0, completed: 3, state: 'exhausted' };
    await expect(client.ask('提问')).rejects.toMatchObject({ code: 'quota_exhausted' });
    session = {
      ...initialSession,
      reserved: 1,
      turns: [
        {
          id: 'uncertain',
          requestKey: 'previous',
          prompt: '之前',
          answer: null,
          status: 'uncertain',
          createdAt: Date.now(),
        },
      ],
    };
    await expect(client.ask('提问')).rejects.toMatchObject({ code: 'turn_pending' });
    expect(posts).toBe(0);
  });

  it('fails closed when the cookie cannot be persisted', async () => {
    let posts = 0;
    const origin = await service((req, res) => {
      if (req.method === 'POST') posts++;
      status(res);
    });
    const client = createTrialClient({
      origin,
      store: {
        load: () => null,
        save: () => {
          throw Error('disk path /private/secret');
        },
      },
    });
    await expect(client.activate('code')).rejects.toMatchObject({ code: 'storage_error' });
    expect(posts).toBe(0);
  });

  it('rejects oversized JSON, redirects, non-JSON and credential origin injection', async () => {
    for (const origin of [
      'https://evil.example',
      'http://evil.example',
      'http://localhost:1/path',
      'http://user@localhost:1',
      'https://xclaude.dev/anything',
    ]) {
      expect(() => createTrialClient({ origin, store: store() })).toThrow();
    }
    let mode = 'large';
    let redirected = false;
    const origin = await service((req, res) => {
      if (req.url === '/redirected') {
        redirected = true;
        return json(res, nativeStatus);
      }
      if (mode === 'large') return json(res, { ...nativeStatus, padding: 'x'.repeat(65536) });
      if (mode === 'redirect') {
        res.writeHead(302, { Location: '/redirected' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<script>secret</script>');
    });
    const client = createTrialClient({ origin, store: store() });
    await expect(client.status()).rejects.toMatchObject({ code: 'invalid_response' });
    mode = 'redirect';
    await expect(client.status()).rejects.toMatchObject({ code: 'network_error' });
    expect(redirected).toBe(false);
    mode = 'html';
    await expect(client.status()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('allows only the trial cookie and keeps state on failed sign-out', async () => {
    const storage = store();
    let logoutFails = true;
    const origin = await service((req, res) => {
      if (req.url?.endsWith('/status')) {
        res.setHeader('Set-Cookie', [
          'owner=do-not-store; HttpOnly; Path=/',
          'aasc_trial=test-private-credential; HttpOnly; Path=/',
        ]);
        return json(res, nativeStatus);
      }
      if (logoutFails) return json(res, { error: 'internal_error' }, 500);
      res.writeHead(204);
      res.end();
    });
    const client = createTrialClient({ origin, store: storage });
    await client.status();
    expect(storage.load()?.cookie).toBe('aasc_trial=test-private-credential');
    await expect(client.logout()).rejects.toMatchObject({ code: 'internal_error' });
    expect(storage.load()?.cookie).toBeTruthy();
    logoutFails = false;
    const snapshot = await client.logout();
    expect(storage.load()).toBeNull();
    expect(snapshot.session).toBeNull();
    expect(snapshot.pending).toBeNull();
  });

  it('finishes sign-out after a lost 204 response and a confirmed unauthorized retry', async () => {
    const storage = store();
    let revoked = false;
    let logoutRequests = 0;
    const origin = await service((req, res) => {
      if (req.url?.endsWith('/status')) return status(res);
      if (req.url?.endsWith('/session')) return json(res, initialSession);
      logoutRequests++;
      if (revoked) return json(res, { error: 'unauthorized' }, 401);
      revoked = true;
      res.writeHead(204);
      res.end();
    });
    const transport = async (url: string, options: RequestInit) => {
      const response = await fetch(url, options);
      if (url.endsWith('/logout') && response.status === 204) {
        throw Error('simulated loss after server sign-out');
      }
      return response;
    };
    const client = createTrialClient({ origin, store: storage, fetch: transport });
    await client.status();
    await client.state();
    await expect(client.logout()).rejects.toMatchObject({ code: 'network_error' });
    expect(storage.load()?.cookie).toBe('aasc_trial=test-private-credential');
    expect(client.getSnapshot().session?.id).toBe('session-1');

    const result = await client.logout();
    expect(logoutRequests).toBe(2);
    expect(storage.load()).toBeNull();
    expect(result.session).toBeNull();
    expect(result.pending).toBeNull();
  });

  it.each([
    ['unauthorized', 500, 'unauthorized'],
    ['unknown_unauthorized_response', 401, 'server_error'],
  ])(
    'retains sign-out recovery state for an unconfirmed %s / %s response',
    async (error, code, expectedCode) => {
      const storage = store();
      const origin = await service((req, res) => {
        if (req.url?.endsWith('/status')) return status(res);
        json(res, { error }, code as number);
      });
      const client = createTrialClient({ origin, store: storage });
      await client.status();
      await expect(client.logout()).rejects.toMatchObject({ code: expectedCode });
      expect(storage.load()?.cookie).toBe('aasc_trial=test-private-credential');
    },
  );

  it('aborts transport after 15 seconds without leaking an underlying error', async () => {
    vi.useFakeTimers();
    try {
      const transport = (_url: unknown, options: any) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(Error('private-provider-key')), {
            once: true,
          });
        });
      const client = createTrialClient({ store: store(), fetch: transport });
      const result = client.status().catch((error: any) => error);
      await vi.advanceTimersByTimeAsync(14999);
      expect(client.getSnapshot().busy).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      const error = await result;
      expect(error).toMatchObject({ code: 'network_error', message: 'network_error' });
      expect(client.getSnapshot().busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not submit a question if saving its pending identity fails', async () => {
    const storage = store();
    let writes = 0;
    let posts = 0;
    const origin = await service((req, res) => {
      if (req.url?.endsWith('/status')) return status(res);
      if (req.method === 'POST') posts++;
      json(res, initialSession);
    });
    const client = createTrialClient({
      origin,
      store: {
        load: storage.load,
        save: (next: any) => {
          if (++writes === 2) throw Error('full disk');
          storage.save(next);
        },
      },
    });
    await expect(client.ask('解释闭包')).rejects.toMatchObject({ code: 'storage_error' });
    expect(posts).toBe(0);
    expect(storage.load()?.pending).toBeNull();
  });

  it('keeps unavailable native service history readable and serializes concurrent callers', async () => {
    const storage = store();
    let release: () => void = () => {};
    let observed: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const origin = await service(async (req, res) => {
      if (req.url?.endsWith('/status')) {
        observed();
        await held;
        return status(res, { ...nativeStatus, available: false });
      }
      json(res, initialSession);
    });
    const client = createTrialClient({ origin, store: storage });
    const first = client.status();
    await entered;
    await expect(client.logout()).rejects.toMatchObject({ code: 'client_busy' });
    release();
    expect((await first).available).toBe(false);
    expect((await client.state()).session?.remaining).toBe(3);
    await expect(client.ask('解释闭包')).rejects.toMatchObject({ code: 'runtime_unavailable' });
  });

  it.each([
    '__Host-aasc_trial=secret; HttpOnly; Path=/',
    '__Host-aasc_trial=secret; Secure; HttpOnly; Path=/; Domain=xclaude.dev',
    '__Host-aasc_trial=secret; Secure; Path=/',
  ])('refuses a production credential missing host-only safeguards', async (cookie) => {
    const storage = store();
    const client = createTrialClient({
      store: storage,
      fetch: async () =>
        new Response(JSON.stringify(nativeStatus), {
          headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie },
        }),
    });
    await expect(client.status()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(storage.load()).toBeNull();
  });

  it('removes terminal escape sequences and dangerous controls from untrusted text', () => {
    expect(
      sanitizeTerminalText(
        '\u001b[2J安全\u001b]8;;https://evil.example\u0007链接\u001b]8;;\u001b\\\r重写\u0008\u0000\u009b31m\u202e换向\n下一行\t列',
      ),
    ).toBe('安全链接重写换向\n下一行\t列');
  });
});
