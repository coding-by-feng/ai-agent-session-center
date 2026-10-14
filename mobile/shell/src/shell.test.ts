// shell.test.ts — AASC-17: the phone shell's pure logic.
import { describe, it, expect, vi } from 'vitest';
import { parsePairingLink, isPrivateLanAddress, isTailnetAddress } from './pairingLink';
import { candidates, pickReachable, isAllowedNavigation, type PairedServer } from './connectionPlan';
import { pairWithMac, pairWithBackend, openSession, type HttpClient } from './pairingClient';
import { parseReauthRequest, returnUrl } from './reauth';

const GOOD = 'https://aasc.work/pair#v=2&name=Kason-MBP&lan=192.168.1.20&ts=100.101.102.103&p=3333&mc=K7Q2M9XPZT';

describe('parsePairingLink', () => {
  it('reads the link the desktop shows', () => {
    expect(parsePairingLink(GOOD)).toEqual({
      version: 2, name: 'Kason-MBP', lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333,
      macCode: 'K7Q2M9XPZT', backendHost: null, backendCode: null,
    });
  });

  it('reads the backend code when present', () => {
    const link = parsePairingLink(`${GOOD}&be=api.aasc.work&bc=abcdefghijklmnopqrstuv`);
    expect(link?.backendHost).toBe('api.aasc.work');
    expect(link?.backendCode).toBe('abcdefghijklmnopqrstuv');
  });

  it.each([
    ['another site', GOOD.replace('https://aasc.work', 'https://evil.example')],
    ['plain http', GOOD.replace('https://', 'http://')],
    ['wrong path', GOOD.replace('/pair#', '/x#')],
    ['old version', GOOD.replace('v=2', 'v=1')],
    ['public LAN address', GOOD.replace('192.168.1.20', '8.8.8.8')],
    ['non-tailnet ts', GOOD.replace('100.101.102.103', '100.200.1.1')],
    ['bad port', GOOD.replace('p=3333', 'p=99999')],
    ['bad code', GOOD.replace('mc=K7Q2M9XPZT', 'mc=K7Q2M9XPZ0')],
    ['backend outside aasc.work', `${GOOD}&be=api.evil.example&bc=abcdefghijklmnopqrstuv`],
    ['backend host without code', `${GOOD}&be=api.aasc.work`],
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

function fakeHttp(routes: Record<string, { status: number; data: unknown }>): HttpClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async post(url) {
      calls.push(url);
      const hit = routes[url];
      if (!hit) throw new Error('unreachable');
      return hit;
    },
  };
}

describe('pairing client', () => {
  const link = parsePairingLink(`${GOOD}&be=api.aasc.work&bc=abcdefghijklmnopqrstuv`)!;
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

  it('pairs with the backend only when the QR carried a backend code', async () => {
    const http = fakeHttp({ 'https://api.aasc.work/v1/devices/pair': { status: 200, data: { success: true, data: { token: 'b'.repeat(43), deviceId: 'be-1' } } } });
    expect(await pairWithBackend(http, link, 'Phone')).toEqual({ deviceId: 'be-1', token: 'b'.repeat(43) });
    expect(await pairWithBackend(http, { ...link, backendHost: null, backendCode: null }, 'Phone')).toBeNull();
  });

  it('maps session answers to states the shell can show', async () => {
    const creds = { deviceId, deviceToken: 't'.repeat(43) };
    const url = `${origin}/api/mobile/session`;
    expect(await openSession(fakeHttp({ [url]: { status: 200, data: { data: { token: 'sess' } } } }), origin, creds)).toEqual({ status: 'ok', token: 'sess' });
    expect(await openSession(fakeHttp({ [url]: { status: 403, data: { code: 'DEVICE_PENDING' } } }), origin, creds)).toEqual({ status: 'pending' });
    expect(await openSession(fakeHttp({ [url]: { status: 401, data: { code: 'DEVICE_REVOKED' } } }), origin, creds)).toEqual({ status: 'revoked' });
    expect(await openSession(fakeHttp({}), origin, creds)).toEqual({ status: 'unreachable' });
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
