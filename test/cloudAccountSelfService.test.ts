import express from 'express';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportCloudAccount, EXPORT_MAX_BYTES, EXPORT_TIMEOUT_MS } from '../server/cloud/accountExport.js';
import { allowedCloudRoute } from '../server/cloud/client.js';
import { createCloudConnection } from '../server/cloud/connection.js';
import { createGoogleCallbackRouter } from '../server/cloud/googleCallbackRouter.js';
import { createGoogleSignIn } from '../server/cloud/googleSignIn.js';
import { cloudJsonParser, createCloudRouter } from '../server/cloud/router.js';
import { createFileSecretStore } from '../server/cloud/secretStore.js';
import { selfDescription } from '../server/cloud/selfDescription.js';
import { createAfterDelete } from '../server/cloud/afterDelete.js';
import { CloudError, type CloudClient } from '../server/cloud/types.js';

/**
 * Plan 18, stage 1, the Mac's half: delete the AASC Cloud account through a Google sign-in started
 * with the intent "delete", export the account to a file on this computer, and tell the backend
 * what this install is (platform, edition, version).
 */
const OWNER = 'd23c54de-1b99-4802-87bf-d84ddba2fdf1';
const DEVICE = 'ddf341c5-6747-4d12-a012-e29034536836';
const TOKEN = 't'.repeat(43);
const CODE = 'c'.repeat(22);
const RETURN = 'http://127.0.0.1:3334/api/resources/cloud/google/callback';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
const ok = (data: unknown) => JSON.stringify({ success: true, data });
const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => resolve(text));
  });

/** A fake backend on loopback and a connector on a scratch folder. `seen` lists every request it got. */
async function backend(handler?: RequestListener, describe?: () => Record<string, unknown> | null) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-cloud-self-')));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];
  let health: 'ok' | 'gone' | 'broken' | 'forbidden' = 'ok';
  const server = createServer(async (req, res) => {
    const text = await body(req);
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: text });
    if (handler && req.url !== '/v1/devices/pair' && req.url !== '/v1/health') return handler(req, res);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/devices/pair') return res.end(ok({ token: TOKEN, ownerId: OWNER, deviceId: DEVICE }));
    if (req.url === '/v1/health' && health !== 'ok') {
      res.statusCode = health === 'gone' ? 401 : health === 'forbidden' ? 403 : 500;
      return res.end(JSON.stringify({ success: false, error: { code: 'unauthorized', message: 'x' } }));
    }
    res.end(ok({ status: 'ok', contractVersion: 1, ownerId: OWNER, deviceId: DEVICE }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cloud = await createCloudConnection({
    directory: join(dir, 'config'),
    secrets: createFileSecretStore(join(dir, 'secrets')),
    timeoutMs: 500,
    ...(describe ? { describe } : {}),
  });
  cleanups.push(() => cloud.stop());
  return {
    dir,
    cloud,
    url,
    seen,
    connect: () => cloud.connectCloud({ backendUrl: url, pairingCode: CODE, deviceName: 'Test device' }),
    deleteAccount: () => (health = 'gone'),
    setHealth: (next: typeof health) => (health = next),
  };
}
/** Waits for fire-and-forget requests to land. */
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('selfDescription', () => {
  it('names the platform, edition and version the backend accepts', () => {
    expect(selfDescription({ platform: 'darwin', edition: 'desktop', lite: false, version: '2.11.0' })).toEqual({
      platform: 'macos',
      edition: 'full',
      appVersion: '2.11.0',
    });
    expect(selfDescription({ platform: 'win32', edition: 'desktop', lite: true, version: '2.11.0' })).toEqual({
      platform: 'windows',
      edition: 'lite',
      appVersion: '2.11.0',
    });
    expect(selfDescription({ platform: 'linux', edition: 'headless', lite: false, version: '2.10.80-beta.1' })).toEqual({
      platform: 'linux',
      edition: 'server',
      appVersion: '2.10.80-beta.1',
    });
  });
  it('leaves out what it cannot name, and says nothing at all when nothing is left', () => {
    expect(selfDescription({ platform: 'freebsd', edition: 'dev', lite: false, version: '2.11.0' })).toEqual({
      edition: 'full',
      appVersion: '2.11.0',
    });
    expect(selfDescription({ platform: 'darwin', edition: 'desktop', lite: false, version: 'not a version' })).toEqual({
      platform: 'macos',
      edition: 'full',
    });
    expect(selfDescription({ platform: 'aix', edition: 'unknown' as never, lite: false, version: '' })).toBeNull();
  });
});

describe('this Mac describes itself to the backend', () => {
  const details = () => ({ platform: 'macos', edition: 'full', appVersion: '2.11.0' });
  it('after connecting, with its own token, and never at startup', async () => {
    const f = await backend((_req, res) => res.end(ok({ device: {} })), details);
    expect(f.seen).toEqual([]);
    await f.connect();
    await settle();
    const put = f.seen.find((r) => r.url === '/v1/devices/self');
    expect(put).toMatchObject({ method: 'PUT', auth: `Bearer ${TOKEN}` });
    expect(JSON.parse(put!.body)).toEqual(details());
    // A restart with the saved connection sends nothing by itself.
    const before = f.seen.length;
    const restored = await createCloudConnection({
      directory: join(f.dir, 'config'),
      secrets: createFileSecretStore(join(f.dir, 'secrets')),
      describe: details,
    });
    cleanups.push(() => restored.stop());
    await settle();
    expect(f.seen.length).toBe(before);
  });
  it('again after a recheck that succeeds', async () => {
    const f = await backend((_req, res) => res.end(ok({ device: {} })), details);
    await f.connect();
    await settle();
    await f.cloud.recheckCloud();
    await settle();
    expect(f.seen.filter((r) => r.url === '/v1/devices/self')).toHaveLength(2);
  });
  it('a backend that does not know the route, or fails, leaves the connection connected and clean', async () => {
    for (const status of [404, 400, 500]) {
      const f = await backend((_req, res) => {
        res.statusCode = status;
        res.end(JSON.stringify({ success: false, error: { code: 'whatever', message: 'x' } }));
      }, details);
      await f.connect();
      await settle();
      expect(f.cloud.status(), String(status)).toMatchObject({ state: 'connected', lastError: null });
    }
  });
  it('a refused description never reads as this Mac being revoked', async () => {
    const f = await backend((_req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ success: false, error: { code: 'unauthorized', message: 'x' } }));
    }, details);
    await f.connect();
    await settle();
    expect(f.cloud.status()).toMatchObject({ state: 'connected', lastError: null });
    expect(f.cloud.status().connection).not.toBeNull();
  });
  it('sends nothing when there is nothing to say', async () => {
    const f = await backend(undefined, () => null);
    await f.connect();
    await settle();
    expect(f.seen.some((r) => r.url === '/v1/devices/self')).toBe(false);
  });
});

describe('the allow-list for the account routes', () => {
  it('lets this Mac read its export and nothing else under /v1/account', () => {
    expect(allowedCloudRoute('GET', '/v1/account/export')).toBe(true);
    for (const [method, path] of [
      ['DELETE', '/v1/account'],
      ['POST', '/v1/account/export'],
      ['GET', '/v1/account'],
      ['GET', '/v1/account/export/x'],
      ['GET', '/v1/account/export?x=1#y'],
    ] as const)
      expect(allowedCloudRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

describe('exportCloudAccount', () => {
  const streamOf = (...parts: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });
  const clientGiving = (stream: () => ReadableStream<Uint8Array>): CloudClient => ({
    request: vi.fn(),
    stream: vi.fn(async (_path, consume) => consume(stream())),
  });
  async function folder() {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-export-')));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }
  it('saves the export to a private file named by its time, and answers where', async () => {
    const dir = await folder();
    const client = clientGiving(() => streamOf('{"owner":', '{"id":"x"}}'));
    const saved = await exportCloudAccount({ client, directory: dir, now: () => Date.UTC(2026, 10, 20, 1, 2, 3) });
    expect(saved).toEqual({ path: join(dir, 'aasc-cloud-export-20261120-010203.json'), bytes: 20 });
    expect(await readFile(saved.path, 'utf8')).toBe('{"owner":{"id":"x"}}');
    expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
    // The one long read: 31 minutes reach the transport, a minute past the backend's own cut-off.
    expect(EXPORT_TIMEOUT_MS).toBe(31 * 60_000);
    expect(client.stream).toHaveBeenCalledWith('/v1/account/export', expect.any(Function), undefined, EXPORT_TIMEOUT_MS);
    expect(await readdir(dir)).toEqual(['aasc-cloud-export-20261120-010203.json']);
  });
  it('never overwrites: a second export in the same second gets its own name', async () => {
    const dir = await folder();
    const now = () => Date.UTC(2026, 10, 20, 1, 2, 3);
    const first = await exportCloudAccount({ client: clientGiving(() => streamOf('a')), directory: dir, now });
    const second = await exportCloudAccount({ client: clientGiving(() => streamOf('b')), directory: dir, now });
    expect(second.path).not.toBe(first.path);
    expect(await readFile(first.path, 'utf8')).toBe('a');
    expect(await readFile(second.path, 'utf8')).toBe('b');
  });
  it('a failed or oversized export leaves no file behind', async () => {
    const dir = await folder();
    const failing: CloudClient = {
      request: vi.fn(),
      stream: vi.fn(async () => {
        throw new CloudError('forbidden', 'This device does not have permission for this cloud action.', 403);
      }),
    };
    await expect(exportCloudAccount({ client: failing, directory: dir, now: Date.now })).rejects.toMatchObject({
      code: 'export_needs_sign_in',
      status: 403,
    });
    const tooBig = clientGiving(() => streamOf('x'.repeat(64)));
    await expect(
      exportCloudAccount({ client: tooBig, directory: dir, now: Date.now, maxBytes: 16 }),
    ).rejects.toMatchObject({ code: 'export_too_large' });
    expect(await readdir(dir)).toEqual([]);
    expect(EXPORT_MAX_BYTES).toBeGreaterThan(1024 ** 3);
  });
  it('shows only a ".part" while it runs, and never writes through something left at that name', async () => {
    const dir = await folder();
    const now = () => Date.UTC(2026, 10, 20, 1, 2, 3);
    const victim = join(dir, 'victim.txt');
    await writeFile(victim, 'untouched');
    // A crash left a part behind, and something planted a link where the next name would go.
    await writeFile(join(dir, 'aasc-cloud-export-20261120-010203.json.part'), 'stale');
    await symlink(victim, join(dir, 'aasc-cloud-export-20261120-010203-2.json.part'));
    let during: string[] = [];
    const client: CloudClient = {
      request: vi.fn(),
      stream: vi.fn(async (_path, consume) => {
        await consume(streamOf('fresh'));
        during = await readdir(dir);
      }),
    };
    const saved = await exportCloudAccount({ client, directory: dir, now });
    expect(await readFile(saved.path, 'utf8')).toBe('fresh');
    expect(await readFile(victim, 'utf8')).toBe('untouched');
    // While the bytes arrived there was no finished-looking ".json" of ours in the folder.
    expect(during.filter((name) => name.endsWith('.json'))).toEqual([]);
    expect(saved.path.endsWith('.json')).toBe(true);
  });
  it('needs a client that can stream', async () => {
    const dir = await folder();
    await expect(
      exportCloudAccount({ client: { request: vi.fn() }, directory: dir, now: Date.now }),
    ).rejects.toMatchObject({ code: 'cloud_error' });
  });
});

describe('deleting the account from the Mac', () => {
  function signInHarness(after: 'gone' | 'still-connected' | 'unknown' = 'gone') {
    let time = 1_000_000;
    const connect = vi.fn();
    const afterDelete = vi.fn(async () => after);
    const logs: string[] = [];
    const signIn = createGoogleSignIn({ connect, afterDelete, now: () => time, log: (m) => logs.push(m) });
    const begin = (intent?: 'delete') =>
      new URL(
        signIn.begin({ backendUrl: 'https://api.aasc.work', deviceName: 'kason-mac', returnUrl: RETURN, ...(intent ? { intent } : {}) }).url,
      );
    return { signIn, connect, afterDelete, logs, begin, advance: (ms: number) => (time += ms) };
  }
  it('the start URL carries intent=delete, and an ordinary sign-in does not', () => {
    const h = signInHarness();
    expect(h.begin('delete').searchParams.get('intent')).toBe('delete');
    expect(h.begin().searchParams.has('intent')).toBe(false);
  });
  it('a return with deleted=1 and the right state checks this Mac and never pairs', async () => {
    for (const [after, result] of [
      ['gone', 'deleted'],
      ['still-connected', 'deleted-other'],
      ['unknown', 'deleted-unchecked'],
    ] as const) {
      const h = signInHarness(after);
      const s = h.begin('delete').searchParams.get('s')!;
      await expect(h.signIn.finish({ deleted: '1', state: s })).resolves.toBe(result);
      expect(h.afterDelete).toHaveBeenCalledTimes(1);
      expect(h.connect).not.toHaveBeenCalled();
      expect(h.signIn.pending()).toBe(false);
      expect(h.signIn.last()).toEqual({ intent: 'delete', result });
    }
  });
  it('a delete return never completes a sign-in, and a code never completes a delete', async () => {
    const h = signInHarness();
    const s1 = h.begin().searchParams.get('s')!;
    await expect(h.signIn.finish({ deleted: '1', state: s1 })).resolves.toBe('failed');
    const s2 = h.begin('delete').searchParams.get('s')!;
    await expect(h.signIn.finish({ code: CODE, state: s2 })).resolves.toBe('failed');
    await expect(h.signIn.finish({ code: CODE, deleted: '1', state: s2 })).resolves.toBe('no-pending');
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.afterDelete).not.toHaveBeenCalled();
  });
  it('a wrong state cannot end the pending delete, expiry can, and the state never reaches the log', async () => {
    const h = signInHarness();
    const s = h.begin('delete').searchParams.get('s')!;
    await expect(h.signIn.finish({ deleted: '1', state: 'x'.repeat(43) })).resolves.toBe('state-mismatch');
    expect(h.signIn.pending()).toBe(true);
    h.advance(600_000);
    await expect(h.signIn.finish({ deleted: '1', state: s })).resolves.toBe('expired');
    expect(h.afterDelete).not.toHaveBeenCalled();
    expect(h.logs.join('\n')).not.toContain(s);
  });
  it('a new begin forgets the last result', async () => {
    const h = signInHarness();
    const s = h.begin('delete').searchParams.get('s')!;
    await h.signIn.finish({ deleted: '1', state: s });
    h.begin();
    expect(h.signIn.last()).toBeNull();
  });
});

describe('after a delete returned from the browser, this Mac looks at its own connection', () => {
  it('a refused token means its account is gone: the connection is forgotten', async () => {
    const f = await backend();
    await f.connect();
    f.deleteAccount();
    await expect(createAfterDelete(f.cloud)()).resolves.toBe('gone');
    expect(f.cloud.status()).toMatchObject({ connection: null, state: 'disconnected' });
    expect(await readdir(join(f.dir, 'secrets')).catch(() => [])).toEqual([]);
  });
  it('a token that still works means another account was deleted: nothing changes', async () => {
    const f = await backend();
    const connection = await f.connect();
    await expect(createAfterDelete(f.cloud)()).resolves.toBe('still-connected');
    expect(f.cloud.status().connection).toEqual(connection);
  });
  it.each(['broken', 'forbidden'] as const)('a %s backend proves nothing: the connection is kept', async (health) => {
    const f = await backend();
    const connection = await f.connect();
    f.setHealth(health);
    await expect(createAfterDelete(f.cloud)()).resolves.toBe('unknown');
    expect(f.cloud.status().connection).toEqual(connection);
  });
  it('with no connection there is nothing to forget', async () => {
    const f = await backend();
    await expect(createAfterDelete(f.cloud)()).resolves.toBe('gone');
    expect(f.seen).toEqual([]);
  });
});

describe('the account routes on the Mac', () => {
  async function app() {
    const exportMode = { stall: false };
    const f = await backend((req, res) => {
      if (req.url === '/v1/account/export') {
        res.setHeader('content-type', 'application/json');
        if (exportMode.stall) return void res.write('{"owner":'); // and never ends
        return res.end('{"owner":{"id":"exported"}}');
      }
      res.end(ok({ device: {} }));
    });
    const exportDir = join(f.dir, 'exports');
    const afterDelete = vi.fn(async () => 'gone' as const);
    const signIn = createGoogleSignIn({ connect: (input) => f.cloud.connectCloud(input), afterDelete });
    const server = express();
    server.get('/api/resources/cloud/google/callback', createGoogleCallbackRouter(signIn, () => true));
    server.use('/cloud', cloudJsonParser());
    server.use(
      '/cloud',
      createCloudRouter(f.cloud, (req) => req.get('sec-fetch-site') !== 'cross-site', { signIn, returnUrl: RETURN }, {
        exportDirectory: async () => {
          await mkdir(exportDir, { recursive: true });
          return exportDir;
        },
      }),
    );
    const listening = await new Promise<ReturnType<typeof server.listen>>((r) => {
      const s = server.listen(0, '127.0.0.1', () => r(s));
    });
    cleanups.push(() => new Promise<void>((r) => { listening.closeAllConnections(); listening.close(() => r()); }));
    const base = `http://127.0.0.1:${(listening.address() as { port: number }).port}`;
    const post = (path: string, payload: unknown, bound = true) => {
      const c = f.cloud.status().connection;
      return fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          ...(bound && c
            ? {
                'x-aasc-cloud-backend': c.backendOrigin,
                'x-aasc-cloud-account': c.accountId,
                'x-aasc-cloud-generation': String(c.generation),
              }
            : {}),
        },
        body: JSON.stringify(payload),
      });
    };
    return { ...f, base, post, signIn, afterDelete, exportDir, exportMode };
  }
  it('starting a delete needs a connection and its reviewed binding, and goes to that backend only', async () => {
    const h = await app();
    expect((await h.post('/cloud/google/start', { intent: 'delete' })).status).toBe(409);
    await h.connect();
    expect((await h.post('/cloud/google/start', { intent: 'delete' }, false)).status).toBe(409);
    const res = await h.post('/cloud/google/start', { intent: 'delete', backendUrl: 'https://evil.example' });
    expect(res.status).toBe(200);
    const url = new URL((await res.json()).data.url);
    expect(url.origin).toBe(h.url);
    expect(url.searchParams.get('intent')).toBe('delete');
    expect(url.searchParams.get('return')).toBe(RETURN);
    expect((await h.post('/cloud/google/start', { intent: 'wipe' })).status).toBe(400);
  });
  it('the page can ask whether a browser step is still pending and how the last one ended', async () => {
    const h = await app();
    await h.connect();
    const state = async () => (await (await fetch(`${h.base}/cloud/google/state`)).json()).data;
    expect(await state()).toEqual({ pending: false, last: null });
    const res = await h.post('/cloud/google/start', { intent: 'delete' });
    const s = new URL((await res.json()).data.url).searchParams.get('s')!;
    expect(await state()).toEqual({ pending: true, last: null });
    const page = await fetch(`${h.base}/api/resources/cloud/google/callback?deleted=1&state=${s}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Your AASC Cloud account was deleted');
    expect(html).not.toContain(s);
    expect(await state()).toEqual({ pending: false, last: { intent: 'delete', result: 'deleted' } });
  });
  it('export saves a file on this computer and answers its path, bound to the reviewed connection', async () => {
    const h = await app();
    await h.connect();
    expect((await h.post('/cloud/account/export', {}, false)).status).toBe(409);
    const res = await h.post('/cloud/account/export', {});
    expect(res.status).toBe(200);
    const saved = (await res.json()).data as { path: string; bytes: number };
    expect(saved.path.startsWith(h.exportDir)).toBe(true);
    expect(await readFile(saved.path, 'utf8')).toBe('{"owner":{"id":"exported"}}');
    expect(saved.bytes).toBe(27);
    const sent = h.seen.find((r) => r.url === '/v1/account/export');
    expect(sent).toMatchObject({ method: 'GET', auth: `Bearer ${TOKEN}` });
  });
  it('an export stops when the page goes away, and leaves nothing in the folder', async () => {
    const h = await app();
    await h.connect();
    h.exportMode.stall = true;
    const c = h.cloud.status().connection!;
    const gone = new AbortController();
    const pending = fetch(`${h.base}/cloud/account/export`, {
      method: 'POST',
      signal: gone.signal,
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'x-aasc-cloud-backend': c.backendOrigin,
        'x-aasc-cloud-account': c.accountId,
        'x-aasc-cloud-generation': String(c.generation),
      },
      body: '{}',
    }).catch(() => 'aborted');
    await vi.waitFor(async () => expect((await readdir(h.exportDir)).some((n) => n.endsWith('.part'))).toBe(true));
    gone.abort();
    expect(await pending).toBe('aborted');
    await vi.waitFor(async () => expect(await readdir(h.exportDir)).toEqual([]));
  });
  it('a delete return this Mac was not waiting for says what may have happened, and changes nothing', async () => {
    const h = await app();
    await h.connect();
    const page = await fetch(`${h.base}/api/resources/cloud/google/callback?deleted=1&state=${'x'.repeat(43)}`);
    const html = await page.text();
    expect(html).toContain('If you pressed Delete my account');
    expect(html).not.toContain('Start again');
    expect(h.afterDelete).not.toHaveBeenCalled();
    expect(h.cloud.status().connection).not.toBeNull();
    // An ordinary stray callback keeps its sign-in wording.
    const stray = await (await fetch(`${h.base}/api/resources/cloud/google/callback?code=${CODE}&state=${'x'.repeat(43)}`)).text();
    expect(stray).not.toContain('If you pressed Delete');
  });
});
