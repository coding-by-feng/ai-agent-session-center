// test/cloudMachinesRoutes.test.ts — plan 18, stage 2 (CONTRACT.md section E): the local routes of the client role.
//
//   GET  /api/resources/cloud/machines             the account's computers (the backend's list, validated)
//   POST /api/resources/cloud/machines/:id/ticket  a ticket to connect to one of them
//   GET  /api/resources/cloud/machines/settings    what this computer tells and allows its account
//   PUT  /api/resources/cloud/machines/settings
// For this computer's own dashboard and Electron main only: behind the RESOURCES local gate (404 for any other
// device), and every one of them, reads too, only from the AASC page itself or a non-browser client on this
// machine (a read here asks the backend, and a ticket is a credential). Built through createResourceRouter, as
// the server mounts it, against a fake backend: no network.
import express from 'express';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { createCloudConnection } from '../server/cloud/connection.js';
import { cloudJsonParser } from '../server/cloud/router.js';
import { createFileSecretStore } from '../server/cloud/secretStore.js';
import log from '../server/logger.js';
import { createMachineAccountSettings } from '../server/mobile/machineAccountSettings.js';
import { createMachineDirectoryPublisher } from '../server/mobile/machineDirectoryPublisher.js';
import { createResourceRouter, resourceErrorHandler } from '../server/resourceRouter.js';

const owner = '00000000-0000-4000-8000-000000000001';
const self = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const token = 't'.repeat(43);
const TICKET = 'k'.repeat(43);
const SEAL_SECRET = 's'.repeat(43);
const CLIENT_KEY = `B${'p'.repeat(86)}`;
const AT = '2026-11-20T01:02:03.000Z';
const MACHINE = {
  deviceId: other, name: 'Mac mini', platform: 'macos', edition: 'full', appVersion: '2.10.81', lastUsedAt: AT,
  current: false, connectable: true, relation: 'self',
  paths: { lan: '192.168.1.57', tailnet: null, public: null, port: 3333, updatedAt: AT },
};
const DEFAULTS = { showOnAccount: true, addresses: { lan: true, tailnet: true, public: false }, computerEnroll: 'ask' };
const NOT_PINNED = { showOnAccount: false, computerEnroll: false };
/** What the settings answer carries beside the settings on a computer whose publisher has nothing to say. */
const NO_CLOUD = { state: 'no-cloud', published: null };
type View = { state: string; lan: string | null; tailnet: string | null; public: string | null; port: number | null; at: number | null };
const view = (state: string, over: Partial<View> = {}): View => ({ state, lan: null, tailnet: null, public: null, port: null, at: null, ...over });

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
  vi.clearAllMocks();
});

type Backend = (call: { method: string; path: string; body: unknown }) => Response | Promise<Response>;
const ok = (data: unknown) => Response.json({ success: true, data });
const failure = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: false, error: { code, message: `SECRET backend text ${token}` } }), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });

interface Options {
  /** Sign in first (default), or leave the connector with no connection. */
  signedIn?: boolean;
  backend?: Backend;
  isLocalRequest?: () => boolean;
  env?: Record<string, string>;
  /** Initial content of server-config.json. */
  config?: string;
  /**
   * The directory publisher the routes read: a stand-in by default, `false` for none, `'real'` for the real one
   * over this fixture's connection and settings, told of every save as the server wires it.
   */
  publisher?: false | 'real';
}

async function setup(options: Options = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-machines-routes-')));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const calls: { path: string; method: string; body: unknown; auth: string | null }[] = [];
  const state = { backend: options.backend ?? (() => ok({ machines: [MACHINE] })) };
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ path: url.pathname, method, body, auth: new Headers(init?.headers).get('authorization') });
    if (url.pathname === '/v1/devices/pair') return ok({ token, ownerId: owner, deviceId: self });
    return state.backend({ method, path: url.pathname, body });
  });
  const cloud = await createCloudConnection({
    directory: join(dir, 'cloud'),
    secrets: createFileSecretStore(join(dir, 'secrets')),
    fetch: fetcher as unknown as typeof fetch,
  });
  cleanup.push(() => cloud.stop());
  if (options.signedIn !== false) {
    await cloud.connectCloud({ backendUrl: 'https://backend.example', pairingCode: 'c'.repeat(22), deviceName: 'Mac' });
  }
  calls.length = 0;

  const configPath = join(dir, 'server-config.json');
  if (options.config !== undefined) await writeFile(configPath, options.config);
  const settings = createMachineAccountSettings({ configPath, saved: {}, env: options.env ?? {} });
  const saved = vi.fn();
  settings.onChange(saved);
  /** A stand-in publisher: what it last found, and what its next look finds (null: it never answers). */
  const directory = { now: view('no-cloud'), next: view('no-cloud') as View | null };
  const publisher = {
    view: () => directory.now,
    check: vi.fn(() => (directory.next === null
      ? new Promise<never>(() => {})
      : Promise.resolve((directory.now = directory.next)))),
  };

  let real: ReturnType<typeof createMachineDirectoryPublisher> | null = null;
  if (options.publisher === 'real') {
    let remembered: string | null = null;
    real = createMachineDirectoryPublisher({
      cloud,
      settings: () => settings.get(),
      unreachable: () => null,
      target: async () => ({ lan: '192.168.1.57', tailnet: null, publicAddress: '203.0.113.5', port: 3333 }),
      remembered: { get: () => remembered, set: (account) => { remembered = account; } },
      log: { warn: vi.fn(), debug: vi.fn() },
    });
    const directoryPublisher = real;
    settings.onChange(() => void directoryPublisher.check({ retryRefused: true }));
  }

  const app = express();
  app.use('/api/resources/cloud', cloudJsonParser());
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/resources', createResourceRouter({
    sessionProjectPaths: () => [],
    home: dir,
    cloud,
    cloudAliasDirectory: join(dir, 'cloud'),
    cloudMachines: {
      cloud, settings, saveWaitMs: 40,
      ...(options.publisher === false ? {} : { publisher: real ?? (publisher as never) }),
    },
    ...(options.isLocalRequest ? { isLocalRequest: options.isLocalRequest } : {}),
  }));
  app.use('/api/resources', resourceErrorHandler);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/resources/cloud/machines`, calls, cloud, state, settings, saved, configPath, directory, publisher };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

const JSON_HEADERS = { 'content-type': 'application/json' };
const send = (f: Fixture, method: string, path: string, body?: unknown, headers: Record<string, string> = JSON_HEADERS) =>
  fetch(f.url + path, { method, headers, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
const errorOf = async (res: Response) => ((await res.json()) as { success: false; error: { code: string; message: string; retryAfter?: number } }).error;

describe('GET /api/resources/cloud/machines', () => {
  it('answers the account\'s computers, asked with this computer\'s token', async () => {
    const f = await setup();
    const res = await fetch(f.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ success: true, data: { machines: [MACHINE] } });
    expect(f.calls).toEqual([{ path: '/v1/machines', method: 'GET', body: undefined, auth: `Bearer ${token}` }]);
  });

  it('is 409 with no connection, and asks the backend nothing', async () => {
    const f = await setup({ signedIn: false });
    const res = await fetch(f.url);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('disconnected');
    expect(f.calls).toEqual([]);
  });

  it('is 409 with a revoked connection, and asks the backend nothing more', async () => {
    const f = await setup({ backend: () => failure(401, 'unauthorized') });
    expect((await fetch(f.url)).status).toBe(401); // the request that learns it: this computer's own 401
    expect(f.cloud.status().state).toBe('revoked');
    f.calls.length = 0;
    const res = await fetch(f.url);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('disconnected');
    expect(f.calls).toEqual([]);
  });

  it('answers needs_sign_in when the backend says 403 (a sign-in from before it listed computers)', async () => {
    const f = await setup({ backend: () => failure(403, 'forbidden') });
    const res = await fetch(f.url);
    expect(res.status).toBe(403);
    const error = await errorOf(res);
    expect(error.code).toBe('needs_sign_in');
    expect(error.message).not.toContain('SECRET');
    expect(f.cloud.status().state).toBe('connected');
  });

  it('answers unsupported for a backend without the service, and invalid_response for a list it can\'t read', async () => {
    const f = await setup({ backend: () => failure(404, 'not_found') });
    const res = await fetch(f.url);
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe('unsupported');
    f.state.backend = () => ok({ machines: [{ ...MACHINE, paths: { ...MACHINE.paths, lan: '8.8.8.8' } }] });
    const bad = await fetch(f.url);
    expect(bad.status).toBe(502);
    expect((await errorOf(bad)).code).toBe('invalid_response');
  });

  it('is 404 for any other device', async () => {
    const f = await setup({ isLocalRequest: () => false });
    for (const path of ['', '/settings']) expect((await fetch(f.url + path)).status).toBe(404);
    expect((await send(f, 'POST', `/${other}/ticket`, { clientKey: CLIENT_KEY })).status).toBe(404);
    expect((await send(f, 'PUT', '/settings', DEFAULTS)).status).toBe(404);
    expect(f.calls).toEqual([]);
  });

  it.each(['same-site', 'cross-site', 'none'])('is refused for a page that is not AASC\'s own (Sec-Fetch-Site: %s), before the backend is asked', async (site) => {
    const f = await setup({ isLocalRequest: () => true });
    const res = await fetch(f.url, { headers: { 'sec-fetch-site': site } });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('forbidden');
    expect(f.calls).toEqual([]);
  });

  it('is refused for a tool that names another origin', async () => {
    const f = await setup();
    const res = await fetch(f.url, { headers: { origin: 'http://127.0.0.1:9' } });
    expect(res.status).toBe(403);
    expect(f.calls).toEqual([]);
  });
});

describe('POST /api/resources/cloud/machines/:id/ticket', () => {
  const TICKET_ANSWER = { ticket: TICKET, sealSecret: SEAL_SECRET, expiresAt: AT };

  it('answers a ticket for that computer and this client\'s key', async () => {
    const f = await setup({ backend: () => ok(TICKET_ANSWER) });
    const res = await send(f, 'POST', `/${other}/ticket`, { clientKey: CLIENT_KEY });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ success: true, data: TICKET_ANSWER });
    expect(f.calls).toEqual([
      { path: '/v1/machines/tickets', method: 'POST', body: { machineId: other, clientKey: CLIENT_KEY }, auth: `Bearer ${token}` },
    ]);
  });

  it('logs nothing of it', async () => {
    const f = await setup({ backend: () => ok(TICKET_ANSWER) });
    await send(f, 'POST', `/${other}/ticket`, { clientKey: CLIENT_KEY });
    const logged = [log.info, log.warn, log.error, log.debug].flatMap((fn) => vi.mocked(fn).mock.calls).flat().join('\n');
    for (const secret of [TICKET, SEAL_SECRET, CLIENT_KEY, token]) expect(logged).not.toContain(secret);
  });

  it.each([
    ['an id that is no uuid', '/mac-1/ticket', { clientKey: CLIENT_KEY }],
    ['an upper-case id', `/${other.replace(/0/g, 'A')}/ticket`, { clientKey: CLIENT_KEY }],
    ['a short key', `/${other}/ticket`, { clientKey: 'p'.repeat(86) }],
    ['no key', `/${other}/ticket`, {}],
    ['an extra field', `/${other}/ticket`, { clientKey: CLIENT_KEY, machineId: self }],
  ])('refuses %s (400) and asks the backend nothing', async (_label, path, body) => {
    const f = await setup({ backend: () => ok(TICKET_ANSWER) });
    const res = await send(f, 'POST', path, body);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('invalid_input');
    expect(f.calls).toEqual([]);
  });

  it('refuses a body that is not JSON (415) and a page that is not AASC\'s own (403)', async () => {
    const f = await setup({ backend: () => ok(TICKET_ANSWER), isLocalRequest: () => true });
    expect((await send(f, 'POST', `/${other}/ticket`, 'clientKey=x', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await send(f, 'POST', `/${other}/ticket`, { clientKey: CLIENT_KEY }, { ...JSON_HEADERS, 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect(f.calls).toEqual([]);
  });

  it('is 409 with no connection, and asks the backend nothing', async () => {
    const f = await setup({ signedIn: false });
    const res = await send(f, 'POST', `/${other}/ticket`, { clientKey: CLIENT_KEY });
    expect(res.status).toBe(409);
    expect(f.calls).toEqual([]);
  });

  it.each([
    [404, 'machine_not_found', 404, 'machine_not_found'],
    [403, 'forbidden', 403, 'needs_sign_in'],
    [500, 'internal', 502, 'backend_error'],
  ])('answers the backend\'s %i %s as %i %s, in AASC\'s own words', async (status, code, answered, as) => {
    const f = await setup({ backend: () => failure(status, code) });
    const res = await send(f, 'POST', `/${other}/ticket`, { clientKey: CLIENT_KEY });
    expect(res.status).toBe(answered);
    const error = await errorOf(res);
    expect(error.code).toBe(as);
    expect(error.message).not.toContain('SECRET');
  });

  it('passes the backend\'s rate limit on with its wait, in seconds', async () => {
    const f = await setup({ backend: () => failure(429, 'rate_limited', { 'retry-after': '42' }) });
    const res = await send(f, 'POST', `/${other}/ticket`, { clientKey: CLIENT_KEY });
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toMatchObject({ code: 'rate_limited', retryAfter: 42 });
  });
});

describe('the settings', () => {
  const CHOICE = { showOnAccount: true, addresses: { lan: true, tailnet: false, public: true }, computerEnroll: 'auto' };

  it('GET answers the defaults on a fresh install, what the environment pins and what is published, with no backend request', async () => {
    const f = await setup({ signedIn: false });
    const res = await fetch(`${f.url}/settings`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { ...DEFAULTS, pinned: NOT_PINNED, publisher: NO_CLOUD } });
    expect(f.calls).toEqual([]);
    expect(f.publisher.check).not.toHaveBeenCalled(); // a read looks at what the publisher found, and starts nothing
  });

  it.each([
    [{ AASC_SHOW_ON_ACCOUNT: '0' }, { showOnAccount: true, computerEnroll: false }],
    [{ AASC_COMPUTER_ACCOUNT_ENROLL: 'auto' }, { showOnAccount: false, computerEnroll: true }],
    [{ AASC_SHOW_ON_ACCOUNT: '1', AASC_COMPUTER_ACCOUNT_ENROLL: 'ask' }, { showOnAccount: true, computerEnroll: true }],
    [{ AASC_SHOW_ON_ACCOUNT: 'maybe' }, NOT_PINNED],
  ])('GET says which settings the environment decides (%j)', async (env, pinned) => {
    const f = await setup({ env: env as Record<string, string> });
    expect(((await (await fetch(`${f.url}/settings`)).json()) as { data: { pinned: unknown } }).data.pinned).toEqual(pinned);
  });

  it('GET shows the addresses the account last accepted while this computer is published', async () => {
    const f = await setup();
    f.directory.now = view('published', { lan: '192.168.1.57', tailnet: '100.101.102.103', public: null, port: 3333, at: 5 });
    expect(((await (await fetch(`${f.url}/settings`)).json()) as { data: { publisher: unknown } }).data.publisher).toEqual({
      state: 'published', published: { lan: '192.168.1.57', tailnet: '100.101.102.103', public: null, port: 3333 },
    });
  });

  it.each(['pending', 'no-cloud', 'off', 'pairing-off', 'no-password', 'no-address', 'needs-sign-in', 'unsupported', 'failed'])(
    'GET shows no address at all while the state is %s, whatever the view still holds',
    async (state) => {
      const f = await setup();
      f.directory.now = view(state, { lan: '192.168.1.57', tailnet: '100.101.102.103', public: '45.63.31.79', port: 3333, at: 5 });
      const text = await (await fetch(`${f.url}/settings`)).text();
      expect((JSON.parse(text) as { data: { publisher: unknown } }).data.publisher).toEqual({ state, published: null });
      for (const address of ['192.168.1.57', '100.101.102.103', '45.63.31.79']) expect(text).not.toContain(address);
    },
  );

  it('GET answers no-cloud for the publisher on a server that has none', async () => {
    const f = await setup({ publisher: false });
    expect(((await (await fetch(`${f.url}/settings`)).json()) as { data: { publisher: unknown } }).data.publisher).toEqual(NO_CLOUD);
  });

  it('PUT saves the choice, tells whoever listens, and answers it with what the publisher then found', async () => {
    const f = await setup();
    f.directory.next = view('published', { lan: '192.168.1.57', tailnet: null, public: '45.63.31.79', port: 3333, at: 9 });
    const res = await send(f, 'PUT', '/settings', CHOICE);
    expect(res.status).toBe(200);
    const answer = {
      success: true,
      data: {
        ...CHOICE, pinned: NOT_PINNED,
        publisher: { state: 'published', published: { lan: '192.168.1.57', tailnet: null, public: '45.63.31.79', port: 3333 } },
      },
    };
    expect(await res.json()).toEqual(answer);
    expect(JSON.parse(await readFile(f.configPath, 'utf8'))).toEqual({
      showOnAccount: true, accountAddresses: { lan: true, tailnet: false, public: true }, computerAccountEnroll: 'auto',
    });
    expect(f.saved).toHaveBeenCalledTimes(1);
    expect(f.publisher.check).toHaveBeenCalledWith({ retryRefused: true });
    expect(await (await fetch(`${f.url}/settings`)).json()).toEqual(answer);
  });

  it('PUT does not hang on a slow cloud: the publisher reads pending, with no address, when it has not finished in time', async () => {
    const f = await setup();
    f.directory.now = view('published', { lan: '192.168.1.57', tailnet: null, public: null, port: 3333, at: 5 });
    f.directory.next = null; // the look this save starts never answers
    const res = await send(f, 'PUT', '/settings', { ...CHOICE, showOnAccount: false });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { publisher: unknown } }).data.publisher).toEqual({ state: 'pending', published: null });
  });

  it.each([
    ['pinned', { pinned: NOT_PINNED }],
    ['publisher', { publisher: NO_CLOUD }],
  ])('PUT refuses a body that sends %s back (400): only the three settings are its to set', async (_label, extra) => {
    const f = await setup();
    const res = await send(f, 'PUT', '/settings', { ...CHOICE, ...extra });
    expect(res.status).toBe(400);
    expect(f.saved).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty object', {}],
    ['a missing part', { showOnAccount: true, computerEnroll: 'ask' }],
    ['a string for a switch', { ...CHOICE, showOnAccount: 'true' }],
    ['a missing address', { ...CHOICE, addresses: { lan: true, tailnet: true } }],
    ['an extra address', { ...CHOICE, addresses: { ...CHOICE.addresses, https: true } }],
    ['an unknown way to enroll', { ...CHOICE, computerEnroll: 'always' }],
    ['an extra field', { ...CHOICE, publicAddress: '45.63.31.79' }],
  ])('PUT refuses %s (400) and saves nothing', async (_label, body) => {
    const f = await setup();
    const res = await send(f, 'PUT', '/settings', body);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('invalid_input');
    expect(f.saved).not.toHaveBeenCalled();
  });

  it('PUT says so when the environment pins what it would change, and saves nothing', async () => {
    const f = await setup({ env: { AASC_COMPUTER_ACCOUNT_ENROLL: 'ask' } });
    const res = await send(f, 'PUT', '/settings', CHOICE);
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe('set_by_environment');
    expect(error.message).toContain('AASC_COMPUTER_ACCOUNT_ENROLL');
    expect(f.saved).not.toHaveBeenCalled();
    expect(f.publisher.check).not.toHaveBeenCalled();
    const shown = await send(f, 'PUT', '/settings', { ...CHOICE, computerEnroll: 'ask' });
    expect(shown.status).toBe(200);
    expect(((await shown.json()) as { data: { pinned: unknown } }).data.pinned).toEqual({ showOnAccount: false, computerEnroll: true });
  });

  it('PUT answers save_failed when server-config.json can\'t be updated, without saying why', async () => {
    const f = await setup({ config: '{ broken' });
    const res = await send(f, 'PUT', '/settings', CHOICE);
    expect(res.status).toBe(500);
    const error = await errorOf(res);
    expect(error).toEqual({ code: 'save_failed', message: 'Couldn’t save the settings. Check server-config.json.' });
    expect(await readFile(f.configPath, 'utf8')).toBe('{ broken');
  });

  it('PUT is refused for a body that is not JSON (415) and a page that is not AASC\'s own (403)', async () => {
    const f = await setup({ isLocalRequest: () => true });
    expect((await send(f, 'PUT', '/settings', 'x=1', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await send(f, 'PUT', '/settings', CHOICE, { ...JSON_HEADERS, 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect(f.saved).not.toHaveBeenCalled();
  });
});

describe('the settings answer while the publisher is still telling the cloud', () => {
  const PUBLIC = '203.0.113.5';
  const TICKED = { ...DEFAULTS, addresses: { lan: true, tailnet: true, public: true } };
  type Publisher = { state: string; published: { lan: string | null; tailnet: string | null; public: string | null; port: number } | null };
  const read = async (f: Fixture): Promise<{ publisher: Publisher; text: string }> => {
    const text = await (await fetch(`${f.url}/settings`)).text();
    return { publisher: (JSON.parse(text) as { data: { publisher: Publisher } }).data.publisher, text };
  };

  /** Public IP ticked and published; then the cloud answers the directory only once `slow.open()` is called. */
  async function publishedThenSlow(then: 'accepts' | 'fails') {
    const slow: { held: Promise<void> | null; open: () => void } = { held: null, open: () => undefined };
    const f = await setup({
      publisher: 'real',
      backend: async ({ method, path }) => {
        if (path !== '/v1/machines/self') return ok({ machines: [MACHINE] });
        if (slow.held) {
          await slow.held;
          if (then === 'fails') return failure(500, 'internal');
        }
        return ok(method === 'PUT' ? { updatedAt: AT } : { withdrawn: true });
      },
    });
    expect((await send(f, 'PUT', '/settings', TICKED)).status).toBe(200);
    await vi.waitFor(async () => expect((await read(f)).publisher).toEqual({
      state: 'published', published: { lan: '192.168.1.57', tailnet: null, public: PUBLIC, port: 3333 },
    }));
    slow.held = new Promise<void>((resolve) => { slow.open = resolve; });
    return { f, slow };
  }

  it('after unticking Public IP on a slow cloud, the PUT and every GET say pending with no address until it settles, then the new finding', async () => {
    const { f, slow } = await publishedThenSlow('accepts');
    const put = await send(f, 'PUT', '/settings', DEFAULTS);
    expect(put.status).toBe(200);
    expect(((await put.json()) as { data: { publisher: Publisher } }).data.publisher).toEqual({ state: 'pending', published: null });
    for (let i = 0; i < 4; i++) {
      const { publisher, text } = await read(f);
      expect(publisher).toEqual({ state: 'pending', published: null });
      expect(text).not.toContain(PUBLIC); // never the address the owner has just turned off
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    slow.open();
    await vi.waitFor(async () => expect((await read(f)).publisher).toEqual({
      state: 'published', published: { lan: '192.168.1.57', tailnet: null, public: null, port: 3333 },
    }));
  });

  it('when that slow check fails: pending, then failed, with no address either way', async () => {
    const { f, slow } = await publishedThenSlow('fails');
    const put = await send(f, 'PUT', '/settings', DEFAULTS);
    expect(((await put.json()) as { data: { publisher: Publisher } }).data.publisher).toEqual({ state: 'pending', published: null });
    expect((await read(f)).publisher).toEqual({ state: 'pending', published: null });
    slow.open();
    await vi.waitFor(async () => expect((await read(f)).publisher).toEqual({ state: 'failed', published: null }));
    expect((await read(f)).text).not.toContain(PUBLIC);
  });

  it('a GET still starts no check of its own', async () => {
    const { f } = await publishedThenSlow('accepts');
    const before = f.calls.length;
    for (let i = 0; i < 3; i++) await read(f);
    expect(f.calls.length).toBe(before);
  });
});

describe('the mount', () => {
  it('answers nothing else under /machines, and leaves the other cloud routes alone', async () => {
    const f = await setup();
    expect((await send(f, 'DELETE', '/settings')).status).toBe(404);
    expect((await send(f, 'POST', '', {})).status).toBe(404);
    expect((await fetch(`${f.url}/${other}`)).status).toBe(404);
    expect((await send(f, 'POST', '/tickets/redeem', { ticket: TICKET })).status).toBe(404);
    const status = await fetch(f.url.replace(/\/machines$/, '/status'));
    expect(status.status).toBe(200);
    expect(f.calls).toEqual([]);
  });
});
