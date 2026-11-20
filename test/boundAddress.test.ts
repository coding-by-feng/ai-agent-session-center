// test/boundAddress.test.ts — plan 18, stage 2: the `host:port` a sealed answer or a machine proof is bound to.
//
// Normally this machine's own address and port on the request's socket (reachedAt), which a box that passes a
// request on can never make its own. Two cases need the Host header instead, because the socket's address is
// not the one the client dialled:
//   (a) a forwarded port: the Host is EXACTLY the public `address:port` this machine publishes;
//   (b) Tailscale in userspace: the Host is EXACTLY the Tailscale `address:port` it publishes AND the socket's
//       own address is loopback AND its own port is the published one AND it is not a remote-only socket.
//       Userspace Tailscale hands the connection to 127.0.0.1 on the very port the client dialled; a tunnel
//       pointed at the remote-only listener is loopback too, on another port. With a kernel Tailscale the socket
//       address is the Tailscale address itself.
// The home-network address is NEVER taken from Host: on a direct connection the socket already is that address,
// and a private address is the one kind a box on another network can hold too. Canonical text only: no DNS, no
// case games, exact `ipv4:port` (or the bare address on port 80, which an HTTP client leaves out).
//
// And the socket's own address is not always one a client dialled. A request on a PRIVATE socket address from a
// PUBLIC peer came through a router's forwarded port: nobody on the home network sent it, so it never earns an
// answer for the home-network address. It gets the published public pair when its Host names exactly that
// (case a), and otherwise UNBOUND, a value no device can have dialled. A request with a proxy's forwarding
// header is never userspace Tailscale (case b): Tailscale hands over raw TCP and adds none.
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { boundAddress, boundAddressOf, UNBOUND, type PublishedAddresses } from '../server/mobile/boundAddress.js';
import { FORWARDING_HEADERS, markRemoteOnlyServer } from '../server/requestLocality.js';

const LAN = '192.168.1.57';
const PUBLIC = '45.63.31.79';
const TAILNET = '100.101.102.103';
const PORT = 3333;
const BOTH: PublishedAddresses = { public: PUBLIC, tailnet: TAILNET, port: PORT };

/**
 * A request that reached this machine's main listener on `local` (its own address on that socket) and `port`
 * (null: the socket's port is not known). `more`: the peer's address on that socket (default: not known) and
 * whether the request carries a proxy's forwarding header (default: none).
 */
const at = (
  local: string, host: string | undefined, published: PublishedAddresses | null, port: number | null = PORT,
  remoteOnly = false, more: { remoteAddress?: string; forwardingHeaders?: boolean } = {},
) => boundAddress({
  reachedAt: `${local}:${port ?? ''}`, localAddress: local, localPort: port ?? undefined,
  remoteAddress: more.remoteAddress, remoteOnly, forwardingHeaders: more.forwardingHeaders ?? false, host, published,
});
/** The same, from the peer `remote`. */
const from = (remote: string | undefined, local: string, host: string | undefined, published: PublishedAddresses | null) =>
  at(local, host, published, PORT, false, { remoteAddress: remote });
/** A peer somewhere on the internet. */
const INTERNET = '203.0.113.9';

describe('boundAddress', () => {
  it('is the address the request reached, whatever the Host says, when nothing is published ("Show this computer" off)', () => {
    for (const local of [LAN, '127.0.0.1']) {
      for (const host of [undefined, '', `${LAN}:3333`, `${PUBLIC}:3333`, `${TAILNET}:3333`, 'evil.example']) {
        expect(at(local, host, null)).toBe(`${local}:3333`);
      }
    }
  });

  it('is the same as before whenever the Host is the socket address (every released phone)', () => {
    for (const published of [null, BOTH, { public: PUBLIC, tailnet: null, port: PORT }]) {
      expect(at(LAN, `${LAN}:3333`, published)).toBe(`${LAN}:3333`);
      expect(at(TAILNET, `${TAILNET}:3333`, published)).toBe(`${TAILNET}:3333`); // a kernel Tailscale
      expect(at('127.0.0.1', '127.0.0.1:3333', published)).toBe('127.0.0.1:3333');
    }
  });

  describe('(a) a forwarded port', () => {
    it.each([LAN, '10.0.0.5', '127.0.0.1', TAILNET])('binds to the public pair when the Host is exactly that, on any socket (%s)', (local) => {
      expect(at(local, `${PUBLIC}:3333`, BOTH)).toBe(`${PUBLIC}:3333`);
    });

    it('has no socket condition at all: another port, a remote-only socket', () => {
      expect(at('127.0.0.1', `${PUBLIC}:3333`, BOTH, 3334)).toBe(`${PUBLIC}:3333`);
      expect(at('127.0.0.1', `${PUBLIC}:3333`, BOTH, PORT, true)).toBe(`${PUBLIC}:3333`);
    });

    it('does not, while Public IP is not ticked (no public address is published)', () => {
      expect(at(LAN, `${PUBLIC}:3333`, { public: null, tailnet: TAILNET, port: PORT })).toBe(`${LAN}:3333`);
    });
  });

  describe('(b) Tailscale in userspace', () => {
    it.each(['127.0.0.1', '127.0.0.53', '::1'])('binds to the Tailscale pair when the Host is exactly that and the socket is loopback (%s)', (local) => {
      expect(at(local, `${TAILNET}:3333`, BOTH)).toBe(`${TAILNET}:3333`);
    });

    it.each([
      ['the home-network address', LAN],
      ['another private address', '10.0.0.5'],
      ['a public address', '203.0.113.9'],
      ['another Tailscale address', '100.101.102.200'],
      ['an address that only starts like loopback', '127.0.0.1.evil'],
      ['an address that is no address', ''],
    ])('does not on a socket that is not loopback: %s', (_label, local) => {
      expect(at(local, `${TAILNET}:3333`, BOTH)).toBe(`${local}:3333`);
    });

    it('the carrier-NAT relay: a box at this machine\'s Tailscale address on a carrier-NAT network passes the request on to a forwarded public port, and the answer names the socket it arrived on', () => {
      // 100.64.0.0/10 is carrier-NAT space too, so on some networks a box CAN sit at the address the client dials.
      // It relays, Host untouched, to the machine's forwarded public port: that socket is the home-network address
      // (or a public-side one on a machine with a public interface), never loopback.
      for (const local of [LAN, '203.0.113.9']) {
        expect(at(local, `${TAILNET}:3333`, BOTH)).toBe(`${local}:3333`);
        expect(at(local, `${TAILNET}:3333`, { public: null, tailnet: TAILNET, port: PORT })).toBe(`${local}:3333`);
      }
    });

    describe('the tunnel relay: a loopback socket that is not userspace Tailscale', () => {
      // A box at this machine's Tailscale address on the client's network (carrier-NAT space) passes the request on,
      // Host untouched, through a TCP tunnel that ends on loopback: the remote-only listener, or anything pointed at it.
      it.each([
        ['another port than the published one (the remote-only listener\'s)', 3334],
        ['a port one off the other way', 3332],
        ['no port known at all', null],
      ])('on %s, the answer names the socket it arrived on', (_label, port) => {
        for (const local of ['127.0.0.1', '::1']) {
          expect(at(local, `${TAILNET}:3333`, BOTH, port)).toBe(`${local}:${port ?? ''}`);
        }
      });

      it('on a remote-only socket, even on the published port, the answer names the socket it arrived on', () => {
        for (const local of ['127.0.0.1', '::1']) {
          expect(at(local, `${TAILNET}:3333`, BOTH, PORT, true)).toBe(`${local}:3333`);
        }
      });

      it('userspace Tailscale itself still binds: the main listener, loopback, the very port the client dialled', () => {
        expect(at('127.0.0.1', `${TAILNET}:3333`, BOTH, PORT, false)).toBe(`${TAILNET}:3333`);
      });
    });

    it('does not, while Tailscale is not ticked or not connected (no Tailscale address is published)', () => {
      expect(at('127.0.0.1', `${TAILNET}:3333`, { public: PUBLIC, tailnet: null, port: PORT })).toBe('127.0.0.1:3333');
    });

    it('does not for a request that carries a proxy\'s forwarding header: a reverse proxy on the main port is not Tailscale', () => {
      for (const local of ['127.0.0.1', '::1']) {
        expect(at(local, `${TAILNET}:3333`, BOTH, PORT, false, { forwardingHeaders: true })).toBe(`${local}:3333`);
        expect(at(local, `${TAILNET}:3333`, BOTH, PORT, false, { forwardingHeaders: false })).toBe(`${TAILNET}:3333`);
      }
      // (a) has no such condition: a forward in front of a proxy is still a forward.
      expect(at('127.0.0.1', `${PUBLIC}:3333`, BOTH, PORT, false, { forwardingHeaders: true })).toBe(`${PUBLIC}:3333`);
      expect(at(LAN, `${PUBLIC}:3333`, BOTH, PORT, false, { forwardingHeaders: true })).toBe(`${PUBLIC}:3333`);
    });
  });

  describe('a request that came through a forwarded port: a private socket address, a public peer', () => {
    const PRIVATE_LOCALS = [LAN, '10.0.0.5', '172.16.4.2', '172.31.255.254', '169.254.10.20'];

    it('UNBOUND is a name, not an address anything could have dialled', () => {
      expect(UNBOUND).toBe('unbound');
      expect(UNBOUND).not.toMatch(/[:.\d]/);
    });

    it.each(PRIVATE_LOCALS)('the relay through the forward: the Host is this machine\'s private pair (%s), and the answer is bound to nothing', (local) => {
      // A hostile network the client is on answers at this machine's home-network address and passes the request
      // on to the forwarded public port. The socket's own address IS the address the client dialled.
      for (const published of [BOTH, { public: PUBLIC, tailnet: null, port: PORT }, { public: null, tailnet: TAILNET, port: PORT }, null]) {
        expect(from(INTERNET, local, `${local}:3333`, published)).toBe(UNBOUND);
      }
    });

    it.each(PRIVATE_LOCALS)('(a) still holds: the Host is exactly the public pair this machine publishes (%s)', (local) => {
      expect(from(INTERNET, local, `${PUBLIC}:3333`, BOTH)).toBe(`${PUBLIC}:3333`);
      expect(from(INTERNET, local, `${PUBLIC}:3333`, { public: PUBLIC, tailnet: null, port: PORT })).toBe(`${PUBLIC}:3333`);
    });

    it.each([
      ['the public pair while none is published', `${PUBLIC}:3333`, { public: null, tailnet: TAILNET, port: PORT }],
      ['the public pair while nothing at all is published', `${PUBLIC}:3333`, null],
      ['the public address on another port', `${PUBLIC}:3334`, BOTH],
      ['another public address', '45.63.31.80:3333', BOTH],
      ['the Tailscale pair', `${TAILNET}:3333`, BOTH],
      ['another private address', '192.168.1.66:3333', BOTH],
      ['a host name', 'mac-mini.example:3333', BOTH],
      ['an empty Host', '', BOTH],
      ['no Host at all', undefined, BOTH],
      ['no Host and nothing published', undefined, null],
    ] as const)('any other Host is bound to nothing, never to the socket address: %s', (_label, host, published) => {
      expect(from(INTERNET, LAN, host, published)).toBe(UNBOUND);
    });

    it.each(['203.0.113.9', '8.8.8.8', '1.1.1.1', '45.63.31.79', '99.255.255.255', '101.0.0.1', '223.255.255.254'])('counts for any public peer (%s)', (remote) => {
      expect(from(remote, LAN, `${LAN}:3333`, BOTH)).toBe(UNBOUND);
    });

    describe('nothing changes for a peer that is not a public address', () => {
      it.each([
        ['a client on the home network', '192.168.1.20'],
        ['this machine itself, on its own address', LAN],
        ['the router, when it rewrites the source (a hairpin)', '192.168.1.1'],
        ['a Docker bridge', '172.17.0.1'],
        ['another private network', '10.8.0.2'],
        ['a link-local peer', '169.254.1.1'],
        ['a Tailscale peer behind a subnet router', '100.101.102.200'],
        ['loopback', '127.0.0.1'],
        ['an address that is not known', undefined],
        ['an empty address', ''],
        ['text that is no address', 'not-an-address'],
        ['an IPv6 peer', '2001:db8::1'],
        ['an octet with a leading zero', '203.000.113.9'],
        ['this network', '0.0.0.0'],
        ['multicast', '224.0.0.1'],
        ['broadcast', '255.255.255.255'],
      ])('%s', (_label, remote) => {
        expect(from(remote, LAN, `${LAN}:3333`, BOTH)).toBe(`${LAN}:3333`);
        expect(from(remote, LAN, `${TAILNET}:3333`, BOTH)).toBe(`${LAN}:3333`);
        expect(from(remote, LAN, undefined, null)).toBe(`${LAN}:3333`);
        expect(from(remote, LAN, `${PUBLIC}:3333`, BOTH)).toBe(`${PUBLIC}:3333`);
      });
    });

    describe('nothing changes on a socket address that is not private', () => {
      it.each([
        ['a public one (a server on the internet)', '45.63.31.79'],
        ['a Tailscale one (a kernel Tailscale)', TAILNET],
        ['loopback', '127.0.0.1'],
        ['IPv6 loopback', '::1'],
        ['an IPv6 one', '2001:db8::57'],
        ['one that is not known', ''],
      ])('%s', (_label, local) => {
        expect(from(INTERNET, local, `${local}:3333`, BOTH)).toBe(`${local}:3333`);
        expect(from(INTERNET, local, 'mac-mini.example:3333', BOTH)).toBe(`${local}:3333`);
        expect(from(INTERNET, local, undefined, null)).toBe(`${local}:3333`);
      });

      it('userspace Tailscale is still bound on loopback, whatever the peer', () => {
        expect(from(INTERNET, '127.0.0.1', `${TAILNET}:3333`, BOTH)).toBe(`${TAILNET}:3333`);
        expect(from('127.0.0.1', '127.0.0.1', `${TAILNET}:3333`, BOTH)).toBe(`${TAILNET}:3333`);
      });
    });
  });

  describe('the home-network address is never taken from Host', () => {
    it('a relay: a box holding this machine\'s home-network address on another network passes the request on, and the answer names the socket it arrived on', () => {
      // Whatever road the box takes to another socket of this machine: a tunnel to localhost, Tailscale, a forwarded port.
      for (const local of ['127.0.0.1', '::1', TAILNET, '10.0.0.5']) {
        expect(at(local, `${LAN}:3333`, BOTH)).toBe(`${local}:3333`);
      }
    });

    it('not even when a source wrongly names a private address as the public or the Tailscale one', () => {
      // machineAccountWiring only ever passes addresses of the right kind; the rule checks the kind itself too.
      const wrong: PublishedAddresses = { public: LAN, tailnet: LAN, port: PORT };
      for (const local of ['127.0.0.1', '10.0.0.5']) expect(at(local, `${LAN}:3333`, wrong)).toBe(`${local}:3333`);
      // And a Tailscale address is not a public one: named as public, it would be bound on any socket.
      expect(at('10.0.0.5', `${TAILNET}:3333`, { public: TAILNET, tailnet: null, port: PORT })).toBe('10.0.0.5:3333');
    });
  });

  it.each([
    ['an address this machine does not publish', '45.63.31.80:3333'],
    ['another Tailscale address', '100.101.102.104:3333'],
    ['the public address on another port', `${PUBLIC}:3334`],
    ['the Tailscale address on another port', `${TAILNET}:3334`],
    ['a published address with no port', PUBLIC],
    ['a host name', 'mac-mini.example:3333'],
    ['a host name that would resolve to a published address', 'mac-mini.tail1234.ts.net:3333'],
    ['two Host values on one line', `${PUBLIC}:3333, 192.168.1.66:3333`],
    ['user info glued on', `x@${PUBLIC}:3333`],
    ['a trailing space', `${PUBLIC}:3333 `],
    ['a trailing dot', `${PUBLIC}.:3333`],
    ['a leading-zero port', `${PUBLIC}:03333`],
    ['a leading-zero octet', '045.63.31.79:3333'],
    ['the address as an IPv4-mapped IPv6 literal', `[::ffff:${PUBLIC}]:3333`],
    ['an empty Host', ''],
    ['no Host at all', undefined],
  ])('stays the address reached for %s', (_label, host) => {
    expect(at('127.0.0.1', host, BOTH)).toBe('127.0.0.1:3333');
  });

  it('reads a Host with no port as port 80, the one an HTTP client leaves out, for both cases and only then', () => {
    const onEighty: PublishedAddresses = { public: PUBLIC, tailnet: TAILNET, port: 80 };
    expect(at('10.0.0.5', PUBLIC, onEighty, 80)).toBe(`${PUBLIC}:80`);
    expect(at('10.0.0.5', `${PUBLIC}:80`, onEighty, 80)).toBe(`${PUBLIC}:80`);
    expect(at('127.0.0.1', TAILNET, onEighty, 80)).toBe(`${TAILNET}:80`);
    expect(at('127.0.0.1', `${TAILNET}:80`, onEighty, 80)).toBe(`${TAILNET}:80`);
    expect(at('10.0.0.5', TAILNET, onEighty, 80)).toBe('10.0.0.5:80'); // (b) still needs a loopback socket
    expect(at('127.0.0.1', TAILNET, onEighty, 8080)).toBe('127.0.0.1:8080'); // and the published port on it
    expect(at('127.0.0.1', TAILNET, onEighty, 80, true)).toBe('127.0.0.1:80'); // and not a remote-only one
    expect(at('10.0.0.5', '45.63.31.80', onEighty, 80)).toBe('10.0.0.5:80');
    expect(at('127.0.0.1', PUBLIC, BOTH)).toBe('127.0.0.1:3333'); // no port is not port 3333
  });
});

describe('boundAddressOf (a request)', () => {
  /**
   * A request as Express hands it over: the socket's own address, and the headers exactly as they were sent.
   * `more`: the peer's address on the socket (default: a client on the home network), and other headers.
   */
  const request = (
    hosts: string[], local = `::ffff:${LAN}`, port = PORT, more: { remote?: string; headers?: Record<string, string> } = {},
  ): Request => ({
    socket: { localAddress: local, localPort: port, remoteAddress: 'remote' in more ? more.remote : '::ffff:192.168.1.20' },
    headers: { ...(hosts.length ? { host: hosts[0] } : {}), ...more.headers }, // Node keeps the first Host line and drops the rest
    rawHeaders: [...hosts.flatMap((host) => ['Host', host]), ...Object.entries(more.headers ?? {}).flat()],
  }) as unknown as Request;
  /** The same request, accepted by a remote-only listener (requestLocality.ts marks its sockets). */
  const onRemoteOnlyListener = (req: Request): Request => {
    const listener = new EventEmitter();
    markRemoteOnlyServer(listener as unknown as Server);
    listener.emit('connection', req.socket);
    return req;
  };

  it('answers the socket address at once, without looking anything up, when the Host is that address', async () => {
    const published = vi.fn(async () => BOTH);
    expect(await boundAddressOf(request([`${LAN}:3333`]), published)).toBe(`${LAN}:3333`);
    expect(published).not.toHaveBeenCalled();
  });

  it('answers the public pair on any socket, and the Tailscale pair on a loopback socket only', async () => {
    expect(await boundAddressOf(request([`${PUBLIC}:3333`]), async () => BOTH)).toBe(`${PUBLIC}:3333`);
    expect(await boundAddressOf(request([`${TAILNET}:3333`], '127.0.0.1'), async () => BOTH)).toBe(`${TAILNET}:3333`);
    expect(await boundAddressOf(request([`${TAILNET}:3333`], '::ffff:127.0.0.1'), async () => BOTH)).toBe(`${TAILNET}:3333`);
    expect(await boundAddressOf(request([`${TAILNET}:3333`], '::1'), async () => BOTH)).toBe(`${TAILNET}:3333`);
    expect(await boundAddressOf(request([`${TAILNET}:3333`]), async () => BOTH)).toBe(`${LAN}:3333`);
  });

  it('the tunnel relay: the Tailscale pair on a loopback socket of another port, or of a remote-only listener, answers the socket address', async () => {
    expect(await boundAddressOf(request([`${TAILNET}:3333`], '127.0.0.1', 3334), async () => BOTH)).toBe('127.0.0.1:3334');
    expect(await boundAddressOf(onRemoteOnlyListener(request([`${TAILNET}:3333`], '127.0.0.1')), async () => BOTH)).toBe('127.0.0.1:3333');
    expect(await boundAddressOf(onRemoteOnlyListener(request([`${TAILNET}:3333`], '::1')), async () => BOTH)).toBe('::1:3333');
    // The public pair has no such condition.
    expect(await boundAddressOf(onRemoteOnlyListener(request([`${PUBLIC}:3333`], '127.0.0.1')), async () => BOTH)).toBe(`${PUBLIC}:3333`);
  });

  it('answers the socket address for a request with a second Host header, whichever comes first', async () => {
    expect(await boundAddressOf(request([`${PUBLIC}:3333`, '192.168.1.66:3333']), async () => BOTH)).toBe(`${LAN}:3333`);
    expect(await boundAddressOf(request(['192.168.1.66:3333', `${PUBLIC}:3333`]), async () => BOTH)).toBe(`${LAN}:3333`);
    expect(await boundAddressOf(request([`${PUBLIC}:3333`, `${PUBLIC}:3333`]), async () => BOTH)).toBe(`${LAN}:3333`);
  });

  it('answers the socket address with no Host header, with nothing published, and when the lookup fails', async () => {
    expect(await boundAddressOf(request([]), async () => BOTH)).toBe(`${LAN}:3333`);
    expect(await boundAddressOf(request([`${PUBLIC}:3333`]), async () => null)).toBe(`${LAN}:3333`);
    expect(await boundAddressOf(request([`${PUBLIC}:3333`]))).toBe(`${LAN}:3333`);
    expect(await boundAddressOf(request([`${PUBLIC}:3333`]), async () => { throw new Error('probe fell over'); })).toBe(`${LAN}:3333`);
  });

  describe('through a forwarded port (a private socket address, a public peer)', () => {
    const forwarded = (hosts: string[], remote = '203.0.113.9') => request(hosts, `::ffff:${LAN}`, PORT, { remote });

    it('never answers the socket address, not even when the Host is exactly that: nothing is looked up, and nothing is bound', async () => {
      const published = vi.fn(async () => BOTH);
      expect(await boundAddressOf(forwarded([`${LAN}:3333`]), published)).toBe(UNBOUND);
      expect(await boundAddressOf(forwarded([`${LAN}:3333`], '::ffff:203.0.113.9'), published)).toBe(UNBOUND); // IPv4-mapped
      expect(published).not.toHaveBeenCalled(); // a private pair is never the public one
    });

    it('answers the published public pair when the Host is exactly that', async () => {
      expect(await boundAddressOf(forwarded([`${PUBLIC}:3333`]), async () => BOTH)).toBe(`${PUBLIC}:3333`);
      expect(await boundAddressOf(forwarded([`${PUBLIC}:3333`], '::ffff:8.8.8.8'), async () => BOTH)).toBe(`${PUBLIC}:3333`);
    });

    it('is bound to nothing with no Host, two Hosts, another Host, nothing published, no rule wired, or a lookup that fails', async () => {
      expect(await boundAddressOf(forwarded([]), async () => BOTH)).toBe(UNBOUND);
      expect(await boundAddressOf(forwarded([`${PUBLIC}:3333`, `${PUBLIC}:3333`]), async () => BOTH)).toBe(UNBOUND);
      expect(await boundAddressOf(forwarded([`${TAILNET}:3333`]), async () => BOTH)).toBe(UNBOUND);
      expect(await boundAddressOf(forwarded(['192.168.1.66:3333']), async () => BOTH)).toBe(UNBOUND);
      expect(await boundAddressOf(forwarded([`${PUBLIC}:3333`]), async () => null)).toBe(UNBOUND);
      expect(await boundAddressOf(forwarded([`${PUBLIC}:3333`]))).toBe(UNBOUND);
      expect(await boundAddressOf(forwarded([`${LAN}:3333`]))).toBe(UNBOUND);
      expect(await boundAddressOf(forwarded([`${PUBLIC}:3333`]), async () => { throw new Error('probe fell over'); })).toBe(UNBOUND);
    });

    it.each([
      ['a client on the home network', '::ffff:192.168.1.20'],
      ['a client on the home network, plain IPv4', '192.168.1.20'],
      ['a peer whose address is not known', undefined],
      ['a Tailscale peer behind a subnet router', '100.101.102.200'],
      ['an IPv6 peer', '2001:db8::1'],
    ])('is the socket address as before, with no lookup, from %s', async (_label, remote) => {
      const published = vi.fn(async () => BOTH);
      expect(await boundAddressOf(request([`${LAN}:3333`], `::ffff:${LAN}`, PORT, { remote }), published)).toBe(`${LAN}:3333`);
      expect(published).not.toHaveBeenCalled();
    });

    it('leaves a public socket address alone (a server on the internet), whatever the peer', async () => {
      const published = vi.fn(async () => BOTH);
      expect(await boundAddressOf(request(['45.63.31.79:3333'], '45.63.31.79', PORT, { remote: '203.0.113.9' }), published)).toBe('45.63.31.79:3333');
      expect(published).not.toHaveBeenCalled();
    });
  });

  describe('a proxy\'s forwarding header', () => {
    it.each([...FORWARDING_HEADERS])('%s alone turns userspace Tailscale off: the answer names the socket', async (header) => {
      const proxied = request([`${TAILNET}:3333`], '127.0.0.1', PORT, { remote: '127.0.0.1', headers: { [header]: '203.0.113.9' } });
      expect(await boundAddressOf(proxied, async () => BOTH)).toBe('127.0.0.1:3333');
    });

    it('without one, the same request is userspace Tailscale', async () => {
      const plain = request([`${TAILNET}:3333`], '127.0.0.1', PORT, { remote: '127.0.0.1', headers: { 'user-agent': 'aasc' } });
      expect(await boundAddressOf(plain, async () => BOTH)).toBe(`${TAILNET}:3333`);
    });

    it.each([...FORWARDING_HEADERS])('%s does not touch the public pair (a)', async (header) => {
      const proxied = request([`${PUBLIC}:3333`], '127.0.0.1', PORT, { remote: '127.0.0.1', headers: { [header]: 'x' } });
      expect(await boundAddressOf(proxied, async () => BOTH)).toBe(`${PUBLIC}:3333`);
    });
  });
});
