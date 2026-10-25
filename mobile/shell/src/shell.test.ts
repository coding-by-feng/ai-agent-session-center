// shell.test.ts — AASC-17: the phone shell's pure logic.
import { describe, it, expect, vi } from 'vitest';
import { parsePairingLink, isPrivateLanAddress, isTailnetAddress } from './pairingLink';
import { candidates, pickReachable, isAllowedNavigation, type PairedServer } from './connectionPlan';
import { pairWithMac, pairWithBackend, requestBackendCode, openSession, unpairSelf, deviceProof, type HttpClient } from './pairingClient';
import type { HttpRequest, HttpRequester } from './http';
import { proofForToken } from '../../../server/mobile/deviceAuth';
import { parseReauthRequest, returnUrl } from './reauth';

const GOOD = 'https://aasc.work/pair#v=2&name=Kason-MBP&lan=192.168.1.20&ts=100.101.102.103&p=3333&mc=K7Q2M9XPZT';

describe('parsePairingLink', () => {
  it('reads the link the desktop shows', () => {
    expect(parsePairingLink(GOOD)).toEqual({
      version: 2, name: 'Kason-MBP', lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333, macCode: 'K7Q2M9XPZT',
    });
  });

  it.each([
    ['a backend code (an old QR)', '&be=api.aasc.work&bc=abcdefghijklmnopqrstuv&md=3f2c1d5e-8a4b'],
    ['a backend outside aasc.work', '&be=api.evil.example&bc=abcdefghijklmnopqrstuv'],
    ['a backend host without a code', '&be=api.aasc.work'],
  ])('ignores %s: the backend code comes from the Mac after approval (AASC-52)', (_label, extra) => {
    expect(parsePairingLink(`${GOOD}${extra}`)).toEqual(parsePairingLink(GOOD));
  });

  it.each([
    ['another site', GOOD.replace('https://aasc.work', 'https://evil.example')],
    ['plain http', GOOD.replace('https://', 'http://')],
    ['wrong path', GOOD.replace('/pair#', '/x#')],
    ['old version', GOOD.replace('v=2', 'v=1')],
    ['public LAN address', GOOD.replace('192.168.1.20', '8.8.8.8')],
    ['non-tailnet ts', GOOD.replace('100.101.102.103', '100.200.1.1')],
    ['a leading-zero LAN address (octal to the URL parser)', GOOD.replace('192.168.1.20', '010.1.1.1')],
    ['a leading-zero tailnet address (octal to the URL parser)', GOOD.replace('100.101.102.103', '100.064.001.001')],
    ['bad port', GOOD.replace('p=3333', 'p=99999')],
    ['bad code', GOOD.replace('mc=K7Q2M9XPZT', 'mc=K7Q2M9XPZ0')],
    ['no address at all', 'https://aasc.work/pair#v=2&name=X&p=3333&mc=K7Q2M9XPZT'],
    ['garbage', 'not a link'],
  ])('refuses %s', (_label, input) => {
    expect(parsePairingLink(input)).toBeNull();
  });

  it('accepts a bare fragment typed by hand', () => {
    expect(parsePairingLink('v=2&name=Mac&ts=100.64.0.1&p=3333&mc=ABCDEFGHJK')?.tailnet).toBe('100.64.0.1');
  });

  it('classifies addresses', () => {
    expect(isPrivateLanAddress('10.0.0.5')).toBe(true);
    expect(isPrivateLanAddress('172.16.0.1')).toBe(true);
    expect(isPrivateLanAddress('172.32.0.1')).toBe(false);
    expect(isTailnetAddress('100.64.0.1')).toBe(true);
    expect(isTailnetAddress('100.128.0.1')).toBe(false);
  });

  it('refuses addresses the URL parser would read as octal or another address', () => {
    for (const s of ['010.1.1.1', '0172.16.1.1', '192.168.001.010', '10.0.0.08', '00.0.0.0'])
      expect(isPrivateLanAddress(s)).toBe(false);
    for (const s of ['100.064.001.001', '100.64.01.1', '0100.64.1.1'])
      expect(isTailnetAddress(s)).toBe(false);
  });
  it('refuses malformed addresses', () => {
    for (const s of ['100.64.1.256', '100.64.1', '100.64.1.1.1', ' 100.64.1.1', '100.64.1.1 ', '+100.64.1.1', '100.64.1.1/32', ''])
      expect(isTailnetAddress(s)).toBe(false);
  });
  it('every address that passes is dialled exactly as written', () => {
    for (const s of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.7.231', '169.254.1.1', '100.64.0.0', '100.127.255.255', '100.101.102.103']) {
      expect(isPrivateLanAddress(s) || isTailnetAddress(s)).toBe(true);
      expect(new URL(`http://${s}:1`).hostname).toBe(s);
    }
  });
});

const server: PairedServer = { id: 's', name: 'Mac', port: 3333, lan: '192.168.1.20', tailnet: '100.101.102.103', lanAllowed: false };

describe('connection plan', () => {
  it('uses only Tailscale unless the home network was allowed', () => {
    expect(candidates(server).map((c) => c.kind)).toEqual(['tailnet']);
    expect(candidates({ ...server, lanAllowed: true }).map((c) => [c.kind, c.encrypted])).toEqual([['lan', false], ['tailnet', true]]);
  });

  it('picks the first path that answers', async () => {
    const list = candidates({ ...server, lanAllowed: true });
    const probe = vi.fn(async (origin: string) => origin.includes('100.101'));
    expect((await pickReachable(list, probe))?.kind).toBe('tailnet');
    expect(probe).toHaveBeenCalledTimes(2);
    expect(await pickReachable(list, async () => { throw new Error('offline'); })).toBeNull();
  });

  it('only lets the WebView navigate to paired addresses or aasc.work over https', () => {
    const servers = [{ ...server, lanAllowed: true }];
    expect(isAllowedNavigation('http://100.101.102.103:3333/queue', servers)).toBe(true);
    expect(isAllowedNavigation('http://192.168.1.20:3333/', servers)).toBe(true);
    expect(isAllowedNavigation('http://192.168.1.20:8080/', servers)).toBe(false);
    expect(isAllowedNavigation('http://example.com/', servers)).toBe(false);
    expect(isAllowedNavigation('https://mac-kason.aasc.work/', servers)).toBe(true);
    expect(isAllowedNavigation('https://evil.example/', servers)).toBe(false);
    expect(isAllowedNavigation('javascript:alert(1)', servers)).toBe(false);
    expect(isAllowedNavigation('http://192.168.1.20:3333/', [server])).toBe(false); // LAN not allowed for this Mac
  });
});

function fakeHttp(routes: Record<string, { status: number; data: unknown }>): HttpClient & { calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  return {
    calls,
    async post(url, body) {
      calls.push({ url, body });
      const hit = routes[url];
      if (!hit) throw new Error('unreachable');
      return hit;
    },
  };
}

function fakeRequester(answer: (req: HttpRequest) => { status: number; data: unknown } | Error): HttpRequester & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      const out = answer(req);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

describe('pairing client', () => {
  const link = parsePairingLink(GOOD)!;
  const origin = 'http://100.101.102.103:3333';
  const deviceId = '0b4b63b5-f006-42f9-9d53-1960c7f9117a';

  it('pairs with the Mac and returns the pending credentials and confirmation code', async () => {
    const http = fakeHttp({ [`${origin}/api/mobile/pair`]: { status: 201, data: { data: { deviceId, deviceToken: 't'.repeat(43), confirmCode: '482913' } } } });
    expect(await pairWithMac(http, origin, link, 'Phone', 'ios')).toEqual({ deviceId, deviceToken: 't'.repeat(43), confirmCode: '482913' });
  });

  it('explains an expired code', async () => {
    const http = fakeHttp({ [`${origin}/api/mobile/pair`]: { status: 401, data: { code: 'INVALID_PAIRING_CODE' } } });
    await expect(pairWithMac(http, origin, link, 'Phone', 'ios')).rejects.toThrow(/expired/);
  });

  it('rejects a malformed answer instead of storing it', async () => {
    const http = fakeHttp({ [`${origin}/api/mobile/pair`]: { status: 201, data: { data: { deviceId: 'x', deviceToken: 'short', confirmCode: '1' } } } });
    await expect(pairWithMac(http, origin, link, 'Phone', 'ios')).rejects.toThrow(/unexpected/);
  });

  it('redeems the backend code the Mac issued with the backend', async () => {
    const http = fakeHttp({ 'https://api.aasc.work/v1/devices/pair': { status: 200, data: { success: true, data: { token: 'b'.repeat(43), deviceId: 'be-1' } } } });
    expect(await pairWithBackend(http, 'api.aasc.work', 'abcdefghijklmnopqrstuv', 'Phone')).toEqual({ deviceId: 'be-1', token: 'b'.repeat(43) });
    expect(http.calls).toEqual([{ url: 'https://api.aasc.work/v1/devices/pair', body: { code: 'abcdefghijklmnopqrstuv', name: 'Phone' } }]);
  });

  it('never sends a backend code anywhere but aasc.work', async () => {
    const http = fakeHttp({});
    await expect(pairWithBackend(http, 'api.evil.example', 'abcdefghijklmnopqrstuv', 'Phone')).rejects.toThrow();
    expect(http.calls).toEqual([]);
  });

  describe('requestBackendCode (AASC-52)', () => {
    const url = `${origin}/api/mobile/backend-code`;
    const ok = { status: 200, data: { success: true, data: { host: 'api.aasc.work', code: 'abcdefghijklmnopqrstuv', macDeviceId: 'mac-dev-1' } } };

    it('asks the Mac with the signed-in session, as JSON', async () => {
      const http = fakeRequester(() => ok);
      expect(await requestBackendCode(http, origin, 'sess-token')).toEqual({
        status: 'ok', host: 'api.aasc.work', code: 'abcdefghijklmnopqrstuv', macDeviceId: 'mac-dev-1',
      });
      expect(http.calls).toEqual([{ method: 'POST', url, headers: { Authorization: 'Bearer sess-token', 'Content-Type': 'application/json' }, body: {} }]);
    });

    it('hears “no cloud” as its own answer, and everything else as try again later', async () => {
      expect(await requestBackendCode(fakeRequester(() => ({ status: 409, data: { code: 'NO_CLOUD' } })), origin, 't')).toEqual({ status: 'no-cloud' });
      for (const res of [
        { status: 409, data: { code: 'BACKEND_CODE_OUTSTANDING' } },
        { status: 401, data: { code: 'DEVICE_REVOKED' } },
        { status: 429, data: { code: 'RATE_LIMITED' } },
        { status: 502, data: { code: 'CLOUD_UNAVAILABLE' } },
      ]) expect(await requestBackendCode(fakeRequester(() => res), origin, 't')).toEqual({ status: 'unavailable' });
      expect(await requestBackendCode(fakeRequester(() => new Error('offline')), origin, 't')).toEqual({ status: 'unavailable' });
    });

    it('refuses an answer that points outside aasc.work or isn’t a code; drops a malformed Mac id', async () => {
      const answer = (data: Record<string, unknown>) => fakeRequester(() => ({ status: 200, data: { data: { ...ok.data.data, ...data } } }));
      expect(await requestBackendCode(answer({ host: 'api.evil.example' }), origin, 't')).toEqual({ status: 'unavailable' });
      expect(await requestBackendCode(answer({ code: 'short' }), origin, 't')).toEqual({ status: 'unavailable' });
      expect(await requestBackendCode(answer({ macDeviceId: 'bad id' }), origin, 't')).toMatchObject({ status: 'ok', macDeviceId: null });
      expect(await requestBackendCode(answer({ macDeviceId: null }), origin, 't')).toMatchObject({ status: 'ok', macDeviceId: null });
    });
  });

  const challengeRoute = { [`${origin}/api/mobile/challenge`]: { status: 200, data: { data: { nonce: 'nonce-abcdefghijklmnopqrstuvwx' } } } };

  it('maps session answers to states the shell can show', async () => {
    const creds = { deviceId, deviceToken: 't'.repeat(43) };
    const url = `${origin}/api/mobile/session`;
    expect(await openSession(fakeHttp({ ...challengeRoute, [url]: { status: 200, data: { data: { token: 'sess' } } } }), origin, creds)).toEqual({ status: 'ok', token: 'sess' });
    expect(await openSession(fakeHttp({ ...challengeRoute, [url]: { status: 403, data: { code: 'DEVICE_PENDING' } } }), origin, creds)).toEqual({ status: 'pending' });
    expect(await openSession(fakeHttp({ ...challengeRoute, [url]: { status: 401, data: { code: 'DEVICE_REVOKED' } } }), origin, creds)).toEqual({ status: 'revoked', verified: true });
    expect(await openSession(fakeHttp({ ...challengeRoute, [url]: { status: 401, data: { code: 'DEVICE_UNKNOWN' } } }), origin, creds)).toEqual({ status: 'revoked', verified: false });
    expect(await openSession(fakeHttp({}), origin, creds)).toEqual({ status: 'unreachable' });
  });

  it('never sends the device token: the sign-in carries only a one-time proof', async () => {
    const creds = { deviceId, deviceToken: 'secret-device-token-0123456789abcdef' };
    const http = fakeHttp({ ...challengeRoute, [`${origin}/api/mobile/session`]: { status: 200, data: { data: { token: 's' } } } });
    await openSession(http, origin, creds);
    expect(JSON.stringify(http.calls)).not.toContain(creds.deviceToken);
    const sent = http.calls[1].body as { nonce: string; proof: string };
    expect(sent.nonce).toBe('nonce-abcdefghijklmnopqrstuvwx');
    expect(sent.proof).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computes exactly the proof the Mac expects (WebCrypto vs node:crypto)', async () => {
    const token = 'tok_' + 'x'.repeat(40);
    const nonce = 'abcDEF123_-abcDEF123_-abcDEF12';
    expect(await deviceProof(token, nonce)).toBe(proofForToken(token, nonce));
  });

  it('unpairs itself with a proof too', async () => {
    const creds = { deviceId, deviceToken: 't'.repeat(43) };
    const http = fakeHttp({ ...challengeRoute, [`${origin}/api/mobile/unpair`]: { status: 200, data: { success: true } } });
    expect(await unpairSelf(http, origin, creds)).toBe(true);
    expect(await unpairSelf(fakeHttp({}), origin, creds)).toBe(false);
  });
});

describe('re-auth requests', () => {
  it('keeps a path to return to and refuses anything else', () => {
    expect(parseReauthRequest('?reauth=1&back=%2Fqueue')).toEqual({ back: '/queue' });
    expect(parseReauthRequest('?reauth=1&back=https%3A%2F%2Fevil.example')).toEqual({ back: '/' });
    expect(parseReauthRequest('?reauth=1&back=%2F%2Fevil.example')).toEqual({ back: '/' });
    expect(parseReauthRequest('?other=1')).toBeNull();
    expect(returnUrl('http://100.101.102.103:3333', '/queue')).toBe('http://100.101.102.103:3333/queue');
    expect(returnUrl('http://100.101.102.103:3333', '//evil')).toBe('http://100.101.102.103:3333/');
  });
});
