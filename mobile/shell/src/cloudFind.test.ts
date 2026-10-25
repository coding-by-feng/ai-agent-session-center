// AASC-60 Remote access: when no saved path answers, the phone asks AASC Cloud where its Mac is on Tailscale. The
// cloud only suggests addresses: the phone opens one only once the Mac there proves it holds this phone's key.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_LOOKUP_MS, cloudHints, findViaCloud, HINT_PROBE_MS, MAX_CLOUD_HINTS,
} from './cloudFind';
import { createFakeMac, type FakeMac, type FakeMacOptions } from './dev/fakeMac';
import type { HttpRequest, HttpRequester } from './http';
import { SWEEP_PROBE_MS } from './lanRescan';
import type { HttpResponse } from './pairingClient';
import {
  needsBackendRelink, readBackendCredential, writeBackendCredential, type SavedMac,
} from './savedMacs';
import { PROBE_TIMEOUT_MS } from './shellFlows';

afterEach(() => {
  vi.useRealTimers();
});

const THIS_MAC = '100.101.102.103';
const THIS_ORIGIN = `http://${THIS_MAC}:3333`;
const MINI = '100.88.1.7';
const MINI_ORIGIN = `http://${MINI}:3333`;
const BACKEND_GET = 'https://api.aasc.work/v1/mac-paths';

/** Away from home: the row knows no Tailscale address, and the Mac is on the account under 'mac-dev-1'. */
const MAC: SavedMac = {
  id: '6f1c2a10-0000-4000-8000-000000000001', name: 'Kason-MBP', port: 3333, lan: '192.168.1.20', tailnet: null,
  lanAllowed: true, backendDeviceId: null, status: 'active', confirmCode: null, phoneName: 'Pixel', lastPath: 'lan',
};

interface Phone {
  fake: FakeMac;
  deps: Parameters<typeof findViaCloud>[0];
  creds: ReturnType<FakeMac['seedDevice']>;
  mac: SavedMac;
  vault: Map<string, string>;
  store: Map<string, string>;
}

/** A phone with its Mac's key and backend token, over a fake Mac and backend. `own` is the backend token it holds, if any. */
async function phone(opts: FakeMacOptions = {}, row: Partial<SavedMac> = {}, own: 'held' | 'none' = 'held'): Promise<Phone> {
  const fake = createFakeMac({ reachable: [THIS_ORIGIN], ...opts });
  const vault = new Map<string, string>();
  const store = new Map<string, string>();
  const mac = { ...MAC, ...row };
  const deps = {
    vault: {
      get: async (k: string) => vault.get(k) ?? null,
      set: async (k: string, v: string) => { vault.set(k, v); },
      delete: async (k: string) => { vault.delete(k); },
    },
    store: { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => { store.set(k, v); } },
    requester: fake.requester,
    http: fake.http,
  };
  if (own === 'held') await writeBackendCredential(deps.vault, mac.id, fake.seedBackendDevice());
  return { fake, deps, creds: fake.seedDevice('active'), mac, vault, store };
}

/** The same phone, with the requests to `intercept` answered by `answer` and every other one passed on. */
function intercepting(p: Phone, intercept: (req: HttpRequest) => boolean, answer: (req: HttpRequest) => Promise<HttpResponse>): Phone {
  const requester: HttpRequester = { request: (req) => (intercept(req) ? answer(req) : p.fake.requester.request(req)) };
  return { ...p, deps: { ...p.deps, requester } };
}

const find = (p: Phone, proceed: () => boolean = () => true, opts?: { triedTailnet?: boolean }) => findViaCloud(p.deps, p.mac, p.creds, proceed, opts);
const urls = (p: Phone) => p.fake.calls.map((c) => c.url);
const identifies = (p: Phone) => p.fake.calls.filter((c) => c.url.endsWith('/api/mobile/identify')).map((c) => new URL(c.url).origin);
const listing = (...macs: Array<Record<string, unknown>>) => ({ success: true, data: { macs } });

describe('cloudHints', () => {
  const mac: SavedMac = { ...MAC, tailnet: MINI, backendDeviceId: 'mac-dev-1' };

  it('tries this Mac’s backend device first and ignores other ports and non-tailnet addresses', () => {
    const raw = listing(
      { deviceId: 'other-mac', tailnet: '100.77.0.1', port: 3333 },
      { deviceId: 'wrong-port', tailnet: '100.77.0.2', port: 4000 },
      { deviceId: 'home', tailnet: '192.168.1.9', port: 3333 },
      { deviceId: 'public', tailnet: '8.8.8.8', port: 3333 },
      { deviceId: 'saved', tailnet: MINI, port: 3333 }, // the address the phone just tried
      { deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 },
    );
    expect(cloudHints(mac, raw)).toEqual([THIS_MAC, '100.77.0.1']);
  });

  // The saved Tailscale address is skipped because it just failed. Where the saved paths stopped before it (a stranger
  // answered at the saved home address), it never did, and it is the one address the cloud may be right about.
  describe('the saved Tailscale address', () => {
    const raw = listing(
      { deviceId: 'mac-dev-1', tailnet: MINI, port: 3333 },
      { deviceId: 'other-mac', tailnet: '100.77.0.1', port: 3333 },
    );

    it('is skipped by default, and when the saved paths tried it', () => {
      expect(cloudHints(mac, raw)).toEqual(['100.77.0.1']);
      expect(cloudHints(mac, raw, {})).toEqual(['100.77.0.1']);
      expect(cloudHints(mac, raw, { triedTailnet: true })).toEqual(['100.77.0.1']);
    });

    it('is asked about when the saved paths never tried it, and then comes first as this Mac’s own device', () => {
      expect(cloudHints(mac, raw, { triedTailnet: false })).toEqual([MINI, '100.77.0.1']);
    });

    it('is still checked like any other listed address', () => {
      const wrongPort = listing({ deviceId: 'mac-dev-1', tailnet: MINI, port: 4000 });
      expect(cloudHints(mac, wrongPort, { triedTailnet: false })).toEqual([]);
      expect(cloudHints({ ...mac, tailnet: null }, raw, { triedTailnet: false })).toEqual([MINI, '100.77.0.1']);
    });
  });

  it('keeps the listing’s order when this Mac’s backend device isn’t known', () => {
    const raw = listing(
      { deviceId: 'a', tailnet: '100.77.0.1', port: 3333 },
      { deviceId: 'b', tailnet: '100.77.0.2', port: 3333 },
    );
    expect(cloudHints({ ...mac, backendDeviceId: null }, raw)).toEqual(['100.77.0.1', '100.77.0.2']);
    expect(cloudHints({ ...mac, backendDeviceId: 'not-listed' }, raw)).toEqual(['100.77.0.1', '100.77.0.2']);
  });

  it('lists an address once', () => {
    const raw = listing(
      { deviceId: 'a', tailnet: '100.77.0.1', port: 3333 },
      { deviceId: 'mac-dev-1', tailnet: '100.77.0.1', port: 3333 },
      { deviceId: 'c', tailnet: '100.77.0.1', port: 3333 },
    );
    expect(cloudHints(mac, raw)).toEqual(['100.77.0.1']);
  });

  it(`gives at most ${MAX_CLOUD_HINTS}, and never cuts this Mac’s own device to make room`, () => {
    const others = Array.from({ length: 12 }, (_, i) => ({ deviceId: `m${i}`, tailnet: `100.77.0.${i + 1}`, port: 3333 }));
    const raw = listing(...others, { deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 });
    const hints = cloudHints(mac, raw);
    expect(hints).toHaveLength(MAX_CLOUD_HINTS);
    expect(hints[0]).toBe(THIS_MAC);
    expect(hints.slice(1)).toEqual(others.slice(0, MAX_CLOUD_HINTS - 1).map((o) => o.tailnet));
  });

  // R12: the address is checked before anything else about the entry matters, and only as plain canonical text.
  it.each([
    ['a leading-zero octet the URL parser would dial as 100.52.1.1', '100.064.001.001'],
    ['padding', ' 100.101.102.103'],
    ['trailing text', '100.101.102.103 '],
    ['a prefix length', '100.101.102.103/32'],
    ['a port in the address', '100.101.102.103:3333'],
    ['a name', 'kason-mbp.tailnet.ts.net'],
    ['just below 100.64.0.0/10', '100.63.255.255'],
    ['just above 100.64.0.0/10', '100.128.0.1'],
    ['IPv6', 'fd7a:115c:a1e0::1'],
    ['a number', 1684300903],
    ['nothing', null],
  ])('ignores %s', (_why, tailnet) => {
    expect(cloudHints({ ...mac, tailnet: null }, listing({ deviceId: 'mac-dev-1', tailnet, port: 3333 }))).toEqual([]);
  });

  it('reads no more than the 20 Macs the backend lists', () => {
    const filler = Array.from({ length: 20 }, (_, i) => ({ deviceId: `m${i}`, tailnet: '192.168.1.9', port: 3333 })); // none usable
    expect(cloudHints(mac, listing(...filler, { deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 }))).toEqual([]);
    expect(cloudHints(mac, listing(...filler.slice(1), { deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 }))).toEqual([THIS_MAC]);
  });

  it('ignores a port that is only text', () => {
    expect(cloudHints(mac, listing({ deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: '3333' }))).toEqual([]);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['text', 'not json'],
    ['an empty object', {}],
    ['a list that isn’t one', { success: true, data: { macs: 'no' } }],
    ['a list of non-entries', { success: true, data: { macs: [null, 1, 'a', [], {}, { tailnet: 5 }] } }],
    ['an error body', { success: false, error: { code: 'forbidden' } }],
  ])('gives nothing for %s', (_why, raw) => {
    expect(cloudHints(mac, raw)).toEqual([]);
  });

  it('does not change the row or the answer it reads', () => {
    const raw = listing({ deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 });
    const before = JSON.stringify([mac, raw]);
    cloudHints(mac, raw);
    expect(JSON.stringify([mac, raw])).toBe(before);
  });
});

describe('findViaCloud', () => {
  it('opens only the listed Mac that proves this phone’s key', async () => {
    const p = await phone({
      strangers: [MINI_ORIGIN],
      cloudMacs: [
        { deviceId: 'mac-mini', tailnet: MINI, port: 3333 }, // another Mac on the account
        { deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 },
        { deviceId: 'wrong-port', tailnet: '100.77.0.2', port: 4000 },
        { deviceId: 'home', tailnet: '192.168.1.9', port: 3333 },
      ],
    });
    expect(await find(p)).toBe(THIS_MAC);
    expect(identifies(p)).toContain(MINI_ORIGIN); // it was asked, and could not prove the key
    expect(urls(p).filter((u) => u.includes(':4000') || u.includes('192.168.1.9'))).toEqual([]); // and these were never dialled
    expect(p.fake.strikes()).toBe(0);
  });

  it('asks the saved Tailscale address too when the saved paths never tried it', async () => {
    const list = [{ deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 }];
    const tried = await phone({ cloudMacs: list }, { tailnet: THIS_MAC });
    expect(await find(tried)).toBeNull(); // it had just failed: not asked again
    expect(identifies(tried)).toEqual([]);
    const untried = await phone({ cloudMacs: list }, { tailnet: THIS_MAC });
    expect(await find(untried, () => true, { triedTailnet: false })).toBe(THIS_MAC);
    expect(identifies(untried)).toEqual([THIS_ORIGIN]); // and only the Mac's own proof opened it
  });

  it('still opens nothing at the saved address for a box there that cannot prove the key', async () => {
    const p = await phone({ reachable: [], strangers: [THIS_ORIGIN], cloudMacs: [{ deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 }] }, { tailnet: THIS_MAC });
    expect(await find(p, () => true, { triedTailnet: false })).toBeNull();
    expect(identifies(p)).toEqual([THIS_ORIGIN]);
  });

  it('is null when no listed Mac proves the key', async () => {
    const p = await phone({ reachable: [], strangers: [MINI_ORIGIN], cloudMacs: [{ deviceId: 'mac-mini', tailnet: MINI, port: 3333 }] });
    expect(await find(p)).toBeNull();
    expect(identifies(p)).toEqual([MINI_ORIGIN]);
  });

  it('never trusts a listed box that passes the question on to the real Mac', async () => {
    const relay = 'http://100.77.0.5:3333';
    const p = await phone({ relays: [relay], cloudMacs: [{ deviceId: 'mac-dev-1', tailnet: '100.77.0.5', port: 3333 }] });
    expect(await find(p)).toBeNull();
    expect(identifies(p)).toEqual([relay]);
  });

  it('does not take the cloud’s word for a Mac that answers nothing', async () => {
    const p = await phone({ reachable: [], cloudMacs: [{ deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 }] });
    expect(await find(p)).toBeNull();
    expect(identifies(p)).toEqual([]); // nothing answered, so no proof was asked of it
  });

  it('asks the backend with this Mac’s token and nothing else, and probes with its own timeouts', async () => {
    const p = await phone({ cloudMacs: [{ deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 }] });
    const held = JSON.parse(p.vault.get(`backend.${p.mac.id}`)!) as { token: string };
    await find(p);
    const [ask, ...others] = p.fake.calls;
    expect(ask).toMatchObject({ method: 'GET', url: BACKEND_GET, headers: { Authorization: `Bearer ${held.token}` }, timeoutMs: CLOUD_LOOKUP_MS });
    expect(ask.body).toBeUndefined();
    expect(Object.keys(ask.headers)).toEqual(['Authorization']);
    expect(others.find((c) => c.url === `${THIS_ORIGIN}/api/auth/status`)?.timeoutMs).toBe(HINT_PROBE_MS);
    const everythingElse = JSON.stringify(others);
    expect(everythingElse).not.toContain(held.token);
    expect(everythingElse).not.toContain(p.creds.deviceToken);
    expect(everythingElse).not.toContain(p.creds.deviceId);
  });

  it('asks nothing of the cloud for a Mac it holds no backend token for', async () => {
    const p = await phone({ cloudMacs: [{ deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 }] }, {}, 'none');
    expect(await find(p)).toBeNull();
    expect(p.fake.calls).toEqual([]);
  });

  it('never sends the token to a host outside aasc.work', async () => {
    const p = await phone({ cloudMacs: [{ deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 }] }, {}, 'none');
    const held = p.fake.seedBackendDevice();
    await writeBackendCredential(p.deps.vault, p.mac.id, { ...held, host: 'api.aasc.work.evil.example' });
    expect(await find(p)).toBeNull();
    expect(p.fake.calls).toEqual([]);
  });
});

describe('what the cloud answers', () => {
  const ONE = [{ deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 }];

  it('a 401 forgets the backend token; a 403 marks it for relink; a 404 does nothing', async () => {
    const revoked = await phone({ cloudMacs: ONE });
    const held = await readBackendCredential(revoked.deps.vault, revoked.mac.id);
    revoked.fake.revokeBackendDevice(held!.deviceId); // "Remove them" on the Mac, or the owner CLI
    expect(await find(revoked)).toBeNull();
    expect(await readBackendCredential(revoked.deps.vault, revoked.mac.id)).toBeNull();
    expect(await needsBackendRelink(revoked.deps.store, revoked.mac.id)).toBe(false);

    const noScope = await phone({ cloudMacs: ONE, cloudReadForbidden: true }); // a push-only token
    expect(await find(noScope)).toBeNull();
    expect(await needsBackendRelink(noScope.deps.store, noScope.mac.id)).toBe(true);
    expect(await readBackendCredential(noScope.deps.vault, noScope.mac.id)).not.toBeNull(); // kept until the relink replaces it

    const oldBackend = await phone({}); // no mac-paths module: 404
    expect(await find(oldBackend)).toBeNull();
    expect(await readBackendCredential(oldBackend.deps.vault, oldBackend.mac.id)).not.toBeNull();
    expect(await needsBackendRelink(oldBackend.deps.store, oldBackend.mac.id)).toBe(false);
    for (const p of [revoked, noScope, oldBackend]) expect(identifies(p)).toEqual([]); // none of them led to a hint
  });

  it.each([
    ['a rate limit', () => Promise.resolve({ status: 429, data: { error: { code: 'rate_limited' } } })],
    ['a server error', () => Promise.resolve({ status: 500, data: {} })],
    ['a dropped connection', () => Promise.reject(new Error('network unreachable'))],
    ['an answer that is not JSON', () => Promise.resolve({ status: 200, data: '<html>' })],
    ['an empty listing', () => Promise.resolve({ status: 200, data: listing() })],
  ])('%s finds nothing and changes nothing', async (_why, answer) => {
    const base = await phone({ cloudMacs: ONE });
    const p = intercepting(base, (req) => req.url === BACKEND_GET, answer);
    expect(await find(p)).toBeNull();
    expect(await readBackendCredential(p.deps.vault, p.mac.id)).not.toBeNull();
    expect(await needsBackendRelink(p.deps.store, p.mac.id)).toBe(false);
    expect(identifies(base)).toEqual([]);
  });

  // Only a 200 is the cloud's list: whatever else comes back, its body names no address to ask.
  it.each([204, 301, 401, 403, 404, 429, 500, 502])('a %i whose body lists the Mac is not believed', async (status) => {
    const base = await phone({ cloudMacs: ONE });
    const p = intercepting(base, (req) => req.url === BACKEND_GET, () => Promise.resolve({ status, data: listing(...ONE) }));
    expect(await find(p)).toBeNull();
    expect(identifies(base)).toEqual([]);
  });

  it('gives up on a cloud that never answers after CLOUD_LOOKUP_MS', async () => {
    const p = await phone({ cloudMacs: ONE });
    p.fake.setBackendHang(true);
    vi.useFakeTimers();
    let done = false;
    const found = find(p).then((host) => {
      done = true;
      return host;
    });
    await vi.advanceTimersByTimeAsync(CLOUD_LOOKUP_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await found).toBeNull();
    expect(identifies(p)).toEqual([]);
  });

  it('a late answer from a cloud that took too long finds nothing', async () => {
    const p = await phone({ cloudMacs: ONE });
    const release = p.fake.holdNextBackendRequest();
    vi.useFakeTimers();
    const found = find(p);
    await vi.advanceTimersByTimeAsync(CLOUD_LOOKUP_MS);
    expect(await found).toBeNull();
    release();
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 30));
    expect(identifies(p)).toEqual([]);
  });
});

describe('listed addresses', () => {
  it('give an address a saved path’s 3 s to answer, not the LAN sweep’s short probe', () => {
    expect(HINT_PROBE_MS).toBe(PROBE_TIMEOUT_MS); // a copy of it: shellFlows imports this module
    expect(HINT_PROBE_MS).toBeGreaterThan(SWEEP_PROBE_MS);
  });

  it('asks at most four at a time, and gives each the Tailscale probe timeout', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ deviceId: `m${i}`, tailnet: `100.77.0.${i + 1}`, port: 3333 }));
    const base = await phone({ cloudMacs: many });
    let started = 0;
    let inFlight = 0;
    let peak = 0;
    // Nothing there answers: like the native layer, a request gives up after the timeout it was given.
    const p = intercepting(base, (req) => req.url.endsWith('/api/auth/status'), (req) => {
      started += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<HttpResponse>((_, reject) => {
        setTimeout(() => {
          inFlight -= 1;
          reject(new Error('timed out'));
        }, req.timeoutMs);
      });
    });
    vi.useFakeTimers();
    const found = find(p);
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(4);
    await vi.advanceTimersByTimeAsync(HINT_PROBE_MS - 1);
    expect(started).toBe(4); // still the first four, one tick before they give up
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(8); // each gave up at HINT_PROBE_MS and the next four started
    await vi.advanceTimersByTimeAsync(HINT_PROBE_MS);
    expect(await found).toBeNull();
    expect(peak).toBe(4);
  });
});

describe('when the user moves on', () => {
  const ONE = [{ deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 }];

  it('stops when the user moves on', async () => {
    const p = await phone({ cloudMacs: ONE });
    const release = p.fake.holdNextBackendRequest();
    let go = true;
    const found = find(p, () => go);
    await new Promise((r) => setTimeout(r, 10)); // the list is asked for and held
    expect(urls(p)).toEqual([BACKEND_GET]);
    go = false;
    const answered = await Promise.race([found, new Promise((r) => setTimeout(() => r('still waiting'), 1_000))]);
    expect(answered).toBeNull(); // at once: the backend has not answered, and the caller's turn is not held for it
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(urls(p)).toEqual([BACKEND_GET]); // and the late list led to no address being dialled
  });

  it('asks no listed address once the user has gone', async () => {
    const base = await phone({ cloudMacs: ONE });
    let go = true;
    const p = intercepting(base, (req) => req.url === BACKEND_GET, async (req) => {
      const answer = await base.fake.requester.request(req);
      go = false; // the user moves on while the list is on its way back
      return answer;
    });
    expect(await find(p, () => go)).toBeNull();
    expect(urls(base)).toEqual([BACKEND_GET]);
  });

  // The answer comes back in the same breath as the user's cancel: nothing it says is acted on.
  it.each([
    ['a 401', 401, async (p: Phone) => p.fake.revokeBackendDevice(JSON.parse(p.vault.get(`backend.${p.mac.id}`)!).deviceId)],
    ['a 403', 403, async () => undefined],
  ])('%s that comes in as the user leaves forgets nothing and marks nothing', async (_why, status, prepare) => {
    const base = await phone({ cloudMacs: ONE, cloudReadForbidden: status === 403 });
    await prepare(base);
    let go = true;
    const p = intercepting(base, (req) => req.url === BACKEND_GET, async (req) => {
      const answer = await base.fake.requester.request(req);
      go = false;
      return answer;
    });
    expect(await find(p, () => go)).toBeNull();
    expect(await readBackendCredential(base.deps.vault, base.mac.id)).not.toBeNull();
    expect(await needsBackendRelink(base.deps.store, base.mac.id)).toBe(false);
  });

  it('forgets nothing and marks nothing for an answer that arrived after the user left', async () => {
    const p = await phone({ cloudMacs: ONE, cloudReadForbidden: true });
    const release = p.fake.holdNextBackendRequest();
    let go = true;
    const found = find(p, () => go);
    await new Promise((r) => setTimeout(r, 10));
    go = false;
    expect(await found).toBeNull();
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(await needsBackendRelink(p.deps.store, p.mac.id)).toBe(false);
  });
});

// The user moves on while the listed addresses are being asked: nothing further goes out, and the caller's turn is not
// held for probes that are still pending (findMac gets the same `proceed`).
describe('when the user moves on while the listed addresses are being asked', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ deviceId: `m${i}`, tailnet: `100.77.0.${i + 1}`, port: 3333 }));

  it('returns at once and starts no further probe or proof', async () => {
    const base = await phone({ cloudMacs: many });
    let started = 0;
    // Nothing there answers: like the native layer, a request gives up after the timeout it was given.
    const p = intercepting(base, (req) => req.url.endsWith('/api/auth/status'), (req) => {
      started += 1;
      return new Promise<HttpResponse>((_, reject) => {
        setTimeout(() => reject(new Error('timed out')), req.timeoutMs);
      });
    });
    vi.useFakeTimers();
    let go = true;
    let done = false;
    const found = find(p, () => go).then((host) => {
      done = true;
      return host;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(4); // the first four are out
    go = false;
    await vi.advanceTimersByTimeAsync(100); // a moment, far short of the probes' 3 s
    expect(done).toBe(true);
    expect(await found).toBeNull();
    await vi.advanceTimersByTimeAsync(HINT_PROBE_MS * 3); // the four still out give up on their own
    expect(started).toBe(4); // and the other four were never asked
    expect(identifies(base)).toEqual([]);
  });

  it('returns at once while a proof is still being waited for', async () => {
    const base = await phone({ cloudMacs: [{ deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 }] });
    let proofs = 0;
    const http = {
      post: (url: string, body: unknown) => {
        if (!url.endsWith('/api/mobile/identify')) return base.fake.http.post(url, body);
        proofs += 1;
        return new Promise<HttpResponse>(() => undefined); // the Mac there never answers the proof
      },
    };
    const p: Phone = { ...base, deps: { ...base.deps, http } };
    let go = true;
    const found = find(p, () => go);
    // Real timers: the proof is signed with WebCrypto, which takes real time.
    for (let i = 0; i < 1_000 && proofs < 1; i += 1) await new Promise((r) => setTimeout(r, 2));
    expect(proofs).toBe(1);
    go = false;
    const answered = await Promise.race([found, new Promise((r) => setTimeout(() => r('still waiting'), 1_000))]);
    expect(answered).toBeNull(); // far short of IDENTIFY_MS, which the Mac that never answers would have cost
  });

  it('sends nothing, and so never the bearer token, when the user has already gone', async () => {
    const p = await phone({ cloudMacs: [{ deviceId: 'mac-dev-1', tailnet: THIS_MAC, port: 3333 }] });
    expect(await find(p, () => false)).toBeNull();
    expect(p.fake.calls).toEqual([]);
    expect(await readBackendCredential(p.deps.vault, p.mac.id)).not.toBeNull(); // a token was there to be sent, and was not
  });
});
