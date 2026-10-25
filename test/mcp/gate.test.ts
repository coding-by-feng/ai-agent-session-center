// test/mcp/gate.test.ts — who may call /mcp (server/mcp/gate.ts): the Mac itself, naming itself in
// Host, with no foreign Origin, carrying the bearer token of a live central.
//
// A request is a plain object shaped like `IncomingMessage` (its headers and its socket's peer
// address); no server is started. The registry is the real one, so a token here is a token the
// way the launch code hands it out. `call` sends a request that is valid in every way except the
// one thing a test changes, so a refusal can only come from that.
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createCentralRegistry, type CentralRegistry } from '../../server/mcp/centrals.js';
import { checkMcpRequest } from '../../server/mcp/gate.js';
import { markRemoteOnlyServer } from '../../server/requestLocality.js';
import { globalInput, roomInput } from './centralFixtures.js';

// The registry and presenceManager (through requestLocality) import the logger, which appends to
// a file on disk. Nothing here logs; the mock keeps it that way.
vi.mock('../../server/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    debugJson: vi.fn(),
    isDebug: false,
  },
}));

const LAN_PEER = '192.168.1.50';

/** A request the way `http` hands it to a handler. A header set to `undefined` is left out. */
function request(headers: IncomingHttpHeaders = {}, peer = '127.0.0.1'): IncomingMessage {
  return {
    headers: { host: 'localhost:3333', ...headers },
    socket: { remoteAddress: peer },
  } as unknown as IncomingMessage;
}

/** One registry with one central, and a `call` that carries that central's token. */
function gate() {
  const reg = createCentralRegistry();
  const central = reg.mint(globalInput());
  const call = (headers: IncomingHttpHeaders = {}, peer = '127.0.0.1') =>
    checkMcpRequest(request({ authorization: `Bearer ${central.token}`, ...headers }, peer), reg);
  return { reg, central, call };
}

/** What a refusal looks like: exactly these four fields, with a message that says something. */
const refused = (status: 401 | 403, code: string) => ({
  ok: false,
  status,
  code,
  message: expect.stringMatching(/\S/),
});

describe('the connection', () => {
  it('refuses a LAN address', () => {
    expect(gate().call({}, LAN_PEER)).toEqual(refused(403, 'NOT_LOCAL'));
  });

  it('refuses forwarding headers', () => {
    expect(gate().call({ 'x-forwarded-for': '203.0.113.9' })).toEqual(refused(403, 'NOT_LOCAL'));
  });

  it('refuses a tunnel that relays from this machine under its own public name', () => {
    const relayed = { host: 'mac.example.dev', 'cf-connecting-ip': '203.0.113.9' };
    expect(gate().call(relayed)).toEqual(refused(403, 'NOT_LOCAL'));
  });

  it('refuses a request that arrived on the remote-only listener, even from loopback', () => {
    const { reg, central } = gate();
    const listener = new EventEmitter() as unknown as Server;
    markRemoteOnlyServer(listener);
    const socket = { remoteAddress: '127.0.0.1' };
    listener.emit('connection', socket);
    const req = {
      headers: { host: 'localhost:3333', authorization: `Bearer ${central.token}` },
      socket,
    } as unknown as IncomingMessage;
    expect(checkMcpRequest(req, reg)).toEqual(refused(403, 'NOT_LOCAL'));
  });

  it('fails closed for a request with no socket and no headers', () => {
    const { reg } = gate();
    expect(checkMcpRequest({} as IncomingMessage, reg)).toEqual(refused(403, 'NOT_LOCAL'));
  });

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts the loopback peer %s', (peer) => {
    const { call, central } = gate();
    expect(call({}, peer)).toEqual({ ok: true, central });
  });
});

describe('Host', () => {
  it('refuses a foreign Host', () => {
    expect(gate().call({ host: 'evil.example:3333' })).toEqual(refused(403, 'BAD_HOST'));
  });

  it('refuses a missing Host', () => {
    expect(gate().call({ host: undefined })).toEqual(refused(403, 'BAD_HOST'));
  });

  it('refuses an address on this machine that is not loopback', () => {
    expect(gate().call({ host: '192.168.1.20:3333' })).toEqual(refused(403, 'BAD_HOST'));
  });

  it.each(['localhost:3333', 'LOCALHOST', '127.0.0.1:3333', '[::1]:3333'])(
    'accepts %s as a name for this machine',
    (host) => {
      const { call, central } = gate();
      expect(call({ host })).toEqual({ ok: true, central });
    },
  );
});

describe('Origin', () => {
  it('refuses a foreign Origin', () => {
    expect(gate().call({ origin: 'https://evil.example' })).toEqual(refused(403, 'BAD_ORIGIN'));
  });

  it('accepts a loopback Origin', () => {
    const { call, central } = gate();
    expect(call({ origin: 'http://localhost:5173' })).toEqual({ ok: true, central });
    expect(call({ origin: 'http://127.0.0.1:3333' })).toEqual({ ok: true, central });
  });

  it('accepts no Origin', () => {
    // Claude Code and Codex are CLIs, not browsers: they send the bearer header and no Origin.
    const { call, central } = gate();
    expect(call({ origin: undefined })).toEqual({ ok: true, central });
  });

  it.each(['null', ''])('refuses the Origin %j (a sandboxed frame, a file page)', (origin) => {
    expect(gate().call({ origin })).toEqual(refused(403, 'BAD_ORIGIN'));
  });

  it('refuses a request the browser marks cross-site, with or without an Origin', () => {
    const { call } = gate();
    expect(call({ 'sec-fetch-site': 'cross-site' })).toEqual(refused(403, 'BAD_ORIGIN'));
    expect(call({ 'sec-fetch-site': 'cross-site', origin: 'http://localhost:5173' })).toEqual(
      refused(403, 'BAD_ORIGIN'),
    );
  });

  it.each(['same-origin', 'same-site', 'none'])('accepts Sec-Fetch-Site: %s', (site) => {
    const { call, central } = gate();
    expect(call({ 'sec-fetch-site': site })).toEqual({ ok: true, central });
  });
});

describe('the bearer token', () => {
  it('401 NO_TOKEN without a bearer', () => {
    expect(gate().call({ authorization: undefined })).toEqual(refused(401, 'NO_TOKEN'));
  });

  it('401 BAD_TOKEN for an unknown token', () => {
    const { call } = gate();
    expect(call({ authorization: 'Bearer aasc_mcp_not-a-token' })).toEqual(
      refused(401, 'BAD_TOKEN'),
    );
  });

  it('ok with the central for a valid token', () => {
    const { call, central } = gate();
    expect(call()).toEqual({ ok: true, central });
  });

  it('answers with the central that holds the token, not another one', () => {
    const { reg, call } = gate();
    const room = reg.mint(roomInput('room-1'));
    expect(call({ authorization: `Bearer ${room.token}` })).toEqual({ ok: true, central: room });
  });

  it.each([
    ['a lowercase scheme', (t: string) => `bearer ${t}`],
    ['an uppercase scheme', (t: string) => `BEARER ${t}`],
    ['a mixed-case scheme', (t: string) => `bEaReR ${t}`],
    ['padding around the scheme and the token', (t: string) => `  Bearer \t  ${t}   `],
  ])('accepts %s', (_name, header) => {
    const { call, central } = gate();
    expect(call({ authorization: header(central.token) })).toEqual({ ok: true, central });
  });

  it.each([
    ['an empty header', () => ''],
    ['a blank header', () => '   '],
    ['another scheme', () => 'Basic dXNlcjpwYXNz'],
    ['the token with no scheme', (t: string) => t],
    ['a scheme that only starts with Bearer', (t: string) => `Bearerx ${t}`],
    ['the Bearer scheme alone', () => 'Bearer'],
    ['the Bearer scheme and padding', () => 'Bearer   '],
  ])('401 NO_TOKEN for %s', (_name, header) => {
    const { call, central } = gate();
    expect(call({ authorization: header(central.token) })).toEqual(refused(401, 'NO_TOKEN'));
  });

  it.each([
    ['a valid token followed by another word', (t: string) => `Bearer ${t} extra`],
    ['a word before a valid token', (t: string) => `Bearer extra ${t}`],
    ['two valid-looking words', () => 'Bearer one two'],
    ['a token that is cut short', (t: string) => `Bearer ${t.slice(0, -1)}`],
    ['a token with a character added', (t: string) => `Bearer ${t}x`],
  ])('401 BAD_TOKEN for %s', (_name, header) => {
    const { call, central } = gate();
    expect(call({ authorization: header(central.token) })).toEqual(refused(401, 'BAD_TOKEN'));
  });

  it('refuses the token of a central that was revoked', () => {
    const { reg, central, call } = gate();
    reg.revoke(central.centralId);
    expect(call()).toEqual(refused(401, 'BAD_TOKEN'));
  });

  it('refuses a token that was rotated away and accepts its replacement', () => {
    const { reg, central, call } = gate();
    const rotated = reg.rotate(central.centralId);
    expect(call()).toEqual(refused(401, 'BAD_TOKEN'));
    expect(call({ authorization: `Bearer ${rotated.token}` })).toEqual({
      ok: true,
      central: rotated,
    });
  });

  it('hands the registry the token exactly, without the scheme or the padding', () => {
    const byToken = vi.fn<CentralRegistry['byToken']>(() => null);
    checkMcpRequest(request({ authorization: '  bEaReR   tok-123_x  ' }), { byToken });
    expect(byToken).toHaveBeenCalledExactlyOnceWith('tok-123_x');
  });

  it('401 BAD_TOKEN when the registry answers with anything but a central', () => {
    // Only a record passes. `undefined` (or any other falsy answer) is no central, not a pass.
    for (const answer of [undefined, false, 0, '']) {
      const byToken = (() => answer) as unknown as CentralRegistry['byToken'];
      const req = request({ authorization: 'Bearer aasc_mcp_some-token' });
      expect(checkMcpRequest(req, { byToken })).toEqual(refused(401, 'BAD_TOKEN'));
    }
  });
});

describe('the order of the checks', () => {
  it('names the connection before the Host', () => {
    // A LAN client's whole request: a LAN peer asking for the LAN address.
    expect(gate().call({ host: `${LAN_PEER}:3333` }, LAN_PEER)).toEqual(refused(403, 'NOT_LOCAL'));
  });

  it('names the Host before the Origin', () => {
    // A DNS-rebinding page: loopback socket, its own domain as Host, its own Origin.
    const rebinding = { host: 'evil.example:3333', origin: 'http://evil.example:3333' };
    expect(gate().call(rebinding)).toEqual(refused(403, 'BAD_HOST'));
  });

  it('names the Origin before the token', () => {
    const { reg } = gate();
    const req = request({ origin: 'https://evil.example' });
    expect(checkMcpRequest(req, reg)).toEqual(refused(403, 'BAD_ORIGIN'));
  });

  it('does not let a valid token open a request that is not the Mac', () => {
    // The token says which central is calling; it is not the wall.
    const { call } = gate();
    expect(call({}, LAN_PEER)).toEqual(refused(403, 'NOT_LOCAL'));
    expect(call({ host: 'evil.example' })).toEqual(refused(403, 'BAD_HOST'));
    expect(call({ origin: 'https://evil.example' })).toEqual(refused(403, 'BAD_ORIGIN'));
  });

  it('does not look a token up for a request that is not the Mac', () => {
    const byToken = vi.fn<CentralRegistry['byToken']>(() => null);
    const bearer = { authorization: 'Bearer some-token' };
    checkMcpRequest(request(bearer, LAN_PEER), { byToken });
    checkMcpRequest(request({ ...bearer, host: 'evil.example' }), { byToken });
    checkMcpRequest(request({ ...bearer, origin: 'https://evil.example' }), { byToken });
    checkMcpRequest(request({ ...bearer, 'sec-fetch-site': 'cross-site' }), { byToken });
    expect(byToken).not.toHaveBeenCalled();
  });
});

describe('what a refusal carries', () => {
  it('never holds a token, the Authorization value, or what the caller chose to send', () => {
    const { central, call } = gate();
    const stranger = 'aasc_mcp_a-token-no-central-holds';
    const refusals = [
      call({}, LAN_PEER),
      call({ host: 'evil.example:3333' }),
      call({ origin: 'https://evil.example' }),
      call({ authorization: `Bearer ${stranger}` }),
      call({ authorization: undefined }),
    ];
    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false);
      const text = JSON.stringify(refusal);
      expect(text).not.toContain(central.token);
      expect(text).not.toContain(stranger);
      expect(text).not.toContain('evil.example');
    }
  });

  it('is exactly the four documented fields', () => {
    const refusal = gate().call({ host: 'evil.example' });
    expect(Object.keys(refusal).sort()).toEqual(['code', 'message', 'ok', 'status']);
  });
});

describe('the request', () => {
  it('is left as the gate found it, whether it passes or not', () => {
    const { reg, central } = gate();
    const requests = [
      request({ authorization: `Bearer ${central.token}`, origin: 'http://localhost:5173' }),
      request({
        host: 'evil.example',
        origin: 'https://evil.example',
        'x-forwarded-for': '1.2.3.4',
      }),
      request({ 'sec-fetch-site': 'cross-site' }),
      request({}, LAN_PEER),
    ];
    for (const req of requests) {
      const before = structuredClone(req.headers);
      checkMcpRequest(req, reg);
      expect(req.headers).toEqual(before);
    }
  });
});
