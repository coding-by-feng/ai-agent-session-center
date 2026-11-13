import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { main } from '../cli/client/index.js';
import { createStore, type Store } from '../cli/client/store.js';
import type { Ctx } from '../cli/client/context.js';
import type { FetchLike } from '../electron/remote/remoteClient.js';

const DEVICE_ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const DEVICE_TOKEN = 'dGhpcyBpcyBhIGRldmljZSB0b2tlbiBmb3IgdGVzdHM';
const SESSION_TOKEN = 's'.repeat(40);
const LAN = 'http://192.168.1.20:3333';
const LINK = 'https://aasc.work/pair#v=2&name=Studio%20Box&lan=192.168.1.20&p=3333&mc=ABCDEFGH23';
const PUBLIC_ONLY = 'https://aasc.work/pair#v=2&name=VPS&pub=203.0.113.7&p=3333&mc=ABCDEFGH23';

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }

/**
 * A pretend remote AASC behind a fake fetch: never the network. `pendingFor` sign-ins
 * answer DEVICE_PENDING before Allow.
 */
function fakeRemote(opts: { pendingFor?: number; sessions?: Record<string, unknown>; offline?: boolean; failSessions?: boolean; failWrite?: boolean } = {}) {
  const calls: Call[] = [];
  let pending = opts.pendingFor ?? 0;
  const sessions = opts.sessions ?? {
    's-1': { sessionId: 's-1', status: 'waiting', title: 'shared one', terminalId: 'term-1', lastActivityAt: Date.now() },
  };
  const fetch: FetchLike = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, url, headers: init.headers, body });
    if (opts.offline) throw new Error('connect ECONNREFUSED');
    const reply = (status: number, data: unknown) => ({ status, text: async () => JSON.stringify(data) });
    const path = url.slice(LAN.length);
    if (!url.startsWith(LAN)) throw new Error('unexpected address');
    if (path === '/api/mobile/pair') return reply(201, { data: { deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN, confirmCode: '482913' } });
    if (path === '/api/mobile/challenge') return reply(200, { data: { nonce: 'srvNonce_abcdefghijklmnopqrstuv' } });
    if (path === '/api/mobile/session') {
      if (pending > 0) { pending--; return reply(403, { code: 'DEVICE_PENDING' }); }
      return reply(200, { data: { token: SESSION_TOKEN, expiresIn: 3600 } });
    }
    if (path === '/api/mobile/paths') return reply(404, {});
    if (path === '/api/mobile/unpair') return reply(200, { ok: true });
    if (path === '/api/sessions' && opts.failSessions) throw new Error('socket hang up');
    if (path.endsWith('/write') && opts.failWrite) throw new Error('socket hang up');
    if (path === '/api/sessions') return reply(200, sessions);
    if (path.endsWith('/write') || path.endsWith('/queue/items')) return reply(200, { ok: true });
    return reply(404, { error: 'not here' });
  };
  return { fetch, calls };
}

describe('aasc commands (paired, against a fake remote)', () => {
  let root: string;
  let store: Store;
  let out: string[];
  let err: string[];
  let sleeps: number[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aasc-cmd-'));
    store = createStore(join(root, 'aasc'));
    out = [];
    err = [];
    sleeps = [];
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const ctxWith = (fetch: FetchLike) => (): Ctx => ({
    store,
    out: (l) => { out.push(l); },
    err: (l) => { err.push(l); },
    confirm: async () => false,
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => Date.now(),
    fetch,
    env: {},
  });

  it('add pairs as a desktop named "aasc on <host>", shows the confirm code, waits for Allow, keeps the key out of servers.json', async () => {
    const remote = fakeRemote({ pendingFor: 2 });
    const code = await main(['add', LINK], ctxWith(remote.fetch));
    expect(code).toBe(0);
    const pairCall = remote.calls.find((c) => c.url.endsWith('/api/mobile/pair'))!;
    expect(pairCall.body).toMatchObject({ code: 'ABCDEFGH23', platform: 'desktop' });
    expect((pairCall.body as { label: string }).label).toMatch(/^aasc on /);
    expect(out.join('\n')).toContain('482 913');
    expect(out.join('\n')).toContain('✓ Paired');
    expect(sleeps).toEqual([2000, 2000]);
    const server = store.getServer('studio-box')!;
    expect(server).toMatchObject({ mode: 'paired', deviceId: DEVICE_ID, addresses: { lan: '192.168.1.20', tailnet: null, public: null } });
    expect(readFileSync(join(root, 'aasc', 'servers.json'), 'utf8')).not.toContain(DEVICE_TOKEN);
    expect(store.readKey(server.id)).toBe(DEVICE_TOKEN);
  });

  it('refuses a public-only link without --insecure, before spending the code', async () => {
    const remote = fakeRemote();
    expect(await main(['add', PUBLIC_ONLY], ctxWith(remote.fetch))).toBe(1);
    expect(err.join('\n')).toMatch(/--insecure/);
    expect(remote.calls).toEqual([]);
  });

  it('ls signs in, sends the identity headers, and numbers the sessions for later', async () => {
    const remote = fakeRemote();
    await main(['add', LINK, '--name', 'vps'], ctxWith(remote.fetch));
    out = [];
    expect(await main(['ls'], ctxWith(remote.fetch))).toBe(0);
    expect(out[0]).toMatch(/^vps · online · home LAN · 1 shared/);
    expect(out.join('\n')).toMatch(/1\s+✓ waiting.*shared one/);
    const list = remote.calls.filter((c) => c.url.endsWith('/api/sessions')).at(-1)!;
    expect(list.headers).toMatchObject({
      Authorization: `Bearer ${SESSION_TOKEN}`, 'X-AASC-Role': 'cli', 'X-AASC-Client-Id': store.getServer('vps')!.clientId,
    });
    expect(store.readLastLs()).toEqual([{ n: 1, server: 'vps', sessionId: 's-1' }]);
  });

  it('a session the server no longer shares is exit 4', async () => {
    const remote = fakeRemote();
    await main(['add', LINK, '--name', 'vps'], ctxWith(remote.fetch));
    store.writeLastLs([{ n: 1, server: 'vps', sessionId: 's-1' }, { n: 2, server: 'vps', sessionId: 's-hidden' }]);
    expect(await main(['send', 'vps:2', 'hello'], ctxWith(remote.fetch))).toBe(4);
    expect(err.join('\n')).toContain('vps:2 isn’t shared with this computer');
    expect(remote.calls.some((c) => c.url.includes('/write'))).toBe(false);
  });

  it('a pending device is exit 3', async () => {
    const remote = fakeRemote();
    await main(['add', LINK, '--name', 'vps'], ctxWith(remote.fetch));
    const stillPending = fakeRemote({ pendingFor: 99 });
    expect(await main(['ls', 'vps'], ctxWith(stillPending.fetch))).toBe(3);
    expect(out.join('\n')).toContain('Press Allow on vps first.');
  });

  it('a server with no answer on any address is exit 2', async () => {
    const remote = fakeRemote();
    await main(['add', LINK, '--name', 'vps'], ctxWith(remote.fetch));
    expect(await main(['ls'], ctxWith(fakeRemote({ offline: true }).fetch))).toBe(2);
    expect(out.join('\n')).toContain('vps · offline: Can’t reach vps on the home LAN.');
  });

  it('remove unpairs, then forgets the server and its key', async () => {
    const remote = fakeRemote();
    await main(['add', LINK, '--name', 'vps'], ctxWith(remote.fetch));
    const id = store.getServer('vps')!.id;
    expect(await main(['remove', 'vps'], ctxWith(remote.fetch))).toBe(0);
    expect(remote.calls.some((c) => c.url.endsWith('/api/mobile/unpair'))).toBe(true);
    expect(store.getServer('vps')).toBeNull();
    expect(store.readKey(id)).toBeNull();
  });

  it('unknown commands and options are usage errors', async () => {
    const remote = fakeRemote();
    expect(await main(['frobnicate'], ctxWith(remote.fetch))).toBe(1);
    expect(await main(['ls', '--bogus'], ctxWith(remote.fetch))).toBe(1);
  });
  it('a network error after sign-in is exit 2, not a usage error', async () => {
    const remote = fakeRemote();
    await main(['add', LINK, '--name', 'vps'], ctxWith(remote.fetch));
    store.writeLastLs([{ n: 1, server: 'vps', sessionId: 's-1' }]);
    expect(await main(['send', 'vps:1', 'hi'], ctxWith(fakeRemote({ failSessions: true }).fetch))).toBe(2);
    expect(await main(['send', 'vps:1', 'hi'], ctxWith(fakeRemote({ failWrite: true }).fetch))).toBe(2);
    expect(await main(['queue', 'vps:1', 'hi'], ctxWith(fakeRemote({ failSessions: true }).fetch))).toBe(2);
  });

  it('server-made ids in messages are stripped of escape sequences', async () => {
    const evilId = 'x\x1b]52;c;aGk=\x07yz';
    const remote = fakeRemote({ sessions: { [evilId]: { sessionId: evilId, status: 'waiting', title: 'only one', terminalId: 't', lastActivityAt: 1 } } });
    await main(['add', LINK, '--name', 'vps'], ctxWith(remote.fetch));
    out = [];
    expect(await main(['send', 'only one', 'hi'], ctxWith(remote.fetch))).toBe(0);
    expect(out.join('\n')).toContain('✓ sent to vps:');
    expect(out.join('\n')).not.toMatch(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/);
  });

  it('ls --json keeps every field the server sent and escapes what a terminal would act on', async () => {
    const remote = fakeRemote({ sessions: { a: { sessionId: 'a', status: 'idle', title: 't\x9b2J', model: 'opus' } } });
    await main(['add', LINK, '--name', 'vps'], ctxWith(remote.fetch));
    out = [];
    expect(await main(['ls', '--json'], ctxWith(remote.fetch))).toBe(0);
    const text = out.join('\n');
    expect(text).not.toMatch(/[\x7F-\x9F]/);
    const parsed = JSON.parse(text);
    expect(parsed.servers[0].sessions[0]).toMatchObject({ model: 'opus', title: 't\x9b2J' });
  });
});
