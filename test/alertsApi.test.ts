// test/alertsApi.test.ts — the alert routes (server/alerts/alertsRouter.ts, Nov 26 2026): a central raises over
// loopback; every device reads and dismisses what it may see, and each change is sent cut per device (a remote device:
// shared sessions only). The router runs on its own with a fake session store: nothing here reaches a process.
import { createServer, type Server } from 'http';
import express, { type Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RaisedAlert } from '../src/types/alert.js';
import { createAlertStore, type AlertStore } from '../server/alerts/alertStore.js';
import { createAlertsService, type AlertsService, type AlertsUpdatePayload } from '../server/alerts/alertsRouter.js';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

interface FakeSession { sessionId: string; remoteVisible?: boolean }

let store: AlertStore;
let sessions: Map<string, FakeSession>;
let aliases: Map<string, string>;
let published: Array<{ local: AlertsUpdatePayload; remote: AlertsUpdatePayload }>;
let service: AlertsService;
let server: Server;
let base = '';

beforeEach(async () => {
  let n = 0;
  store = createAlertStore({ newId: () => `a${++n}` });
  sessions = new Map([
    ['s1', { sessionId: 's1', remoteVisible: true }],
    ['s2', { sessionId: 's2' }],
    ['cs', { sessionId: 'cs' }],
  ]);
  aliases = new Map();
  published = [];
  service = createAlertsService({
    store,
    isLocal: (req: Request) => req.headers['x-test-remote'] !== '1',
    clientId: (req: Request) => String(req.headers['x-aasc-client-id'] ?? ''),
    getSession: (id) => sessions.get(aliases.get(id) ?? id) ?? null,
    canSee: (isLocal, s) => isLocal || s.remoteVisible === true,
    publish: (local, remote) => { published.push({ local, remote }); },
  });
  const a = express();
  a.use(express.json());
  a.use('/api', service.router);
  server = createServer(a);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`;
});
afterEach(() => {
  service.dispose();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

const central = { 'x-aasc-client-id': 'mcp:c1' };
const remote = { 'x-test-remote': '1', 'x-aasc-client-id': 'dev-2' };

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const raise = (over: Record<string, unknown> = {}, headers: Record<string, string> = central) =>
  call('POST', '/alerts', { sessionId: 's1', key: 'stuck:package', message: 'Package stuck 45m', centralSessionId: 'cs', ...over }, headers);

describe('POST /api/alerts', () => {
  it('raises an alert for a central, and updates it when the key is raised again', async () => {
    const first = await raise({ level: 'loud' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ ok: true, created: true, alert: { id: 'a1', sessionId: 's1', centralId: 'c1', centralSessionId: 'cs', level: 'loud', message: 'Package stuck 45m' } });
    const again = await raise({ message: 'Package stuck\n75m' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, created: false, alert: { id: 'a1', message: 'Package stuck 75m', count: 2 } });
    expect((again.body?.alert as RaisedAlert).level).toBeUndefined();
  });

  it('files the alert under the session’s current id', async () => {
    aliases.set('term-1', 's1');
    const res = await raise({ sessionId: 'term-1' });
    expect(res.body).toMatchObject({ alert: { sessionId: 's1' } });
  });

  it('is not found from another device', async () => {
    const res = await raise({}, { ...remote, 'x-aasc-client-id': 'mcp:c1' });
    expect(res.status).toBe(404);
    expect(store.list()).toEqual([]);
  });

  it('is refused to a caller that is not a central', async () => {
    expect((await raise({}, { 'x-aasc-client-id': 'dev-1' })).status).toBe(403);
    expect((await raise({}, { 'x-aasc-client-id': 'mcp:' })).status).toBe(403);
    expect(store.list()).toEqual([]);
  });

  it('refuses a bad body: no session, a bad key, an empty message, an unknown level', async () => {
    expect((await raise({ sessionId: 'nobody' })).status).toBe(404);
    expect((await raise({ key: 'has space' })).status).toBe(400);
    expect((await raise({ key: '' })).status).toBe(400);
    expect((await raise({ message: ' \n\t ' })).status).toBe(400);
    expect((await raise({ message: 5 })).status).toBe(400);
    expect((await raise({ level: 'deafening' })).status).toBe(400);
    expect(store.list()).toEqual([]);
  });

  it('drops a central card id no session answers to', async () => {
    const res = await raise({ centralSessionId: 'gone' });
    expect(res.body).toMatchObject({ alert: { centralSessionId: null } });
  });

  it('answers TOO_MANY and RATE_LIMITED as 409 and 429', async () => {
    for (let i = 0; i < 10; i += 1) await raise({ key: `k${i}` });
    expect((await raise({ key: 'k-new' })).status).toBe(409);
    for (let i = 0; i < 20; i += 1) await raise({ key: 'k0' });
    expect((await raise({ key: 'k0' })).status).toBe(429);
  });
});

describe('GET /api/alerts', () => {
  it('gives this Mac every alert, and another device only those on sessions shared with it', async () => {
    await raise({ sessionId: 's1', key: 'a' });
    await raise({ sessionId: 's2', key: 'b' });
    const local = await call('GET', '/alerts');
    expect((local.body?.alerts as RaisedAlert[]).map((a) => a.sessionId).sort()).toEqual(['s1', 's2']);
    const away = await call('GET', '/alerts', undefined, remote);
    expect((away.body?.alerts as RaisedAlert[]).map((a) => a.sessionId)).toEqual(['s1']);
    expect((away.body?.alerts as RaisedAlert[])[0].centralId).toBe('');
    expect((local.body?.alerts as RaisedAlert[])[0].centralId).toBe('c1');
  });

  it('never names a central card another device may not see', async () => {
    await raise({ sessionId: 's1' });
    const away = await call('GET', '/alerts', undefined, remote);
    expect((away.body?.alerts as RaisedAlert[])[0].centralSessionId).toBeNull();
    sessions.set('cs', { sessionId: 'cs', remoteVisible: true });
    const shared = await call('GET', '/alerts', undefined, remote);
    expect((shared.body?.alerts as RaisedAlert[])[0].centralSessionId).toBe('cs');
  });

  it('leaves out an alert whose session is gone', async () => {
    await raise();
    sessions.delete('s1');
    expect((await call('GET', '/alerts')).body?.alerts).toEqual([]);
  });
});

describe('POST /api/alerts/:id/dismiss', () => {
  it('closes an alert from this Mac', async () => {
    await raise();
    expect((await call('POST', '/alerts/a1/dismiss', {})).status).toBe(200);
    expect(store.list()).toEqual([]);
    expect((await call('POST', '/alerts/a1/dismiss', {})).status).toBe(404);
  });

  it('lets another device close only an alert it can see', async () => {
    await raise({ sessionId: 's2', key: 'hidden' });
    await raise({ sessionId: 's1', key: 'shared' });
    expect((await call('POST', '/alerts/a1/dismiss', {}, remote)).status).toBe(404);
    expect(store.get('a1')).not.toBeNull();
    expect((await call('POST', '/alerts/a2/dismiss', {}, remote)).status).toBe(200);
    expect(store.get('a2')).toBeNull();
  });
});

describe('the broadcast', () => {
  it('sends every change cut per device', async () => {
    await raise({ sessionId: 's1', key: 'a' });
    await raise({ sessionId: 's2', key: 'b' });
    await call('POST', '/alerts/a1/dismiss', {});
    expect(published).toHaveLength(3);
    const last = published[2];
    expect(last.local).toEqual({ type: 'alerts_update', alerts: [expect.objectContaining({ id: 'a2' })] });
    expect(last.remote).toEqual({ type: 'alerts_update', alerts: [] });
    expect(published[1].remote.alerts.map((a) => a.id)).toEqual(['a1']);
  });

  it('re-sends on republish (a session was shared or hidden)', async () => {
    await raise({ sessionId: 's2' });
    published = [];
    sessions.set('s2', { sessionId: 's2', remoteVisible: true });
    service.republish();
    expect(published).toHaveLength(1);
    expect(published[0].remote.alerts.map((a) => a.sessionId)).toEqual(['s2']);
  });
});
