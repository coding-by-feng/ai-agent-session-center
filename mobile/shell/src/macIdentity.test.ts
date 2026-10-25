// macIdentity.test.ts — the phone checks that an address it found is the Mac it paired with (LAN rescan).
import { describe, expect, it } from 'vitest';
import type { HttpRequest, HttpRequester } from './http';
import {
  fetchMacPaths, MAC_PROOF_PREFIX, openSession, PATHS_BUDGET_MS, PATHS_PROOF_PREFIX, verifyMac, WHO_TAG_PREFIX, type HttpClient,
} from './pairingClient';
import {
  createDeviceAuth, PATHS_PROOF_PREFIX as MAC_PATHS_PROOF_PREFIX, proofForToken, type MobileDeviceRecord, type MobileDeviceStore,
} from '../../../server/mobile/deviceAuth';

const origin = 'http://192.168.1.57:3333';
/** Where the Mac sees the phone's request arrive: the address the phone dialled. */
const REACHED = '192.168.1.57:3333';

function memoryStore(): MobileDeviceStore {
  const rows = new Map<string, MobileDeviceRecord>();
  return {
    insert: (rec) => { rows.set(rec.id, { ...rec }); },
    get: (id) => (rows.has(id) ? { ...rows.get(id)! } : null),
    update: (id, patch) => { const r = rows.get(id); if (r) rows.set(id, { ...r, ...patch }); },
    listLive: () => [...rows.values()].filter((r) => r.status !== 'revoked').map((r) => ({ ...r })),
    remove: (id) => { rows.delete(id); },
  };
}

/** The real Mac's service, and a phone it approved. */
function pairedMac() {
  const auth = createDeviceAuth({ store: memoryStore() });
  const { code } = auth.createPairingCode();
  const redeemed = auth.redeem({ code, label: 'Pixel', platform: 'android' })!;
  auth.approve(redeemed.device.id);
  return { auth, creds: { deviceId: redeemed.device.id, deviceToken: redeemed.deviceToken } };
}

/** A Mac at `origin` that answers /identify with `answer(body)`. */
function macAnswering(answer: (body: { tag: string; nonce: string }) => { status: number; data: unknown }) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const http: HttpClient = {
    async post(url, body) {
      calls.push({ url, body });
      if (url !== `${origin}/api/mobile/identify`) throw new Error('unreachable');
      return answer(body as { tag: string; nonce: string });
    },
  };
  return { http, calls };
}

describe('verifyMac', () => {
  it('uses the same prefixes as the Mac', () => {
    expect(MAC_PROOF_PREFIX).toBe('aasc-mac:');
    expect(WHO_TAG_PREFIX).toBe('aasc-who:');
  });

  it('accepts the Mac that holds this phone\'s key (the real deviceAuth.macProof)', async () => {
    const { auth, creds } = pairedMac();
    const mac = macAnswering((b) => ({ status: 200, data: { success: true, data: { proof: auth.macProof(b.tag, b.nonce, REACHED) } } }));
    expect(await verifyMac(mac.http, origin, creds)).toBe(true);
  });

  it('refuses a relay: the real Mac\'s proof, but for the address the relay reached it at', async () => {
    const { auth, creds } = pairedMac();
    // The phone dialled .66; the box there forwards the question to the real Mac at .57.
    const relay = macAnswering((b) => ({ status: 200, data: { data: { proof: auth.macProof(b.tag, b.nonce, REACHED) } } }));
    const viaRelay: HttpClient = { post: (url, body) => relay.http.post(url.replace('192.168.1.66', '192.168.1.57'), body) };
    expect(await verifyMac(viaRelay, 'http://192.168.1.66:3333', creds)).toBe(false);
  });

  it('refuses another Mac, which knows no key for this phone', async () => {
    const { creds } = pairedMac();
    const stranger = pairedMac().auth; // a different Mac
    const mac = macAnswering((b) => ({ status: 200, data: { data: { proof: stranger.macProof(b.tag, b.nonce, REACHED) } } }));
    expect(await verifyMac(mac.http, origin, creds)).toBe(false);
  });

  it('refuses a sign-in proof replayed as a Mac proof', async () => {
    const { creds } = pairedMac();
    const mac = macAnswering((b) => ({ status: 200, data: { data: { proof: proofForToken(creds.deviceToken, b.nonce) } } }));
    expect(await verifyMac(mac.http, origin, creds)).toBe(false);
  });

  it('refuses its own tag sent back as a proof', async () => {
    const { creds } = pairedMac();
    const mac = macAnswering((b) => ({ status: 200, data: { data: { proof: b.tag } } }));
    expect(await verifyMac(mac.http, origin, creds)).toBe(false);
  });

  it.each([
    ['an error status', { status: 404, data: { error: 'Not found' } }],
    ['no proof', { status: 200, data: { data: {} } }],
    ['a proof that is not hex', { status: 200, data: { data: { proof: 'z'.repeat(64) } } }],
    ['a short proof', { status: 200, data: { data: { proof: 'ab' } } }],
  ])('refuses %s', async (_label, answer) => {
    const { creds } = pairedMac();
    expect(await verifyMac(macAnswering(() => answer).http, origin, creds)).toBe(false);
  });

  it('is false for an address that doesn\'t answer', async () => {
    const { creds } = pairedMac();
    expect(await verifyMac(macAnswering(() => ({ status: 200, data: {} })).http, 'http://192.168.1.99:3333', creds)).toBe(false);
  });

  it('sends a fresh nonce and a tag that changes with it: never its device id or token', async () => {
    const { auth, creds } = pairedMac();
    const mac = macAnswering((b) => ({ status: 200, data: { data: { proof: auth.macProof(b.tag, b.nonce, REACHED) } } }));
    await verifyMac(mac.http, origin, creds);
    await verifyMac(mac.http, origin, creds);
    const [a, b] = mac.calls.map((c) => c.body as { tag: string; nonce: string });
    expect(Object.keys(a).sort()).toEqual(['nonce', 'tag']);
    expect(a.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(a.tag).toMatch(/^[0-9a-f]{64}$/);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.tag).not.toBe(b.tag);
    expect(JSON.stringify(mac.calls)).not.toContain(creds.deviceToken);
    expect(JSON.stringify(mac.calls)).not.toContain(creds.deviceId);
  });
});

describe('openSession signs only the Mac\'s own kind of nonce', () => {
  it('refuses a challenge that would make it sign a Mac proof', async () => {
    const { creds } = pairedMac();
    const calls: string[] = [];
    const http: HttpClient = {
      async post(url) {
        calls.push(url);
        if (url.endsWith('/challenge')) return { status: 200, data: { data: { nonce: `${MAC_PROOF_PREFIX}${'a'.repeat(64)}` } } };
        return { status: 200, data: { data: { token: 'sess' } } };
      },
    };
    const out = await openSession(http, origin, creds);
    expect(out.status).not.toBe('ok');
    expect(calls.some((u) => u.endsWith('/session'))).toBe(false);
  });
});

// ── POST /api/mobile/paths (AASC-60): the Mac tells a signed-in phone its Tailscale address, signed with the phone's key.
// The phone checks the real deviceAuth.pathsProof, so the two prefixes and the message can't drift apart.

const SESSION = 'sess-0123456789abcdef';
const ADDRESS = '100.101.102.103';
type Auth = ReturnType<typeof createDeviceAuth>;
type Paths = { tailnet: string | null; port: number };
const REAL: Paths = { tailnet: ADDRESS, port: 3333 };

/**
 * The real Mac's POST /paths for the phone `deviceId`: it signs `signed` with deviceAuth.pathsProof and shows `shown`
 * (the same, unless a box on the network rewrote the answer). `tamper` bends the answer after it is signed.
 */
function pathsMac(
  auth: Auth, deviceId: string, signed: Paths, shown: Paths = signed,
  tamper: (data: Record<string, unknown>) => Record<string, unknown> = (d) => d, status = 200,
) {
  const calls: HttpRequest[] = [];
  const requester: HttpRequester = {
    async request(req) {
      calls.push(req);
      if (req.url !== `${origin}/api/mobile/paths`) throw new Error('unreachable');
      const { nonce } = req.body as { nonce: string };
      const proof = auth.pathsProof(deviceId, nonce, signed.tailnet, signed.port);
      return { status, data: { success: true, data: tamper({ ...shown, proof }) } };
    },
  };
  return { requester, calls };
}

/** `hex` with the digit at `at` (negative: from the end) changed. */
function oneOff(hex: string, at: number): string {
  const i = at < 0 ? hex.length + at : at;
  return `${hex.slice(0, i)}${hex[i] === '0' ? '1' : '0'}${hex.slice(i + 1)}`;
}

describe('fetchMacPaths', () => {
  it('uses the same prefix as the Mac', () => {
    expect(PATHS_PROOF_PREFIX).toBe('aasc-paths:');
    expect(PATHS_PROOF_PREFIX).toBe(MAC_PATHS_PROOF_PREFIX);
  });

  it('fetchMacPaths accepts the real Mac’s paths proof and refuses one for another address', async () => {
    const { auth, creds } = pairedMac();
    expect(await fetchMacPaths(pathsMac(auth, creds.deviceId, REAL).requester, origin, SESSION, creds)).toEqual(REAL);
    // The Mac's own proof, shown with another address: a box on the home network rewrote the answer.
    const rewritten = pathsMac(auth, creds.deviceId, REAL, { tailnet: '100.64.0.9', port: 3333 });
    expect(await fetchMacPaths(rewritten.requester, origin, SESSION, creds)).toBeNull();
  });

  it('accepts a Mac with no Tailscale address: the proof is over "-"', async () => {
    const { auth, creds } = pairedMac();
    const none: Paths = { tailnet: null, port: 3333 };
    expect(await fetchMacPaths(pathsMac(auth, creds.deviceId, none).requester, origin, SESSION, creds)).toEqual(none);
  });

  it.each([
    ['another address', REAL, { tailnet: '100.64.0.9', port: 3333 }],
    ['an address for a Mac that has none', { tailnet: null, port: 3333 }, REAL],
    ['the address taken away', REAL, { tailnet: null, port: 3333 }],
    ['another port', REAL, { tailnet: ADDRESS, port: 3334 }],
  ])('refuses a proof made for %s', async (_what, signed, shown) => {
    const { auth, creds } = pairedMac();
    expect(await fetchMacPaths(pathsMac(auth, creds.deviceId, signed, shown).requester, origin, SESSION, creds)).toBeNull();
  });

  it('refuses another Mac, which holds no key of this phone’s', async () => {
    const { creds } = pairedMac();
    const stranger = pairedMac();
    const mac = pathsMac(stranger.auth, stranger.creds.deviceId, REAL);
    expect(await fetchMacPaths(mac.requester, origin, SESSION, creds)).toBeNull();
  });

  it('refuses an earlier answer replayed: every question has its own nonce', async () => {
    const { auth, creds } = pairedMac();
    const mac = pathsMac(auth, creds.deviceId, REAL);
    expect(await fetchMacPaths(mac.requester, origin, SESSION, creds)).toEqual(REAL);
    const earlier = await mac.requester.request(mac.calls[0]);
    expect(await fetchMacPaths({ request: async () => earlier }, origin, SESSION, creds)).toBeNull();
  });

  it('refuses a sign-in proof, a Mac proof or a tag passed off as a paths proof', async () => {
    const { creds } = pairedMac();
    const makers: Array<(nonce: string) => string> = [
      (nonce) => proofForToken(creds.deviceToken, nonce),
      (nonce) => proofForToken(creds.deviceToken, `${MAC_PROOF_PREFIX}${nonce}:${ADDRESS}:3333`),
      (nonce) => proofForToken(creds.deviceToken, `${WHO_TAG_PREFIX}${nonce}`),
      (nonce) => proofForToken(creds.deviceToken, `${nonce}:${ADDRESS}:3333`),
    ];
    for (const make of makers) {
      const requester: HttpRequester = {
        request: async (req) => ({ status: 200, data: { data: { ...REAL, proof: make((req.body as { nonce: string }).nonce) } } }),
      };
      expect(await fetchMacPaths(requester, origin, SESSION, creds)).toBeNull();
    }
  });

  // The Mac only ever names its Tailscale address; the phone opens nothing else, whoever signs it.
  it.each(['192.168.1.99', '10.0.0.5', '8.8.8.8', '100.63.255.255', '100.128.0.1', 'mac.local', '-', ''])(
    'refuses %s even when the Mac signs it', async (address) => {
      const { auth, creds } = pairedMac();
      const odd: Paths = { tailnet: address, port: 3333 };
      expect(await fetchMacPaths(pathsMac(auth, creds.deviceId, odd).requester, origin, SESSION, creds)).toBeNull();
    },
  );

  it.each([
    ['port 0', { tailnet: ADDRESS, port: 0 }],
    ['port 65536', { tailnet: ADDRESS, port: 65536 }],
    ['a port with a fraction', { tailnet: ADDRESS, port: 3333.5 }],
    ['a negative port', { tailnet: ADDRESS, port: -1 }],
  ])('refuses %s even when the Mac signs it', async (_what, odd) => {
    const { auth, creds } = pairedMac();
    expect(await fetchMacPaths(pathsMac(auth, creds.deviceId, odd).requester, origin, SESSION, creds)).toBeNull();
  });

  it.each([
    ['an error status', 401, (d: Record<string, unknown>) => d],
    ['a server error', 500, (d: Record<string, unknown>) => d],
    ['a 201', 201, (d: Record<string, unknown>) => d],
    ['a port sent as text', 200, (d: Record<string, unknown>) => ({ ...d, port: '3333' })],
    ['a missing port', 200, ({ port: _port, ...d }: Record<string, unknown>) => d],
    ['a missing address (null says none)', 200, ({ tailnet: _tailnet, ...d }: Record<string, unknown>) => d],
    ['a missing proof', 200, ({ proof: _proof, ...d }: Record<string, unknown>) => d],
    ['a proof with its last digit changed', 200, (d: Record<string, unknown>) => ({ ...d, proof: oneOff(String(d.proof), -1) })],
    ['a proof with its first digit changed', 200, (d: Record<string, unknown>) => ({ ...d, proof: oneOff(String(d.proof), 0) })],
    ['a proof in capitals', 200, (d: Record<string, unknown>) => ({ ...d, proof: String(d.proof).toUpperCase() })],
    ['a proof with a trailing newline', 200, (d: Record<string, unknown>) => ({ ...d, proof: `${String(d.proof)}\n` })],
    ['a proof that is not text', 200, (d: Record<string, unknown>) => ({ ...d, proof: [d.proof] })],
  ])('refuses %s', async (_what, status, tamper) => {
    const { auth, creds } = pairedMac();
    expect(await fetchMacPaths(pathsMac(auth, creds.deviceId, REAL, REAL, tamper, status).requester, origin, SESSION, creds)).toBeNull();
  });

  it.each([
    ['text', 'ok'],
    ['nothing', undefined],
    ['an empty object', {}],
    ['a list', []],
  ])('refuses an answer that is %s', async (_what, data) => {
    const { creds } = pairedMac();
    expect(await fetchMacPaths({ request: async () => ({ status: 200, data }) }, origin, SESSION, creds)).toBeNull();
  });

  it('is null, never a throw, when the Mac can’t be reached or answers nonsense', async () => {
    const { creds } = pairedMac();
    const down: HttpRequester = { request: async () => { throw new Error('network unreachable'); } };
    const garbage = { request: async () => undefined } as unknown as HttpRequester;
    expect(await fetchMacPaths(down, origin, SESSION, creds)).toBeNull();
    expect(await fetchMacPaths(garbage, origin, SESSION, creds)).toBeNull();
  });

  it('asks POST /api/mobile/paths with the session and a fresh nonce: never the device id or token', async () => {
    const { auth, creds } = pairedMac();
    const mac = pathsMac(auth, creds.deviceId, REAL);
    await fetchMacPaths(mac.requester, origin, SESSION, creds);
    await fetchMacPaths(mac.requester, origin, SESSION, creds);
    const [a, b] = mac.calls;
    expect(a).toMatchObject({
      method: 'POST', url: `${origin}/api/mobile/paths`,
      headers: { Authorization: `Bearer ${SESSION}`, 'Content-Type': 'application/json' },
    });
    expect(Object.keys(a.body as object)).toEqual(['nonce']);
    expect((a.body as { nonce: string }).nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(a.body).not.toEqual(b.body);
    expect(JSON.stringify(mac.calls)).not.toContain(creds.deviceToken);
    expect(JSON.stringify(mac.calls)).not.toContain(creds.deviceId);
  });

  it('asks with PATHS_BUDGET_MS as its own timeout, so a late answer is cancelled rather than left running for the native 15 s', async () => {
    expect(PATHS_BUDGET_MS).toBe(3_000);
    const { auth, creds } = pairedMac();
    const mac = pathsMac(auth, creds.deviceId, REAL);
    await fetchMacPaths(mac.requester, origin, SESSION, creds);
    expect(mac.calls[0].timeoutMs).toBe(PATHS_BUDGET_MS);
  });
});
