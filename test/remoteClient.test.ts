import { describe, it, expect, vi } from 'vitest';
import {
  addressPlan, countShared, deviceProof, fetchPaths, pair, signIn, unpair,
  PATHS_PROOF_PREFIX, HANDSHAKE_MAX_BYTES, SESSIONS_MAX_BYTES, type FetchLike, type RemoteClientDeps,
} from '../electron/remote/remoteClient.js';
import type { RemotePairingLink } from '../electron/remote/pairingLinkRules.js';
// The remote's own proof functions: the client must agree with them byte for byte.
import { proofForToken, PATHS_PROOF_PREFIX as SERVER_PATHS_PREFIX } from '../server/mobile/deviceAuth.js';

const DEVICE_ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const DEVICE_TOKEN = 'dGhpcyBpcyBhIGRldmljZSB0b2tlbiBmb3IgdGVzdHM';
const SESSION_TOKEN = 'a'.repeat(64);
const NONCE = 'c'.repeat(64);
const SIGN_IN_NONCE = 'srvNonce_abcdefghijklmnopqrstuv';
const LAN = 'http://192.168.1.20:3333';
const TS = 'http://100.101.102.103:3333';
const creds = { deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN };
const target = { lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333 };
const link: RemotePairingLink = {
  version: 2, name: 'Studio', lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333, macCode: 'ABCDEFGH23',
};

type Handler = (url: string, init: Parameters<FetchLike>[1]) => { status: number; body?: unknown } | 'network-error' | 'hang';

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown; redirect: string }

/** A fake fetch: never the network. 'hang' resolves only when the client aborts. */
function fakeFetch(handler: Handler): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect });
    const out = handler(url, init);
    if (out === 'network-error') return Promise.reject(new TypeError('fetch failed'));
    if (out === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const text = out.body === undefined ? '' : typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
    return Promise.resolve({ status: out.status, text: async () => text });
  };
  return { fetch, calls };
}

function deps(fetch: FetchLike, extra: Partial<RemoteClientDeps> = {}): RemoteClientDeps {
  return { fetch, randomHex: () => NONCE, timeoutMs: 50, ...extra };
}

/** A remote that answers the sign-in protocol, with the session step chosen per test. */
function signInRemote(session: { status: number; body?: unknown }, opts: { lanDown?: boolean } = {}): Handler {
  return (url, init) => {
    if (opts.lanDown && url.startsWith(LAN)) return 'network-error';
    if (url.endsWith('/api/mobile/challenge')) return { status: 200, body: { success: true, data: { nonce: SIGN_IN_NONCE, expiresAt: 0 } } };
    if (url.endsWith('/api/mobile/session')) {
      const body = JSON.parse(init.body ?? '{}');
      // The real remote checks the proof; so does this one.
      if (body.proof !== proofForToken(DEVICE_TOKEN, SIGN_IN_NONCE)) return { status: 401, body: { code: 'DEVICE_UNKNOWN' } };
      return session;
    }
    return { status: 404, body: { error: 'Not found' } };
  };
}

describe('deviceProof', () => {
  it('matches the remote’s proofForToken', () => {
    expect(deviceProof(DEVICE_TOKEN, 'some-nonce')).toBe(proofForToken(DEVICE_TOKEN, 'some-nonce'));
    expect(PATHS_PROOF_PREFIX).toBe(SERVER_PATHS_PREFIX);
  });
});

describe('addressPlan', () => {
  it('tries the home network first, then Tailscale', () => {
    expect(addressPlan(target)).toEqual([{ via: 'lan', origin: LAN }, { via: 'tailnet', origin: TS }]);
  });

  it('tries a public address last, after the home network and Tailscale', () => {
    expect(addressPlan({ ...target, publicAddress: '45.63.31.79' })).toEqual([
      { via: 'lan', origin: LAN }, { via: 'tailnet', origin: TS }, { via: 'public', origin: 'http://45.63.31.79:3333' },
    ]);
    expect(addressPlan({ lan: null, tailnet: null, publicAddress: '45.63.31.79', port: 3333 }))
      .toEqual([{ via: 'public', origin: 'http://45.63.31.79:3333' }]);
  });

  it('never dials a "public" address that is private, Tailscale or local', () => {
    for (const publicAddress of ['192.168.1.5', '100.74.194.86', '127.0.0.1', '169.254.169.254', 'evil.example']) {
      expect(addressPlan({ lan: null, tailnet: null, publicAddress, port: 3333 }), publicAddress).toEqual([]);
    }
  });

  it('skips anything that isn’t a validated private or Tailscale address', () => {
    expect(addressPlan({ lan: '8.8.8.8', tailnet: 'evil.example', port: 3333 })).toEqual([]);
    expect(addressPlan({ lan: '10.0.0.1', tailnet: null, port: 0 })).toEqual([]);
  });
});

describe('pair', () => {
  it('pairs over a public address when the link names only that, and says where it looked when none answers', async () => {
    const pub: RemotePairingLink = { ...link, lan: null, tailnet: null, publicAddress: '45.63.31.79' };
    const ok = fakeFetch(() => ({
      status: 201,
      body: { success: true, data: { deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN, confirmCode: '042137', status: 'pending' } },
    }));
    expect(await pair(deps(ok.fetch), pub, 'kason-mbp')).toMatchObject({ ok: true, via: 'public' });
    expect(ok.calls.map((c) => c.url)).toEqual(['http://45.63.31.79:3333/api/mobile/pair']);

    const down = fakeFetch(() => 'network-error');
    const out = await pair(deps(down.fetch), pub, 'kason-mbp');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('45.63.31.79');
  });

  it('redeems the code as a desktop and returns the device', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 201,
      body: { success: true, data: { deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN, confirmCode: '042137', status: 'pending' } },
    }));
    const out = await pair(deps(fetch), link, 'kason-mbp');
    expect(out).toEqual({ ok: true, deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN, confirmCode: '042137', via: 'lan' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${LAN}/api/mobile/pair`);
    expect(calls[0].body).toEqual({ code: 'ABCDEFGH23', label: 'kason-mbp', platform: 'desktop' });
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].redirect).toBe('manual');
  });

  it('falls back to Tailscale when the home network doesn’t answer', async () => {
    const { fetch, calls } = fakeFetch((url) => url.startsWith(LAN) ? 'network-error' : {
      status: 201, body: { data: { deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN, confirmCode: '000001' } },
    });
    const out = await pair(deps(fetch), link, 'x');
    expect(out).toMatchObject({ ok: true, via: 'tailnet' });
    expect(calls.map((c) => c.url)).toEqual([`${LAN}/api/mobile/pair`, `${TS}/api/mobile/pair`]);
  });

  it('does not spend the code twice once AASC refused it', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 401, body: { error: 'x', code: 'INVALID_PAIRING_CODE' } }));
    const out = await pair(deps(fetch), link, 'x');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/expired or was already used/);
    expect(calls).toHaveLength(1);
  });

  it('moves on when the LAN address answers but isn’t AASC', async () => {
    const { fetch } = fakeFetch((url) => url.startsWith(LAN) ? { status: 200, body: '<html>router</html>' } : {
      status: 201, body: { data: { deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN, confirmCode: '000001' } },
    });
    expect(await pair(deps(fetch), link, 'x')).toMatchObject({ ok: true, via: 'tailnet' });
  });

  it('explains a remote with no password and a rate limit', async () => {
    const noPw = fakeFetch(() => ({ status: 403, body: { code: 'REMOTE_PASSWORD_REQUIRED' } }));
    expect(await pair(deps(noPw.fetch), link, 'x')).toMatchObject({ ok: false, error: expect.stringMatching(/no dashboard password/) });
    const limited = fakeFetch(() => ({ status: 429, body: { error: 'Too many', retryAfter: 60 } }));
    expect(await pair(deps(limited.fetch), link, 'x')).toMatchObject({ ok: false, error: expect.stringMatching(/too many attempts/) });
  });

  it('rejects a malformed answer', async () => {
    const { fetch } = fakeFetch(() => ({ status: 201, body: { data: { deviceId: 'nope', deviceToken: DEVICE_TOKEN, confirmCode: '1' } } }));
    expect(await pair(deps(fetch), link, 'x')).toEqual({ ok: false, error: 'That computer sent an unexpected answer.' });
  });

  it('says it’s unreachable when no address answers, and never leaks the token', async () => {
    const { fetch } = fakeFetch(() => 'network-error');
    const out = await pair(deps(fetch), link, 'x');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain('192.168.1.20');
      expect(out.error).toContain('100.101.102.103');
    }
  });

  it('gives up on an address after the per-try timeout', async () => {
    const { fetch, calls } = fakeFetch(() => 'hang');
    const started = Date.now();
    const out = await pair(deps(fetch, { timeoutMs: 30 }), link, 'x');
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('signIn', () => {
  it('answers the challenge with the proof and returns the session', async () => {
    const { fetch, calls } = fakeFetch(signInRemote({ status: 200, body: { data: { token: SESSION_TOKEN, expiresIn: 3600 } } }));
    const out = await signIn(deps(fetch), target, creds);
    expect(out).toEqual({ state: 'ok', token: SESSION_TOKEN, expiresIn: 3600, origin: LAN, via: 'lan' });
    expect(calls.map((c) => c.url)).toEqual([`${LAN}/api/mobile/challenge`, `${LAN}/api/mobile/session`]);
    expect(calls[0].body).toEqual({ deviceId: DEVICE_ID });
    // The token itself never travels.
    expect(JSON.stringify(calls)).not.toContain(DEVICE_TOKEN);
  });

  it('reports pending while the remote hasn’t allowed this computer', async () => {
    const { fetch } = fakeFetch(signInRemote({ status: 403, body: { code: 'DEVICE_PENDING' } }));
    expect(await signIn(deps(fetch), target, creds)).toEqual({ state: 'pending', origin: LAN, via: 'lan' });
  });

  it('reports revoked for DEVICE_REVOKED and DEVICE_UNKNOWN', async () => {
    const revoked = fakeFetch(signInRemote({ status: 401, body: { code: 'DEVICE_REVOKED' } }));
    expect(await signIn(deps(revoked.fetch), target, creds)).toMatchObject({ state: 'revoked', verified: true });
    const unknown = fakeFetch(signInRemote({ status: 401, body: { code: 'DEVICE_UNKNOWN' } }));
    expect(await signIn(deps(unknown.fetch), target, creds)).toMatchObject({ state: 'revoked', verified: false });
  });

  it('signs in over Tailscale when the LAN is down, and stays on that address', async () => {
    const { fetch, calls } = fakeFetch(signInRemote({ status: 200, body: { data: { token: SESSION_TOKEN, expiresIn: 3600 } } }, { lanDown: true }));
    const out = await signIn(deps(fetch), target, creds);
    expect(out).toMatchObject({ state: 'ok', origin: TS, via: 'tailnet' });
    expect(calls.map((c) => c.url)).toEqual([`${LAN}/api/mobile/challenge`, `${TS}/api/mobile/challenge`, `${TS}/api/mobile/session`]);
  });

  it('is offline when nothing answers in time', async () => {
    const { fetch } = fakeFetch(() => 'hang');
    expect(await signIn(deps(fetch, { timeoutMs: 20 }), target, creds)).toMatchObject({ state: 'offline' });
  });

  it('refuses a session answer with a malformed token', async () => {
    const { fetch } = fakeFetch(signInRemote({ status: 200, body: { data: { token: 'bad token!', expiresIn: 3600 } } }));
    expect(await signIn(deps(fetch), target, creds)).toMatchObject({ state: 'error' });
  });

  it('caps an odd expiresIn to a sane value', async () => {
    const { fetch } = fakeFetch(signInRemote({ status: 200, body: { data: { token: SESSION_TOKEN, expiresIn: -5 } } }));
    expect(await signIn(deps(fetch), target, creds)).toMatchObject({ state: 'ok', expiresIn: 3600 });
  });
});

describe('fetchPaths', () => {
  const pathsRemote = (tailnet: string | null, port: number, sign: { tailnet: string | null; port: number } = { tailnet, port }): Handler =>
    (url, init) => {
      if (!url.endsWith('/api/mobile/paths')) return { status: 404 };
      const { nonce } = JSON.parse(init.body ?? '{}');
      const proof = proofForToken(DEVICE_TOKEN, `${SERVER_PATHS_PREFIX}${nonce}:${sign.tailnet ?? '-'}:${sign.port}`);
      return { status: 200, body: { success: true, data: { tailnet, port, proof } } };
    };

  it('accepts a proved Tailscale address, sending a client nonce and the Bearer session', async () => {
    const { fetch, calls } = fakeFetch(pathsRemote('100.88.1.2', 3333));
    expect(await fetchPaths(deps(fetch), LAN, SESSION_TOKEN, creds)).toEqual({ tailnet: '100.88.1.2', port: 3333 });
    expect(calls[0].body).toEqual({ nonce: NONCE });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${SESSION_TOKEN}`);
  });

  it('accepts a proved "no Tailscale" answer', async () => {
    const { fetch } = fakeFetch(pathsRemote(null, 3333));
    expect(await fetchPaths(deps(fetch), LAN, SESSION_TOKEN, creds)).toEqual({ tailnet: null, port: 3333 });
  });

  it('rejects an address rewritten on the way (proof made for another one)', async () => {
    const { fetch } = fakeFetch(pathsRemote('100.66.6.6', 3333, { tailnet: '100.88.1.2', port: 3333 }));
    expect(await fetchPaths(deps(fetch), LAN, SESSION_TOKEN, creds)).toBeNull();
  });

  it('rejects a rewritten port', async () => {
    const { fetch } = fakeFetch(pathsRemote('100.88.1.2', 4444, { tailnet: '100.88.1.2', port: 3333 }));
    expect(await fetchPaths(deps(fetch), LAN, SESSION_TOKEN, creds)).toBeNull();
  });

  it('rejects an address outside Tailscale’s range even with a valid proof', async () => {
    const { fetch } = fakeFetch(pathsRemote('8.8.8.8', 3333));
    expect(await fetchPaths(deps(fetch), LAN, SESSION_TOKEN, creds)).toBeNull();
  });

  it('is null on refusal, timeout or a bad nonce source', async () => {
    expect(await fetchPaths(deps(fakeFetch(() => ({ status: 401, body: {} })).fetch), LAN, SESSION_TOKEN, creds)).toBeNull();
    expect(await fetchPaths(deps(fakeFetch(() => 'hang').fetch, { timeoutMs: 20 }), LAN, SESSION_TOKEN, creds)).toBeNull();
    const calledFetch = vi.fn();
    expect(await fetchPaths(deps(calledFetch as unknown as FetchLike, { randomHex: () => 'short' }), LAN, SESSION_TOKEN, creds)).toBeNull();
    expect(calledFetch).not.toHaveBeenCalled();
  });
});

describe('unpair', () => {
  it('proves the key to /unpair', async () => {
    const { fetch, calls } = fakeFetch((url, init) => {
      if (url.endsWith('/challenge')) return { status: 200, body: { data: { nonce: SIGN_IN_NONCE } } };
      if (url.endsWith('/unpair')) {
        const body = JSON.parse(init.body ?? '{}');
        return body.proof === proofForToken(DEVICE_TOKEN, SIGN_IN_NONCE) ? { status: 200, body: { success: true } } : { status: 401, body: {} };
      }
      return { status: 404, body: {} };
    });
    expect(await unpair(deps(fetch), target, creds)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([`${LAN}/api/mobile/challenge`, `${LAN}/api/mobile/unpair`]);
  });

  it('is false when the remote can’t be reached or refuses', async () => {
    expect(await unpair(deps(fakeFetch(() => 'network-error').fetch), target, creds)).toBe(false);
    expect(await unpair(deps(fakeFetch(() => ({ status: 401, body: {} })).fetch), target, creds)).toBe(false);
  });
});

describe('countShared', () => {
  it('counts the sessions the remote returns, with the Bearer session', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { s1: { sessionId: 's1' }, s2: { sessionId: 's2' } } }));
    expect(await countShared(deps(fetch), LAN, SESSION_TOKEN)).toBe(2);
    expect(calls[0]).toMatchObject({ url: `${LAN}/api/sessions`, method: 'GET', redirect: 'manual' });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${SESSION_TOKEN}`);
  });

  it('stops reading an oversized answer instead of holding it all', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(chunk); } });
    const fetch: FetchLike = () => Promise.resolve({ status: 200, text: async () => '', body: endless });
    expect(await countShared(deps(fetch), LAN, SESSION_TOKEN)).toBeNull();
    // The 8 MB cap, plus at most a chunk or two of read-ahead: never the whole stream.
    expect(pulled * chunk.byteLength).toBeLessThanOrEqual(SESSIONS_MAX_BYTES + 3 * chunk.byteLength);
  });

  it('reads a streamed answer under the cap', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ s1: {}, s2: {}, s3: {} }));
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
    const fetch: FetchLike = () => Promise.resolve({ status: 200, text: async () => '', body });
    expect(await countShared(deps(fetch), LAN, SESSION_TOKEN)).toBe(3);
  });

  it('treats a handshake answer past 64 KB as no answer', async () => {
    const huge = 'x'.repeat(HANDSHAKE_MAX_BYTES + 1);
    const { fetch } = fakeFetch(() => ({ status: 200, body: huge }));
    expect(await fetchPaths(deps(fetch), LAN, SESSION_TOKEN, creds)).toBeNull();
  });

  it('is null when refused or unreadable', async () => {
    expect(await countShared(deps(fakeFetch(() => ({ status: 401, body: {} })).fetch), LAN, SESSION_TOKEN)).toBeNull();
    expect(await countShared(deps(fakeFetch(() => ({ status: 302 })).fetch), LAN, SESSION_TOKEN)).toBeNull();
    expect(await countShared(deps(fakeFetch(() => 'network-error').fetch), LAN, SESSION_TOKEN)).toBeNull();
  });
});
